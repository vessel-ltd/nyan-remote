// Turn transcript JSONL into the structure used by the chat UI.
//
// ⚠️ Never parse the whole file (we have measured 14MB files).
//    Read backwards from the end in 64KB chunks and stop once enough entries are collected.
//    "Show the latest first, go back to older ones if needed" is also the natural reading order of a chat UI.
//
// ⚠️ For bandwidth and display, long bodies such as tool results are summarized and clipped. If the full text
//    is ever needed, add a separate endpoint (out of scope for M2).

import { type FileHandle, open } from 'node:fs/promises'
import type { LogEntry } from '../../../shared/types.ts'
import { senderName } from './inbox.ts'
import { t } from '../../../shared/i18n.ts'

const CHUNK = 64 * 1024
/** Limit for tool commands / results. Keeps enough to read when the fold is opened */
const TOOL_MAX = 1200
const TEXT_MAX = 8000
/**
 * ★ How much can be read when a folded line (`meta`) is opened. **Same limit as body text**.
 * ⚠️ With the tool limit (1200) almost the whole compaction summary gets cut (= more unreadable content).
 */
const META_MAX = TEXT_MAX

type Rec = Record<string, unknown>

export interface LogSlice {
  entries: LogEntry[]
  /** Byte offset where reading started. 0 means read all the way to the start */
  cursor: number | null
  tail: number
  bytes: number
}

