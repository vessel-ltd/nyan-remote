import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang } from '../../../shared/i18n.ts'
import { planRows } from './plan.ts'

test('★★ plan rows: free, Plus, not signed in, machine limit, old agent', () => {
  setLang('ja')
  const rows = planRows([
    { name: 'pc-b', account: { signedIn: true, plan: 'free', maxMachines: 1, maxDevices: 2, login: 'nyan', relay: 'ok' } },
    { name: 'pc-a', account: { signedIn: true, plan: 'free', maxMachines: 1, maxDevices: 2, relay: 'machine-limit' } },
    { name: 'pc-c', account: { signedIn: false } },
    { name: 'old', account: undefined },
    { name: 'mac', account: { signedIn: true, plan: 'plus', maxMachines: 5, maxDevices: 5 } },
  ])
  assert.deepEqual(rows.map((r) => r.machine), ['pc-b', 'pc-a', 'pc-c', 'mac'], '⚠️ showed an old agent')
  assert.match(rows[0]!.text, /Free · マシン1台・スマホ2台まで/)
  assert.equal(rows[0]!.warn, false)
  assert.equal(rows[1]!.warn, true)
  assert.match(rows[1]!.text, /上限/)
  assert.equal(rows[2]!.warn, false, '⚠️ reproached not being signed in (normal with Tailscale)')
  assert.match(rows[3]!.text, /Plus/)
  setLang('en')
  assert.match(planRows([{ name: 'x', account: { signedIn: true, plan: 'plus', maxMachines: 5, maxDevices: 5 } }])[0]!.text, /Plus · up to 5 machines, 5 phones/)
  setLang('ja')
})
