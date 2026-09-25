#!/usr/bin/env python3
"""pty リレー — 稼働中セッションに「打鍵として」文字を入れるための1枚。

    relay.py [--sock <path>] -- <command> [args...]

    claude-r  →  relay.py -- claude …      （rc の1行が呼ぶ）

## なぜ要るか（ARCHITECTURE.md §9.7.2）

受信箱（UDS）に投げた文字は **受信側の CLI が peer と判定して英文の枠を付ける**。
枠は送信側から外せない（`origin.kind` は受信箱の投入口が `peer` 固定で書く）。
枠が付かないのは **TUI に打鍵されたもの**（`origin.kind: "human"`）だけで、
打鍵するには **pty を持っている必要がある**。それがこのプロセス。

## やることは3つだけ

  1. pty を1本張って <command> を中に入れ、端末 ⇄ pty を **バイトのまま** 中継する
  2. SIGWINCH で桁を伝える／終了コードをそのまま返す
  3. UNIX ソケットに書かれたバイトを pty に流す（＝ 打鍵）

⚠️ **画面を模倣しない**（VT のエミュレータを持たない）。だから `TERM` も変えないし、
   スクロールバックも素の端末のまま（2026-08-22 に実測: 素の claude と画面が同一）。
⚠️ **本文をログに出さない**（長さだけ / §6.2）。
⚠️ **fail-open**: 何か用意できなければ **素で `exec`** する。利用者の起動を止めない。
⚠️ **端末を閉じたら claude も終わる**（実測。素の claude と同じで、幽霊は残らない）。

## agent との待ち合わせ

CLI が `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` に `sessionId` を書くので、
こちらは **pid で名乗る**だけでよい:

    ~/.nyan-remote/panes/<子の pid>.json   { pid, procStart, socket, startedAt }

⚠️ `procStart` を必ず入れる（pid 再利用と区別できないと、**別プロセスに打鍵する**）。
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import pty
import select
import signal
import socket
import subprocess
import stat
import struct
import sys
import termios
import time
import tty

STDIN = 0
STDOUT = 1
# Upper bound on simultaneous connections to the injection socket. ⚠️ Letting them pile up pushes fds past select's limit (1024) and crashes
MAX_CONNS = 8


def _lang() -> str:
    """★ Language of the messages (2026-09-24): NYAN_LANG > LC_ALL > LC_MESSAGES > LANG.

    `ja*` => Japanese, anything else (unset / C) => English (same rule as shared/i18n.ts `langFromEnv`).
    """
    # ★ the first non-empty one decides (NYAN_LANG too: `NYAN_LANG=ja_JP.UTF-8` is Japanese)
    for k in ("NYAN_LANG", "LC_ALL", "LC_MESSAGES", "LANG"):
        v = os.environ.get(k)
        if v:
            return "ja" if v.lower().startswith("ja") else "en"
    return "en"


_LANG = _lang()


def _t(ja: str, en: str) -> str:
    return ja if _LANG == "ja" else en


# ★ English version of `--help` (the Japanese one prints __doc__ as is)
_HELP_EN = """pty relay: lets text be typed into a running session as keystrokes.

    relay.py [--sock <path>] -- <command> ...

  1. opens a pty, runs <command> in it and relays terminal <-> pty byte for byte
  2. forwards SIGWINCH and returns the child's exit code
  3. writes bytes received on a UNIX socket into the pty (= keystrokes)