/** For body text. Keeps newlines (it is a chat view) */
function clip(s: string, max: number): string {
  const t = s.trimEnd()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * For tool display. Keeps newlines (the client folds to one line and expands on tap).
 * Also returns the line count and whether it was truncated.
 */
function foldable(raw: string, max = TOOL_MAX): { summary: string; lines: number; truncated: boolean } {
  const t = raw.replace(/\s+$/, '')
  if (!t) return { summary: '', lines: 0, truncated: false }
  const truncated = t.length > max
  const summary = truncated ? `${t.slice(0, max - 1)}…` : t
  return { summary, lines: summary.split('\n').length, truncated }
}

/**
 * ★★ Is this an **internal record** that a slash command (`/compact` etc.) leaves in the transcript?
 *
 * The four measured on 2026-08-25 (captured by sending `/compact` as keystrokes):
 *
 * | Record | Marker |
 * |---|---|
 * | The full summary | `isCompactSummary: true` |
 * | caveat (the DO NOT RESPOND boilerplate) | `isMeta: true` |
 * | `<command-name>…</command-name>…` | ★ **no marker** |
 * | `<local-command-stdout>…` | ★ **no marker** |
 *
 * ⚠️ The two without a marker **can only be detected by the tags in the body** (`isMeta` was not set).
 * ⚠️ Fold rather than drop. `<local-command-stdout>` is **the command's result itself**, so
 *    dropping it breaks the condition for the command table (the effect is visible from the phone).
 */
export function localCommandMeta(
  text: string,
  /**
   * ★★ Whether the record has `isMeta` (**used only for detecting the caveat**).
   *
   * ⚠️⚠️ Using `isMeta` **on its own** as "not a human message" is wrong
   *    (records delivered via the inbox carry it too = every instruction sent would vanish).
   *    Here it is **ANDed with the caveat tag**, which is safe (inbox records
   *    start with the frame, so they never match the tag).
   * ★ Measured (2026-08-25 / 26 records from my own logs): **26/26 real caveats have `isMeta: true`**.
   */
  isMeta: boolean,
): { label: string; body: string } | undefined {
  // ★ The caveat is **a frame with no body** (just the boilerplate "what follows is not a human message").
  //   Treated like something that becomes empty after `stripPeerFrame` removes the frame = not shown.
  // ⚠️⚠️ **Do not decide from the body alone** (2026-08-25 codex medium #4 → round 6, medium #2).
  //    At first only the tag was checked, so `<local-command-caveat>text that should stay</…>` vanished entirely.
  //    Next it was changed to "also check the wording (`Caveat:`)", but **a human typing the same opening gets the same result**.
  //    ⇒ **AND with `isMeta` (a marker the CLI sets)**. Humans cannot set `isMeta`.
  //    ★ The wording check stays too (be strict on the removing side. ⚠️ removing too much does more harm).
  if (isMeta && text.startsWith('<local-command-caveat>Caveat:')) return { label: '', body: '' }
  const named = /^<command-name>\s*([^<\n]{1,64}?)\s*<\/command-name>/.exec(text)
  if (named) return { label: t(`コマンド ${named[1]}`, `Command ${named[1]}`), body: text }
  const head = '<local-command-stdout>'
  if (text.startsWith(head)) {
    const inner = text.slice(head.length).replace(/<\/local-command-stdout>\s*$/, '')
    // ⚠️ Strip terminal color codes (SGR). Left in, `[2m` is read as body text
    return { label: t('コマンドの出力', 'Command output'), body: inner.replace(/\u001b\[[0-9;]*m/g, '') }
  }
  return undefined
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Rec
    if (b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text'])
  }
  return parts.join('\n\n')
}

/**
 * Render AskUserQuestion (being asked to pick an option) in human-readable form.
 *
 * ★ No picker UI is built (ARCHITECTURE.md §9.7). Sending one text message
 *   implicit_cancels the dialog, so **if it is readable you can reply "the second one"**.
 *   So the only requirement here is "the question and options are readable on the phone".
 *   ⚠️ Left as JSON it is effectively unreadable on a phone (which was the original state).
 *
 * The first line is the question, because the folded list view shows only the first line.
 */
export function formatAskUserQuestion(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const questions = (input as Rec)['questions']
  if (!Array.isArray(questions) || questions.length === 0) return ''

  const out: string[] = []
  questions.forEach((q, qi) => {
    if (!q || typeof q !== 'object') return
    const qo = q as Rec
    const text = typeof qo['question'] === 'string' ? qo['question'] : ''
    const header = typeof qo['header'] === 'string' ? qo['header'] : ''
    const prefix = questions.length > 1 ? `Q${qi + 1}. ` : ''
    out.push(header ? `${prefix}${text}  [${header}]` : `${prefix}${text}`)

    const options = Array.isArray(qo['options']) ? qo['options'] : []
    options.forEach((op, oi) => {
      if (!op || typeof op !== 'object') return
      const oo = op as Rec
      const label = typeof oo['label'] === 'string' ? oo['label'] : ''
      const desc = typeof oo['description'] === 'string' ? oo['description'] : ''
      out.push(desc ? `  ${oi + 1}) ${label} — ${desc}` : `  ${oi + 1}) ${label}`)
    })
    if (qo['multiSelect'] === true) out.push(t('  ※ 複数選択できる', '  * Multiple choices allowed'))
    // "Other" is added automatically by the CLI, so it is not in the options array
    out.push(t('  ※ 上の番号以外に、自由に書いて答えてもよい', '  * You may also answer freely instead of choosing a number above'))
  })
  return out.join('\n')
}

/** Show only the gist of the tool: command for Bash, file_path for Read, and so on */
function toolSummary(name: string, input: unknown) {
  if (!input || typeof input !== 'object') return foldable('')
  const o = input as Rec

  // ★ When options are being asked, readable question and options come first
  if (name === 'AskUserQuestion') {
    const formatted = formatAskUserQuestion(o)
    if (formatted) return foldable(formatted)
  }

  const pick = (k: string): string | undefined =>
    typeof o[k] === 'string' ? (o[k] as string) : undefined
  const first =
    pick('command') ??
    pick('file_path') ??
    pick('pattern') ??
    pick('path') ??
    pick('url') ??
    // plan = ExitPlanMode (plan approval). Without reading it you cannot decide on the approval either
    pick('plan') ??
    pick('prompt') ??
    pick('description') ??
    pick('query')
  return foldable(first ?? readableInput(o))
}

/**
 * Render the input of an unknown tool in a form readable on a phone.
 *
 * ★ Where the requirement came from: to answer an approval or question by text, **you cannot answer
 *   unless you can read what is being asked** (user feedback / 2026-08-12). With a one-line JSON.stringify
 *   inputs such as MCP tools or TodoWrite were effectively unreadable.
 *   Known tools (Bash / Read / …) show only their gist via pick above. This is the catch-all for the rest.
 */
export function readableInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Rec
  const lines: string[] = []
  for (const [k, v] of Object.entries(o)) {
    let shown: string
    if (typeof v === 'string') shown = v
    else if (v === null || typeof v !== 'object') shown = String(v)
    else {
      // Pretty-print nested values (one-line JSON is unreadable)
      shown = JSON.stringify(v, null, 2)
    }
    // For multi-line values, continue indented on the lines after the key
    if (shown.includes('\n')) {
      lines.push(`${k}:`)
      for (const l of shown.split('\n')) lines.push(`  ${l}`)
    } else {
      lines.push(`${k}: ${shown}`)
    }
  }
  return lines.join('\n')
}

function resultSummary(content: unknown) {
  if (typeof content === 'string') return foldable(content)
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Rec
      if (b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text'])
      else if (b['type'] === 'image') parts.push(t('[画像]', '[image]'))
    }
    return foldable(parts.join('\n'))
  }
  return foldable('')
}

