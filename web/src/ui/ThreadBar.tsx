import { useEffect, useRef, useState } from 'preact/hooks'
import type { SessionSummary } from '../../../shared/types.ts'
import type { ThreadAlert } from './alerts.ts'
import { statusView } from './status.ts'
import { t } from '../../../shared/i18n.ts'

/**
 * The bar that sticks to the top of the thread (2026-08-18).
 *
 * ★ The goal is to always know "**which thread you are in**" (user request).
 *   The session name was shown before, but **it was in normal flow, so it scrolled away**.
 *
 * ★ The state (working / running in background / needs attention) lives here too. It is **changing information**,
 *   so having to scroll back up to see it is inconvenient (the details = account, project, branch
 *   only need one look on entering, so they stay below and scroll away).
 *
 * ★ The second line is "what is waiting in **another thread**" (`alerts.ts`). A line for clearing
 *   accumulated approvals in order without going back to the list.
 *
 * ⚠️ Previously "a back button in the header scrolls away", so it floated
 *    (2026-08-13). **That was about a normal-flow header**; a sticky one does not disappear.
 *    Putting it here made the special calculation aligning the floating button to the content column on PC
 *    (`calc(50% - 328px)`) unnecessary for the `← list` button.
 *
 * ⚠️ Always pass text as JSX children (the session name comes from the conversation / no innerHTML).
 */
export interface ThreadBarAction {
  label: string
  onClick: () => void
}

/**
 * ★★ The auto-approve mode warning (the bar's second line).
 *
 * ⚠️⚠️ This feature is the **opposite of "stops if unnoticed": it keeps running if unnoticed**. So
 *    **keep it shown in the bar, not inside the menu** (never a state you only find by opening `⋯`).
 * ⚠️ **It is itself the off button** (bar → menu → confirm is too many layers to reach in a panic).
 * ⚠️ Whether it shows is decided by `ui/autoApprove.ts` (**never cleared by the device clock**).
 */
export interface ThreadBarAuto {
  /** "⚡ Auto-approve on · 2h41m left" (text from `autoApproveBanner`) */
  text: string
  /** Pressing turns it off. ⚠️ No confirmation (turning off is the urgent action) */
  onOff: () => void
  /** Not pressable while sending (prevents double taps) */
  disabled: boolean
}

