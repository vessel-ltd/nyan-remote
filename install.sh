#!/usr/bin/env bash
# ★★ Install nyan-remote on one machine (distribution for ③ / 2026-09-20).
#
#   curl -fsSL https://<distribution origin>/install.sh | bash
#
# ★ The user's machine needs **only Node 24 or later**.
#   ⚠️ No npm, git or vite needed (the tarball bundles the built PWA and
#      the 18 runtime dependencies / `scripts/pack.mjs`).
# ⚠️⚠️ **Never asks for `sudo`.**
#
# ⚠️⚠️ **Stops when something breaks** (lesson of 2026-09-19: when steps were handed over as a list, one broken line
#    was silently skipped and "it looked like it succeeded"). ⇒ `set -euo pipefail`.
#
# What can be changed (environment variables):
#   NYAN_REMOTE_TARBALL=<path|url>   where to fetch from (★ default is the official one; use this for local testing)
#   NYAN_REMOTE_HOME=<dir>           where to install (default ~/nyan-remote)
#   NYAN_REMOTE_UPDATE=1             ★ **update an existing install** (refused by default)
#   NYAN_REMOTE_NO_SERVICE=1         do not run as a service (★ for testing with a throwaway HOME.
#                                    ⚠️ systemd looks at **the real ~/.config**, so
#                                    it always fails with a fake HOME = that part cannot be tested)
set -euo pipefail

# ★★★★ Language of the messages (2026-09-24): NYAN_LANG > LC_ALL > LC_MESSAGES > LANG (the first non-empty one).
#   `ja*` => Japanese, anything else (unset / C) => English (same rule as shared/i18n.ts `langFromEnv`).
case "${NYAN_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in
  [Jj][Aa]*) NYAN_L=ja ;;
  *) NYAN_L=en ;;
esac
tr2() { if [ "$NYAN_L" = ja ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

TARBALL="${NYAN_REMOTE_TARBALL:-https://app.nyan-remote.app/nyan-remote.tar.gz}"
HOME_DIR="${NYAN_REMOTE_HOME:-$HOME/nyan-remote}"
STATE_DIR="${NYAN_REMOTE_STATE_DIR:-$HOME/.nyan-remote}"
UNIT="nyan-remote"

say() { printf '▸ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ★★★ **If the current directory is gone, move to home** (2026-09-24 / seen in practice on machine C).
#   ⚠️⚠️ An update moves the tree to `.old-<timestamp>`, so a shell opened **inside the tree** is left in a deleted directory.
#      Running the next update from there made Node fail on `process.cwd()` and stop with **the wrong reason**, "could not check the old state".
#   ⚠️ Does nothing when it still exists (never changes the meaning of values passed as relative paths).
pwd -P >/dev/null 2>&1 || cd "$HOME" || cd /

# ★★ Resolve paths to **the real path** (follow symlinks, fix `//` and trailing `/` / codex round 16, high #1).
#   A path that does not exist yet becomes "the real path of the deepest existing parent + the rest" (on first install neither state nor tree exists).
#   ⚠️ No `realpath` (old macs lack it). ⚠️ Returns 1 on failure (the caller stops and removes nothing).
phys() {
  local p="$1" rest="" base
  while [ -n "$p" ] && [ "$p" != "/" ] && [ ! -d "$p" ]; do
    rest="/$(basename "$p")$rest"
    p="$(dirname "$p")"
  done
  [ -n "$p" ] || p=/
  base="$(cd "$p" 2>/dev/null && pwd -P)" || return 1
  [ "$base" = "/" ] && base=""
  [ -n "$base$rest" ] || { printf '/'; return 0; }
  printf '%s%s' "$base" "$rest"
}

# ── ① Preflight (⚠️ only stop here for things that would otherwise break silently later) ─────────
command -v node >/dev/null 2>&1 || die "$(tr2 'Node が見つかりません（24 以上が要ります）' 'Node not found (version 24 or later is required)')"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || die "$(tr2 "Node $NODE_MAJOR は古すぎます（24 以上が要ります。TypeScript を直接 実行します）" "Node $NODE_MAJOR is too old (24 or later is required; it runs TypeScript directly)")"

# ★★ **Separate "does it run on this OS" from "how is it kept running"** (2026-09-21).
#   ⚠️ It used to reject Darwin unconditionally, but **only the service (launchd) was missing**, so
#      skipping the service let us try it on mac (= measure the other parts first).
#   ⚠️⚠️ **Never install half-way silently**: arriving on mac with the service enabled is **refused**.
# ★★ 2026-09-23: mac runs as a **launchd** service (`scripts/launchd.mjs`).
#   ⚠️ The service type is held in a single `SVC` (systemd / launchd / empty = no service).
#      ⚠️⚠️ Do not add places that branch on the OS = **branches look only at `SVC`**.
SERVICE=1
[ "${NYAN_REMOTE_NO_SERVICE:-}" = "1" ] && SERVICE=
SVC=
case "$(uname -s)" in
  Linux)
    [ -z "$SERVICE" ] || SVC=systemd
    ;;
  Darwin)
    [ -z "$SERVICE" ] || SVC=launchd
    [ -n "$SERVICE" ] || say "$(tr2 '⚠️ mac です。常駐させないので、agent は自分で起動してください（下に出します）' '⚠️ This is a Mac and no background service will be set up, so start the agent yourself (shown below)')"
    ;;
  *) die "$(tr2 "未対応の OS です: $(uname -s)" "Unsupported OS: $(uname -s)")" ;;
