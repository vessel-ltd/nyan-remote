#!/bin/bash
# Antigravity CLI (agy) status line relay — keep the session state agy hands to the status line (docs/AGY.md §5).
#
# ★ agy runs the status line command whenever the agent state changes (at most every 300 ms, killed after 5 s) with a
#   JSON object on stdin: conversation id, cwd, model, context use, plan quota, `agent_state`, and
#   `tool_confirmation_pending` while an approval card is up. We keep the latest one per conversation as
#     ~/.nyan-remote/agy/session-<conversation id>.json = {"nyanPid":<agy's pid>,"nyanBusyAt":<epoch s>,"input":{…}}
#   and the agent reads it for the session list.
# ★ Installed by `scripts/install-agy.mjs`:
#     no status line of the user's ⇒ "command": "'<this file>'" with "stack_with_default": true (we print nothing, so
#       agy's own status line stays as it was / measured 2026-11-19)
#     a status line of the user's  ⇒ "command": "'<this file>' --nyan-remote-relay '<the user's command>'"
#
# ⚠️⚠️ This runs in agy's render path. Rules (the same as `hooks/statusline.sh`):
#   - Never call the agent or the network. Write one file and go on.
#   - Our part runs in a subshell (its umask and failures stay there); the user's command gets the same bytes.
#   - ⚠️ The e-mail address agy includes is removed before writing; if it cannot be removed, nothing is written.
#   - The file is written to a new temporary name with noclobber and renamed into place.
#   - `nyanPid` is agy itself: this script runs under `sh -c`, whose parent is agy. The agent checks that the pid is a
#     live agy before showing the row.
#   - `nyanBusyAt` is when the conversation was last seen working (carried over from the previous file): with it an
#     `idle` after a turn reads as "done", and an `idle` before any turn as "idle".

IFS= read -r -d '' input || :

