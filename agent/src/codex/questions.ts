// ★★ Codex questions (`item/tool/requestUserInput`) as one of our question cards (2026-11-16 / docs/CODEX.md §5.2).
//
// Measured on codex-cli 0.169.0 (a thread in Plan mode; the probe joined it with `thread/resume`):
//   `{threadId, turnId, itemId, questions:[{id, header, question, isOther:true, isSecret:false,
//     options:[{label, description}…]}…], isBlocking:true, autoResolutionMs:null}`
//   Answered in the TUI ⇒ `serverRequest/resolved`. ESC in the TUI ⇒ the turn ends `interrupted`, then resolved.
// From the rust-v0.169.0 source (asked through codex exec; not all measured):
//   - The answer is `{answers:{[questionId]:{answers:[…]}}}`. A chosen option is its exact label. "None of the above" is
//     the literal string, and a note is one more entry `"user_note: …"`.
//   - ⚠️⚠️ The daemon validates nothing (ids, labels). Any string reaches the model ⇒ **we** check against the request.
//   - ⚠️⚠️ A JSON-RPC error or a malformed result becomes `{answers:{}}` and **resolves** the request. ⇒ Never answer
//     with an error to mean "leave it to the PC": a question we do not take is simply not answered.
//   - Plan mode only by default (`features.default_mode_request_user_input` is off).
//
// The rules:
//  1. ⚠️⚠️ **The phone sends labels and notes, never the answer object.** The agent builds it here from the request it
//     holds (the ids never travel to the phone), the same way Claude's `updatedInput` is built (`claude/interaction.ts`).
//  2. ⚠️ **Only a label that was shown is accepted**, one per question (Codex has no multi-select).
//  3. ★ A note is allowed on every question: with a label it is added after it; without one it is the answer
//     ("None of the above" + the note, as the TUI sends) — only where the request allows another answer (`isOther`).
//  4. ⚠️ **What we do not understand is left to the PC** (not answered at all): a secret question, a question without
//     options, a non-blocking request, duplicate ids or texts (the phone keys answers by question text), or anything
//     whose shape is off.

import type { Interaction } from '../../../shared/types.ts'
import { MAX_MESSAGE_BYTES } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'
import type { RpcId, ServerRequest } from './rpc.ts'

export const USER_INPUT_METHOD = 'item/tool/requestUserInput'

/** What the TUI sends when no option fits (the literal string, from the 0.169.0 source) */
export const NONE_OF_THE_ABOVE = 'None of the above'
/** The prefix the TUI puts before a note */
export const NOTE_PREFIX = 'user_note: '

export interface CodexQuestionItem {
  /** Codex's id for the question (stays on the agent) */
  id: string
  question: string
  header?: string
  options: { label: string; description?: string }[]
  /** Whether an answer other than the options is allowed (`isOther`) */
  other: boolean
}

/** One question request the phone can answer */
export interface CodexQuestion {
  requestId: RpcId
  threadId: string
  turnId: string
  itemId: string
  questions: CodexQuestionItem[]
}