export function ThreadBar({
  sessionId,
  title,
  session,
  alert,
  onJump,
  onBack,
  actions,
  auto,
}: {
  /** ★ The open thread. **Also used to close "…" when it changes** */
  sessionId: string
  /** The name to show (the start of the ID when the session is not in the list) */
  title: string
  session?: SessionSummary
  /**
   * ★ What is waiting in another thread (`undefined` if none).
   * ⚠️ Decided by `alerts.ts` (pure functions). This only draws it
   * ⚠️ **Not optional** (do not allow a shape where dropping it still type-checks)
   */
  alert: ThreadAlert | null
  /** Navigation when the second line is pressed (`main.tsx` rewrites the hash) */
  onJump: (sessionId: string) => void
  onBack: () => void
  /** ★ What goes in "…". **This is the place for future additions** (line 1 stays one line as they grow) */
  actions: ThreadBarAction[]
  /**
   * ★ The auto-approve mode warning (`null` when not in effect).
   * ⚠️⚠️ **Not optional** (do not allow a shape where dropping it still type-checks = same discipline as `alert`.
   *    Forgetting to pass it means "approving but not on screen" = the most dangerous state for this feature)
   */
  auto: ThreadBarAuto | null
}) {
  const [open, setOpen] = useState(false)
  /** ★ Only **the menu and `⋯`** are protected (the whole bar would stop closing when the name is tapped) */
  const popRef = useRef<HTMLDivElement | null>(null)
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  const barRef = useRef<HTMLElement | null>(null)
  const view = session ? statusView(session.status, session.live, session.waitingFor) : null

  /**
   * ★★ Write the bar's **actual size** to `--bar-h`. The CSS looks only at this.
   *
   * ⚠️⚠️ It used to be `scroll-margin-top: calc(env(safe-area-inset-top) + var(--jump-h) + 10px)`,
   *    **duplicating the bar height as a formula**. The moment the second line appeared the formula became a lie,
   *    and the target of "↑ To top" **hid behind the bar** (the same bug hit twice on 2026-08-18:
   *    forgetting the notch / double-counting with `#app`'s padding).
   *    → **Stop duplicating the formula**. `getBoundingClientRect()` is the actual size **including** the notch
   *      padding, so neither double-counting nor forgetting can happen in principle.
   * ⚠️ It changes for more than the second line (font size, wrapping, device insets).
   *    So it is tracked with `ResizeObserver` (where absent, we settle for the first measurement).
   */
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const root = document.documentElement
    const write = () => root.style.setProperty('--bar-h', `${el.getBoundingClientRect().height}px`)
    write()
    if (typeof ResizeObserver === 'undefined') {
      return () => root.style.removeProperty('--bar-h')
    }
    const ro = new ResizeObserver(write)
    // ⚠️⚠️ **Observe with `border-box`.** The default (content-box) **does not fire on padding changes**.
    //    The bar reserves the notch with `padding-top: env(safe-area-inset-top)`, so
    //    when the inset changes (**device rotation**, split view) `--bar-h` would stay stale,
    //    and "↑ To top" would hide behind the bar. **Fixed after artificially inserting 47px, measuring,
    //    and confirming it did not fire** (2026-08-18).
    ro.observe(el, { box: 'border-box' })
    return () => {
      ro.disconnect()
      // Cleared on returning to the list (no stale height on a screen without the bar)
      root.style.removeProperty('--bar-h')
    }
  }, [])

  /**
   * ★ Close when the thread changes.
   *
   * ⚠️ `<Thread>` **is not recreated when the session changes** (it has no key), so
   *    moving A → B via a notification or hash change **leaves the menu open**
   *    (2026-08-18 codex review, low).
   */
  useEffect(() => setOpen(false), [sessionId])

  /**
   * Close when the outside is touched.
   *
   * ⚠️ **Listen to `pointerdown`, not `click`.** iOS Safari sometimes does not bubble `click` up to
   *    `document` when a "non-pressable element" is tapped, so **tapping the conversation text
   *    does not close it** (2026-08-18 /code-review, low #4).
   * ⚠️ In exchange, `pointerdown` arrives before an item's `click`. **Doing nothing inside the bar**
   *    prevents an item press from not responding (the menu vanishing first and the click being lost).
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: Event) => {
      const t = e.target
      if (!(t instanceof Node)) return
      // Protect only the inside of the menu (so item clicks are not lost) and `⋯` itself (the onClick below closes it)
      if (popRef.current?.contains(t) || toggleRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <header class="threadbar" ref={barRef}>
      <div class="tbrow">
        <button class="tbbtn" onClick={onBack} aria-label={t('一覧へ戻る', 'Back to list')}>
          ←
        </button>
        <span class="tbtitle">{title}</span>
        {view ? (
          <>
            <span class={`dot ${view.cls}`} aria-hidden="true" />
            <span class={`state ${view.cls}`}>{view.label}</span>
          </>
        ) : null}
        {actions.length > 0 ? (
          <>
            <button
              class="tbbtn"
              ref={toggleRef}
              aria-label={t('そのほかの操作', 'More actions')}
              aria-haspopup="true"
              aria-expanded={open ? 'true' : 'false'}
              onClick={() => setOpen(!open)}
            >
              ⋯
            </button>
            {open ? (
              <div class="tbmenu" ref={popRef}>
                {actions.map((a) => (
                  <button
                    key={a.label}
                    class="tbmenuitem"
                    onClick={() => {
                      setOpen(false)
                      a.onClick()
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {/* ★★ The auto-approve mode warning. ⚠️ **Never hidden inside the menu** (it keeps running if unnoticed).
          ⚠️ Pressing turns it off (no confirmation). The text is in one place, `autoApproveBanner` */}
      {auto ? (
        <button
          class="tbauto"
          onClick={() => {
            if (!auto.disabled) auto.onOff()
          }}
          aria-label={t(
            `${auto.text}。押すと自動承認をオフにします`,
            `${auto.text}. Tap to turn off auto-approve`,
          )}
        >
          <span class="tbautolabel">{auto.text}</span>
          <span class="tbago">{auto.disabled ? '…' : t('オフにする ›', 'Turn off ›')}</span>
        </button>
      ) : null}

      {/* ★ What is waiting in another thread. Orange = answerable on the phone / grey = a cue to go back to the PC.
          ⚠️ Pressing it means different things, so it is distinguished by **both colour and text** (not colour alone) */}
      {alert ? (
        <button
          class={alert.kind === 'permission' ? 'tbalert' : 'tbalert quiet'}
          onClick={() => onJump(alert.sessionId)}
          aria-label={
            (alert.kind === 'permission'
              ? t(
                  `承認 ${alert.count} 件。${alert.title} に移動`,
                  `${alert.count} approval(s). Go to ${alert.title}`,
                )
              : t(
                  `要対応 ${alert.count} 件。${alert.title} に移動（PCで対応）`,
                  `${alert.count} need(s) you. Go to ${alert.title} (handle on the PC)`,
                )) +
            (alert.machine ? t(`。マシン ${alert.machine}`, `. Machine ${alert.machine}`) : '')
          }
        >
          <span class="tbacount">
            {alert.kind === 'permission' ? t('承認', 'Approval') : t('要対応', 'Needs you')} {alert.count}
          </span>
          {/* ★ Which PC (only present with 2+ machines). For grey, "handle on PC", **this is the key information** */}
          {alert.machine ? <span class="tbamachine">{alert.machine}</span> : null}
          <span class="tbalabel">
            {alert.title}
            {alert.detail ? t(`・${alert.detail}`, ` · ${alert.detail}`) : ''}
          </span>
          <span class="tbago">{alert.kind === 'permission' ? '›' : t('PCで対応 ›', 'Handle on PC ›')}</span>
        </button>
      ) : null}
    </header>
  )
}