esac
# ⚠️ Require the service tools **only when running as a service** (do not block a trial run)
case "$SVC" in
  systemd)
    command -v systemctl >/dev/null 2>&1 ||
      die "$(tr2 'systemd が見つかりません（常駐に使います。無しで試すなら NYAN_REMOTE_NO_SERVICE=1）' 'systemd not found (used to run in the background; to try without it, set NYAN_REMOTE_NO_SERVICE=1)')"
    ;;
  launchd)
    command -v launchctl >/dev/null 2>&1 ||
      die "$(tr2 'launchctl が見つかりません（常駐に使います。無しで試すなら NYAN_REMOTE_NO_SERVICE=1）' 'launchctl not found (used to run in the background; to try without it, set NYAN_REMOTE_NO_SERVICE=1)')"
    ;;
esac
# ★ "How to read the logs" per service type (⚠️ never print instructions that cannot run / same wording as scripts/lib/service.mjs)
case "$SVC" in
  launchd) LOG_HINT="tail -n 30 ~/Library/Logs/nyan-remote/agent.log" ;;
  *) LOG_HINT="journalctl --user -u $UNIT -n 30" ;;
esac

# ★★ **The update path** (2026-09-21 / we got stuck in practice).
#
# ⚠️⚠️ The installed tree has no `.git` (it is just an extracted tarball), so **`git pull` does not work**.
#    And this used to stop unconditionally here, so **people who installed had no way at all to update**
#    = a clear hole in the distribution.
# ⚠️ But **never overwrite silently**. Requires `NYAN_REMOTE_UPDATE=1` (= never delete by accident).
UPDATING=
if [ -e "$HOME_DIR" ]; then
  [ "${NYAN_REMOTE_UPDATE:-}" = "1" ] ||
    die "$(tr2 "$HOME_DIR が既に在ります（更新するなら NYAN_REMOTE_UPDATE=1 を付けてください）" "$HOME_DIR already exists (to update it, set NYAN_REMOTE_UPDATE=1)")"
  # ⚠️⚠️ **Confirm it is a nyan-remote install before** touching it (never break some other directory)
  [ -f "$HOME_DIR/RELEASE" ] && [ -f "$HOME_DIR/agent/src/index.ts" ] ||
    die "$(tr2 "$HOME_DIR は nyan-remote の導入に見えません（RELEASE と agent/src/index.ts がありません）" "$HOME_DIR does not look like a nyan-remote install (RELEASE and agent/src/index.ts are missing)")"
  UPDATING=1