/** The result sent to the daemon */
export interface CodexAnswers {
  answers: Record<string, { answers: string[] }>
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Read a server request as a question the phone can answer. `undefined` = not ours (rule 4).
 * ⚠️ Another program's output: a missing or mistyped field means "not ours", never a default.
 */
export function parseUserInput(req: ServerRequest): CodexQuestion | undefined {
  if (req.method !== USER_INPUT_METHOD || !isObject(req.params)) return undefined
  const p = req.params
  const threadId = text(p.threadId)
  const turnId = text(p.turnId)
  const itemId = text(p.itemId)
  if (!threadId || !turnId || !itemId) return undefined
  // ★ Missing = blocking (the source's default). A request that does not block is not one a person must answer now.
  if (p.isBlocking !== undefined && p.isBlocking !== true) return undefined
  if (!Array.isArray(p.questions) || p.questions.length === 0) return undefined
  const questions: CodexQuestionItem[] = []
  for (const raw of p.questions) {
    if (!isObject(raw)) return undefined
    const id = text(raw.id)
    const question = text(raw.question)
    if (!id || !question) return undefined
    // ⚠️ A secret answer would be shown on the phone and travel through the relay. Left to the PC.
    if (raw.isSecret !== false && raw.isSecret !== undefined) return undefined
    if (raw.isOther !== undefined && typeof raw.isOther !== 'boolean') return undefined
    if (!Array.isArray(raw.options) || raw.options.length === 0) return undefined
    const options: CodexQuestionItem['options'] = []
    for (const o of raw.options) {
      if (!isObject(o)) return undefined
      const label = text(o.label)
      if (!label) return undefined
      const description = text(o.description)
      options.push({ label, ...(description ? { description } : {}) })
    }
    // ⚠️ Two equal labels cannot be told apart by the phone (it sends the label)
    if (new Set(options.map((o) => o.label)).size !== options.length) return undefined
    const header = text(raw.header)
    questions.push({ id, question, ...(header ? { header } : {}), options, other: raw.isOther === true })
  }
  // ⚠️ Answers are keyed by id here and by question text on the phone: both must be unique
  if (new Set(questions.map((q) => q.id)).size !== questions.length) return undefined
  if (new Set(questions.map((q) => q.question)).size !== questions.length) return undefined
  return { requestId: req.id, threadId, turnId, itemId, questions }
}

/** The card's question block (what the phone shows; no ids) */
export function questionInteraction(q: CodexQuestion): Interaction {
  return {
    kind: 'question',
    questions: q.questions.map((x) => ({
      question: x.question,
      ...(x.header ? { header: x.header } : {}),
      multiSelect: false,
      options: x.options.map((o) => ({ ...o })),
      // ★ Every Codex question takes a note (rule 3); `answer` = a note alone is an answer too
      note: x.other ? 'answer' : 'add',
    })),
  }
}

export type BuildAnswers = { ok: true; result: CodexAnswers } | { ok: false; message: string }

/** Own keys only (`__proto__` and friends never count as a question) */
function own(rec: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined
}

/**
 * Build the answer from the phone's labels and notes (rule 1). Strict: anything off is refused with a reason, and
 * nothing is sent (the card stays; the person can fix it or answer on the PC).
 */
export function buildCodexAnswers(question: unknown, answers: unknown, notes: unknown): BuildAnswers {
  const q = question as CodexQuestion | undefined
  if (!q || !Array.isArray(q.questions)) {
    return { ok: false, message: t('質問が読めないため、スマホからは答えられません', 'The question could not be read, so it cannot be answered from the phone.') }
  }
  const chosen = answers === undefined ? {} : answers
  const written = notes === undefined ? {} : notes
  if (!isObject(chosen) || !isObject(written)) {
    return { ok: false, message: t('答えの形が正しくありません', 'The answer is not in the right shape.') }
  }
  // ⚠️ Keys we do not know are refused (a screen out of date must not pass silently)
  const texts = q.questions.map((x) => x.question)
  for (const key of [...Object.keys(chosen), ...Object.keys(written)]) {
    if (!texts.includes(key)) {
      return { ok: false, message: t('知らない質問が含まれています（画面を開き直してください）', 'It contains an unknown question. Reopen the screen.') }
    }
  }
  const pairs: [string, { answers: string[] }][] = []
  for (const x of q.questions) {
    const picked = own(chosen, x.question)
    let label: string | undefined
    if (picked !== undefined) {
      if (!Array.isArray(picked) || picked.length > 1 || picked.some((l) => typeof l !== 'string')) {
        return { ok: false, message: t('この質問はひとつだけ選べます', 'Only one option can be chosen for this question.') }
      }
      label = picked[0] as string | undefined
      // ⚠️ Rule 2: only a label that was shown
      if (label !== undefined && !x.options.some((o) => o.label === label)) {
        return { ok: false, message: t('選択肢が一致しません（画面を開き直してください）', 'The options do not match. Reopen the screen.') }
      }
    }
    const rawNote = own(written, x.question)
    if (rawNote !== undefined && typeof rawNote !== 'string') {
      return { ok: false, message: t('書き足す文は文字列で送ってください', 'Send the note as text.') }
    }
    const note = rawNote?.trim() ?? ''
    if (Buffer.byteLength(note, 'utf8') > MAX_MESSAGE_BYTES) {
      return { ok: false, message: t(`長すぎます（${MAX_MESSAGE_BYTES} バイトまで）`, `Too long (up to ${MAX_MESSAGE_BYTES} bytes).`) }
    }
    const out: string[] = []
    if (label !== undefined) out.push(label)
    else if (note && x.other) out.push(NONE_OF_THE_ABOVE)
    else if (note) {
      return { ok: false, message: t('この質問は選択肢から選んでください', 'Choose one of the options for this question.') }
    } else {
      return { ok: false, message: t('すべての質問に答えてください', 'Answer all of the questions.') }
    }
    if (note) out.push(NOTE_PREFIX + note)
    pairs.push([x.id, { answers: out }])
  }
  // ⚠️ `Object.fromEntries` defines (an id of `__proto__` would be swallowed by an assignment)
  return { ok: true, result: { answers: Object.fromEntries(pairs) } }
}
