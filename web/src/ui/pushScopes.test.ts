import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canUnregisterScope, planPush, registeredFor, scopeFor } from './pushScopes.ts'

// ⚠️ Mutants killed here:
//   ① discarding subscriptions of endpoints with an unknown key (notifications vanish although it is only down)
//   ② not recreating when the key changed (bound to the key, so it keeps failing to deliver)
//   ③ not discarding leftover subscriptions (remain after removing an endpoint / the root one from the shared-key days remains)
//   ④ building the scope from the key (each key regeneration piles up undiscardable registrations)
//   ⑤ recreating although already correctly subscribed (needless unsubscribe → subscribe changes the endpoint every time)

const A = { id: 'https://a.example', publicKey: 'KA', registered: true }
const B = { id: 'https://b.example', publicKey: 'KB', registered: true }

test('★★ scopes differ per endpoint and are identical for the same id (④)', () => {
  assert.notEqual(scopeFor(A.id), scopeFor(B.id))
  assert.equal(scopeFor(A.id), scopeFor(A.id))
  assert.match(scopeFor(A.id), /^\/push\/[a-z0-9-]+\/$/, 'contains characters not allowed in URLs')
})

test('★★ if not subscribed, subscribe with that agent\'s own key', () => {
  const p = planPush([A, B], [])
  assert.deepEqual(
    p.subscribe.map((s) => [s.id, s.publicKey]),
    [[A.id, 'KA'], [B.id, 'KB']],
    '⚠️⚠️ not subscribing with the per-agent key (back to a shared key)',
  )
  assert.deepEqual(p.drop, [])
})

test('★★ endpoints with an unknown key are left alone (① just down / fail-closed)', () => {
  const down = { id: 'https://down.example', publicKey: undefined, registered: undefined }
  const p = planPush([A, down], [{ scope: scopeFor(down.id), publicKey: 'KOLD' }])
  assert.deepEqual(p.subscribe.map((s) => s.id), [A.id], '⚠️ trying to create a subscription for an endpoint that is down')
  assert.deepEqual(p.drop, [], '⚠️⚠️ discarding the subscription of an endpoint that is merely down (no notifications after it returns)')
})

test('★★ recreate when the key changed (②)', () => {
  const p = planPush([A], [{ scope: scopeFor(A.id), publicKey: 'ちがう' }])
  assert.deepEqual(p.subscribe.map((s) => s.publicKey), ['KA'], '⚠️⚠️ not recreating although the key changed')
})

test('★★ nothing to do when already correct (⑤ do not change the endpoint needlessly)', () => {
  const p = planPush([A], [{ scope: scopeFor(A.id), publicKey: 'KA' }])
  assert.deepEqual(p.subscribe, [])
  assert.deepEqual(p.drop, [])
})

test('★★ leftover subscriptions are discarded (③ including "/" from the shared-key days)', () => {
  const p = planPush([A], [
    { scope: scopeFor(A.id), publicKey: 'KA' },
    { scope: scopeFor('https://gone.example'), publicKey: 'KG' },
    { scope: '/', publicKey: 'KSHARED' }, // ⚠️ root subscription from the shared-key days
  ])
  assert.deepEqual(p.subscribe, [])
  assert.deepEqual(
    [...p.drop].sort(),
    [scopeFor('https://gone.example'), '/'].sort(),
    '⚠️⚠️ leftover subscriptions remain (removed endpoints / old shared key)',
  )
})

