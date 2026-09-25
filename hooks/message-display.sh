#!/bin/bash
# MessageDisplay hook — intercept "text not yet written to the transcript" and keep it aside.
#
# ★★ Why it is needed (found by measurement on 2026-08-21):
#    The CLI batches transcript writes through `transcriptMirrorBatcher`, and
#    **flushing stops while it waits for a human answer (approval, AskUserQuestion)**.
#    Measured: 0 bytes for 93 s → +10KB the moment it was answered. ⇒ the "explanation right before" an approval card
#    is **always missing by construction** (nothing to base an answer from the phone on).
#    MessageDisplay is called **on every render**, so picking it up here makes it readable while waiting.
#
# ⚠️⚠️ **Never call the agent.** This runs in the CLI's render path (`forceSyncExecution: true`).
#    Putting network in here would freeze the user's screen for our reasons (CLAUDE.md §4).
#    ⇒ **Just append one line to a file**. Measured 2.6 ms (called every 0.7 s, so 0.37% of rendering).
#
# ⚠️ **Do not fork** (no `cat` / `jq` / `python`). read and regexes are bash builtins.
# ⚠️ **Always exit 0 and print nothing to stdout**. Returning JSON **replaces what is displayed** by contract,
#    so ending silently falls back to "show the original text as-is".
umask 077

# ★ Escape hatch (`/code-review` 2026-08-21, medium #3). **Lets you stop it without editing settings by hand**.
#   ⚠️ It lives on tmpfs (/tmp). If $HOME is on a hung FS, the stat itself would block
if [[ -e ${TMPDIR:-/tmp}/nyan-remote-inflight.off ]]; then
  # ⚠️⚠️ **Drain stdin before exiting** (2026-08-23). Exiting without reading makes
  #    the writer (the CLI) hit **a broken pipe = EPIPE**. This hook is called every 0.7 s,
  #    so from the moment the escape hatch is used it would **error every single time**.
  #    ⚠️ It always happens when the body exceeds the pipe capacity (64KB) (pinned by a test).
  #    ⚠️ Do not fork (no `cat`). read is a bash builtin
  IFS= read -r -d '' _ || :
  exit 0
fi

IFS= read -r -d '' payload

# ⚠️⚠️ **Collapse to one line** (same review, low #6). If pretty-printed (multi-line) JSON arrives,
#    writing it as-is **breaks the JSONL so it cannot be read**. Newlines inside JSON strings
#    are already encoded as `\n`, so collapsing here loses nothing.
payload=${payload//$'\n'/ }
payload=${payload//$'\r'/ }

# ★ session_id is **validated strictly** (it is used directly in a path). Anything but a UUID is dropped.
# ⚠️ Allow whitespace after the colon (so `"session_id": "..."` formatting works too / same review, low #6)
[[ $payload =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([0-9a-fA-F-]{36})\" ]] || exit 0
sid=${BASH_REMATCH[1]}

# Which delta this is (0 = start of a new message).
# ⚠️⚠️ **Required** (codex 2026-08-21, medium #6). It used to default to 0, so when `index`
#    became unreadable **the file was truncated every time** and only the last fragment of the body survived.
# ⚠️ Bound the digit count and check that a delimiter follows (prevents long numbers from breaking arithmetic.
#    Unbounded, `1234567` could be read as `123456` and slip past the limit check)
[[ $payload =~ \"index\"[[:space:]]*:[[:space:]]*([0-9]{1,6})[,}[:space:]] ]] || exit 0
idx=${BASH_REMATCH[1]}

# ⚠️ Do not grow without limit. Give up on overly long messages midway (the transcript has them in the end)
(( idx > 500 )) && exit 0

dir=${NYAN_REMOTE_STATE_DIR:-$HOME/.nyan-remote}/inflight
[[ -d $dir ]] || mkdir -p -m 700 "$dir" || exit 0

# ★★ **Truncate** at index 0. That leaves only "the message currently streaming",
#    with no fork to measure size and no cleanup needed
if (( idx == 0 )); then
  printf '%s\n' "$payload" > "$dir/$sid.jsonl"
else
  printf '%s\n' "$payload" >> "$dir/$sid.jsonl"
fi
exit 0