/** Did the record come via the inbox (another process)? ⚠️ **Not evidence of "from the phone"** (below) */
export function isPeerOrigin(origin: unknown): boolean {
  return Boolean(origin) && typeof origin === 'object' && (origin as Rec)['kind'] === 'peer'
}

/** The sender's self-declared name (`from`). The agent puts `nyan-remote(<machine name>)` there */
/**
 * ★★ **Was this peer message sent by "us" (this agent)?**
 *
 * ⚠️ `origin.kind === 'peer'` is not a nyan-remote-specific marker (2026-08-14 review, high).
 *    The CLI's own cross-session inbox and **any process of the same user** that can write to the UDS look the same.
 *    Showing "you (from the phone)" just because it is a peer would
 *    **list instructions we never sent as our own messages**.
 * ⚠️ `from` is self-declared by the sender, so it **can be spoofed**. This marker is for "not getting it wrong",
 *    **not an anti-spoofing measure** (the premise stays: processes of the same user are not a trust boundary).
 */
export function isFromThisAgent(origin: unknown, self = senderName()): boolean {
  return peerFrom(origin) === self
}

export function peerFrom(origin: unknown): string | undefined {
  if (!isPeerOrigin(origin)) return undefined
  const from = (origin as Rec)['from']
  return typeof from === 'string' && from && from !== 'unknown' ? from : undefined
}

/**
 * Strip the frame the CLI adds around a peer message, leaving only the body.
 *
 * ```
 * Another Claude session sent a message:
 * <body>
 *
 * This came from another Claude session — … (boilerplate continues from here)
 * ```
 *
 * ⚠️ **If it cannot be stripped, return the full text as is** (showing too much is safer than deleting).
 *    The frame wording may change on the CLI side, so **a mismatch is not treated as an error**.
 */
export function stripPeerFrame(text: string): string {
  const head = 'Another Claude session sent a message:\n'
  const tail = '\n\nThis came from another Claude session'
  if (!text.startsWith(head)) return text
  const rest = text.slice(head.length)
  // ⚠️ Cut at the **last occurrence**. If the body contains this boilerplate, cutting earlier would trim the message
  //    (2026-08-14 review, low. Reproduced in practice)
  const end = rest.lastIndexOf(tail)
  return end < 0 ? rest : rest.slice(0, end)
}