fi

# ★★ **The state directory must not be inside the tree** (2026-09-21 / codex medium #3).
#
# ⚠️⚠️ Updates `mv` the whole tree, so if `$STATE_DIR` is under `$HOME_DIR`
#    **the keys and subscriptions get moved away too** (= they look gone from the new tree,
#    and removing `.old-*` as instructed **loses the recovery source too**).
# ⚠️ "Never touch the state" **only holds when the locations are separate**, so check it here.
#
# ★★ **Compare real paths** (2026-09-23 / codex round 16, high #1). ⚠️⚠️ A plain string prefix match
#   missed "inside" for paths containing `//` or symlinks (⇒ cleaning up the backups could remove the keys too).
#   ⚠️ If it cannot be resolved to a real path, **stop** (never treat something unverifiable as "unrelated" / fail-closed).
STATE_PHYS="$(phys "$STATE_DIR")" || die "$(tr2 "状態ディレクトリ $STATE_DIR の実体を確かめられません" "Could not resolve the real path of the state directory $STATE_DIR")"
HOME_PHYS="$(phys "$HOME_DIR")" || die "$(tr2 "$HOME_DIR の実体を確かめられません" "Could not resolve the real path of $HOME_DIR")"
case "$STATE_PHYS/" in
  "$HOME_PHYS"/*) die "$(tr2 "状態ディレクトリ $STATE_DIR が $HOME_DIR の中にあります（更新で一緒に動くので、外に出してください）" "The state directory $STATE_DIR is inside $HOME_DIR (it would be moved along on update; move it outside)")" ;;
esac
case "$HOME_PHYS/" in
  "$STATE_PHYS"/*) die "$(tr2 "$HOME_DIR が状態ディレクトリ $STATE_DIR の中にあります（入れ替えで状態を壊します）" "$HOME_DIR is inside the state directory $STATE_DIR (replacing it would break the state)")" ;;
esac

# ── ② Fetch and extract ─────────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "$(tr2 "取得します: $TARBALL" "Downloading: $TARBALL")"
if [ -f "$TARBALL" ]; then
  cp "$TARBALL" "$TMP/n.tar.gz"
else
  command -v curl >/dev/null 2>&1 || die "$(tr2 'curl が見つかりません' 'curl not found')"
  curl -fsSL "$TARBALL" -o "$TMP/n.tar.gz" || die "$(tr2 "取得できませんでした: $TARBALL" "Download failed: $TARBALL")"
fi
tar xzf "$TMP/n.tar.gz" -C "$TMP" || die "$(tr2 '展開できませんでした（壊れた tarball？）' 'Could not extract (broken tarball?)')"
[ -d "$TMP/nyan-remote" ] || die "$(tr2 'tarball の中身が想定と違います' 'The tarball does not contain what was expected')"
[ -f "$TMP/nyan-remote/web/dist/index.html" ] || die "$(tr2 'PWA のビルドが入っていません' 'The tarball has no PWA build')"

# ⚠️⚠️ **If state under the old name remains, stop before installing** (the 2026-09-19 rename / CLAUDE.md §0).
#    Recreating it **irrecoverably loses** `vapid.json` (subscriptions) and `device-key.json` (pairings).
#
# ★★ **The check calls the same implementation as the agent** (`legacyStateProblem()`).
#   ⚠️⚠️ Do not write the old name here again. That would make **two places to fix**, and
#      add **one more range outside** the `rename.test.ts` guard (= one more hiding place).
#   ★ Called from the freshly extracted tree (not yet placed in $HOME_DIR = never half-installed).
LEGACY="$(NYAN_SRC="$TMP/nyan-remote" node --input-type=module -e \
  'const m = await import(process.env.NYAN_SRC + "/agent/src/state.ts"); process.stdout.write((await m.legacyStateProblem()) ?? "")')" \
  || die "$(tr2 '古い状態を確認できませんでした（Node が TypeScript を直接 実行できていない？）' 'Could not check for old state (is Node unable to run TypeScript directly?)')"
[ -z "$LEGACY" ] || die "$LEGACY"

# ★★ **Never touch the state directory (`~/.nyan-remote`) at all.**
#   ⚠️⚠️ It holds `vapid.json` (subscriptions) and `device-key.json` (pairings), and
#      recreating them is **irrecoverable** (CLAUDE.md §0). ⇒ Only **the tree** is swapped.
if [ -n "$UPDATING" ]; then
  # ★★ **Check pending approvals before stopping** (2026-09-23).
  #   ⚠️⚠️ Stopping the agent makes pending approvals **unanswerable from the phone** (the hook connections die).
  #      The git one-liner (`git pull && npm run pending && …`) had this guard,
  #      but **this update path did not** = on machines installed via install.sh (machine C) it was skipped every time.
  #   ★ Ask **the agent running now** with `pending.mjs` from **the newly extracted tree**.
  #   ⚠️ Exit codes: 0 none / 1 **pending** / 2 agent is stopped / 3 could not check (pending.mjs's contract)
  #   ⚠️ Do not stop on 3: old agents do not allow the hook token, so stopping would mean **old machines can never update**.
  #      ⇒ Say so and proceed (same as before = no worse).
  if [ -n "$SERVICE" ]; then
    rc=0
    NYAN_REMOTE_STATE_DIR="$STATE_DIR" node "$TMP/nyan-remote/scripts/pending.mjs" || rc=$?
    case "$rc" in
      0 | 2) ;;
      1) die "$(tr2 '承認待ちがあります。先に答えてから、もう一度 実行してください（止めると答えられなくなります）' 'There are pending approvals. Answer them first, then run this again (stopping the agent would make them unanswerable)')" ;;
      *) say "$(tr2 '⚠️ 承認待ちを確かめられませんでした（古い agent かもしれません）。そのまま進みます' '⚠️ Could not check for pending approvals (maybe an old agent). Continuing')" ;;
    esac
  fi
  # ⚠️ Never swap the tree while it is running (files being read would disappear)
  # ⚠️ Stop launchd with the **new tree's** launchd.mjs (the old tree may not have it. The label is a constant)
  case "$SVC" in
    systemd) systemctl --user stop "$UNIT" 2>/dev/null || true ;;
    # ⚠️⚠️ **Do not proceed unless it has fully stopped** (codex round 15, medium #3. Never swap the tree while it runs)
    launchd) node "$TMP/nyan-remote/scripts/launchd.mjs" stop ||
      die "$(tr2 "古い agent を止められませんでした（見てください: ${LOG_HINT}）" "Could not stop the old agent (see: ${LOG_HINT})")" ;;
  esac
  # ★ The old tree is **moved aside, not deleted** (⚠️ keep a way back)
  OLD="$HOME_DIR.old-$(date +%Y%m%d-%H%M%S)"
  mv "$HOME_DIR" "$OLD"
  mv "$TMP/nyan-remote" "$HOME_DIR"
  VER="$(head -1 "$HOME_DIR/RELEASE" 2>/dev/null || tr2 '不明' 'unknown')"
  say "$(tr2 "更新しました: ${HOME_DIR}（版 ${VER}）" "Updated: ${HOME_DIR} (version ${VER})")"
  say "$(tr2 "前の版は ${OLD} に置いてあります（次に更新すると自動で消えます。戻すときはこれを使います）" "The previous version is kept at ${OLD} (removed automatically on the next update; use it to roll back)")"
else
  mv "$TMP/nyan-remote" "$HOME_DIR"
  VER="$(head -1 "$HOME_DIR/RELEASE" 2>/dev/null || tr2 '不明' 'unknown')"
  say "$(tr2 "入れました: ${HOME_DIR}（版 ${VER}）" "Installed: ${HOME_DIR} (version ${VER})")"
fi


# ── ③ Service (⚠️ no sudo) ────────────────────────────────────────────
# ⚠️ Without this, it stops when the shell is closed
if [ "$SVC" = systemd ]; then
  loginctl enable-linger "$USER" >/dev/null 2>&1 ||
    printf '%s\n' "$(tr2 "⚠️ linger を有効にできませんでした（端末を閉じると止まります。\`loginctl enable-linger ${USER}\`）" "⚠️ Could not enable linger (the agent stops when you close the terminal; run \`loginctl enable-linger ${USER}\`)")"
fi

# ★★ **Write the unit only when running as a service** (2026-09-21 / noticed on a real mac).
#   ⚠️⚠️ It used to sit **outside** `if [ -n "$SERVICE" ]`, so **even on mac it wrote a systemd unit**
#      (creating `~/.config/systemd/user/` along the way) = placing something unused.
#
# ★★ **Never write backquotes inside the heredoc** (same day / showed up on a real mac).
#   ⚠️⚠️ `<<UNITFILE2` is **unquoted**, so the body undergoes not only variable expansion but
#      **command substitution too**. ⇒ backquotes like `[Unit]` written in comments inside it
#      **were executed**, printing `[Unit]: command not found` 3 times.
#      ⚠️ **Not mac-specific. The same happened on Linux** (we had skimmed past the output).
#   ⚠️ It cannot be quoted (`<<'"'"'UNITFILE2'"'"'`) — `$STATE_DIR` and `$HOME_DIR` must expand.
#   ⇒ **Keep comments outside the heredoc** (the unit file itself also reads better).
#
# ⚠️⚠️ `StartLimitIntervalSec` is **a [Unit] key** (measured 2026-09-20: placed in [Service],
#    systemd drops it with "Unknown key … ignoring" = the default "5 times in 10 seconds" applies,
#    and after repeated crashes it gives up and silently stays down).
#
# ★★ **Make the location we checked and the one the agent actually uses the same value** (2026-09-21 / codex medium #2).
#   ⚠️⚠️ Without it, the installer looks at STATE_DIR while the agent uses the default (~/.nyan-remote)
#      = keys and registrations are recreated, and every registered device stops connecting.
#   ⚠️ Shell environment variables are not passed to processes started by systemctl.
if [ "$SVC" = systemd ]; then
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/$UNIT.service" <<UNITFILE2
[Unit]
Description=nyan-remote
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
Environment=NYAN_REMOTE_STATE_DIR=$STATE_DIR
WorkingDirectory=$HOME_DIR
ExecStart=$HOME_DIR/scripts/agent-service.sh
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNITFILE2
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT"
  say "$(tr2 "常駐させました: $UNIT.service" "Running as a background service: $UNIT.service")"
elif [ "$SVC" = launchd ]; then
  # ★★ The plist is built in Node (⚠️ never in a heredoc = the hole hit with the unit above / tests check the contents)
  # ⚠️⚠️ **Pass node's absolute path** (launchd's PATH has no Homebrew = it does not start without it)
  # ⚠️ Pass the state directory too (same reason as the unit's Environment=)
  node "$HOME_DIR/scripts/launchd.mjs" install \
    --home-dir "$HOME_DIR" --state-dir "$STATE_DIR" --node "$(command -v node)" ||
    die "$(tr2 "launchd に常駐させられませんでした（見てください: ${LOG_HINT}）" "Could not set up the launchd service (see: ${LOG_HINT})")"
  # ⚠️ A mac LaunchAgent runs **only while logged in** (there is no equivalent of linger)
  say "$(tr2 '⚠️ mac はログインしている間だけ動きます（画面のロックでは止まりません。ログアウトで止まります）' '⚠️ On a Mac it runs only while you are logged in (locking the screen does not stop it; logging out does)')"
else
  say "$(tr2 '常駐は飛ばしました（NYAN_REMOTE_NO_SERVICE=1）' 'Skipped the background service (NYAN_REMOTE_NO_SERVICE=1)')"
fi

# ── ④ Install the hooks (⚠️ once per machine. git pull does not install them) ──────────────
#
# ⚠️⚠️ **Wait until the agent has started once.** `install-permission-hook.mjs` reads
#    `$STATE_DIR/hook-token` (created by the agent), so right after starting the service **it is a race**
#    (hit for real with a throwaway HOME on 2026-09-20).
wait_state() {
  local i=0
  while [ ! -f "$STATE_DIR/hook-token" ]; do
    i=$((i + 1))
    [ "$i" -gt 30 ] && return 1
    sleep 1
  done
  return 0
}

# ★★ **Place `notify.sh` first** (order changed on 2026-09-21).
#
# ⚠️⚠️ `install-permission-hook.mjs` wires Stop / StopFailure / Notification **only when `~/.claude/hooks/notify.sh` exists**
#    (fail-closed).
#    ⇒ **Placing it afterwards means nothing is wired** = **no notifications at all**. Exactly the shape we hit in practice.
# ⚠️⚠️ **Installed as a copy** (`notify.sh` sends a header name, so if only one side is old every notification drops)
# ★★ Reinstall it only when it equals **one of the versions we shipped** (if modified, leave it and say so / codex round 23, high #1).
#    ⚠️ Handling when `~/.claude` is missing or it is a link also lives in one place, `install-notify.mjs`
node "$HOME_DIR/scripts/install-notify.mjs"

if [ -z "$SERVICE" ]; then
  say "$(tr2 'フックの設置は飛ばしました（agent を動かしていないため）' 'Skipped installing the hooks (the agent is not running)')"
  # ⚠️⚠️ **Ending here gives "installed but no notifications or approvals"** (2026-09-21 / a real mac).
  #    Without a service, the hooks must be installed **by yourself** after starting the agent.
  say "$(tr2 '⚠️ agent を起こしたあとに、もう一度だけこれを実行してください:' '⚠️ After starting the agent, run this once:')"
  printf '   cd %s && node scripts/install-permission-hook.mjs && node scripts/install-relay.mjs\n' "$HOME_DIR"
else
  wait_state || die "$(tr2 "agent が起動していません（見てください: ${LOG_HINT}）" "The agent did not start (see: ${LOG_HINT})")"
  node "$HOME_DIR/scripts/install-permission-hook.mjs"
  node "$HOME_DIR/scripts/install-relay.mjs"
fi

# ── Cleanup: keep **only the most recent** update backup (2026-09-23 / user decision) ─────────
# ⚠️ Each update used to add another `.old-<timestamp>`, and **the only way to remove them was by hand** (they piled up in the user's home).
# ★ Reaching here = the update went all the way through. ⇒ Keep only this run's backup (`$OLD`) and remove **older backups**.
#   ⚠️ If it fails midway it never gets here = all backups stay (never reduce the ways back).
# ⚠️⚠️ Remove only things "shaped `$HOME_DIR.old-<digits>`" that "look like a nyan-remote tree"
#    (`agent/src/index.ts` exists). ⚠️ If the state directory is inside one, **leave it** (never create something irrecoverable).
if [ -n "$UPDATING" ]; then
  # ⚠️⚠️ **Compare real paths** (codex round 16, high #1). ⚠️ If any real path is unknown, **remove nothing**.
  if SP="$(phys "$STATE_DIR")" && HP="$(phys "$HOME_DIR")" && OP="$(phys "$OLD")"; then
    for d in "$HOME_DIR".old-*; do
      [ -d "$d" ] || continue
      # ★ A linked backup is stopped below by "is its real path the current tree or this run's backup" (`rm -rf` removes only the link itself)
      case "$d" in "$HOME_DIR".old-[0-9]*) ;; *) continue ;; esac
      [ -f "$d/agent/src/index.ts" ] || continue
      DP="$(phys "$d")" || continue
      # ★ Never remove the current tree or this run's backup itself (even under another name)
      [ "$DP" = "$HP" ] && continue
      [ "$DP" = "$OP" ] && continue
      # ⚠️⚠️ If the state directory is inside it, leave it (never create something irrecoverable)
      case "$SP/" in "$DP"/*) continue ;; esac
      rm -rf -- "$d" && say "$(tr2 "古い退避を消しました: ${d}" "Removed an old backup: ${d}")"
    done
  else
    say "$(tr2 '⚠️ パスの実体を確かめられなかったので、古い退避は消しませんでした' '⚠️ Could not resolve the real paths, so old backups were not removed')"
  fi
fi

# ── ⑤ Register one phone (⚠️ no QR here) ──────────────────────
# ★★ **Do not show a QR at the end of the install** (2026-09-23 / user decision).
#   ⚠️ Every update showed a QR (and on mac an image window) = a nuisance every time for people already registered,
#      and the issued one-time token stayed **alive for 5 minutes**.
#   ⇒ Only print instructions. People who want to register type `npm run pair` themselves (it exits once scanned).
printf '\n%s\n\n' "$(tr2 '✅ 入りました。' '✅ Installed.')"
# ★ Our hosted relay (the default) requires sign-in since 2026-09-25 ⇒ say it before pairing (Tailscale / your own relay do not need it)
printf '%s\n' "$(tr2 '★ こちらの relay（既定）を使うなら、先にログイン（新しいシェルで）: nyan login' '★ Using our hosted relay (the default)? Sign in first (in a new shell): nyan login')"
printf '%s\n' "$(tr2 '   （Tailscale や自分の relay で使うなら不要。README の「Hosting the relay」）' '   (Not needed with Tailscale or your own relay — see "Hosting the relay" in the README)')"
# ★ 2026-09-24: point to `nyan`, which works from anywhere (`scripts/lib/cli.mjs`; from a new shell).
#   ⚠️ For machines where `nyan` could not be placed (another tool uses the name), also list the form with the path
if [ -z "$SERVICE" ]; then
  printf '%s\n' "$(tr2 '★ スマホを登録するには、agent を起こしてから（新しいシェルで）: nyan pair' '★ To register a phone, start the agent, then (in a new shell): nyan pair')"
else
  printf '%s\n' "$(tr2 '★ スマホを登録するには（新しいシェルで）: nyan pair' '★ To register a phone (in a new shell): nyan pair')"
fi
printf '%s\n' "$(tr2 "   （nyan が使えないときは: cd ${HOME_DIR} && npm run pair）" "   (if nyan is not available: cd ${HOME_DIR} && npm run pair)")"
printf '%s\n' "$(tr2 '★ 更新は: nyan update ／ 様子は: nyan status' '★ To update: nyan update / status: nyan status')"
# ⚠️ mac uses zsh (`install-relay.mjs` also detects zsh and writes `.zshrc`), so
#    saying `exec bash` would be **an instruction that cannot run** ⇒ print the shell in use.
SH_NAME="$(basename "${SHELL:-sh}")"
printf '\n%s\n' "$(tr2 "⚠️ 打鍵の経路は**新しいシェル**から有効になります（exec ${SH_NAME}）。" "⚠️ Typing from the phone works from a **new shell** (exec ${SH_NAME}).")"

# ★ Without a service, print how to start it (⚠️ otherwise it becomes "installed but nothing happens")
if [ -z "$SERVICE" ]; then
  printf '\n%s\n' "$(tr2 '⚠️ 常駐させていないので、agent は自分で起動してください:' '⚠️ No background service was set up, so start the agent yourself:')"
  printf '   cd %s && npm start\n' "$HOME_DIR"
  printf '%s\n' "$(tr2 '   （止めるのは Ctrl-C。⚠️ 閉じると通知も承認も止まります）' '   (Stop it with Ctrl-C. ⚠️ Closing it stops notifications and approvals)')"
fi

# ★ From the second machine on, **nothing extra is needed** (changed to 1:1 on 2026-09-21).
#   ⚠️⚠️ This used to say "copy vapid.json from the first machine".
#      Now the phone holds **a separate subscription per machine**, so the keys need not match
#      (one subscription per Service Worker registration (scope) / HANDOFF 5.0-bt).
