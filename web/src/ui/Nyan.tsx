// Original right-facing cat. It animates only while running; otherwise it rests on frame 0.
// Chosen via a native select overlaid on the cat, and saved on the device.
import { useState } from 'preact/hooks'
import { t } from '../../../shared/i18n.ts'
import { CAT_CHOICES, catId, loadCat, saveCat } from './catPreference.ts'

export function Nyan({
  /**
   * ★★ Whether it runs (user's choice on 2026-08-28: **when idle, show a resting cat**).
   *
   * ⚠️⚠️ **Do not make this `?`.** If it were optional, a caller could drop it and still type-check,
   *    giving "running while idle" = **a picture that lies about the state** (the worst direction).
   * ⚠️ Do not decide here (the input comes from `composerBusy` in `ui/status.ts`).
   * ⚠️ The resting picture is **frame 0** (the animation applies only when `.nyanrun` is present =
   *    no separate rule to stop it. Writing it in two places drifts from reduced-motion).
   */
  running,
}: {
  running: boolean
}) {
  const [selected, setSelected] = useState(loadCat)
  // ⚠️ The meaning is carried by **the adjacent text** (`Composer` places the status label beside it).
  //    The picture alone never conveys state, hence `aria-hidden`.
  return (
    <span class="catpicker" data-cat={selected} title={t('ねこを変更', 'Change cat')}>
      <span class={running ? 'nyan nyanrun' : 'nyan'} aria-hidden="true" />
      <span class="catpicker-arrow" aria-hidden="true">⌄</span>
      <select aria-label={t('ステータスのねこを変更', 'Change the status cat')} value={selected} onChange={(event) => {
        const next = catId(event.currentTarget.value)
        setSelected(next)
        saveCat(next)
      }}>
        {CAT_CHOICES.map((cat) => <option key={cat.id} value={cat.id}>{cat.label}</option>)}
      </select>
    </span>
  )
}
