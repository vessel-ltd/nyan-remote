#!/bin/bash
# Status line relay — keep the plan limits Claude Code hands to the status line, then show the user's own status line.
#
# ★ Why (2026-11-17 / agent/src/usage.ts): Claude Code gives the status line command `rate_limits` (5-hour and weekly
#   use, with their resets) after each API response — the one documented place these numbers reach this machine.
# ★ Installed by `scripts/install-permission-hook.mjs` **only in front of a status line the user already has**:
#     "command": "'<this file>' --nyan-remote-relay '<the user's command>'"
#   ⇒ What the user sees does not change: the same input bytes go to their command, and its output is what Claude shows.
#   ⚠️ Never installed where there is no status line (an empty one still takes a row on screen).
#   ⚠️ `--nyan-remote-relay` is how the installer knows the entry is ours (a file name alone is not: codex review).
#
# ⚠️⚠️ This runs in Claude Code's render path. Rules:
#   - Never call the agent or the network. Write one file and go on.
#   - Never let our part fail or change the status line: our part runs in a subshell (its umask and failures stay
#     there), and the user's command runs with the environment and stdin bytes it would get without us.
#   - Only a reading with `rate_limits` is kept as the profile's (the first calls of a session have none and must not
#     wipe the last one).
#   - ★ Each session's latest input is also kept as `session-<session id>.json` (2026-11-17: its model, effort and
#     context use for the session list). The agent reads only those fields, checks the id inside, and removes the
#     files of sessions that ended.
#   - The file is written to a new temporary name with noclobber and renamed into place (never written through an
#     existing name: a link, a FIFO or a hard link there cannot redirect or block the write).

IFS= read -r -d '' input || :

if [[ $input == *'"rate_limits"'* || $input == *'"session_id"'* ]]; then
  (
    umask 077
    set -C
    dir=${NYAN_REMOTE_STATE_DIR:-$HOME/.nyan-remote}/usage
    name=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
    name=${name%/}
    name=${name##*/}
    # ⚠️ Only into our own directory (made by the installer, 0700), never through a link
    [[ $name =~ ^\.claude(-[A-Za-z0-9._-]+)?$ && -d $dir && ! -L $dir && -O $dir ]] || exit 0
    # ★ The session's own copy (any input with a session id). ⚠️ The id goes into a file name ⇒ a UUID only.
    # ⚠️ Only the **first key of the object** (Claude Code 2.1.326 writes it first): a `session_id` nested further on
    #    must not name the file (codex review). Another layout ⇒ no copy (the list falls back to the transcript).
    re=$'^[[:space:]]*\\{[[:space:]]*"session_id"[[:space:]]*:[[:space:]]*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"'
    if [[ $input =~ $re ]]; then
      sid=${BASH_REMATCH[1]}
      tmp=$dir/.session-$sid.$$.$RANDOM.tmp
      if printf '%s' "$input" >"$tmp"; then
        mv -f -- "$tmp" "$dir/session-$sid.json" || rm -f -- "$tmp"
      else
        rm -f -- "$tmp"
      fi
    fi
    [[ $input == *'"rate_limits"'* ]] || exit 0
    # ★ Which account this reading is, read **now** from the config this session uses (codex review: a time comparison
    #   in the agent could not prove it, and the default profile's config is `~/.claude.json`, not `~/.claude/.claude.json`).
    # ⚠️ Only the **top-level** `oauthAccount` (Claude Code 2.1.326 writes the file with 2-space indentation, so a
    #    top-level key is the only one at exactly two spaces after a newline; a nested copy is deeper, and a newline
    #    cannot appear inside a JSON string), and only when `accountUuid` is its first key. Anything else ⇒ no account
    #    (the reading is shown under its profile alone, never merged into a wrong account).
    # ⚠️ At most 1 MB is read (render path: ~5 ms for the usual 200 KB). A bigger config ⇒ maybe no account.
    # ⚠️ Not a JSON parser: a config the user rewrote by hand in another layout could fool it (Claude Code itself always
    #    writes this layout). Accepted: the worst case is one profile's numbers shown under another account's row.
    cfg=${CLAUDE_CONFIG_DIR:+${CLAUDE_CONFIG_DIR%/}/.claude.json}
    cfg=${cfg:-$HOME/.claude.json}
    acct=
    if [[ -f $cfg ]]; then
      conf=
      # ⚠️ Bytes are capped before bash sees them (`read -N` counts characters and skips NULs / codex review round 5);
      #    a NUL ends the read early (no account, never a wrong one)
      IFS= read -r -d '' conf < <(head -c 1048576 -- "$cfg" 2>/dev/null) || :
      re=$'\n  "oauthAccount": \\{\n    "accountUuid": "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"'
      [[ $conf =~ $re ]] && acct=${BASH_REMATCH[1]}
    fi
    tmp=$dir/.claude-$name.$$.$RANDOM.tmp
    printf '{"nyanAccount":"%s","input":%s}' "$acct" "$input" >"$tmp" || {
      rm -f -- "$tmp"
      exit 0
    }
    mv -f -- "$tmp" "$dir/claude-$name.json" || rm -f -- "$tmp"
  ) 2>/dev/null
fi

[[ ${1:-} == --nyan-remote-relay ]] && shift

# The user's own status line, exactly as before (Claude Code runs it through a shell, so do we)
if [[ -n ${1:-} ]]; then
  # ⚠️ A command that does not read its input ends the pipe early: that is not an error of ours to print
  exec bash -c "$1" < <(printf '%s' "$input" 2>/dev/null)
fi
exit 0
