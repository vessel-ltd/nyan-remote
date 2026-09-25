// The pairing **steps** (register, list, revoke).
//
// ★★ **Why they were moved into `.ts`** (2026-09-08 codex):
//   `.tsx` has no behavioural tests, so **while the steps were written in `Pairing.tsx`
//   nobody was checking "how return values tie to side effects"**. The slipping mutant codex named
//   (`transports[at]` → `transports[0]`) was exactly that, and
//   `discipline.test.ts` only checks **that function names exist and their order**.
//   ⇒ Move the steps out and **exercise them with a stubbed transport** (codex's own advice).
//
// ★★ **Mutants killed by name** here:
//   ① sending to index 0 instead of `at` (★ named by codex. **Sends to another machine**)
//   ② sending even when matching failed
//   ③ sending even when the identity is unusable
//   ④ reverting revocation to "try every endpoint in turn, stop at the first success" (★ medium #5. **Another machine's entry vanishes**)
//   ⑤ discarding revocation's `saved:false` (★ medium #6. The row vanishes and **revives on restart**)
//   ⑥ the list discarding "which endpoint it came from" (= makes ④ possible)
//   ⑦ dropping the reason it is broken (looks like 0 entries)
//   ⑧ showing the screen before health is known (★ low #1. Buttons appear without the mark)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DevicesResult, PairResult, RevokeResult } from '../../../shared/types.ts'
import { PUBKEY_BYTES, toBase64Url } from '../../../shared/crypto.ts'
import { buildPairUrl } from '../../../shared/pairing.ts'
import type { Identity } from '../identity.ts'
import { pairText } from './pairing.ts'
import {
  collectDevices,
  runPairing,
  runRevoke,
  revokeText,
  runUnlink,
  unlinkText,
  showPairing,
  type PairTransport,
} from './pairRun.ts'

const PAIRABLE = ['device-pairing'] as const

const KEY_A = toBase64Url(new Uint8Array(PUBKEY_BYTES).fill(1))
const KEY_B = toBase64Url(new Uint8Array(PUBKEY_BYTES).fill(2))
const TOKEN = 'Xk2qP9vLzA-_0123456789abcdefghij'
const MINE = 'このたんまつのこうかいかぎ'

const identity: Identity = {
  kind: 'ok',
  pair: {} as never,
  deviceId: 'わたしのid',
  publicKey: MINE,
}

/** A recording stub (★ keeps what was sent to which endpoint) */
function stub(
  name: string,
  opts: {
    pair?: PairResult
    devices?: DevicesResult
    revoke?: RevokeResult
  } = {},
) {
  const sent: { to: string; body: unknown }[] = []
  const t: PairTransport = {
    async pairDevice(body) {
      sent.push({ to: name, body })
      return opts.pair ?? { ok: true, deviceId: 'あいて' }
    },
    async listDevices() {
      return opts.devices ?? { devices: [] }
    },
    async revokeDevice(key) {
      sent.push({ to: name, body: { revoke: key } })
      return opts.revoke ?? { ok: true }
    },
  }
  return { t, sent }
}

const RELAY = 'wss://relay.example.workers.dev'

/** Stub for the relay line (★ also counts opens and closes) */
function relayStub(opts: { pair?: PairResult } = {}) {
  const s = stub('RELAY', opts)
  const state = { opened: 0, closed: 0, to: [] as { url: string; agentPublicKey: string }[] }
  const connectRelay = (relay: { url: string; agentPublicKey: string }) => {
    state.opened++
    state.to.push(relay)
    return { transport: s.t, close: () => void state.closed++ }
  }
  return { ...s, state, connectRelay }
}

const dev = (key: string, id: string) => ({
  key,
  label: 'たんまつ',
  addedAt: '2026-09-08T00:00:00.000Z',
  deviceId: id,
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Registration (never the wrong destination)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ sends only to the matching endpoint (★ kills the mutant codex named)', async () => {
  const a = stub('A')
  const b = stub('B')
  const url = buildPairUrl({ agentPublicKey: KEY_B, token: TOKEN, machine: 'pc-b' })

  const out = await runPairing(url, {
    transports: [a.t, b.t],
    healths: [{ agentPublicKey: KEY_A, machine: 'pc-a' }, { agentPublicKey: KEY_B, machine: 'pc-b' }],
    identity,
    ua: 'Android',
  })

  assert.equal(out.kind, 'done')
  assert.deepEqual(a.sent, [], '⚠️⚠️ nothing must be sent to the first machine')
  assert.equal(b.sent.length, 1, '★ must send only to the second machine')
  assert.deepEqual(b.sent[0]?.body, {
    key: MINE,
    token: TOKEN,
    label: 'Android',
    agentPublicKey: KEY_B,
  })
})

