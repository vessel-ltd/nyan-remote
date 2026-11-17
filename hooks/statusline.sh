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
#   - Only a reading with `rate_limits` is kept (the first calls of a session have none and must not wipe the last one).
#   - The file is written to a new temporary name with noclobber and renamed into place (never written through an
#     existing name: a link, a FIFO or a hard link there cannot redirect or block the write).

IFS= read -r -d '' input || :

if [[ $input == *'"rate_limits"'* ]]; then
  (
    umask 077
    set -C
    dir=${NYAN_REMOTE_STATE_DIR:-$HOME/.nyan-remote}/usage
    name=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
    name=${name%/}
    name=${name##*/}
    # ⚠️ Only into our own directory (made by the installer, 0700), never through a link
    [[ $name =~ ^\.claude(-[A-Za-z0-9._-]+)?$ && -d $dir && ! -L $dir && -O $dir ]] || exit 0
    tmp=$dir/.claude-$name.$$.$RANDOM.tmp
    printf '%s' "$input" >"$tmp" || {
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
