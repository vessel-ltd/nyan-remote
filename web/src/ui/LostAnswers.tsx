import { useEffect, useState } from 'preact/hooks'
import { t } from '../../../shared/i18n.ts'
import { dismissLost, lostAnswers, onLostChange } from './lostAnswers.ts'

/** ★ The fixed bar of answers that did not go through (`lostAnswers.ts`). Nothing when there are none */
export function LostAnswers() {
  const [, setTick] = useState(0)
  useEffect(() => onLostChange(() => setTick((n) => n + 1)), [])
  const list = lostAnswers()
  if (list.length === 0) return null
  return (
    <div class="lostbar" role="alert">
      {list.map(([id, l]) => (
        <p class="notice warn" key={id}>
          <strong>
            {l.unknown
              ? t('答えが効いたか分かりません（返事が届きませんでした）。PC で確かめてください', 'Whether the answer took effect is unknown (no reply came back). Check on the PC')
              : t('答えが届きませんでした', 'The answer did not go through')}
          </strong>{' '}
          {/* ★ Dismiss first: a long command after it never pushes it out of reach (codex review) */}
          <button type="button" class="plain" onClick={() => dismissLost(id)}>
            {t('閉じる', 'Dismiss')}
          </button>
          {` ${l.reason} — ${l.summary.length > 200 ? `${l.summary.slice(0, 199)}…` : l.summary}`}
        </p>
      ))}
    </div>
  )
}