test('★★ even for a party **already** in endpoints, use relay when `r` is present (codex round 9, high #1)', async () => {
  // ⚠️⚠️ **The round 8 fix only half worked**: relay-first was added only to the "not in endpoints"
  //    branch, so in **normal use at home** (= already in endpoints)
  //    `pickPairTarget` chose it and **sent the one-time token to local `/pair`**
  //    (codex measured "0 relay calls" with a real transport).
  // ★ The decision is placed **before looking at endpoints** = "strength does not depend on being in the list".
  const a = stub('A')
  const b = stub('B')
  const r = relayStub()
  const added: unknown[] = []
  const url = buildPairUrl({
    agentPublicKey: KEY_B,
    token: TOKEN,
    machine: 'pc-b',
    relayUrl: RELAY,
  })

  const out = await runPairing(url, {
    // ⚠️ The second machine matches the QR's key (= it always used to be sent here)
    transports: [a.t, b.t],
    healths: [
      { agentPublicKey: KEY_A, machine: 'pc-a' },
      { agentPublicKey: KEY_B, machine: 'pc-b' },
    ],
    identity,
    ua: 'Android',
    addEndpoint: (e) => void added.push(e),
    connectRelay: r.connectRelay,
  })

  assert.equal(out.kind, 'done')
  assert.equal(r.sent.length, 1, '⚠️⚠️ not using relay')
  assert.deepEqual(a.sent, [], '⚠️ sending to another machine')
  assert.deepEqual(b.sent, [], '⚠️⚠️ sent the one-time token to the matching endpoint (local)')
  assert.equal(r.state.closed, 1)
  // ★ Existing endpoints also get the verified inputs and route (medium #3)
  assert.deepEqual(added, [
    { url: '', label: 'pc-b', relay: { url: RELAY, agentPublicKey: KEY_B }, kind: 'relay' },
  ])
})

test('★★ refused ⇒ not added to endpoints (even with existing endpoints)', async () => {
  const b = stub('B')
  const r = relayStub({ pair: { ok: false, reason: 'ワンタイムが違います' } })
  const added: unknown[] = []
  const url = buildPairUrl({
    agentPublicKey: KEY_B,
    token: TOKEN,
    machine: 'pc-b',
    relayUrl: RELAY,
  })
  const out = await runPairing(url, {
    transports: [b.t],
    healths: [{ agentPublicKey: KEY_B, machine: 'pc-b' }],
    identity,
    ua: 'Android',
    addEndpoint: (e) => void added.push(e),
    connectRelay: r.connectRelay,
  })
  assert.equal(out.kind, 'refused')
  assert.deepEqual(added, [], '⚠️⚠️ remembered the entry point of a party that refused')
  assert.deepEqual(b.sent, [], '⚠️⚠️ also sending to local')
})

test('★★ a QR without `r` goes to the endpoint as before (and the text changes)', async () => {
  const b = stub('B')
  const url = buildPairUrl({ agentPublicKey: KEY_B, token: TOKEN, machine: 'pc-b' })
  const out = await runPairing(url, {
    transports: [b.t],
    healths: [{ agentPublicKey: KEY_B, machine: 'pc-b' }],
    identity,
    ua: 'Android',
  })
  assert.equal(out.kind, 'done')
  assert.equal(out.kind === 'done' && out.relay, undefined)
  assert.equal(b.sent.length, 1, '★ no stronger route, so as before')
})

test('★★ with `r` but no relay route, **do not send to local**; show how to fix it', async () => {
  // ⚠️⚠️ Never silently take the weaker route (= do not hide a wiring omission behind "happens to work")
  const b = stub('B')
  const url = buildPairUrl({
    agentPublicKey: KEY_B,
    token: TOKEN,
    machine: 'pc-b',
    relayUrl: RELAY,
  })
  const out = await runPairing(url, {
    transports: [b.t],
    healths: [{ agentPublicKey: KEY_B, machine: 'pc-b' }],
    identity,
    ua: 'Android',
    // ⚠️ `connectRelay` is not passed
  })
  assert.equal(out.kind, 'relay-only')
  assert.deepEqual(b.sent, [], '⚠️⚠️ sent the one-time token to local')
  // ★ The text must include **how to fix it** (otherwise the user is stuck)
  const text = pairText(out)
  assert.match(text, /pc-b/)
  assert.match(text, /relayUrl/, '⚠️ the fix (empty `relayUrl`) is not shown')
})

test('★★ if matching fails, send to none', async () => {
  const a = stub('A')
  const url = buildPairUrl({ agentPublicKey: KEY_B, token: TOKEN, machine: 'pc-b' })
  const out = await runPairing(url, {
    transports: [a.t],
    healths: [{ agentPublicKey: KEY_A, machine: 'pc-a', features: PAIRABLE }],
    identity,
    ua: '',
  })
  assert.equal(out.kind, 'no-target')
  assert.ok(out.kind === 'no-target' && out.machine === 'pc-b')
  assert.deepEqual(a.sent, [])
})

test('★★ do not send if the identity is unusable', async () => {
  const a = stub('A')
  const url = buildPairUrl({ agentPublicKey: KEY_A, token: TOKEN, machine: 'k' })
  for (const id of [
    undefined,
    { kind: 'broken', reason: 'こわれています' } as Identity,
    { kind: 'unavailable', reason: 'つかえません' } as Identity,
  ]) {
    const out = await runPairing(url, {
      transports: [a.t],
      healths: [{ agentPublicKey: KEY_A }],
      identity: id,
      ua: '',
    })
    assert.equal(out.kind, 'no-identity')
    assert.deepEqual(a.sent, [])
  }
})

test('★★ unreadable strings are not sent', async () => {
  const a = stub('A')
  const out = await runPairing('なにか', {
    transports: [a.t],
    healths: [{ agentPublicKey: KEY_A }],
    identity,
    ua: '',
  })
  assert.equal(out.kind, 'unreadable')
  assert.deepEqual(a.sent, [])
})

