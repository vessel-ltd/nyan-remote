// Approvals that cannot be answered with "yes/no" (§9.11). **The CLI-side contract is confined to this one file.**
//
// ★★ Why this is needed (2026-08-14 on a real machine → cause confirmed in the CLI 2.1.232 implementation):
//
//   `AskUserQuestion` and `ExitPlanMode` have `requiresUserInteraction()` true in their tool definitions.
//   The code that handles the `PermissionRequest` hook's reply looks like this:
//
//     if (g.behavior === "allow") {
//       if (!g.updatedInput && e.requiresUserInteraction?.()) return null   // ★
//       …
//     }
//
//   Returning `null` makes the caller exit without doing anything. So
//   **an `allow` without `updatedInput` is silently dropped, and the PC dialog keeps waiting.**
//   That was the real-machine symptom "pressing 'yes' on the phone does nothing on the PC" (`deny` is a different branch, so it works).
//
//   We also confirmed how answers are passed in the implementation. `AskUserQuestion`'s input schema has `answers`, and
//   its description is **"User answers collected by the permission component"**.
//   **Key is the question text, value is the option label** (multi-select is comma-separated).
//
// ⚠️⚠️ **Never accept `updatedInput` from the phone.**
//   Accepting it would allow "rewriting the command while pressing approve on a Bash approval".
//   Only **labels** come from the phone. We match them here against the original `tool_input` and build the input.
//
// ⚠️ MCP tools can have the same property via `anthropic/requiresUserInteraction`, but
//   **it cannot be told from the hook payload**. We handle only the two known tools and
//   accept that everything else stays as before (= may be missed).

import type { Interaction, InteractionOption, InteractionQuestion } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'

/**
 * ★ Limit for the diagram attached to an option (`preview`). **Per option**.
 *
 * ⚠️ Do not make it unlimited. `/permissions` returns **all** pending approvals, so
 *    many diagram-bearing questions piling up inflate the response accordingly (same reason as `DETAIL_MAX`).
 * ⚠️⚠️ When clipping, **say it was clipped** (`previewClipped`). If the lower half of a diagram silently vanishes,
 *    the user chooses believing they "saw everything".
 */
export const PREVIEW_MAX = 2000

/** ★ Tools that require `updatedInput` on "allow" (only those confirmed in CLI 2.1.232) */
export const ASK_USER_QUESTION = 'AskUserQuestion'
export const EXIT_PLAN_MODE = 'ExitPlanMode'

