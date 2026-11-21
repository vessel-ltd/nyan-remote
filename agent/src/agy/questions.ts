// ★★ agy questions (`ask_question`) answered from the phone (2026-11-21 / docs/AGY.md §13).
//
// Measured on agy 1.5.13 (2026-11-21, a relayed tmux agy):
//   - The call: `{name: 'ask_question', args: {questions: [{question, options: ['apple', 'banana'], is_multi_select}]}}`
//     (`questions` was a list; an earlier call recorded it as a JSON string: both are read). Options are plain strings.
//   - The PC shows one question at a time ("Question 1/2") with the options numbered and a last "Write-in..." row.
//   - Single-select: a digit picks that option at once and goes to the next question; on the last one it submits all.
//   - Multi-select: a digit toggles that option (`[x]`); → goes to the next question; Enter on the last submits all.
//   - Write-in (the number after the options): a field "Your answer:" opens; the text is typed, Enter takes it and goes
//     on (single-select, also when not last) or submits all (the last question). On a multi-select the written text is
//     added to the toggled options ("A2: saw, nails").
//   - ESC skips the question on screen ("User Skipped") and goes to the next; one ESC per question skips them all.
//   - The answer is recorded as one GENERIC result: "A1: banana\nA2: red, green".
//
// The rules:
//  1. ⚠️⚠️ The phone sends labels and notes, never keys. The keys are built here from the call the agent read
//     (the same rule as Claude's `updatedInput` and Codex's answers): a label that was not shown is refused.
//  2. ⚠️ What was not measured stays on the PC (no card): more than 8 options (the write-in row would need two digits),
//     a note on a multi-select that is not the last question (Enter there was not measured), a shape that is off,
//     duplicate questions or options (the phone answers by text).
//  3. A note is typed into the write-in field: one line (CR / LF become spaces, control characters go), not starting
//     with `/`, `!` or `?` (if the dialog closed in the meantime, the text would land in agy's prompt), at most
//     `NOTE_MAX_BYTES`. On a single-select it is the answer instead of an option (not both).

import type { Interaction } from '../../../shared/types.ts'
import { visibleHead } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'
import type { PendingCall } from './pending.ts'
import { AGY_QUESTION_TOOL } from './sessions.ts'

/**
 * ★ What the phone takes, by whether the agy's relay shows its screen (docs/AGY.md §14):
 * - blind (an older relay): one question per call, at most 8 options (the write-in row is still one digit). A batch
 *   cannot be seen to be untouched (the PC writes nothing until it is submitted), so a key could answer another question
 *   (codex review) — it rings and is answered on the PC.
 * - with the screen: batches and long lists too; every key is checked against what the screen shows (`keys.ts`).
 */
export const LIMITS = { blind: { questions: 1, options: 8 }, screen: { questions: 8, options: 40 } } as const
/** (the blind limits, as before) */
export const MAX_OPTIONS = LIMITS.blind.options
export const MAX_QUESTIONS = LIMITS.blind.questions
export const NOTE_MAX_BYTES = 2000

export interface AgyQuestionItem {
  question: string
  options: string[]
  multi: boolean
}

export interface AgyQuestion {
  items: AgyQuestionItem[]
}

/** One step typed into agy: a fixed key or the text of a note */
export type AgyStep = { key: string } | { text: string }

