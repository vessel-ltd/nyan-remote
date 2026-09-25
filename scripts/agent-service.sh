#!/usr/bin/env bash
# Launcher to start the agent from systemd / launchd.
#
# ⚠️ Why not write `node agent/src/index.ts` directly:
#    the PATH of a systemd user service is minimal and includes neither nvm's node nor claude in ~/.local/bin.
#    - without node it does not start at all
#    - without claude, `claude agents --json` fails and the list stops showing "Working"
#      (/health's liveAvailable becomes false, which is how you notice)
#
# ⚠️ Writing node's absolute path into the unit breaks when nvm updates the version.
#    It is resolved here, so the unit only needs to point at this script.

set -euo pipefail

# ★ Language: NYAN_LANG > LC_ALL > LC_MESSAGES > LANG (`ja*` => Japanese, anything else => English)
#   (same rule as shared/i18n.ts `langFromEnv`)
case "${NYAN_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in
  [Jj][Aa]*) NYAN_L=ja ;;
  *) NYAN_L=en ;;
esac
tr2() { if [ "$NYAN_L" = ja ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

# So claude and other user commands can be found
# ⚠️ launchd's PATH on mac is only `/usr/bin:/bin:/usr/sbin:/sbin` ⇒ Homebrew's node
#    is not found (2026-09-23). Apple Silicon uses /opt/homebrew, Intel uses /usr/local.
export PATH="$HOME/.local/bin:$HOME/bin:$PATH:/opt/homebrew/bin:/usr/local/bin"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  # Pick the newest one under nvm.
  # ⚠️ The path is $HOME/.nvm/versions/node/<version>/bin/node (3 levels below the root).
  #    With find -maxdepth 2 it is not found (hit this for real).
  local dir="$HOME/.nvm/versions/node"
  if [ -d "$dir" ]; then
    local latest=""
    local candidate
    for candidate in $(printf '%s\n' "$dir"/*/bin/node | sort -V); do
      [ -x "$candidate" ] && latest="$candidate"
    done
    if [ -n "$latest" ]; then
      printf '%s' "$latest"
      return 0
    fi
  fi
  return 1
}

# ★ Prefer the absolute path passed at install time (AGENT_NODE).
# ⚠️ But **search again if it is not executable** (Homebrew / nvm updates can remove it.
#    exec'ing a vanished path makes launchd restart it every 5 seconds and **fail silently forever**).
NODE=""
if [ -n "${AGENT_NODE:-}" ]; then
  if [ -x "$AGENT_NODE" ]; then
    NODE="$AGENT_NODE"
  else
    echo "[agent-service] $(tr2 "AGENT_NODE=$AGENT_NODE は実行できません。探し直します" "AGENT_NODE=$AGENT_NODE is not executable; searching again")" >&2
  fi
fi
[ -n "$NODE" ] || NODE="$(find_node || true)"
if [ -z "$NODE" ]; then
  echo "[agent-service] $(tr2 "node が見つかりません。AGENT_NODE で絶対パスを指定してください" "node not found. Set AGENT_NODE to its absolute path")" >&2
  exit 1
fi

# Also put node's directory on PATH (in case child processes call node)
export PATH="$(dirname "$NODE"):$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ⚠️ Never set NYAN_REMOTE_DEV in production (it allows access without identity headers)
unset NYAN_REMOTE_DEV

echo "[agent-service] node=$NODE"
echo "[agent-service] claude=$(command -v claude || tr2 '見つかりません（一覧の応答中が出なくなります）' 'not found (the list will not show "Working")')"

exec "$NODE" "$ROOT/agent/src/index.ts"
