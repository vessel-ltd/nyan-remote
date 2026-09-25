// Input box for sending instructions from the phone (M4-2 / ARCHITECTURE.md §9.10).
//
// ★ **Always present** at the bottom of the thread (user's choice, 2026-08-14). Same
//   "thumb-reachable position" as the approval cards. Not needing an open step is fastest.
//
// ⚠️ Drafts live in **localStorage** (no server-side state / CLAUDE.md §2, §7.3).
//    The app crashing or a phone call arriving mid-typing is common, so losing drafts hurts.
// ⚠️ Sending is **button only**. Enter inserts a newline (a mis-send on a phone cannot be undone).
//    For the PC, only Ctrl/⌘+Enter is accepted.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import { MAX_MESSAGE_BYTES } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'
import { perMessageNote } from './sendMark.ts'
import { Nyan } from './Nyan.tsx'

const DRAFT_PREFIX = 'tmux-agent.draft.'
/** ★ Uses the same value as the agent (separate copies drift into "sendable but rejected") */
const MAX_BYTES = MAX_MESSAGE_BYTES
/** Maximum height the input grows to (px). Keep in sync with the CSS max-height */
const MAX_HEIGHT = 120

export function draftKey(sessionId: string): string {
  return `${DRAFT_PREFIX}${sessionId}`
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function Composer({
  sessionId,
  disabled,
  hint,
  result,
  busy,
  ctx,
  onSend,
}: {
  sessionId: string
  /** Cannot send to a session that is not running (the agent also rejects with 409) */
  disabled?: boolean
  /**
   * ★ Caution when sending to this session (currently "an English wrapper is added" / `ui/sendMark.ts`).
   * ⚠️ Shows text **already completed by the caller** (not assembled here).
   */
  hint?: string
  /**
   * ★★ **Result of an action** (right after sending / stopping). Added 2026-08-24.
   *
   * ⚠️⚠️ This used to be shown at the **top** of the thread, so a user near the input box
   *    **never saw it** (reported on a real device as "nothing shows after sending").
   *    Stop's success/failure lived there too, so **the most important text was invisible**.
   * ⇒ The input box is `position: fixed`, so **showing it here guarantees it is seen**.
   */
  result?: { bad: boolean; text: string }
  /**
   * ★★ The line above the input box (where the CLI shows `✢ Cooking…`). User's choice, 2026-08-28.
   *
   * ⚠️⚠️ **Do not decide here.** The input comes from `composerBusy` in `ui/status.ts`
   *    (running/stopped is decided only in `showNyan`. Copying the condition makes state and picture disagree).
   * ⚠️⚠️ **Do not make this `?`** (if optional, a caller could drop it and still type-check,
   *    and it would silently vanish from the screen. Same reason as `waitingFor` / `lastEvent`).
   * ⚠️ It goes **above the input box**. Inline (left of the input) makes the input 56px narrower
   *    on a 320px device, and showing it only while busy **makes the width jump mid-typing**, so rejected.
   */
  busy: { label: string; cls: string; running: boolean } | null
  /**
   * ★ Amount of context currently in use (e.g. `1.2M` / user request 2026-09-24). Shown at the right end of the cat line.
   * ⚠️ undefined if unknown (not shown). Formatted with the same `formatTokens` as the list (built by the caller).
   */
  ctx: string | undefined
  onSend: (text: string) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const area = useRef<HTMLTextAreaElement | null>(null)
  const box = useRef<HTMLDivElement | null>(null)

  /**
   * ★★★ **Measure and publish** the padding for the fixed input box (`--pad-h`) (codex 2026-08-28, medium #5 and #7).
   *
   * ⚠️⚠️ It used to be a **hard-coded** `calc(58px + …)` on `:root`. It is used by
   *    `.composerpad` (the slot at the end of the thread) and by `.permswrap`'s `scroll-margin-bottom`
   *    (where approval buttons land), so **if it differs from the real height, the text and approval
   *    buttons hide behind the input box**. ⚠️ There are more ways for a hard-coded value to lie than expected:
   *      - **typing multiple lines grows the textarea from 42 → 120px** (+78px)
   *      - one line each for `error` / `result` / `tooLong` / `hint` / the slash warning
   *      - the "responding" line (`busy`)
   *      - the device notch (`env(safe-area-inset-bottom)`)
   *    I wrote "reserved room for just the responding line (1.87px spare)", but **missed the multi-line
   *    paths above** (codex medium #7). ⇒ **Stop computing it with a formula; measure it.**
   *
   * ★ Copied straight from the technique established after tripping three times on `--bar-h` (the sticky bar) (CLAUDE.md §5).
   * ⚠️ Measurement is **two-layered**: (1) every render (height changes almost always come with a render)
   *    (2) `ResizeObserver` (changes without a render, e.g. rotation). Without (1), **tracking stops in
   *    environments where observation doesn't work** (codex round 2, low #4).
   *
   * ★★ **This only reserves space; it does not chase the scroll position** (confirmed on a real device 2026-08-28).
   *    Growth only lengthens the document, so while typing the last message is **covered**.
   *    ⚠️ But **it can be revealed by swiping** (before the fix there wasn't enough room and it **couldn't be**).
   * ⚠️⚠️ **Do not add automatic scrolling to the bottom.** The reasons are in CLAUDE.md
   *    (auto-scroll sites are fixed at three = scar from the incident where approval cards stopped showing /
   *    moving while typing fights the iOS keyboard offset). By user decision **the behavior stays as is**.
   * ⚠️⚠️ **Do not add `env(safe-area-inset-bottom)`.** `.composer`'s `padding-bottom` is already
   *    `calc(8px + env(...))`, so the measured size already includes it (**double counting** is exactly
   *    what we tripped on with `--bar-h`).
   * ⚠️⚠️ **Observe with `border-box`.** The default (content-box) **doesn't fire on padding changes**,
   *    so a stale height remains when the notch changes on device rotation.
   * ⚠️ Written in `useLayoutEffect` (before paint; `useEffect` shows padding that is one frame stale).
   */
  const writePad = () => {
    const el = box.current
    if (!el) return
    document.documentElement.style.setProperty(
      '--pad-h',
      `${el.getBoundingClientRect().height}px`,
    )
  }

  /**
   * ★★ **Re-measure on every render** (codex 2026-08-28 round 2, low #4).
   *
   * ⚠️⚠️ It relied solely on the `ResizeObserver` below, so **where observation doesn't work** it measured
   *    once at first and then **stopped tracking** (open with one line and type eight: measured 164px while
   *    `--pad-h` stayed at 87px = about 77px hidden behind it).
   * ★ Height changes **almost always come with a render** (text grows, a notice appears,
   *   the cat line comes and goes), so measuring here keeps up even without observation.
   * ⚠️ No dependency list (= runs every time). `useLayoutEffect`, so before paint.
   */
  useLayoutEffect(writePad)

  /**
   * ★ Changes without a render (**device rotation** changing the notch, split view) are tracked by observation.
   *
   * ⚠️⚠️ **Watch with `border-box`.** The default (content-box) **doesn't fire on padding changes**,
   *    and since `.composer` reserves the notch with `padding-bottom`, rotation would leave a stale value
   *    (the same thing we actually tripped on and fixed with `--bar-h`).
   * ⚠️ Cleanup removes it and falls back to the `:root` safety value (no stale measurement after returning to the list).
   */
  useLayoutEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(writePad)
    ro.observe(el, { box: 'border-box' })
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => () => document.documentElement.style.removeProperty('--pad-h'), [])

  // Read/write the draft (per session)
  useEffect(() => {
    try {
      setText(localStorage.getItem(draftKey(sessionId)) ?? '')
    } catch {
      setText('')
    }
    setError(undefined)
  }, [sessionId])

  useEffect(() => {
    try {
      if (text) localStorage.setItem(draftKey(sessionId), text)
      else localStorage.removeItem(draftKey(sessionId))
    } catch {
      // Typing still works even if storage is unwritable (private mode, etc.)
    }
  }, [text, sessionId])

  // Grow the height with the input (capped)
  const grow = () => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    // ⚠️ With `box-sizing: border-box`, **it is 2px short unless the border is added**.
    //    When short, a vertical scrollbar (▲▼) appears even with a single line
    //    (noticed in a Playwright screenshot, confirmed with clientHeight 38 / scrollHeight 40).
    const border = el.offsetHeight - el.clientHeight
    const full = el.scrollHeight + border
    el.style.height = `${Math.min(full, MAX_HEIGHT)}px`
    // No scrollbar until fully grown (with one line it looks cramped)
    el.style.overflowY = full > MAX_HEIGHT ? 'auto' : 'hidden'
  }
  useEffect(grow, [text])

  const tooLong = byteLength(text) > MAX_BYTES
  /**
   * ★ Slash commands **don't get through** (hit twice on a real device, 2026-08-14).
   *
   * ⚠️ On the inbox path the CLI injects with `skipSlashCommands: true` (intentionally).
   *    Both `/status` and `/code-review` arrive **as plain strings**.
   *    Passing them silently looks like "I typed it and nothing happened", so say so before sending.
   */
  // ★ Decided in one place, `ui/sendMark.ts` (⚠️ same shape as the agent = strip control chars, then look at the start)
  const note = perMessageNote(text)
  const canSend = !disabled && !sending && text.trim().length > 0 && !tooLong

  const send = async () => {
    if (!canSend) return
    setSending(true)
    setError(undefined)
    try {
      await onSend(text)
      setText('')
      try {
        localStorage.removeItem(draftKey(sessionId))
      } catch {
        // The send succeeded even if the draft can't be removed
      }
    } catch (err) {
      // ⚠️ **Don't clear the input** on failure (retyping is the worst experience)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div class="composer" ref={box}>
      {/* ⚠️ The reason sending is unavailable goes **in the placeholder**. A separate line would say it twice
             and occupy the bottom of the screen the whole time you read the history */}
      {error ? <p class="notice bad composererr">{error}</p> : null}
      {/* ★★ Cat and status (where the CLI shows `✢ Cooking…`).
             ⚠️ This line coming and going changes the input's height, but **`--pad-h` is measured and published above**,
                so no formula needs recounting (a hard-coded value hides the text and approval buttons).
             ⚠️ Shown even when stopped (the cat rests).
             ⚠️ The meaning is **carried by the text** (not by the picture alone). Wording, color and running
                all come from `composerBusy` = no state decision here */}
      {busy ? (
        <p class="composerbusy">
          <Nyan running={busy.running} />
          <span class={`state ${busy.cls}`}>{busy.label}</span>
          {ctx ? (
            <span class="chip ctx composerctx" title={t('いま使っているコンテキストの量（最後の応答時点）', 'Context currently in use (as of the last response)')}>
              ctx {ctx}
            </span>
          ) : null}
        </p>
      ) : null}
      <div class="composerrow">
        <textarea
          ref={area}
          class="composerinput"
          rows={1}
          value={text}
          disabled={disabled}
          // ⚠️ The input is only one line tall (it grows for **typed text** only).
          //    A long placeholder gets **its second line cut off** (confirmed in a Playwright screenshot). Keep it short
          placeholder={
            disabled
              ? t('動いていないので送れません', 'Not running, can’t send')
              : t('指示を送る…', 'Send an instruction…')
          }
          onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            // ⚠️ Plain Enter does not send (a mis-send on a phone cannot be undone)
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button class="composersend" disabled={!canSend} onClick={() => void send()}>
          {sending ? '…' : t('送信', 'Send')}
        </button>
      </div>
      {/* ★ Action results go **here** (the input box is fixed on screen, so it is always visible) */}
      {result ? (
        <p class={`notice composerhint${result.bad ? ' bad' : ''}`}>{result.text}</p>
      ) : null}
      {tooLong ? <p class="notice bad composererr">
          {t(`長すぎます（${MAX_BYTES} バイトまで）`, `Too long (max ${MAX_BYTES} bytes)`)}
        </p> : null}
      {/* ★ The point is to know before sending (previously you only noticed afterwards via the "from phone" tag) */}
      {hint ? <p class="notice warn composerhint">{hint}</p> : null}
      {/* ★★ Behavior changed on 2026-08-24: instead of rejecting and dropping into the inbox,
             **prefix one space and send via keystrokes** (measured: this disables the CLI's command parsing).
             ⇒ The correct description is "**arrives as plain text**", not "gets a wrapper". */}
      {note === 'slash' && !tooLong ? (
        <p class="notice warn composerhint">
          {t(
            'スラッシュコマンドは実行されません（先頭に空白を1つ足して、',
            'Slash commands are not run (a space is added at the start, so it arrives ',
          )}
          <strong>{t('文章として', 'as plain text')}</strong>
          {t('届きます）。', '). Ask in words instead, like ')}
          <strong>{t('「コードレビューして」', '“review the code”')}</strong>
          {t('のように言葉で頼んでください', '')}
        </p>
      ) : null}
      {note === 'bang' && !tooLong ? (
        <p class="notice warn composerhint">
          {t('', 'Instructions starting with ')}
          <code>!</code>
          {t(
            ' で始まる指示は実行されません（先頭に空白を1つ足して、',
            ' are not run (a space is added at the start, so it arrives ',
          )}
          <strong>{t('文章として', 'as plain text')}</strong>
          {t('届きます）', ')')}
        </p>
      ) : null}
    </div>
  )
}
