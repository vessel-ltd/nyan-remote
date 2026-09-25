// Confirmation shown before an irreversible action.
//
// ★ Why a dialog rather than a two-step tap: `/exit` **also discards pending approvals**,
//   so "what will happen" has to be spelled out **in a sentence** (it does not fit in a menu label).
//
// ⚠️ Make escape easy (tapping anywhere on the backdrop cancels). **Only one place executes.**
// ⚠️ Always pass strings as JSX children (never `innerHTML` / CLAUDE.md §2).

import { t } from '../../../shared/i18n.ts'

interface Props {
  title: string
  body: string
  /** Extra caution (e.g. about the PC's input box). Omitted if absent */
  note?: string
  /** Label of the button that executes */
  ok: string
  /** ⚠️ Irreversible actions are shown in red */
  danger?: boolean
  /**
   * ★ A second execute button (2026-09-24 / auto-approve's "turn on for 24 hours").
   * ⚠️ Use only for another variant of the same action (putting a different action here means a mis-tap does something else).
   */
  alt?: { ok: string; onOk: () => void }
  onCancel: () => void
  onOk: () => void
}

export function Confirm({ title, body, note, ok, danger, alt, onCancel, onOk }: Props) {
  return (
    <div
      class="confirmwrap"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
    >
      {/* ⚠️ Tapping the content does not close it (only the backdrop cancels) */}
      <div class="confirmbox" onClick={(e) => e.stopPropagation()}>
        <h2 class="confirmtitle">{title}</h2>
        <p class="confirmbody">{body}</p>
        {note ? <p class="confirmnote">{note}</p> : null}
        <div class="confirmbtns">
          {/* ★ Cancel comes first (the thumb-reachable side). Execute is on the right */}
          <button class="plain" onClick={onCancel}>
            {t('やめる', 'Cancel')}
          </button>
          <button class={danger ? 'danger' : 'primary'} onClick={onOk}>
            {ok}
          </button>
          {alt ? (
            <button class={danger ? 'danger' : 'primary'} onClick={alt.onOk}>
              {alt.ok}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