/** Turn one record into 0..N display entries. Records not worth showing give an empty array. */
export function toEntries(rec: Rec): LogEntry[] {
  // Fold away subagents' internal exchanges (not shown in M2)
  if (rec['isSidechain'] === true) return []
  const at = typeof rec['timestamp'] === 'string' ? rec['timestamp'] : undefined
  const type = rec['type']

  // ⚠️⚠️ **Do not drop on `isMeta`** (measured and reverted on 2026-08-25).
  //    `transcript.ts` (which builds titles) excludes `isMeta`, but **borrowing the same marker here breaks things**:
  //    **records delivered via the inbox also carry `isMeta: true`** (confirmed in a real transcript).
  //    Dropping them makes every instruction sent "from the phone" **vanish from the thread**.
  //    ⇒ Decide by **tags in the body**, not by the marker (`localCommandMeta`).
  // ★★ For instructions delivered via the inbox, rely only on "**records that name the sender**"
  //     (2026-08-14 external review, medium).
  //
  // ⚠️ At first `queue-operation/enqueue` was shown as "evidence it came from the phone", which was **wrong**.
  //    `enqueue` **has no sender**, so input typed on the PC during a response, or automatic injections, were
  //    labeled "from the phone". It also rejected bodies starting with `<task-notification>`,
  //    so **real instructions starting with that string disappeared from the screen**.
  //    → `enqueue` is not used for display. Only these two carry the sender:
  //      - the `origin` of a `user` record (delivered while idle; re-posted with the frame)
  //      - the `origin` of a `queued_command` attachment (interrupting while busy)
  if (type === 'queue-operation') return []

  if (type === 'attachment') {
    const a = rec['attachment']
    if (!a || typeof a !== 'object') return []
    const at2 = a as Rec
    if (at2['type'] !== 'queued_command') return []
    // ⚠️ Things typed on the PC and queued are **not shown here** (a matching user record appears separately)
    if (!isPeerOrigin(at2['origin'])) return []
    const prompt = at2['prompt']
    if (typeof prompt !== 'string' || !prompt.trim()) return []
    return [
      {
        kind: 'user',
        at,
        text: clip(prompt, TEXT_MAX),
        via: isFromThisAgent(at2['origin']) ? 'inbox' : 'peer',
        from: peerFrom(at2['origin']),
      },
    ]
  }

  if (type === 'user') {
    const message = rec['message']
    if (!message || typeof message !== 'object') return []
    // ★ Inbox deliveries are re-posted with a long frame around the body (measured 2026-08-13).
    //   Showing the frame as is fills the phone screen with boilerplate, so keep **only the body** and mark it.
    const origin = rec['origin']
    if (isPeerOrigin(origin)) {
      const text = stripPeerFrame(textOf((message as Rec)['content']))
      if (!text.trim()) return []
      return [
        {
          kind: 'user',
          at,
          text: clip(text, TEXT_MAX),
          // ★ Only what we sent is "from the phone". Anything else is "from another session"
          via: isFromThisAgent(origin) ? 'inbox' : 'peer',
          from: peerFrom(origin),
        },
      ]
    }
    const content = (message as Rec)['content']
    // ★★ Compaction summary. **Do not list the full text as "your message"** (thousands of characters fill the thread)
    // ⚠️⚠️ **Keep this after the `origin` check** (2026-08-25 codex medium #4. Reproduced in practice).
    //    It used to come first, so **inbox records carrying both markers turned into `meta`** and
    //    "instructions sent from the phone" vanished from the thread. ⇒ The source check always comes first.
    if (rec['isCompactSummary'] === true) {
      const summary = textOf(content)
      if (!summary.trim()) return []
      return [{ kind: 'meta', at, label: t('会話を圧縮しました', 'Conversation compacted'), ...foldable(summary, META_MAX) }]
    }
    // ★ Fold `<command-name>` / `<local-command-stdout>` (internal records with no marker)
    const local = localCommandMeta(textOf(content), rec['isMeta'] === true)
    if (local) {
      if (!local.body.trim()) return [] // ★ Frame only (caveat)
      return [{ kind: 'meta', at, label: local.label, ...foldable(local.body, META_MAX) }]
    }
    // Tool results arrive as user records
    if (Array.isArray(content)) {
      const out: LogEntry[] = []
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Rec
        if (b['type'] === 'tool_result') {
          out.push({
            kind: 'tool_result',
            at,
            ok: b['is_error'] !== true,
            forId: typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : undefined,
            ...resultSummary(b['content']),
          })
        }
      }
      const text = textOf(content)
      if (text.trim()) out.unshift({ kind: 'user', at, text: clip(text, TEXT_MAX) })
      return out
    }
    const text = textOf(content)
    if (!text.trim()) return []
    return [{ kind: 'user', at, text: clip(text, TEXT_MAX) }]
  }

  if (type === 'assistant') {
    const message = rec['message']
    if (!message || typeof message !== 'object') return []
    const content = (message as Rec)['content']
    const out: LogEntry[] = []
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Rec
        if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].trim()) {
          out.push({ kind: 'assistant', at, text: clip(b['text'], TEXT_MAX) })
        } else if (b['type'] === 'thinking' && typeof b['thinking'] === 'string') {
          // ⚠️ The transcript does not store thinking text (only the signature remains).
          //    Measured: 7 files, 500+ blocks, all thinking: "".
          //    Making empty ones into entries would only bump a "thinking N" count with no content,
          //    so they are dropped. If the CLI ever stores it, it will show up naturally.
          if (b['thinking'].trim()) {
            out.push({ kind: 'thinking', at, text: clip(b['thinking'], TEXT_MAX) })
          }
        } else if (b['type'] === 'tool_use') {
          const name = typeof b['name'] === 'string' ? b['name'] : 'tool'
          out.push({
            kind: 'tool_use',
            at,
            name,
            id: typeof b['id'] === 'string' ? b['id'] : undefined,
            ...toolSummary(name, b['input']),
          })
        }
      }
      return out
    }
    const text = textOf(content)
    if (!text.trim()) return []
    return [{ kind: 'assistant', at, text: clip(text, TEXT_MAX) }]
  }

  if (type === 'system') {
    const content = rec['content']
    if (typeof content !== 'string' || !content.trim()) return []
    // Only show warning/error levels (informational ones are noise)
    const level = rec['level']
    if (level !== 'warning' && level !== 'error') return []
    return [{ kind: 'system', at, text: clip(content, TOOL_MAX) }]
  }

  return []
}