if [[ $input == *'"conversation_id"'* ]]; then
  (
    umask 077
    set -C
    dir=${NYAN_REMOTE_STATE_DIR:-$HOME/.nyan-remote}/agy
    # ⚠️ Only into our own directory (made by the installer, 0700), never through a link
    [[ -d $dir && ! -L $dir && -O $dir ]] || exit 0
    # ⚠️ The id goes into a file name ⇒ a UUID only (it is "" until the first prompt: no file then)
    re=$'"conversation_id"[[:space:]]*:[[:space:]]*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"'
    [[ $input =~ $re ]] || exit 0
    cid=${BASH_REMATCH[1]}
    # ⚠️ Drop the e-mail (a quoted string without quotes or backslashes inside) with the comma that joins it, so the
    #    rest stays valid JSON; anything left that names it ⇒ no file (the agent also refuses a file that is not JSON)
    re=$',[[:space:]]*"email"[[:space:]]*:[[:space:]]*"[^"\\\\]*"'
    while [[ $input =~ $re ]]; do input=${input/"${BASH_REMATCH[0]}"/}; done
    re=$'"email"[[:space:]]*:[[:space:]]*"[^"\\\\]*"[[:space:]]*,'
    while [[ $input =~ $re ]]; do input=${input/"${BASH_REMATCH[0]}"/}; done
    [[ $input == *'"email"'* ]] && exit 0
    # ★ agy's pid: our parent when the `sh -c` replaced itself with us (bash as sh, e.g. macOS), else its parent
    #   (dash keeps the shell / measured 2026-11-19). The agent checks the pid is a running agy either way.
    pid=$PPID
    comm=
    if [[ -r /proc/$pid/comm ]]; then
      IFS= read -r comm </proc/$pid/comm || comm=
    else
      comm=$(ps -o comm= -p "$pid" 2>/dev/null) || comm=
      comm=${comm##*/}
    fi
    if [[ $comm != agy ]]; then
      if [[ -r /proc/$pid/stat ]]; then
        read -r _ _ _ pid _ </proc/$pid/stat || pid=
      else
        pid=$(ps -o ppid= -p "$pid" 2>/dev/null) || pid=
        pid=${pid//[[:space:]]/}
      fi
    fi
    [[ $pid =~ ^[0-9]+$ ]] || exit 0
    file=$dir/session-$cid.json
    busy=0
    if [[ -f $file && ! -L $file ]]; then
      prev=
      IFS= read -r -d '' prev < <(head -c 200 -- "$file" 2>/dev/null) || :
      [[ $prev =~ \"nyanBusyAt\":([0-9]+) ]] && busy=${BASH_REMATCH[1]}
    fi
    re=$'"agent_state"[[:space:]]*:[[:space:]]*"(working|tool_use|reviewing)"'
    [[ $input =~ $re ]] && busy=$(date +%s)
    tmp=$dir/.session-$cid.$$.$RANDOM.tmp
    if printf '{"nyanPid":%s,"nyanBusyAt":%s,"input":%s}' "$pid" "$busy" "$input" >"$tmp"; then
      mv -f -- "$tmp" "$file" || rm -f -- "$tmp"
    else
      rm -f -- "$tmp"
    fi
    # ★ The same state again as this agy's own file, `pid-<agy pid>.json`. The file above is per conversation, so two agys
    #   on one conversation (agy allows it) write the same file; the approval cards read each agy's own file instead
    #   (a second agy can neither take over nor hide the first one's card / codex review 2026-11-20)
    #   ⚠️ A write that fails removes the old one (a full disk must not leave a card "up" after it was answered: no
    #      file = no card on the phone)
    tmp=$dir/.pid-$pid.$$.$RANDOM.tmp
    if printf '{"nyanPid":%s,"nyanBusyAt":%s,"input":%s}' "$pid" "$busy" "$input" >"$tmp" && mv -f -- "$tmp" "$dir/pid-$pid.json"; then
      :
    else
      rm -f -- "$tmp" "$dir/pid-$pid.json"
    fi
    # ★ A visit mark per conversation and agy, touched on every write: it stays when this agy moves to another
    #   conversation (its own file above does not), so the agent can tell that it wrote into this conversation's
    #   transcript during another agy's card (codex review). `>|`: noclobber is on here.
    : >|"$dir/visit-$cid-$pid"
  ) 2>/dev/null
fi

[[ ${1:-} == --nyan-remote-relay ]] && shift

# The user's own status line, as before: through `sh -c`, as agy runs it (bash would print `echo '\033…'`
# differently / codex review), with the same bytes on stdin; what it prints is passed on.
# ★★ But it never fails on its behalf (2026-11-20 / codex review of the approval cards): agy turns the whole status
#    line off after 30 failures (a non-zero exit, or its 5 s limit), and our relay with it. A state file that stops
#    changing keeps an old approval card "up", so an answer to it could land on another conversation's card.
#    ⇒ the user's command gets 4 s (then its whole process group is killed: SIGKILL, which a command cannot ignore),
#      and this always exits 0.
#    ⚠️ Its output goes to a temporary file and is printed when `sh` ends: a background child it leaves running would
#       otherwise hold agy's pipe open past the limit (codex review). The child keeps running; its later output is lost.
if [[ -n ${1:-} ]]; then
  exec 3>&2 2>/dev/null
  out=$(mktemp "${TMPDIR:-/tmp}/nyan-agy-status.XXXXXX") || out=
  err=
  [[ -n $out ]] && { err=$(mktemp "${TMPDIR:-/tmp}/nyan-agy-status.XXXXXX") || { rm -f -- "$out"; out=; }; }
  # ⚠️ No temporary file (a full or unwritable temp directory) ⇒ the user's line is skipped this once: handing it agy's
  #    own pipes would let a child it leaves running hold them past the limit (codex review)
  if [[ -n $out ]]; then
    set -m
    sh -c "$1" < <(printf '%s' "$input") >"$out" 2>"$err" 3>&- &
    child=$!
    { sleep 4 && kill -KILL -- "-$child"; } </dev/null >/dev/null 3>&- &
    timer=$!
    wait "$child"
    kill -KILL -- "-$timer"
    cat -- "$out"
    cat -- "$err" >&3
    rm -f -- "$out" "$err"
  fi
fi
exit 0