export function requiresInteraction(toolName: string): boolean {
  return toolName === ASK_USER_QUESTION || toolName === EXIT_PLAN_MODE
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/**
 * ★ Clip the diagram at the limit. **Keep newlines and leading whitespace** (no wrapping, no squeezing).
 *
 * ⚠️⚠️ **Cut at a grapheme (one visible character) boundary** (2026-08-19 codex review, low #4).
 *    At first we only avoided splitting surrogate pairs, but then
 *    `👩‍💻` became `👩‍` (ending in a ZWJ) / `⚠️` became `⚠` / `é` became `e` + a dangling combining mark.
 *    ⇒ Back off to an `Intl.Segmenter` boundary.
 *
 * ⚠️ `PREVIEW_MAX` is a count of **UTF-16 code units** (`String#length`).
 *    With only extended CJK characters, the limit is reached at 1000 visible characters.
 */
function previewOf(preview: string | undefined): Pick<InteractionOption, 'preview' | 'previewClipped'> {
  if (!preview) return {}
  if (preview.length <= PREVIEW_MAX) return { preview }
  return { preview: clipToGrapheme(preview, PREVIEW_MAX), previewClipped: true }
}

/** Up to the **last grapheme boundary** that does not exceed the limit (anything crossing it is dropped whole) */
export function clipToGrapheme(text: string, max: number): string {
  const S = Intl.Segmenter
  if (typeof S !== 'function') {
    // Old environment. ⚠️ At least do not split surrogate pairs
    const code = text.charCodeAt(max - 1)
    return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
  }
  let out = 0
  for (const g of new S('ja', { granularity: 'grapheme' }).segment(text)) {
    const end = g.index + g.segment.length
    if (end > max) break
    out = end
  }
  return text.slice(0, out)
}

/**
 * Into the shape used for display and validation. **`undefined` for broken input** (then approval is not allowed).
 */
export function describeInteraction(toolName: string, toolInput: unknown): Interaction | undefined {
  if (toolName === EXIT_PLAN_MODE) return { kind: 'plan' }
  if (toolName !== ASK_USER_QUESTION) return undefined
  const input = asRecord(toolInput)
  const raw = input?.['questions']
  if (!Array.isArray(raw)) return undefined
  const questions: InteractionQuestion[] = []
  for (const q of raw) {
    const rec = asRecord(q)
    const question = str(rec?.['question'])
    const opts = rec?.['options']
    if (!question || !Array.isArray(opts)) continue
    const options: InteractionOption[] = []
    for (const o of opts) {
      const or = asRecord(o)
      const label = str(or?.['label'])
      if (!label) continue
      const description = str(or?.['description'])
      options.push({
        label,
        ...(description ? { description } : {}),
        // ★ Diagrams only pass through here. Dropping it means **nothing reaches the screen** (found on a real machine on 2026-08-18)
        ...previewOf(str(or?.['preview'])),
      })
    }
    if (options.length === 0) continue
    const header = str(rec?.['header'])
    questions.push({
      question,
      ...(header ? { header } : {}),
      multiSelect: rec?.['multiSelect'] === true,
      options,
    })
  }
  return questions.length > 0 ? { kind: 'question', questions } : undefined
}

export type BuildResult =
  | { ok: true; updatedInput: Record<string, unknown> }
  | { ok: false; message: string }

/**
 * ★ Build the `updatedInput` attached to "allow".
 *
 * ⚠️ Validate strictly. **Options that were not presented are rejected** (even if the screen's version is out of date,
 *    we never pass the CLI an answer we do not know).
 */
export function buildUpdatedInput(
  toolName: string,
  toolInput: unknown,
  answers: Record<string, string[]> | undefined,
): BuildResult {
  if (toolName === EXIT_PLAN_MODE) {
    const input = asRecord(toolInput)
    const plan = str(input?.['plan'])
    if (!plan) return { ok: false, message: t('プランの本文が読めないため、スマホからは許可できません', 'The plan text could not be read, so it cannot be approved from the phone.') }
    // ★ The CLI itself narrows the input to plan / planFilePath, so use the same shape
    const planFilePath = str(input?.['planFilePath'])
    return {
      ok: true,
      updatedInput: { plan, ...(planFilePath ? { planFilePath } : {}) },
    }
  }

  if (toolName !== ASK_USER_QUESTION) {
    return { ok: false, message: t('この道具はスマホからの選択に対応していません', 'This tool does not support choosing from the phone.') }
  }

  const described = describeInteraction(toolName, toolInput)
  if (!described || described.kind !== 'question') {
    return { ok: false, message: t('質問の形が読めないため、スマホからは答えられません', 'The question format could not be read, so it cannot be answered from the phone.') }
  }
  const chosen = answers ?? {}
  // ⚠️⚠️ **Two identical question texts cannot be answered from the phone** (2026-08-19 codex review, medium #2).
  //    `answers` is keyed by question text (the CLI's spec), so there is no way to tell them apart.
  //    ⇒ Rather than silently saying "the options do not match", **refuse with the reason**
  const texts = described.questions.map((q) => q.question)
  if (new Set(texts).size !== texts.length) {
    return { ok: false, message: t('同じ質問文が複数あるため、スマホからは答えられません（PCで答えてください）', 'Several questions have the same text, so they cannot be answered from the phone. Answer on the PC.') }
  }
  // ⚠️ With a question text of `__proto__`, **the assignment (`out[key] =`) is swallowed by the special setter and the answer vanishes**
  //    (`answers` came out empty despite `ok:true`. Same review, medium #2).
  //    ⇒ Collect pairs and build with `Object.fromEntries` (it becomes **a definition, not an assignment**)
  const pairs: [string, string][] = []
  for (const q of described.questions) {
    const picked = chosen[q.question]
    if (!Array.isArray(picked) || picked.length === 0) {
      return { ok: false, message: t('すべての質問に答えてください', 'Answer all of the questions.') }
    }
    if (!q.multiSelect && picked.length > 1) {
      return { ok: false, message: t('この質問はひとつだけ選べます', 'Only one option can be chosen for this question.') }
    }
    const labels = q.options.map((o) => o.label)
    for (const p of picked) {
      // ⚠️ This is the key point. **Reject anything but the presented labels**
      if (!labels.includes(p)) {
        return { ok: false, message: t('選択肢が一致しません（画面を開き直してください）', 'The options do not match. Reopen the screen.') }
      }
    }
    if (new Set(picked).size !== picked.length) {
      return { ok: false, message: t('同じ選択肢が重複しています', 'The same option was chosen more than once.') }
    }
    // Multi-select is comma-separated (matches the description in the CLI's output schema)
    pairs.push([q.question, picked.join(', ')])
  }
  // ⚠️ Refuse if unknown keys are mixed in (do not silently pass a version mismatch between screen and agent)
  for (const key of Object.keys(chosen)) {
    if (!described.questions.some((q) => q.question === key)) {
      return { ok: false, message: t('知らない質問が含まれています（画面を開き直してください）', 'It contains an unknown question. Reopen the screen.') }
    }
  }

  const input = asRecord(toolInput) ?? {}
  // ★ Just add answers to the original input. **Other keys cannot be changed from the phone**
  return { ok: true, updatedInput: { ...input, answers: Object.fromEntries(pairs) } }
}
