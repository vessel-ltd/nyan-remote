// ★★ The "Plan" row in settings (2026-09-24 / billing / docs/BILLING.md §2.4). The decision is here; the screen (Endpoints.tsx) only renders it.
//   Input is each machine's `/health` `account` (⚠️ an external value ⇒ its shape is checked here).
// ⚠️ Having no account is a normal state (Tailscale, your own relay) ⇒ do not phrase it as a reproach.
// ⚠️ Old agents (that do not return `account`) are not shown.

import { t } from '../../../shared/i18n.ts'

export interface PlanRow {
  machine: string
  text: string
  /** ★ Needs fixing (machine limit, licence not accepted, unreadable) */
  warn: boolean
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 200 ? v : undefined)

export function planRows(machines: readonly { name: string; account: unknown }[]): PlanRow[] {
  const out: PlanRow[] = []
  for (const m of machines) {
    const a = m.account
    if (typeof a !== 'object' || a === null) continue
    const o = a as Record<string, unknown>
    if (o['signedIn'] !== true) {
      out.push({ machine: m.name, text: t('ログインしていません（こちらの relay を使うなら PC で nyan login）', 'Not signed in (to use our relay, run nyan login on the PC)'), warn: false })
      continue
    }
    const plan = o['plan'] === 'plus' ? 'Plus' : o['plan'] === 'free' ? 'Free' : t('プラン不明', 'Unknown plan')
    const machinesMax = num(o['maxMachines'])
    const phones = num(o['maxDevices'])
    const limits =
      machinesMax !== undefined && phones !== undefined
        ? t(`マシン${machinesMax}台・スマホ${phones}台まで`, `up to ${machinesMax} machines, ${phones} phones`)
        : ''
    const relay = str(o['relay'])
    const warnText =
      relay === 'machine-limit'
        ? t('⚠️ マシンの台数の上限です（アカウントで外すか Plus に）', '⚠️ Machine limit reached (remove one in your account or upgrade to Plus)')
        : relay === 'invalid' || relay === 'expired'
          ? t('⚠️ relay が受け付けていません（PC で nyan account）', '⚠️ The relay did not accept this machine (run nyan account on the PC)')
          : str(o['problem'])
    out.push({
      machine: m.name,
      text: [`${plan}${limits ? ` · ${limits}` : ''}`, str(o['login']) ? `(${str(o['login'])})` : '', warnText ?? ''].filter(Boolean).join(' '),
      warn: warnText !== undefined,
    })
  }
  return out
}