test('★★ carries the agent\'s refusal reason (so you know to re-show the QR)', async () => {
  const a = stub('A', { pair: { ok: false, reason: 'ワンタイムが正しくありません' } })
  const url = buildPairUrl({ agentPublicKey: KEY_A, token: TOKEN, machine: 'k' })
  const out = await runPairing(url, {
    transports: [a.t],
    healths: [{ agentPublicKey: KEY_A }],
    identity,
    ua: '',
  })
  assert.equal(out.kind, 'refused')
  assert.ok(out.kind === 'refused' && /ワンタイム/.test(out.reason))
})

test('★★ swallows transport throws (the screen does not freeze)', async () => {
  const t: PairTransport = {
    async pairDevice() {
      throw new Error('繋がりません')
    },
    async listDevices() {
      return { devices: [] }
    },
    async revokeDevice() {
      return { ok: true }
    },
  }
  const url = buildPairUrl({ agentPublicKey: KEY_A, token: TOKEN, machine: 'k' })
  const out = await runPairing(url, {
    transports: [t],
    healths: [{ agentPublicKey: KEY_A }],
    identity,
    ua: '',
  })
  assert.equal(out.kind, 'error')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ List and revocation (keep which machine the registration is on)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ the list keeps "which endpoint it came from" (no mixing even with the same key on two machines)', async () => {
  const a = stub('A', { devices: { devices: [dev(MINE, 'わたしのid')] } })
  const b = stub('B', { devices: { devices: [dev(MINE, 'わたしのid')] } })
  const got = await collectDevices({
    transports: [a.t, b.t],
    healths: [
      { agentPublicKey: KEY_A, machine: 'pc-a', features: PAIRABLE },
      { agentPublicKey: KEY_B, machine: 'pc-b', features: PAIRABLE },
    ],
    identity,
    ua: '',
  })
  assert.equal(got.rows.length, 2, '★ must be 2 rows (same key, different machines)')
  assert.deepEqual(
    got.rows.map((r) => [r.at, r.machine]),
    [
      [0, 'pc-a'],
      [1, 'pc-b'],
    ],
  )
})

test('★★ revocation is sent only to "the pressed row\'s machine" (★ medium #5)', async () => {
  const a = stub('A')
  const b = stub('B')
  const deps = {
    transports: [a.t, b.t],
    healths: [
      { agentPublicKey: KEY_A, machine: 'pc-a', features: PAIRABLE },
      { agentPublicKey: KEY_B, machine: 'pc-b', features: PAIRABLE },
    ],
    identity,
    ua: '',
  }
  const rows = (
    await collectDevices({
      ...deps,
      transports: [
        stub('A', { devices: { devices: [dev(MINE, 'わたしのid')] } }).t,
        stub('B', { devices: { devices: [dev(MINE, 'わたしのid')] } }).t,
      ],
    })
  ).rows

  // ★ Revoke the second machine's row
  const out = await runRevoke(rows[1]!, deps)
  assert.equal(out.kind, 'done')
  assert.deepEqual(a.sent, [], '⚠️⚠️ nothing sent to the first machine (this is what used to vanish)')
  assert.deepEqual(b.sent, [{ to: 'B', body: { revoke: MINE } }])
})

test('★★ revocation\'s saved:false is not discarded (says it revives on restart / ★ medium #6)', async () => {
  const b = stub('B', { revoke: { ok: false, reason: '保存に失敗しました', saved: false } })
  const rows = (
    await collectDevices({
      transports: [stub('B', { devices: { devices: [dev(MINE, 'わたしのid')] } }).t],
      healths: [{ agentPublicKey: KEY_B, machine: 'pc-b', features: PAIRABLE }],
      identity,
      ua: '',
    })
  ).rows

  const out = await runRevoke(rows[0]!, {
    transports: [b.t],
    healths: [{ agentPublicKey: KEY_B, machine: 'pc-b', features: PAIRABLE }],
    identity,
    ua: '',
  })
  assert.equal(out.kind, 'unsaved', '★ "gone but not saved" is a separate result')
  const text = revokeText(out)
  assert.match(text, /再起動/, '⚠️ must say that it revives')
})

test('★★ an ordinary refusal of revocation shows the reason', async () => {
  const b = stub('B', { revoke: { ok: false, reason: 'そのデバイスは登録されていません' } })
  const rows = (
    await collectDevices({
      transports: [stub('B', { devices: { devices: [dev(MINE, 'x')] } }).t],
      healths: [{ agentPublicKey: KEY_B, machine: 'pc-b', features: PAIRABLE }],
      identity,
      ua: '',
    })
  ).rows
  const out = await runRevoke(rows[0]!, {
    transports: [b.t],
    healths: [{ agentPublicKey: KEY_B, features: PAIRABLE }],
    identity,
    ua: '',
  })
  assert.equal(out.kind, 'refused')
  assert.match(revokeText(out), /登録されていません/)
})