/**
 * Split a chunk into "record + the byte offset where that record starts in the file".
 *
 * ★ Why the offset is needed (a bug found in the 2026-08-12 review):
 *   Reading backwards "drops the surplus from the older side", but cursor pointed at **the chunk start**,
 *   so the dropped records never appeared on the next page (before cursor) either and were **lost forever**.
 *   cursor must be "the start of the oldest record returned".
 *
 * @param bodyStartAbs byte offset of the start of body within the file
 */
function splitRecords(body: Buffer, bodyStartAbs: number): { start: number; rec: Rec }[] {
  const out: { start: number; rec: Rec }[] = []
  let lineStart = 0
  for (let i = 0; i <= body.length; i++) {
    // Once at a line end (newline or end of buffer), process it as one line
    if (i !== body.length && body[i] !== 0x0a) continue
    const raw = body.subarray(lineStart, i).toString('utf8')
    const t = raw.trim()
    if (t) {
      try {
        const o = JSON.parse(t) as unknown
        if (o && typeof o === 'object') out.push({ start: bodyStartAbs + lineStart, rec: o as Rec })
      } catch {
        // Drop broken lines that are still being written
      }
    }
    lineStart = i + 1
  }
  return out
}

function parseChunk(text: string): Rec[] {
  const lines = text.split('\n')
  const out: Rec[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t) as unknown
      if (o && typeof o === 'object') out.push(o as Rec)
    } catch {
      // Drop broken lines that are still being written
    }
  }
  return out
}

/**
 * ★★ **Return the end of the last "complete line"** (not the file size).
 *
 * ⚠️⚠️ A transcript **can be observed mid-append**. Linux buffered writes
 *    **grow `i_size` in 4KB pages**, so **records larger than 4KB can be seen
 *    "mid-line"** (= the longer the body, the more likely).
 *
 * ⚠️ Using `size` here drops the broken line and then starts the next read **in the middle of that line**,
 *    so even after the line completes **that record is never read**. Reported on a real device on 2026-08-20
 *    as "only long bodies with tables don't show on the phone" (same for the tail of `readLogSince`).
 */
async function lastCompleteTail(fh: FileHandle, size: number): Promise<number> {
  let end = size
  while (end > 0) {
    const start = Math.max(0, end - CHUNK)
    const buf = Buffer.alloc(end - start)
    await fh.read(buf, 0, buf.length, start)
    const nl = buf.lastIndexOf(0x0a)
    if (nl >= 0) return start + nl + 1
    end = start
  }
  // No newline at all (not a single record is complete)
  return 0
}

/**
 * Collect limit display entries from the end (or just before `before`).
 * @param before read what lies before this offset. If omitted, from the end of the file
 */
