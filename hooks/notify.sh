#!/usr/bin/env bash
# Claude Code notification hook — tagged with account / project identifiers
#
#   [.claude-v] tmux-agent — ターン終了  15:32 @pc-a      (example; the label itself is Japanese)
#
# Settings live in ~/.claude/notify.env (the webhook URL goes there, never in settings.json)
# The notification body never contains conversation content, prompts or code (identifiers and state only).
#
# Called by all three accounts (~/.claude, ~/.claude-r, ~/.claude-v).

set -uo pipefail

CONF="${CLAUDE_NOTIFY_ENV:-$HOME/.claude/notify.env}"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

payload=$(cat)

# NOTIFY_DEBUG=1 records the raw payload (to check field names in the field)
if [ "${NOTIFY_DEBUG:-0}" = "1" ]; then
  printf '%s\n' "$payload" >> "$HOME/.claude/notify-debug.jsonl"
fi

# --- Forward to the local nyan-remote (the Web Push sender) ---
# Pass the raw payload as-is. The agent decides the account and builds the body.
# The Discord notification below keeps running as well (both are used so a failure of one is noticed).
#
# Auth: the agent only listens on 127.0.0.1, but traffic via serve also arrives from loopback,
#       so IP cannot tell them apart. The shared token in ~/.nyan-remote/hook-token (600) does.
AGENT_URL="${NYAN_REMOTE_HOOK_URL:-http://127.0.0.1:7777/hook}"
TOKEN_FILE="${NYAN_REMOTE_TOKEN_FILE:-$HOME/.nyan-remote/hook-token}"
if [ -r "$TOKEN_FILE" ]; then
  curl -sS --max-time 5 \
    -H "Content-Type: application/json" \
    -H "X-Nyan-Remote-Token: $(cat "$TOKEN_FILE")" \
    -X POST -d "$payload" \
    "$AGENT_URL" >/dev/null 2>&1 || true
fi

j() { printf '%s' "$payload" | jq -r "$1 // empty" 2>/dev/null; }

event=$(j '.hook_event_name')
cwd=$(j '.cwd')
transcript=$(j '.transcript_path')

# --- Account detection ---
# transcript_path is the most reliable:
#   /home/user/.claude-v/projects/-home-user-x/<uuid>.jsonl  ->  .claude-v
account=""
case "$transcript" in
  "$HOME"/*)
    rest="${transcript#"$HOME"/}"
    account="${rest%%/*}"
    ;;
esac
# Fallback: environment variable -> default
if [ -z "$account" ]; then
  account="$(basename "${CLAUDE_CONFIG_DIR:-$HOME/.claude}")"
fi

project="$(basename "${cwd:-unknown}")"
host="${NOTIFY_HOST:-${HOSTNAME:-$(hostname 2>/dev/null || echo unknown)}}"
now="$(date +%H:%M)"

# ★★ The Discord text does not claim "done" (external review 2026-08-16, high #3).
#
#   `Stop` only means **Claude's turn ended**. If a background Bash (codex exec) or
#   a subagent is running, **the work is not finished**. That happened in practice.
#   ⚠️ This script **cannot read state** (it sends by itself the moment the hook fires).
#      The agent's Web Push waits 1.5 s and looks at state to pick "running in background / responding / done"
#      (agent/src/stopPush.ts), but here the only option is a neutral wording.
#   → Not asserting keeps it from contradicting the phone notification.
case "$event" in
  Stop)          label="ターン終了" ;;
  Notification)  label="通知" ;;
  StopFailure)   label="⚠ 異常終了" ;;
  SessionEnd)    label="終了" ;;
  *)             label="${event:-イベント}" ;;
esac

text="[$account] $project — $label  $now @$host"

# --- Resolve the destination: per account > default ---
#   .claude-v -> WEBHOOK_claude_v
key="WEBHOOK_$(printf '%s' "${account#.}" | tr '.-' '__')"
url="${!key:-${WEBHOOK_DEFAULT:-}}"
[ -z "$url" ] && exit 0

curl -sS --max-time 10 \
  -H "Content-Type: application/json" \
  -X POST \
  -d "$(jq -nc --arg c "$text" '{content:$c}')" \
  "$url" >/dev/null 2>&1

# Do not let a hook failure get in the way of the session
exit 0