Registers itself as ~/.nyan-remote/panes/<child pid>.json { pid, procStart, socket, startedAt }.
Fail-open: if anything cannot be prepared, it execs the command directly.
Bypass: NYAN_REMOTE_NO_RELAY=1. Debug log: RELAY_DEBUG=1 or RELAY_LOG=<path>.
"""


def log(msg: str) -> None:
    """Only with RELAY_DEBUG=1 or RELAY_LOG=<path>. ⚠️ Never pass the text itself (length only).

    ⚠️ Why an output-to-file option is needed: the screen (stderr) is **the side that is stuck**, so
          it cannot be used to verify backpressure (the log itself gets stuck).
    """
    path = os.environ.get("RELAY_LOG")
    if path:
        try:
            with open(path, "a", encoding="utf-8") as f:
                f.write(f"[relay] {msg}\n")
        except OSError:
            pass
    if os.environ.get("RELAY_DEBUG"):
        # ⚠️⚠️ **Writing this bare crashes** (measured 2026-08-23). Making STDIN non-blocking
        #    on a tty makes **fd2 non-blocking too**, since fds 0/1/2 share the same open file description,
        #    and a write while the terminal is stuck raises `BlockingIOError`.
        #    ⇒ The backpressure log itself throws and **the relay dies = the running claude dies**.
        try:
            sys.stderr.write(f"[relay] {msg}\r\n")
            sys.stderr.flush()
        except OSError:
            pass


def state_dir() -> str:
    return os.environ.get("NYAN_REMOTE_STATE_DIR") or os.path.join(os.path.expanduser("~"), ".nyan-remote")


def default_socket_path(pid: int) -> str:
    """Decide where to put the keystroke injection socket.

    ⚠️⚠️ **Handling the fallback to `/tmp` is the crux** (2026-08-23 / mac has no `XDG_RUNTIME_DIR`,
          so **it lands here by default**). `/tmp` is sticky but world-writable, so
          **another user can plant a symlink before the path is created**.
          It used to be `makedirs(exist_ok=True)` + `chmod`, so:
              - `isdir()` **follows links**, accepting a link someone else prepared
              - `chmod` hit **the link target** (any of the user's directories could be changed to 0700)
              - if the socket could then be swapped, **the keystroke text would go to another user**
    ⇒ **Create it ourselves** (`mkdir` fails if it already exists). If it exists, use `lstat` to confirm
          **① not a link ② owned by us ③ not open to others**, and
          if any is missing **raise OSError to fall into the caller's fail-open** (give up keystrokes and start directly).
    ⚠️ Also check the path length. AF_UNIX `sun_path` is 108 bytes; beyond that `bind` raises
          an OSError with `errno=None` and **the reason is unclear** (hit for real).
    """
    base = os.environ.get("XDG_RUNTIME_DIR") or os.environ.get("CLAUDE_CODE_TMPDIR") or "/tmp"
    d = os.path.join(base, f"nyan-remote-{os.geteuid()}")
    try:
        os.mkdir(d, 0o700)
    except FileExistsError:
        st = os.lstat(d)  # ⚠️ **lstat** (does not follow links)
        if not stat.S_ISDIR(st.st_mode):
            raise OSError(errno.ENOTDIR, _t(f"打鍵の置き場がディレクトリではない: {d}", f"the keystroke directory is not a directory: {d}"))
        if st.st_uid != os.geteuid():
            raise OSError(errno.EPERM, _t(f"打鍵の置き場が自分の所有ではない: {d}", f"the keystroke directory is not owned by you: {d}"))
        if st.st_mode & 0o077:
            raise OSError(errno.EPERM, _t(f"打鍵の置き場が他人に開いている: {d}", f"the keystroke directory is open to others: {d}"))
    path = os.path.join(d, f"keys-{pid}.sock")
    if len(path.encode()) > 100:
        raise OSError(errno.ENAMETOOLONG, _t(f"ソケットのパスが長すぎる（{len(path.encode())}バイト）: {d}", f"the socket path is too long ({len(path.encode())} bytes): {d}"))
    return path


def parse_max_buf(raw: str | None) -> int:
    """Upper bound for backpressure. ⚠️ **Enforce a minimum** (allowing `0` stops the screen and keystrokes entirely)."""
    if not raw:
        return 4 * 1024 * 1024
    return max(64 * 1024, int(raw))


def proc_start(pid: int) -> str | None:
    """Process start time (identity to tell pid reuse apart).

    Linux: starttime in /proc/<pid>/stat (the 22nd field).
    mac  : ★★ `ps -o lstart=` (added 2026-09-22).

    ⚠️⚠️ **On mac this returned None, so keystrokes were refused as `unverified`**
          (= text from the phone silently fell back to the inbox with the English wrapper).
    ⚠️⚠️ **Always pass `LC_ALL=C` and `TZ=UTC`**. Without them, on the user's terminal it comes out
          like `"火  9/22 08:12:13 2026"`, **garbled by locale and time zone** (measured).
          ⇒ The agent side (`sessionIndex.ts`) fetches it under the same conditions, so the strings can be compared.
    ⚠️ This sits **in the daily path**, so never raise on failure (fall back to None = fail-open).
          ⚠️ Also time-box it (claude failing to start just because `ps` does not return is unacceptable).
    """
    # ⚠️⚠️ **On an OS with `/proc`, never fall back to `ps`** (2026-09-23 / removed a side effect of the mac support).
    #    It used to be "`ps` if unreadable" ⇒ even on Linux a dead child launched `ps`,
    #    so **the daily path** could wait up to 3 seconds (`/proc` exists but unreadable = dead).
    if os.path.exists("/proc/self/stat"):
        try:
            with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
                stat = f.read()
            rest = stat[stat.rindex(")") + 2 :].split()
            return rest[19]  # counting from the 3rd field, starttime is index 19
        except (OSError, ValueError, IndexError):
            return None
    try:
        env = {**os.environ, "LC_ALL": "C", "TZ": "UTC"}
        out = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            env=env,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    # Whitespace padding differs by implementation (two spaces for a single-digit day), so collapse it
    #    = the same collapsing as the agent's `sameProcStart`
    value = " ".join(out.stdout.split())
    return value or None


def register(child_pid: int, sock_path: str) -> str | None:
    """Register ourselves. ⚠️ Temp file → rename (never let a half-written file be read / §8.3)."""
    d = os.path.join(state_dir(), "panes")
    try:
        os.makedirs(d, mode=0o700, exist_ok=True)
        path = os.path.join(d, f"{child_pid}.json")
        tmp = f"{path}.{os.getpid()}.tmp"
        body = {
            "pid": child_pid,
            "procStart": proc_start(child_pid),
            "socket": sock_path,
            "startedAt": int(time.time() * 1000),
        }
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps(body))
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
        return path
    except OSError as e:
        log(_t(f"名乗れなかった: {e.errno}", f"could not register: {e.errno}"))
        return None


# ★ Where the refusal record goes (decided by `register`. ⚠️ nothing is recorded if registration failed)
_REJECT_PATH: str | None = None
_REJECT_COUNT = 0


def rejected_path_for(reg_path: str) -> str:
    """Next to the pane record (`<pid>.json`). ⚠️ Must not end with `.json` (never confused with the pane record)."""
    return reg_path[: -len(".json")] + ".rejected" if reg_path.endswith(".json") else reg_path + ".rejected"


def note_rejected(uid: int | None) -> None:
    """★★ **Record a refused keystroke connection in a file** (2026-09-23).

    ⚠️⚠️ Why: we decided not to add an ACK, so the agent only knows "it wrote to the socket".
          ⇒ When we refuse here, **the agent logs "sent as keystrokes" and nothing shows on screen**
          (actually happened on mac. The log only appears with RELAY_DEBUG = nobody sees it).
          ⇒ `npm run keys` reads this and says "the relay is refusing" **in the affirmative**.
    ⚠️ Never write the text (only the count and the peer's uid / §6.2).
    ⚠️ **Never raise, no matter what** (the daily path = dying here takes claude down with it).
    """
    global _REJECT_COUNT
    if _REJECT_PATH is None:
        return
    _REJECT_COUNT += 1
    try:
        tmp = f"{_REJECT_PATH}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps({"count": _REJECT_COUNT, "uid": uid, "at": int(time.time() * 1000)}))
        os.chmod(tmp, 0o600)
        os.replace(tmp, _REJECT_PATH)
    except OSError:
        pass


def admit(conn: socket.socket, conns: list) -> bool:
    """Decide whether to accept a keystroke connection. If accepted, add it to `conns` and return True.

    ★ Why it is split out of the loop (2026-09-23): to hit **the refusal path itself** in tests.
          On Linux the peer has the same uid, so a "refuse" situation cannot be created, and the mutation removing `note_rejected`
          survived. ⚠️ Never add a test-only hook in production (env vars etc.; this is the daily path).
    """
    uid = peer_uid(conn)
    # ⚠️⚠️ **Also refuse `None` (could not be obtained)** (2026-08-23).
    #    It used to be `uid is not None and …`, so connections whose identity could not be obtained
    #    were accepted (the only boundary had fallen to fail-open).
    if uid != os.geteuid():
        # ⚠️ **Record the refusal next to the pane record** (the log only appears with RELAY_DEBUG =
        #    from the user's screen it only looks like "sent but never arrived" / 2026-09-23)
        log(_t(f"接続を断った uid={uid}", f"rejected a connection uid={uid}"))
        note_rejected(uid)
        conn.close()
        return False
    if len(conns) >= MAX_CONNS:
        # ⚠️ Enforce an upper bound (silently piling up pushes fds past 1024 and select crashes).
        #    ★ **accept and close immediately** (without accept, select keeps spinning)
        log(_t(f"接続が多すぎるので断った（{len(conns)}本）", f"rejected: too many connections ({len(conns)})"))
        conn.close()
        return False
    conn.setblocking(False)
    conns.append(conn)
    return True


def get_winsize(fd: int) -> bytes | None:
    try:
        return fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8)
    except OSError:
        return None


def set_winsize(fd: int, packed: bytes) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)
    except OSError:
        pass


# ★ Values from mac's `<sys/un.h>` / `<sys/ucred.h>` (⚠️ some Python versions lack the names, so keep them as numbers)
_SOL_LOCAL = 0
_LOCAL_PEERCRED = 0x001
_XUCRED_VERSION = 0
# struct xucred { u_int cr_version; uid_t cr_uid; short cr_ngroups; gid_t cr_groups[16]; }
_XUCRED_SIZE = 4 + 4 + 2 + 2 + 16 * 4


def parse_xucred(raw: bytes) -> int | None:
    """Extract the uid from mac's `struct xucred`. `None` (= refuse) if the shape differs.

    ⚠️⚠️ **Always check the version (`cr_version`)**. Trusting only the offset on a changed layout
          **reads some other value as the uid** and lets it through (= accepts someone else's keystrokes).
    """
    if len(raw) < 8:
        return None
    version, uid = struct.unpack_from("=II", raw, 0)
    if version != _XUCRED_VERSION:
        return None
    return uid


def peer_uid(conn: socket.socket) -> int | None:
    """Get the peer's uid. `None` if it cannot be obtained.

    ⚠️⚠️ **`None` is not "allowed".** The caller refuses `None` too (fixed 2026-08-23).
          It used to refuse with `uid is not None and uid != geteuid()`, so
          **connections whose lookup failed were accepted** (the only boundary had fallen to fail-open).

    ★★ **mac uses `LOCAL_PEERCRED`** (2026-09-23 / not a single keystroke arrived on a real machine).
          ⚠️⚠️ It used to look only at Linux's `SO_PEERCRED`, so on mac it was **always `None`**
                = **it silently closed every connection**. The agent logs "sent as keystrokes" as soon as the write
                reaches the kernel, so **it looked like success while nothing showed on screen**
                (a consequence of not adding an ACK / see the note on `writeControl` in keys.ts).
          ⚠️ Use this number **only on mac** (on Linux `(0, 1)` is `IP_TOS` = reads something else).
    ⚠️ `SO_PEERCRED` is **a Linux-specific name**, so on mac `socket.SO_PEERCRED` raises
          `AttributeError`. `except OSError` alone lets it escape and **the relay dies**
          (= the running claude goes down with it). Catch `struct.error` likewise.
    """
    try:
        if sys.platform == "darwin":
            raw = conn.getsockopt(
                getattr(socket, "SOL_LOCAL", _SOL_LOCAL),
                getattr(socket, "LOCAL_PEERCRED", _LOCAL_PEERCRED),
                _XUCRED_SIZE,
            )
            return parse_xucred(raw)
        raw = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", raw)
        return uid
    except (OSError, AttributeError, struct.error):
        return None


def main() -> int:
    # ★★ **Do not drop `_NYAN_REMOTE_SHIM`** (policy changed on 2026-08-24).
    #
    # On 2026-08-23 it was dropped here (the boolean re-entry guard **misfired inside
    # sessions started through the relay**, so claude launched from there silently bypassed the relay).
    # ⚠️⚠️ But **dropping it makes loops come back forever**: shim → relay → another wrapper → shim → …
    #    each stage looks like "the first time", so the limit is never hit (measured: 9 of 12 combinations looped forever).
    # ⇒ The shim side became **a count** (no longer a boolean). With a count
    #    - claude inside a relayed session does not hit the limit, so it **properly goes through the relay**
    #    - loops stop after a few stages
    #    both hold. **Never remove it here.**
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--sock")
    ap.add_argument("-h", "--help", action="store_true")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    if args.help:
        sys.stderr.write(_t(__doc__ or "", _HELP_EN))
        return 0
    cmd = args.cmd[1:] if args.cmd and args.cmd[0] == "--" else args.cmd
    if not cmd:
        sys.stderr.write("usage: relay.py [--sock <path>] -- <command> ...\n")
        return 2

    # ★★ The fail-open branch. If this cannot be passed, **start directly** (never block the user's launch).
    #    - bypass is set                → direct
    #    - non-interactive (`claude -p`) → direct (a pty in between changes the output shape)
    #    - socket cannot be prepared    → direct
    plain = bool(os.environ.get("NYAN_REMOTE_NO_RELAY"))
    if not plain and not (os.isatty(STDIN) and os.isatty(STDOUT)):
        plain = True
    # ⚠️ Non-interactive (`-p` / `--print`) is also filtered by the shim, but pass it straight through **even when relay.py is called directly**
    #    (2026-08-23. A pty in between changes the output shape)
    if not plain and any(a in ("-p", "--print") for a in cmd[1:]):
        plain = True

    # ★★★ All the preparation below happens **inside a single fail-open boundary** (fixed 2026-08-23).
    #
    # ⚠️⚠️ `sock_path` computation, `RELAY_MAX_BUF` parsing and `tcgetattr` used to be **outside** the try,
    #    so a broken `XDG_RUNTIME_DIR` or a non-numeric value alone
    #    **produced a traceback and claude never started** (measured).
    #    And **even `NYAN_REMOTE_NO_RELAY=1` did not save it** (the bypass had lost its meaning).
    # ⇒ **If preparation fails, clean up and `exec` directly**. The relay sits in the daily path, so
    #    falling back to "keystrokes unavailable" is right, but falling back to "cannot start" is not.
    listener: socket.socket | None = None
    sock_path = ""
    saved: list | None = None
    ws = None
    max_buf = 4 * 1024 * 1024
    wake_r = wake_w = -1

    def _give_up(why: str) -> None:
        """Give up midway through preparation. Clean up what was created; the caller then execs directly."""
        nonlocal listener, sock_path, wake_r, wake_w
        log(_t(f"用意できなかったので素で起こす: {why}", f"could not prepare, starting directly: {why}"))
        if listener is not None:
            try:
                listener.close()
            except OSError:
                pass
            listener = None
        for fd in (wake_r, wake_w):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        wake_r = wake_w = -1
        if sock_path:
            try:
                os.unlink(sock_path)
            except OSError:
                pass
            sock_path = ""

    if not plain:
        try:
            max_buf = parse_max_buf(os.environ.get("RELAY_MAX_BUF"))
            sock_path = args.sock or default_socket_path(os.getpid())
            if os.path.exists(sock_path):
                os.unlink(sock_path)
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(sock_path)
            os.chmod(sock_path, 0o600)
            listener.listen(4)
            listener.setblocking(False)
            saved = termios.tcgetattr(STDIN)
            ws = get_winsize(STDOUT)
            wake_r, wake_w = os.pipe()
            os.set_blocking(wake_r, False)
            os.set_blocking(wake_w, False)
        except (OSError, ValueError) as e:
            _give_up(str(e))
            plain = True
    if plain or listener is None or saved is None:
        log(_t("素で exec する", "exec directly"))
        os.execvp(cmd[0], cmd)

    signal.set_wakeup_fd(wake_w)
    winch = {"pending": False}
    signal.signal(signal.SIGWINCH, lambda *_: winch.__setitem__("pending", True))
    # ★★ Catch termination signals (2026-08-23).
    #    ⚠️ Without it `finally` does not run and **the terminal is returned raw to the user's shell**
    #       (measured: `-icanon -echo` remained, and so did the socket and pane record = 42 orphans on a real machine).
    #    ⚠️ The handler **only sets a flag** (`set_wakeup_fd` wakes `select`).
    dying = {"sig": 0}

    def _die(signum: int, _frame: object) -> None:
        dying["sig"] = signum

    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT):
        try:
            signal.signal(sig, _die)
        except (OSError, ValueError):
            pass

    try:
        pid, master = pty.fork()
    except OSError as e:
        # ⚠️ Never fall back to "cannot start" here either (happens with process-count limits etc.)
        signal.set_wakeup_fd(-1)
        _give_up(f"pty を作れなかった: {e}")
        os.execvp(cmd[0], cmd)
    if pid == 0:
        # child: pty.fork already did setsid and the controlling terminal
        try:
            os.execvp(cmd[0], cmd)
        except OSError:
            os._exit(127)

    if ws:
        set_winsize(master, ws)
    os.set_blocking(master, False)
    # ★★ **Positive evidence that "the relay ran"** (2026-08-23 / A1).
    #    ⚠️⚠️ The install script's check was **negative**: "no 'exec directly' and the version is included",
    #       so **it showed ✅ even on a machine without any python3** (measured).
    #       The pass-through branch says nothing, so a negative check cannot tell them apart.
    #    ⇒ Announce only when passing here (does nothing without `RELAY_LOG` / `RELAY_DEBUG`).
    reg_path = ""

    conns: list[socket.socket] = []
    to_child = bytearray()
    to_screen = bytearray()
    child_gone = False
    # ★★ Backpressure (2026-08-23). **Do not read while things are piled up.**
    #
    # ⚠️ Without it, even when the terminal stops reading, we keep reading from the child and piling into the buffer
    #    (= behaves differently from plain claude, where the child blocks on write and stops naturally).
    #    RSS grew to 14MB when measured. In theory it keeps growing as long as the terminal is frozen.
    # ⇒ While over the limit, do not read the pty → the pty buffer fills → **the child blocks**.
    # ⚠️ Never discard (the screen would lose output). ⚠️ The limit is large enough to pass ordinary bulk output (a few MB).
    stalled = False
    child_stalled = False

    try:
        tty.setraw(STDIN)
        os.set_blocking(STDIN, False)
        # ★★ Register **only after setraw succeeds** (2026-08-23).
        #    ⚠️ With `claude &` (background start), `setraw` is **stopped by SIGTTOU**.
        #       Registering first leaves "visible as a keystroke target but not a single byte arrives", and
        #       the agent falsely logs "sent as keystrokes" (measured).
        reg_path = register(pid, sock_path)
        if reg_path:
            global _REJECT_PATH
            _REJECT_PATH = rejected_path_for(reg_path)
        # ★★ **"Started" alone is not evidence that keystrokes work** (review B5).
        #    If it cannot register in `panes/`, the agent cannot find it = keystrokes do not work.
        #    ⇒ Put the registration result on the same line (the install script looks at this).
        log(_t(f"起動した pid={pid} 名乗り={'あり' if reg_path else 'なし'}", f"started pid={pid} registered={'yes' if reg_path else 'no'}"))

        while True:
            # ★ If a termination signal was received, break out here into finally (always restore the terminal)
            if dying["sig"]:
                log(_t(f"シグナル {dying['sig']} で終了する", f"exiting on signal {dying['sig']}"))
                break
            # ★ Not putting the backed-up side in rset (= not reading it) is the backpressure itself
            # ⚠️ Hysteresis: **once applied, do not release until it drops to half**.
            #    Toggling on/off at the boundary makes select oscillate (measured: 2400 switches in 5 seconds)
            screen_full = len(to_screen) > max_buf // 2 if stalled else len(to_screen) >= max_buf
            child_full = len(to_child) > max_buf // 2 if child_stalled else len(to_child) >= max_buf
            if screen_full != stalled:
                stalled = screen_full
                log(_t(f"背圧 {'かけた' if screen_full else 'はずした'} 溜まり={len(to_screen)}バイト", f"backpressure {'on' if screen_full else 'off'} buffered={len(to_screen)}bytes"))
            child_stalled = child_full
            rset = [wake_r, listener.fileno()]
            if not screen_full:
                rset.append(master)
            if not child_full:
                rset.append(STDIN)
                rset.extend(c.fileno() for c in conns)
            wset = []
            if to_child:
                wset.append(master)
            if to_screen:
                wset.append(STDOUT)
            try:
                r, w, _ = select.select(rset, wset, [], 0.5)
            except (OSError, ValueError):
                break

            if winch["pending"]:
                winch["pending"] = False
                ws = get_winsize(STDOUT)
                if ws:
                    set_winsize(master, ws)

            if wake_r in r:
                try:
                    os.read(wake_r, 4096)
                except BlockingIOError:
                    pass

            # terminal → child
            if STDIN in r:
                try:
                    data = os.read(STDIN, 65536)
                except (BlockingIOError, OSError):
                    data = b""
                if data:
                    # ★★ Only Ctrl-Z (0x1a) is **not passed to the child** (found in practice on 2026-08-23).
                    #
                    # ⚠️⚠️ When Claude Code gets Ctrl-Z it **suspends itself**
                    #    (printing `Claude Code has been suspended. Run fg …`).
                    #    With a plain launch the shell comes to the foreground so `fg` resumes it, but
                    #    **through the relay the relay stays in the foreground**, so typing `fg`
                    #    only sends characters to the stopped child and **the window gets stuck** (confirmed on a real machine).
                    # ⇒ **Drop it as a no-op**. It just turns a broken feature into "nothing happens";
                    #    nothing is lost (better than getting stuck).
                    # ⚠️ **Do not touch termios here**. An implementation that follows the child's stop (the relay also
                    #    stops on SIGTSTP and SIGCONT wakes both)
                    #    would touch the one path where "the user's shell comes back broken",
                    #    and job control cannot be reproduced in automated tests. ⇒ **We decided not to do it**.
                    #    If it is ever done, set 3 rules first (refuse keystrokes while stopped / reapply the size on SIGCONT /
                    #    confirm 3 times on a real machine). Details in docs/VERIFY.md
                    if b"\x1a" in data:
                        data = data.replace(b"\x1a", b"")
                        log(_t("Ctrl-Z を落とした（リレー経由では使えない）", "dropped Ctrl-Z (not usable through the relay)"))
                    to_child += data

            # injection socket → child
            if listener.fileno() in r:
                try:
                    conn, _ = listener.accept()
                except OSError:
                    conn = None
                if conn is not None:
                    admit(conn, conns)
            for conn in list(conns):
                if child_full:
                    break  # ⚠️ do not accept while the child is not reading (do not pile up)
                if conn.fileno() in r:
                    try:
                        chunk = conn.recv(65536)
                    except BlockingIOError:
                        continue
                    except OSError:
                        chunk = b""
                    if chunk:
                        log(_t(f"注入 {len(chunk)} バイト", f"injected {len(chunk)} bytes"))
                        to_child += chunk
                    else:
                        conns.remove(conn)
                        conn.close()

            # child → screen
            if master in r:
                # ⚠️⚠️ **Do not read EAGAIN as "the child died"** (2026-08-23).
                #    It used to turn `BlockingIOError` into `data=b""` and then
                #    fall into "empty means child_gone", so **a single empty read ended
                #    the relay and the live claude died of SIGHUP**.
                #    On Linux a child's death arrives as EIO. A 0-byte read is also an end marker.
                data = None
                try:
                    data = os.read(master, 65536)
                except BlockingIOError:
                    pass  # just not arrived yet
                except OSError as e:
                    if e.errno in (errno.EIO, errno.EBADF):
                        child_gone = True
                    else:
                        raise
                if data:
                    to_screen += data
                elif data == b"":
                    child_gone = True

            # Writing out (⚠️ carry over partial writes. Discarding them loses screen output)
            if to_child and master in w:
                try:
                    n = os.write(master, bytes(to_child))
                    del to_child[:n]
                except BlockingIOError:
                    pass
                except OSError:
                    child_gone = True
            if to_screen and STDOUT in w:
                try:
                    n = os.write(STDOUT, bytes(to_screen))
                    del to_screen[:n]
                except BlockingIOError:
                    pass
                except OSError:
                    break

            if child_gone and not to_screen:
                break
    finally:
        # ⚠️ Leaking this **returns the user's shell broken** (echo disappears)
        try:
            termios.tcsetattr(STDIN, termios.TCSADRAIN, saved)
        except OSError:
            pass
        os.set_blocking(STDIN, True)
        signal.set_wakeup_fd(-1)
        for conn in conns:
            conn.close()
        listener.close()
        for path in (sock_path, reg_path, _REJECT_PATH):
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
        # ⚠️ A single write **may not write everything** (short writes / a stuck terminal).
        #    ⇒ Write as much as possible. ⚠️ But do not persist forever (about 2 seconds at most)
        deadline = time.monotonic() + 2.0
        while to_screen and time.monotonic() < deadline:
            try:
                select.select([], [STDOUT], [], 0.1)
                n = os.write(STDOUT, bytes(to_screen))
            except (OSError, ValueError):
                break
            if n <= 0:
                break
            del to_screen[:n]

    # ★★ **Close the master before `waitpid`** (2026-08-23).
    #    ⚠️ When breaking out early (an exception in select / a failed write to the screen), leaving the master
    #       open means the child gets neither EIO nor SIGHUP, **lives on, and waitpid never returns**
    #       (measured: the terminal stayed unresponsive with the foreground held). Closing it always ends the child.
    try:
        os.close(master)
    except OSError:
        pass
    try:
        _, status = os.waitpid(pid, 0)
    except (ChildProcessError, OSError):
        # ⚠️ Even if missed, do not make it look like "it could not start"
        return 128 + dying["sig"] if dying["sig"] else 0
    # ★ If it ended by a signal, reflect that in the exit code
    if dying["sig"]:
        return 128 + dying["sig"]
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


if __name__ == "__main__":
    sys.exit(main())