test('★★ the list does not drop "the reason it is broken" (not shown as 0 entries)', async () => {
  const a = stub('A', { devices: { devices: [], broken: 'devices が配列ではありません' } })
  const got = await collectDevices({
    transports: [a.t],
    healths: [{ agentPublicKey: KEY_A, machine: 'pc-a', features: PAIRABLE }],
    identity,
    ua: '',
  })
  assert.deepEqual(got.rows, [])
  assert.ok(got.trouble && /pc-a/.test(got.trouble))
  assert.ok(got.trouble && /配列/.test(got.trouble))
})

test('★★ agent key problems are shown too (explains why no QR can be shown)', async () => {
  const a = stub('A', { devices: { devices: [], keyProblem: '知らない版です' } })
  const got = await collectDevices({
    transports: [a.t],
    healths: [{ agentPublicKey: KEY_A, machine: 'pc-a', features: PAIRABLE }],
    identity,
    ua: '',
  })
  assert.ok(got.trouble && /知らない版/.test(got.trouble))
})

test('★★ endpoints without the mark (old) are not listed (not even requested / fail-closed)', async () => {
  // ⚠️⚠️ Agents without the mark have no `GET /devices`, so requesting it 404s.
  //    ⇒ **Do not issue the request at all** (added on 2026-09-08 after a mutant slipped through).
  let asked = 0
  const t: PairTransport = {
    async pairDevice() {
      return { ok: true, deviceId: 'x' }
    },
    async listDevices() {
      asked += 1
      return { devices: [dev(MINE, 'わたしのid')] }
    },
    async revokeDevice() {
      return { ok: true }
    },
  }
  const got = await collectDevices({
    transports: [t],
    healths: [{ agentPublicKey: KEY_A, machine: 'ふるいagent' }], // ★ no mark
    identity,
    ua: '',
  })
  assert.deepEqual(got.rows, [], '★ must not be listed')
  assert.equal(asked, 0, '⚠️⚠️ must not even be requested')
})