export const STEP_KEYS = { enter: '\r', next: '\x1b[C', skip: '\x1b' } as const

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** ★ Read an `ask_question` call. undefined = not one the phone takes (rule 2) */
export function parseAgyQuestion(call: Pick<PendingCall, 'name' | 'args'>, screen = false): AgyQuestion | undefined {
  const limit = screen ? LIMITS.screen : LIMITS.blind
  if (call.name !== AGY_QUESTION_TOOL) return undefined
  let raw: unknown = call.args['questions']
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > limit.questions) return undefined
  const items: AgyQuestionItem[] = []
  for (const q of raw) {
    if (!isObj(q)) return undefined
    const question = q['question']
    const options = q['options']
    const multi = q['is_multi_select']
    if (typeof question !== 'string' || question.trim() === '') return undefined
    if (multi !== undefined && typeof multi !== 'boolean') return undefined
    if (!Array.isArray(options) || options.length === 0 || options.length > limit.options) return undefined
    if (!options.every((o) => typeof o === 'string' && o.trim() !== '')) return undefined
    if (new Set(options).size !== options.length) return undefined
    items.push({ question, options: options as string[], multi: multi === true })
  }
  if (new Set(items.map((x) => x.question)).size !== items.length) return undefined
  return { items }
}

/**
 * ★ The question texts of any `ask_question` call, also one the phone does not take (duplicate options, too long …):
 * the screen tells dialogs apart by text, so such a sibling must still count as "another question with this text"
 * (codex review: its dialog took the phone's answer for a twin). undefined = not readable at all.
 */
export function questionTextsOf(call: Pick<PendingCall, 'name' | 'args'>): string[] | undefined {
  if (call.name !== AGY_QUESTION_TOOL) return []
  let raw: unknown = call.args['questions']
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const q of raw) {
    if (!isObj(q) || typeof q['question'] !== 'string') return undefined
    out.push(q['question'])
  }
  return out
}

/** Whether this question takes a written answer from the phone (rule 2: not a multi-select before the last) */
function takesNote(q: AgyQuestion, i: number): boolean {
  return !q.items[i]!.multi || i === q.items.length - 1
}

/** The card's question block (what the phone shows) */
export function agyQuestionInteraction(q: AgyQuestion): Interaction {
  return {
    kind: 'question',
    questions: q.items.map((x, i) => ({
      question: x.question,
      multiSelect: x.multi,
      options: x.options.map((label) => ({ label })),
      ...(takesNote(q, i) ? { note: 'answer' as const } : {}),
    })),
  }
}

/** ★ The answer as choices (option indexes from 0, a note), typed step by step against the screen (`keys.ts`) */
export interface AgyAnswerPlan {
  items: { indexes: number[]; note?: string }[]
}

/**
 * The answer as a plan, and as fixed keys when every question fits the digits (a blind relay types those; undefined
 * otherwise — such a question never has a card there).
 */
export type BuildSteps = { ok: true; plan: AgyAnswerPlan; steps?: AgyStep[] } | { ok: false; message: string }

function own(rec: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined
}

/** ★ A note as typed into the write-in field (rule 3); a message when it cannot be */
export function noteForKeys(raw: string): { ok: true; text: string } | { ok: false; message: string } {
  // ⚠️ Every line break (also NEL and the Unicode separators) becomes a space; other control characters (C0, DEL, C1) go
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/\r\n|[\r\n\t\u0085\u2028\u2029]/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()
  if (Buffer.byteLength(text, 'utf8') > NOTE_MAX_BYTES) {
    return { ok: false, message: t(`長すぎます（${NOTE_MAX_BYTES} バイトまで）`, `Too long (up to ${NOTE_MAX_BYTES} bytes).`) }
  }
  const head = visibleHead(text).charAt(0)
  if (head === '/' || head === '!' || head === '?') {
    return { ok: false, message: t('`/` `!` `?` で始まる答えは書けません。前に語を足してください', 'An answer cannot start with `/`, `!` or `?`. Add a word in front.') }
  }
  return { ok: true, text }
}

/**
 * ★ The keys for the phone's answer (rule 1). Strict: anything off is refused with a reason and nothing is typed (the
 * card stays; the person can fix it or answer on the PC).
 */