test('★★ the shell SW (/) is never unregistered (offline startup would break)', () => {
  // ⚠️⚠️ Nearly hit in practice: the subscription-discarding code had a branch that also removed the `/` registration
  assert.equal(canUnregisterScope('/'), false, '⚠️⚠️ trying to remove the shell SW')
  // ★ Touch only what we created
  assert.equal(canUnregisterScope(scopeFor('https://a.example')), true)
  assert.equal(canUnregisterScope('/other/'), false, '⚠️ touching someone else\'s scope')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ codex round 12, high #2 and #3
// ─────────────────────────────────────────────────────────────────────────────

test('★★ subscription exists but has not reached the agent ⇒ "resend" (high #2)', () => {
  // ⚠️⚠️ The state where subscribe() succeeded but registerPush() failed.
  //    Without checking this it is **never resent** (the browser has the subscription, so "no longer needed").
  const p = planPush([{ ...A, registered: false }], [{ scope: scopeFor(A.id), publicKey: 'KA' }])
  assert.deepEqual(p.subscribe, [], '⚠️ recreating (the endpoint changes and breaks more)')
  assert.deepEqual(p.reregister.map((r) => r.id), [A.id], '⚠️⚠️ not resending (never delivered)')
  assert.deepEqual(p.drop, [])
})

test('★★ nothing to do when delivered (the flip side of high #2)', () => {
  const p = planPush([A], [{ scope: scopeFor(A.id), publicKey: 'KA' }])
  assert.deepEqual(p.reregister, [])
  assert.deepEqual(p.subscribe, [])
})

test('★★ the old shared subscription is not discarded until replacement is done (high #3)', () => {
  // ⚠️⚠️ `/` was **shared by every agent**, so discarding it first means an agent that was down
  //    cannot send notifications after it comes back (the endpoint is unsubscribed).
  const down = { id: 'https://down.example', publicKey: undefined, registered: undefined }
  const legacy = { scope: '/', publicKey: 'KSHARED' }

  // ① not created yet ⇒ do not discard
  assert.deepEqual(planPush([A], [legacy]).drop, [], '⚠️⚠️ discarding before creating the replacement')
  // ② one machine is down ⇒ do not discard (replacements are not complete for everyone)
  assert.deepEqual(
    planPush([A, down], [legacy, { scope: scopeFor(A.id), publicKey: 'KA' }]).drop,
    [],
    '⚠️⚠️ discarding while leaving a down agent behind',
  )
  // ③ complete for everyone ⇒ discard now
  assert.deepEqual(
    planPush([A, B], [
      legacy,
      { scope: scopeFor(A.id), publicKey: 'KA' },
      { scope: scopeFor(B.id), publicKey: 'KB' },
    ]).drop,
    ['/'],
    '⚠️ old subscription remains although replacement is done',
  )
})

test('★★ subscriptions of removed endpoints may be discarded even mid-replacement (they belong to an agent)', () => {
  const gone = scopeFor('https://gone.example')
  const p = planPush([A], [{ scope: gone, publicKey: 'KG' }])
  assert.deepEqual(p.drop, [gone])
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Wiring (`.tsx` has no behavioural tests, so the machine only checks **that the order and conditions exist**)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ the intent to stop is saved, and auto-sync honours it (codex round 12, high #1)', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./PushPanel.tsx', import.meta.url), 'utf8'),
  )
  // ⚠️⚠️ Without remembering it, "Stop → back to the list" revives it (the permission is still granted)
  assert.match(src, /localStorage\.setItem\(OFF_KEY/, '⚠️⚠️ the intent to stop is not saved')
  assert.match(src, /pushOff\(\)\) return/, '⚠️⚠️ auto-sync ignores the intent to stop')
  assert.match(src, /setPushOff\(false\)/, '"Allow notifications" does not clear the mark')
  // ⚠️ The mark is set **before unsubscribing** (a failure midway must not revive it)
  //   ★ 2026-09-23: the actual unsubscribe moved to `stopAll` in `pushExec.ts` (exercised there)
  const at = { flag: src.indexOf('setPushOff(true)'), loop: src.indexOf('stopAll(') }
  assert.ok(at.flag >= 0 && at.loop >= 0, 'stop mark or unsubscribe (stopAll) not found')
  assert.ok(at.flag < at.loop, '⚠️⚠️ sets the mark after unsubscribing (a midway failure revives it)')
  // ★★ Stop goes on **the same chain** as sync (codex round 13, high #2 = do not interleave with another tab's sync)
  assert.match(src, /await serialize\(async \(\) => \{\s*left = await stopAll\(/, '⚠️⚠️ stop runs outside the serialisation')
})

test('★★ executing the plan is left to pushExec.ts (⚠️ do not write it back into `.tsx`)', async () => {
  // ★ "Create first, discard after" (round 12, high #3), "never remove the shell SW" and "do not register if stopped"
  //   (round 13, high #2) are **exercised by pushExec.test.ts**. Only the wiring is checked here.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./PushPanel.tsx', import.meta.url), 'utf8'),
  )
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.match(code, /await executePlan\(plan, have, targets\(\), pushDeps\)/, '⚠️⚠️ the plan is not executed via pushExec')
  assert.doesNotMatch(code, /for \(const scope of plan\.drop\)/, '⚠️⚠️ discarding written back into .tsx (a place without tests)')
  // ⚠️ The "never remove the shell SW" decision lives only in pushExec.ts (in .tsx the tests cannot reach it)
  assert.doesNotMatch(code, /canUnregisterScope/, '⚠️⚠️ the unregister decision is made in .tsx (unreachable by tests)')
})

test('★★ do not proceed unless the worker becomes active (codex round 12, medium #6)', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./PushPanel.tsx', import.meta.url), 'utf8'),
  )
  // ⚠️⚠️ Treating a timeout as success means **"subscribed" although it is not**
  //    (and no reason on screen). ⇒ Check the result, skip, and collect the reason.
  // ★ 2026-09-23: the subscription port (`pushDeps.subscribe`) **throws**. pushExec checks that it does not proceed after a throw
  assert.match(
    src,
    /if \(!\(await waitActive\(reg, \d+\)\)\) throw new Error\(/,
    '⚠️⚠️ proceeds without checking the waitActive result',
  )
  assert.match(src, /problems\.push\(/, 'failure reasons are not collected')
  assert.match(src, /setMsg\((?:t\()?`通知の設定に失敗しました/, '⚠️ failure is not shown on screen')
})

// ★★ codex round 13, high #3: deciding by "does this device have any subscription" meant
//   **even if registering the new scope failed, a leftover old subscription looked "registered"**,
//   so it did not resend and **deleted the old subscription too** (= no subscription reaching the agent at all).
test('★★ registeredFor decides by "this scope\'s tag", undefined without input', () => {
  assert.equal(registeredFor({ endpointTags: ['T1', 'T2'] }, 'T1'), true)
  assert.equal(registeredFor({ endpointTags: ['T2'] }, 'T1'), false, '⚠️⚠️ "registered" by a different endpoint')
  assert.equal(registeredFor({ endpointTags: [] }, undefined), false)
  // ⚠️⚠️ Old agents (returning no tags) are **unknown** (do not fall back to `subscribed`)
  assert.equal(registeredFor({}, 'T1'), undefined)
  assert.equal(registeredFor({ endpointTags: 'T1' }, 'T1'), undefined, 'reads a non-array as tags')
})

test('★★ if the new subscription has not reached the agent, resend and keep the old one (the high #3 scenario)', () => {
  const have = [
    { scope: '/', publicKey: 'KA' }, // ★ old shared subscription (the only one left on the agent)
    { scope: scopeFor(A.id), publicKey: 'KA' }, // ★ new subscription (subscribe succeeded, registration failed)
  ]
  const p = planPush([{ ...A, registered: false }], have)
  assert.deepEqual(p.reregister.map((r) => r.id), [A.id], '⚠️⚠️ does not resend the undelivered new subscription')
  assert.ok(!p.drop.includes('/'), '⚠️⚠️ deleted the old subscription although the new one had not arrived (notifications stop)')
})

test('★★ even with an old agent (cannot confirm), resend and keep the old subscription', () => {
  const have = [
    { scope: '/', publicKey: 'KA' },
    { scope: scopeFor(A.id), publicKey: 'KA' },
  ]
  const p = planPush([{ ...A, registered: undefined }], have)
  assert.deepEqual(p.reregister.map((r) => r.id), [A.id], 'treats what cannot be confirmed as "delivered"')
  assert.ok(!p.drop.includes('/'), '⚠️⚠️ deleted the old subscription although it cannot be confirmed')
})

test('★★ if everyone definitely has it, delete the old subscription (the route is not lost)', () => {
  const have = [
    { scope: '/', publicKey: 'KA' },
    { scope: scopeFor(A.id), publicKey: 'KA' },
    { scope: scopeFor(B.id), publicKey: 'KB' },
  ]
  const p = planPush([A, B], have)
  assert.deepEqual(p.reregister, [])
  assert.ok(p.drop.includes('/'), 'keeps the old subscription although everyone has received it')
})