test('★★ unreachable endpoints are silently skipped (the endpoints screen reports them)', async () => {
  const t: PairTransport = {
    async pairDevice() {
      return { ok: true, deviceId: 'x' }
    },
    async listDevices() {
      throw new Error('繋がりません')
    },
    async revokeDevice() {
      return { ok: true }
    },
  }
  const got = await collectDevices({
    transports: [t],
    healths: [{ agentPublicKey: KEY_A, machine: 'pc-a', features: PAIRABLE }],
    identity,
    ua: '',
  })
  assert.deepEqual(got.rows, [])
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Not shown before the marks are known (low #1)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ the screen is not shown before health is known (no buttons without the mark)', () => {
  // ⚠️⚠️ It used to be `healths.length > 0 && !anyPair`, so **it showed while loading ([])**
  assert.equal(showPairing(undefined), false, '★ not shown while loading')
  // ★★ On 2026-09-16 **only this line's rule changed** (hit in practice on Y):
  //    on the public origin **0 machines is the normal initial state**; closing it here
  //    **removes the QR paste field itself, leaving no way to connect anywhere**. ⇒ Shown with 0.
  assert.equal(showPairing([]), true, '★ shown when there are no endpoints (to paste a QR)')
  // ★★ **Shown when only unreachable agents exist** (2026-09-19 / codex round 7, medium #7).
  //   ⚠️⚠️ **Got stuck in practice**: the only agent in the list was down and **the field for adding another PC vanished**
  //      = no way to recover from the phone.
  assert.equal(showPairing([undefined]), true, '⚠️⚠️ with only a down agent, recovery is impossible')
  assert.equal(showPairing([undefined, undefined]), true)
  // ⚠️ **When a reachable agent exists**, fail-closed as before (not shown without the mark)
  assert.equal(
    showPairing([undefined, { features: [] }]),
    false,
    '⚠️ shows the button although the reachable agent has no mark',
  )
  assert.equal(showPairing([undefined, { features: ['device-pairing'] }]), true)
  assert.equal(showPairing([{ features: [] }]), false, '★ not shown without the mark')
  assert.equal(showPairing([{ features: ['slash-commands'] }]), false)
  assert.equal(showPairing([{ features: ['device-pairing'] }]), true)
  assert.equal(showPairing([{ features: [] }, { features: ['device-pairing'] }]), true)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Register by **adding an unknown endpoint** from the QR (2026-09-16 / to move on to Y).
//
//   ⚠️⚠️ **A PWA served from the public origin starts with no agents at all**
//      (its own origin is not a candidate = discipline 1). ⇒ The first one can only be added from the QR's `u`.
//   ⚠️⚠️ **This loosens "never send the one-time token to the wrong party"**, so
//      **match the public key via `/health` before adding** (if it does not match, **send to none**).
//
//   Mutants killed by name:
//     ⑨ sending without checking `u`'s `/health` (= hand the one-time token to wherever the QR points)
//     ⑩ sending even when the public key differs
//     ⑪ adding as an endpoint even when registration was refused (rows that cannot connect pile up)
//     ⑫ sending to `u` although it is already in endpoints (= registered twice)
//     ⑬ not making the added endpoint remember the relay entry point
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_URL = 'https://pc-b.example.ts.net'
const RELAY_URL = 'wss://nyan-relay.example.workers.dev'

/** ★ A fake that connects from `u` (★ also counts how many times `/health` was fetched) */
function discovery(health: { agentPublicKey?: string; machine?: string } | undefined) {
  const s = stub('U')
  const asked: string[] = []
  const added: unknown[] = []
  return {
    sent: s.sent,
    asked,
    added,
    deps: {
      connect: (url: string) => {
        asked.push(url)
        return { transport: s.t, health: async () => health }
      },
      addEndpoint: (e: unknown) => void added.push(e),
    },
  }
}

test('★★ an agent not in endpoints is added from the QR\'s `u` and registered (⑨⑩)', async () => {
  // ⚠️ This path is now taken only for **QRs without `r`** (2026-09-19 / codex round 9, high #1).
  //    With `r`, only relay is used (no fallback to the weaker one) = checked by the test below.
  const d = discovery({ agentPublicKey: KEY_B, machine: 'PC-B' })
  const url = buildPairUrl({
    agentPublicKey: KEY_B,
    token: TOKEN,
    machine: 'pc-b',
    agentUrl: AGENT_URL,
  })
  const out = await runPairing(url, {
    transports: [],
    healths: [],
    identity,
    ua: 'Android',
    ...d.deps,
  })
  assert.equal(out.kind, 'done')
  assert.deepEqual(d.asked, [AGENT_URL], '⚠️ the QR\'s entry point was not verified')
  assert.equal(d.sent.length, 1, 'sends only to that one machine')
  // ⚠️ Added only after registration succeeds (⑪)
  assert.deepEqual(d.added, [{ url: AGENT_URL, label: 'PC-B' }])
})

test('★★ a QR with both `u` and `r` but no `connectRelay` sends to `u` neither (round 9, high #1)', async () => {
  // ⚠️⚠️ The shape codex measured: **`r` present, no `connectRelay`** went on to `pairViaQr`.
  //    ⇒ The screen normally passes both, but **the API allowed this input**, which was the problem.
  const d = discovery({ agentPublicKey: KEY_B, machine: 'PC-B' })
  const url = buildPairUrl({
    agentPublicKey: KEY_B,
    token: TOKEN,
    machine: 'pc-b',
    agentUrl: AGENT_URL,
    relayUrl: RELAY_URL,
  })
  const out = await runPairing(url, {
    transports: [],
    healths: [],
    identity,
    ua: 'Android',
    ...d.deps,
  })
  assert.equal(out.kind, 'relay-only')
  assert.deepEqual(d.asked, [], '⚠️⚠️ fetches `u`\'s `/health`')
  assert.deepEqual(d.sent, [], '⚠️⚠️ sent the one-time token to `u`')
  assert.deepEqual(d.added, [])
})

test('★★ if `u`\'s `/health` has a different key than the QR, send to none (⑩)', async () => {
  const d = discovery({ agentPublicKey: KEY_A, machine: 'べつのマシン' })
  const url = buildPairUrl({
    agentPublicKey: KEY_B,
    token: TOKEN,
    machine: 'pc-b',
    agentUrl: AGENT_URL,
  })
  const out = await runPairing(url, { transports: [], healths: [], identity, ua: 'Android', ...d.deps })
  assert.equal(out.kind, 'no-target')
  assert.deepEqual(d.sent, [], '⚠️⚠️ handed the one-time token to a machine with a different key')
  assert.deepEqual(d.added, [])
})

test('★★ do not send if `/health` cannot be fetched (⑨)', async () => {
  const d = discovery(undefined)
  const url = buildPairUrl({ agentPublicKey: KEY_B, token: TOKEN, machine: 'x', agentUrl: AGENT_URL })
  const out = await runPairing(url, { transports: [], healths: [], identity, ua: 'Android', ...d.deps })
  assert.equal(out.kind, 'no-target')
  assert.deepEqual(d.sent, [])
})

test('★★ refused ⇒ not added as an endpoint (⑪)', async () => {
  const d = discovery({ agentPublicKey: KEY_B, machine: 'PC-B' })
  const s = stub('U', { pair: { ok: false, reason: 'ワンタイムが切れています' } })
  const url = buildPairUrl({ agentPublicKey: KEY_B, token: TOKEN, machine: 'x', agentUrl: AGENT_URL })
  const added: unknown[] = []
  const out = await runPairing(url, {
    transports: [],
    healths: [],
    identity,
    ua: 'Android',
    connect: () => ({ transport: s.t, health: async () => ({ agentPublicKey: KEY_B }) }),
    addEndpoint: (e) => void added.push(e),
  })
  assert.equal(out.kind, 'refused')
  assert.deepEqual(added, [], '⚠️ unreachable endpoints pile up')
  void d
})

test('★★ if already in endpoints, send there (⑫ do not add twice)', async () => {
  const known = stub('KNOWN')
  const d = discovery({ agentPublicKey: KEY_B, machine: 'PC-B' })
  const url = buildPairUrl({ agentPublicKey: KEY_B, token: TOKEN, machine: 'x', agentUrl: AGENT_URL })
  const out = await runPairing(url, {
    transports: [known.t],
    healths: [{ agentPublicKey: KEY_B, machine: 'PC-B' }],
    identity,
    ua: 'Android',
    ...d.deps,
  })
  assert.equal(out.kind, 'done')
  assert.equal(known.sent.length, 1, 'sends to the existing endpoint')
  assert.deepEqual(d.asked, [], '⚠️ hit `u` although it exists (opens a path to add twice)')
  assert.deepEqual(d.added, [])
})

test('★★ QRs without `u` behave as before (backward compatible)', async () => {
  const d = discovery({ agentPublicKey: KEY_B })
  const url = buildPairUrl({ agentPublicKey: KEY_B, token: TOKEN, machine: 'pc-b' })
  const out = await runPairing(url, { transports: [], healths: [], identity, ua: 'Android', ...d.deps })
  assert.equal(out.kind, 'no-target')
  assert.deepEqual(d.asked, [])
})

test('★★ with no endpoints at all, show the paste field (hit on Y / 2026-09-16)', () => {
  // ⚠️⚠️ **On the public origin 0 machines is the normal initial state**. It used to fail closed here,
  //    so opening on a new origin **removed the QR paste field itself and nothing could connect** (hit in practice).
  assert.equal(showPairing([]), true, '⚠️⚠️ no paste field with 0 machines (no way to connect)')
  // ★ "Not yet known" is still not shown
  assert.equal(showPairing(undefined), false)
  // ★ With only agents lacking the mark it is still not shown (no buttons that 404)
  assert.equal(showPairing([{ features: [] }]), false)
  assert.equal(showPairing([{ features: ['device-pairing'] }]), true)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ ③ stage 7: **pairing via relay** (2026-09-18 / ARCHITECTURE §14.1.4)
//
// ⚠️⚠️ This is the last piece of "complete without a tailnet". ⇒ Mutants killed:
//   ⑰ using `u` (local) although relay inputs exist (**the path to being fooled by a fake host** = codex high #1)
//   ⑱ not closing the line (eats the relay's 8 slots and **the real phone can no longer connect**)
//   ⑲ adding to endpoints although refused (**a row that cannot connect** remains)
//   ⑳ going the relay way without relay (kills the `u` path)
// ─────────────────────────────────────────────────────────────────────────────


test('★★ registration works via relay even when not in endpoints (⑰ complete without a tailnet)', async () => {
  const r = relayStub()
  const local = stub('LOCAL')
  const url = buildPairUrl({
    agentPublicKey: KEY_B,
    token: TOKEN,
    machine: 'pc-b',
    relayUrl: RELAY,
  })
  const added: unknown[] = []

  const out = await runPairing(url, {
    transports: [local.t],
    // ⚠️ Only another machine is in endpoints (= matching misses)
    healths: [{ agentPublicKey: KEY_A, machine: 'pc-a' }],
    identity,
    ua: 'Android',
    addEndpoint: (e) => void added.push(e),
    connectRelay: r.connectRelay,
  })

  assert.equal(out.kind, 'done', '⚠️⚠️ not registered although relay inputs exist')
  assert.deepEqual(local.sent, [], '⚠️⚠️ sending to an existing endpoint')
  assert.equal(r.state.opened, 1, '⚠️ the relay line was not opened')
  assert.deepEqual(r.state.to, [{ url: RELAY, agentPublicKey: KEY_B }], '⚠️⚠️ connected to a different party')
  assert.equal(r.sent.length, 1, '★ sends to relay exactly once')
  // ⚠️⚠️ **Always close** (do not eat slots)
  assert.equal(r.state.closed, 1, '⚠️⚠️ the relay line was not closed (eats the 8 slots)')
  // ★ Added to endpoints only after registration succeeds (⚠️ `url` is empty = reachable only via relay)
  // ★ Save **the route registration succeeded on** as-is (⚠️ no guessing / codex round 8, medium #2)
  assert.deepEqual(added, [
    { url: '', label: 'pc-b', relay: { url: RELAY, agentPublicKey: KEY_B }, kind: 'relay' },
  ])
  // ★ Returns the registered party (to find old endpoints of the same machine whose key was regenerated / `staleTwins` / 2026-09-24)
  assert.deepEqual(out.kind === 'done' ? out.paired : undefined, { relayUrl: RELAY, agentPublicKey: KEY_B })
})

test('★★ refused ⇒ not added to endpoints. ⚠️ The line is still closed (⑱⑲)', async () => {
  const r = relayStub({ pair: { ok: false, reason: 'ワンタイムが違います' } })
  const url = buildPairUrl({
    agentPublicKey: KEY_B,
    token: TOKEN,
    machine: 'pc-b',
    relayUrl: RELAY,
  })
  const added: unknown[] = []

  const out = await runPairing(url, {
    transports: [],
    healths: [],
    identity,
    ua: 'Android',
    addEndpoint: (e) => void added.push(e),
    connectRelay: r.connectRelay,
  })

  assert.equal(out.kind, 'refused')
  assert.deepEqual(added, [], '⚠️⚠️ leaves a refusing party in the list')
  assert.equal(r.state.closed, 1, '⚠️⚠️ the line is not closed on failure')
})

test('★★ the line is closed even on a throw (⚠️ without finally, slots keep leaking)', async () => {
  const state = { closed: 0 }
  const url = buildPairUrl({
    agentPublicKey: KEY_B,
    token: TOKEN,
    machine: 'pc-b',
    relayUrl: RELAY,
  })
  const out = await runPairing(url, {
    transports: [],
    healths: [],
    identity,
    ua: 'Android',
    addEndpoint: () => {},
    connectRelay: () => ({
      transport: {
        pairDevice: () => Promise.reject(new Error('線が落ちました')),
        listDevices: () => Promise.resolve({ devices: [] }),
        revokeDevice: () => Promise.resolve({ ok: true as const }),
      },
      close: () => void state.closed++,
    }),
  })
  // ⚠️ **No fallback to `u`** (no downgrade / codex round 8, high #1)
  // ★ Failure is `relay-only` (= rides on the notice that first says "the QR may be stale" / 2026-09-19)
  assert.equal(out.kind, 'relay-only')
  assert.equal(state.closed, 1, '⚠️⚠️ the line is not closed on an exception')
})

test('★★ without relay in the QR, the `u` path as before (⑳ do not kill local)', async () => {
  const r = relayStub()
  const viaU = stub('U')
  const url = buildPairUrl({
    agentPublicKey: KEY_B,
    token: TOKEN,
    machine: 'pc-b',
    agentUrl: 'https://pc-b.example.ts.net',
  })
  const added: unknown[] = []

  const out = await runPairing(url, {
    transports: [],
    healths: [],
    identity,
    ua: 'Android',
    addEndpoint: (e) => void added.push(e),
    connect: () => ({
      transport: viaU.t,
      health: async () => ({ agentPublicKey: KEY_B, machine: 'pc-b' }),
    }),
    connectRelay: r.connectRelay,
  })

  assert.equal(out.kind, 'done')
  assert.equal(r.state.opened, 0, '⚠️ went to relay without relay inputs')
  assert.equal(viaU.sent.length, 1, '★ must send via the `u` path')
  assert.deepEqual(added, [{ url: 'https://pc-b.example.ts.net', label: 'pc-b' }])
})

test('★★ with both relay and `u`, use relay (⚠️ the stronger first / codex high #1)', async () => {
  // ⚠️⚠️ `u` can be fooled by "a fake host that merely returns the real public key" (reproduced by measurement).
  //    Relay's handshake is bound to the key, so it cannot be fooled. ⇒ **Relay first**.
  const r = relayStub()
  const viaU = stub('U')
  const url = buildPairUrl({
    agentPublicKey: KEY_B,
    token: TOKEN,
    machine: 'pc-b',
    relayUrl: RELAY,
    agentUrl: 'https://pc-b.example.ts.net',
  })
  const added: { url: string; label: string; relay?: unknown }[] = []

  const out = await runPairing(url, {
    transports: [],
    healths: [],
    identity,
    ua: 'Android',
    addEndpoint: (e) => void added.push(e),
    connect: () => ({
      transport: viaU.t,
      health: async () => ({ agentPublicKey: KEY_B, machine: 'pc-b' }),
    }),
    connectRelay: r.connectRelay,
  })

  assert.equal(out.kind, 'done')
  assert.equal(r.sent.length, 1, '⚠️⚠️ used `u` instead of relay (the weaker first)')
  assert.deepEqual(viaU.sent, [], '⚠️⚠️ also sends the one-time token to `u`')
  // ★ `u` is remembered too (local can be used at home)
  assert.equal(added[0]?.url, 'https://pc-b.example.ts.net')
  assert.deepEqual(added[0]?.relay, { url: RELAY, agentPublicKey: KEY_B })
})

test('★★ even if relay fails, no fallback to `u` (⚠️⚠️ downgrade attack / codex round 8, high #1)', async () => {
  // ⚠️⚠️ It used to "fall back to `u` only when it could not connect", but **`error` is not
  //    reserved for "failure before sending"** (disconnects after sending, timeouts and 503 also throw).
  //    ⇒ **The same one-time token went out on both relay and local** (codex reproduced it with a real transport).
  // ★★ The essence is that **an attacker can push us onto the weak route**: anyone in the middle just cuts the relay line,
  //    and the one-time token is sent to `u`, which only has the `/health` string comparison.
  //    ⇒ **A fix that "tells whether it was sent" is not enough** (as long as the weak route remains).
  for (const [name, fail] of [
    ['handshake fails (= before sending)', () => Promise.reject(new Error('握手できませんでした'))],
    ['dropped after sending', () => Promise.reject(new Error('線が落ちました（応答なし）'))],
  ] as const) {
    const viaU = stub('U')
    const state = { closed: 0 }
    const url = buildPairUrl({
      agentPublicKey: KEY_B,
      token: TOKEN,
      machine: 'pc-b',
      relayUrl: RELAY,
      agentUrl: 'https://pc-b.example.ts.net',
    })
    const out = await runPairing(url, {
      transports: [],
      healths: [],
      identity,
      ua: 'Android',
      addEndpoint: () => {},
      connect: () => ({
        transport: viaU.t,
        health: async () => ({ agentPublicKey: KEY_B, machine: 'pc-b' }),
      }),
      connectRelay: () => ({
        transport: {
          pairDevice: fail,
          listDevices: () => Promise.resolve({ devices: [] }),
          revokeDevice: () => Promise.resolve({ ok: true as const }),
        },
        close: () => void state.closed++,
      }),
    })
    assert.equal(out.kind, 'relay-only', `${name}: must return a reason`)
    // ★★ **State the most common cause first (the QR is single-use, 5 minutes)** (hit in practice on 2026-09-19)
    assert.match(pairText(out), /1回きり/, `${name}: does not mention that the QR may be stale`)
    assert.match(pairText(out), /npm run pair/, `${name}: does not say how to re-show it`)
    assert.deepEqual(viaU.sent, [], `⚠️⚠️ ${name}: sent the one-time token to \`u\``)
    assert.equal(state.closed, 1, `${name}: the line is closed`)
  }
})

test('★★ refused ⇒ do not retry on `u` (⚠️⚠️ never put the same one-time token on two routes)', async () => {
  const r = relayStub({ pair: { ok: false, reason: 'ワンタイムが正しくありません' } })
  const viaU = stub('U')
  const url = buildPairUrl({
    agentPublicKey: KEY_B,
    token: TOKEN,
    machine: 'pc-b',
    relayUrl: RELAY,
    agentUrl: 'https://pc-b.example.ts.net',
  })
  const out = await runPairing(url, {
    transports: [],
    healths: [],
    identity,
    ua: 'Android',
    addEndpoint: () => {},
    connect: () => ({
      transport: viaU.t,
      health: async () => ({ agentPublicKey: KEY_B, machine: 'pc-b' }),
    }),
    connectRelay: r.connectRelay,
  })
  assert.equal(out.kind, 'refused')
  assert.deepEqual(viaU.sent, [], '⚠️⚠️ after refusal, the one-time token is also sent to `u`')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Unlinking (2026-09-21)
//
// ⚠️ Mutants killed here:
//   ① removing the endpoint first (⇒ the revocation's destination vanishes; the shape hit in practice)
//   ② keeping the endpoint when revocation fails (⇒ **a down agent's row cannot be removed** / the 2026-09-19 hole)
//   ③ skipping `forget` on an exception (same as above)
//   ④ sending something other than our own key
//   ⑤ silently treating `saved:false` as success (⇒ **the registration revives on restart**)
//   ⑥ attempting revocation although the key cannot be read
// ─────────────────────────────────────────────────────────────────────────────

test('★★ revoke first, then remove the endpoint (①; reversed, the destination vanishes)', async () => {
  const order: string[] = []
  const out = await runUnlink('PC-B', {
    transport: {
      revokeDevice: async (key) => {
        order.push(`revoke:${key}`)
        return { ok: true }
      },
    },
    myKey: 'MYKEY',
    forget: () => order.push('forget'),
  })
  assert.deepEqual(order, ['revoke:MYKEY', 'forget'], '⚠️⚠️ removes the endpoint before revoking')
  assert.deepEqual(out, { kind: 'done', machine: 'PC-B' })
})

test('★★ the endpoint is removed even if revocation is refused (②; no dead endpoints left)', async () => {
  let forgot = 0
  const out = await runUnlink('PC-B', {
    transport: { revokeDevice: async () => ({ ok: false, reason: 'そのデバイスは登録されていません' }) },
    myKey: 'MYKEY',
    forget: () => forgot++,
  })
  assert.equal(forgot, 1, '⚠️⚠️ the endpoint is not removed when revocation fails (an unremovable row remains)')
  assert.equal(out.kind, 'kept')
  // ⚠️⚠️ **Do not stay silent** (only here can we learn that the registration remained on the other side)
  assert.match(unlinkText(out), /登録は消せませんでした/)
  assert.match(unlinkText(out), /npm run devices/, '★ does not say how to fix it (the machine-side command)')
})

test('★★ the endpoint is removed even if unreachable (③ exception)', async () => {
  let forgot = 0
  const out = await runUnlink('PC-B', {
    transport: {
      revokeDevice: async () => {
        throw new Error('Failed to fetch')
      },
    },
    myKey: 'MYKEY',
    forget: () => forgot++,
  })
  assert.equal(forgot, 1, '⚠️⚠️ cannot remove the endpoint when the agent is down (the 2026-09-19 hole returns)')
  assert.equal(out.kind, 'kept')
  assert.match(unlinkText(out), /Failed to fetch/)
})

test('★★ only "this device\'s key" is sent (④)', async () => {
  const sent: string[] = []
  await runUnlink('PC-B', {
    transport: {
      revokeDevice: async (key) => {
        sent.push(key)
        return { ok: true }
      },
    },
    myKey: 'MYKEY',
    forget: () => {},
  })
  assert.deepEqual(sent, ['MYKEY'], '⚠️ trying to remove registrations other than our own')
})

test('★★ `saved:false` is not a success (⑤ revives on restart)', async () => {
  const out = await runUnlink('PC-B', {
    transport: {
      revokeDevice: async () => ({ ok: false, reason: '書けません', saved: false }),
    },
    myKey: 'MYKEY',
    forget: () => {},
  })
  assert.equal(out.kind, 'kept', '⚠️⚠️ says "unlinked" although it was not saved')
  assert.match(unlinkText(out), /保存できていません/)
})

test('★★ if the key cannot be read, revocation is not attempted (⑥ the endpoint is still removed)', async () => {
  let tried = 0
  let forgot = 0
  const out = await runUnlink('PC-B', {
    transport: {
      revokeDevice: async () => {
        tried++
        return { ok: true }
      },
    },
    myKey: undefined,
    forget: () => forgot++,
  })
  assert.equal(tried, 0, '⚠️ sends a revocation although there is no key')
  assert.equal(forgot, 1)
  assert.equal(out.kind, 'kept')
})