export function buildAgySteps(question: unknown, answers: unknown, notes: unknown): BuildSteps {
  const q = question as AgyQuestion | undefined
  if (!q || !Array.isArray(q.items)) {
    return { ok: false, message: t('質問が読めないため、スマホからは答えられません', 'The question could not be read, so it cannot be answered from the phone.') }
  }
  const chosen = answers === undefined ? {} : answers
  const written = notes === undefined ? {} : notes
  if (!isObj(chosen) || !isObj(written)) return { ok: false, message: t('答えの形が正しくありません', 'The answer is not in the right shape.') }
  const texts = q.items.map((x) => x.question)
  for (const key of [...Object.keys(chosen), ...Object.keys(written)]) {
    if (!texts.includes(key)) {
      return { ok: false, message: t('知らない質問が含まれています（画面を開き直してください）', 'It contains an unknown question. Reopen the screen.') }
    }
  }
  const steps: AgyStep[] = []
  const plan: AgyAnswerPlan = { items: [] }
  const digits = q.items.every((x) => x.options.length <= LIMITS.blind.options)
  for (let i = 0; i < q.items.length; i++) {
    const x = q.items[i]!
    const last = i === q.items.length - 1
    const picked = own(chosen, x.question)
    let labels: string[] = []
    if (picked !== undefined) {
      if (!Array.isArray(picked) || picked.some((l) => typeof l !== 'string')) {
        return { ok: false, message: t('答えの形が正しくありません', 'The answer is not in the right shape.') }
      }
      labels = picked as string[]
    }
    if (new Set(labels).size !== labels.length) return { ok: false, message: t('同じ選択肢が2回あります', 'The same option is chosen twice.') }
    if (!x.multi && labels.length > 1) return { ok: false, message: t('この質問はひとつだけ選べます', 'Only one option can be chosen for this question.') }
    const indexes: number[] = []
    for (const l of labels) {
      const k = x.options.indexOf(l)
      if (k < 0) return { ok: false, message: t('選択肢が一致しません（画面を開き直してください）', 'The options do not match. Reopen the screen.') }
      indexes.push(k)
    }
    const rawNote = own(written, x.question)
    if (rawNote !== undefined && typeof rawNote !== 'string') return { ok: false, message: t('書いた答えは文字列で送ってください', 'Send the written answer as text.') }
    let note = ''
    if (rawNote !== undefined && rawNote.trim() !== '') {
      if (!takesNote(q, i)) return { ok: false, message: t('この質問には書いて答えられません（PC で答えてください）', 'This question cannot take a written answer (answer it on the PC).') }
      const n = noteForKeys(rawNote)
      if (!n.ok) return { ok: false, message: n.message }
      note = n.text
    }
    if (!x.multi && labels.length === 1 && note) {
      return { ok: false, message: t('選ぶか書くかのどちらか1つにしてください', 'Either choose an option or write an answer, not both.') }
    }
    if (indexes.length === 0 && !note) return { ok: false, message: t('すべての質問に答えてください', 'Answer all of the questions.') }
    plan.items.push({ indexes: [...indexes].sort((a, b) => a - b), ...(note ? { note } : {}) })
    const write = x.options.length + 1
    if (!x.multi) {
      if (note) steps.push({ key: String(write) }, { text: note }, { key: STEP_KEYS.enter })
      else steps.push({ key: String(indexes[0]! + 1) })
      continue
    }
    // ★ In the order shown (a digit also moves the cursor; the order does not change the answer)
    for (const k of [...indexes].sort((a, b) => a - b)) steps.push({ key: String(k + 1) })
    if (note) steps.push({ key: String(write) }, { text: note }, { key: STEP_KEYS.enter })
    else steps.push({ key: last ? STEP_KEYS.enter : STEP_KEYS.next })
  }
  return { ok: true, plan, ...(digits ? { steps } : {}) }
}

/** ★ "Skip" from the phone: one ESC per question (measured: each skips the one on screen) */
export function skipSteps(q: AgyQuestion): AgyStep[] {
  return q.items.map(() => ({ key: STEP_KEYS.skip }))
}