export async function readLogSlice(
  file: string,
  limit: number,
  before?: number,
): Promise<LogSlice> {
  const fh = await open(file, 'r')
  try {
    const st = await fh.stat()
    const size = st.size
    // ★★ **Use the same boundary for the read limit and tail** (2026-08-20 `/code-review`, medium).
    //    `splitRecords` treats the end of the buffer as a line end, so reading up to `size`
    //    **emits a record whose JSON is complete but whose newline has not arrived yet**.
    //    tail points before it, so **the next live follow delivers the same thing again** (duplicate delivery).
    const end = await lastCompleteTail(fh, size)
    // ⚠️⚠️ `before` beyond the complete boundary = **the file was recreated** (the cursor passed in
    //    no longer exists. 2026-08-20 codex review, high #2). Clamping to `end` here would
    //    **return the latest page as "older"**, which the PWA prepends and duplicates.
    //    ⇒ Return nothing (the PWA re-reads from the latest via `reset` on the follow side).
    if (before !== undefined && before > end) {
      return { entries: [], cursor: null, tail: end, bytes: size }
    }
    // Keep per record (oldest first). Keeping only display entries loses the position of what was dropped
    const records: { start: number; entries: LogEntry[] }[] = []
    let total = 0
    let start = before !== undefined && before >= 0 && before <= end ? before : end

    // To avoid losing records at chunk boundaries, carry the incomplete leading line "as bytes"
    // over to the next (earlier) chunk. Concatenating as strings would break multibyte characters.
    // ⚠️ **Keep the carry-over as an array and concatenate once, when a boundary is found**
    //    (2026-08-20 codex review, medium #5). Calling `Buffer.concat` every time makes copying quadratic
    //    when a single record is long (the largest record in real data is **1.3MB**).
    //    ★ The carry-over contains no newline (it is what remains after cutting at one),
    //      so the newline search only needs to look at **the new chunk**.
    let pending: Buffer[] = []

    while (start > 0 && total < limit) {
      const nextStart = Math.max(0, start - CHUNK)
      const len = start - nextStart
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, nextStart)

      let body: Buffer
      let bodyStartAbs: number
      if (nextStart > 0) {
        const nl = buf.indexOf(0x0a)
        if (nl >= 0) {
          body = Buffer.concat([buf.subarray(nl + 1), ...pending])
          bodyStartAbs = nextStart + nl + 1
          pending = [buf.subarray(0, nl)]
        } else {
          // This whole chunk is in the middle of one line. Carry it all over
          pending = [buf, ...pending]
          body = Buffer.alloc(0)
          bodyStartAbs = nextStart
        }
      } else {
        body = Buffer.concat([buf, ...pending])
        bodyStartAbs = 0
        pending = []
      }

      const chunk = splitRecords(body, bodyStartAbs).map((r) => ({
        start: r.start,
        entries: toEntries(r.rec),
      }))
      records.unshift(...chunk)
      for (const r of chunk) total += r.entries.length
      start = nextStart
    }

    // ★ Remove the surplus per record from the older side.
    //   "The start of the removed record" becomes the next page's starting point, so no entry is lost.
    while (records.length > 1) {
      const oldest = records[0]!
      if (total - oldest.entries.length < limit) break
      total -= oldest.entries.length
      records.shift()
    }

    // Where to read next.
    // ⚠️⚠️ **Always "the start of the oldest record returned"** (2026-08-20 codex review, high #1).
    //    It used to return `start` (= the chunk start) when nothing was `dropped`.
    //    With a record over 64KB, `start` points **into its middle**, so the next page
    //    could not be parsed as JSON and **that record was lost forever** (measured: page 2 came back empty).
    //    ★ `records` also keeps records with zero display entries, so it is present whenever anything was read.
    const oldestKept = records[0]
    const cursor = oldestKept ? oldestKept.start : start > 0 ? start : null

    return {
      entries: records.flatMap((r) => r.entries),
      cursor: cursor !== null && cursor > 0 ? cursor : null,
      // ★ Where live follow starts. **End of what was read = end of the last complete line** (not size)
      tail: end,
      bytes: size,
    }
  } finally {
    await fh.close()
  }
}

/** Live follow: read only what was appended after byte offset `from` */
export async function readLogSince(file: string, from: number): Promise<LogSlice> {
  const fh = await open(file, 'r')
  try {
    const st = await fh.stat()
    const size = st.size
    if (from >= size) {
      return { entries: [], cursor: null, tail: size, bytes: size }
    }
    const len = size - from
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, from)
    // `from` is **the end of a complete line** (the tail returned last time), so the first line is not dropped.
    // ⚠️⚠️ The end may be seen "mid-line" (see lastCompleteTail).
    //    Consume only up to the last newline and **stop tail there too**.
    //    Returning `size` here would lose a record that was being written.
    const nl = buf.lastIndexOf(0x0a)
    // No complete line = nothing to read yet (do not advance tail)
    if (nl < 0) return { entries: [], cursor: null, tail: from, bytes: size }
    const entries = parseChunk(buf.subarray(0, nl + 1).toString('utf8')).flatMap(toEntries)
    return { entries, cursor: null, tail: from + nl + 1, bytes: size }
  } finally {
    await fh.close()
  }
}
