// Pairing decisions and text.
//
// ★★ **Mutants killed by name** here:
//   ① take the first endpoint without matching (**the one-time token leaks to another machine**)
//   ② treat an agent with no public key (old) as a match (`undefined === undefined`)
//   ③ return index 0 when nothing matches (letting `findIndex`'s `-1` through)
//   ④ decoding throws / passes on an empty string
//   ⑤ not stripping control characters from the name to send / not capping its length
//   ⑥ sending an empty name as-is (becomes "no name" on the PC)
//   ⑦ dropping "no route yet" from the success text (**misread as "now it connects"**)
//   ⑧ swapping the UA check order (iPad becomes Mac)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PUBKEY_BYTES, toBase64Url } from '../../../shared/crypto.ts'
import { buildPairUrl } from '../../../shared/pairing.ts'
import {
  MAX_SEND_LABEL,
  defaultDeviceLabel,
  pairAbility,
  pairText,
  pickPairTarget,
  readPairInput,
  sendLabel,
  verifyHandshake,
  verifyText,
} from './pairing.ts'

const KEY_A = toBase64Url(new Uint8Array(PUBKEY_BYTES).fill(1))
const KEY_B = toBase64Url(new Uint8Array(PUBKEY_BYTES).fill(2))
const TOKEN = 'Xk2qP9vLzA-_0123456789abcdefghij'

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Matching the destination (never leak the one-time token)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ returns only the endpoint whose public key matches', () => {
  const list = [{ agentPublicKey: KEY_B, machine: 'pc-b' }, { agentPublicKey: KEY_A, machine: 'pc-a' }]
  assert.equal(pickPairTarget(KEY_A, list), 1)
  assert.equal(pickPairTarget(KEY_B, list), 0)
})

test('★★ undefined if nothing matches (= do not send the one-time token)', () => {
  const list = [{ agentPublicKey: KEY_B, machine: 'pc-b' }]
  assert.equal(pickPairTarget(KEY_A, list), undefined)
  assert.equal(pickPairTarget(KEY_A, []), undefined)
})

test('★★ an agent that returns no public key (old) is not a match', () => {
  // ⚠️⚠️ A mutant passing on `undefined === undefined` **sends the one-time token to an old agent**
  assert.equal(pickPairTarget('', [{ machine: 'old' }]), undefined)
  assert.equal(pickPairTarget(KEY_A, [{ machine: 'old' }]), undefined)
  assert.equal(pickPairTarget(KEY_A, [{ agentPublicKey: undefined }]), undefined)
  // ★★ **An empty key does not match "a candidate that returned empty" either** (without this, the moment a keyless
  //   agent returns `agentPublicKey: ''`, **the one-time token goes there**).
  //   ⚠️ Added on 2026-09-08 after a mutant slipped through (the guard existed but had no test).
  assert.equal(pickPairTarget('', [{ agentPublicKey: '' }]), undefined)
})

test('★★ with several identical keys, take the first (the same agent registered under two URLs)', () => {
  const list = [{ agentPublicKey: KEY_A }, { agentPublicKey: KEY_A }]
  assert.equal(pickPairTarget(KEY_A, list), 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// Decoding
// ─────────────────────────────────────────────────────────────────────────────

test('★★ can read the QR string (leading/trailing whitespace stripped)', () => {
  const url = buildPairUrl({ agentPublicKey: KEY_A, token: TOKEN, machine: 'pc-a' })
  const got = readPairInput(`  ${url}\n`)
  assert.equal(got.kind, 'ok')
  assert.ok(got.kind === 'ok')
  assert.equal(got.payload.agentPublicKey, KEY_A)
  assert.equal(got.payload.token, TOKEN)
  assert.equal(got.payload.machine, 'pc-a')
})

test('★★ unreadable input is unreadable (no throw)', () => {
  for (const bad of ['', '   ', 'なにか', 'https://evil/pair?v=1', 'nyan://pair?v=9']) {
    assert.doesNotThrow(() => readPairInput(bad))
    assert.equal(readPairInput(bad).kind, 'unreadable', `must refuse: ${bad}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

test('★★ default name from the UA (★ check order: the iPad UA contains Macintosh)', () => {
  const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Version/17 Safari'
  assert.equal(defaultDeviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome'), 'Android')
  assert.equal(defaultDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari'), 'iPhone')
  assert.equal(defaultDeviceLabel('Mozilla/5.0 (iPad; CPU OS 17_0) Safari'), 'iPad')
  assert.equal(defaultDeviceLabel(IPAD), 'Mac', '⚠️ iPadOS cannot be told apart from Mac (known)')
  assert.equal(defaultDeviceLabel('Mozilla/5.0 (Windows NT 10.0) Chrome'), 'Windows')
  assert.equal(defaultDeviceLabel(''), 'この端末')
})

test('★★ Android is checked before Linux (the Android UA contains Linux)', () => {
  assert.equal(defaultDeviceLabel('Mozilla/5.0 (Linux; Android 14) Chrome'), 'Android')
  assert.equal(defaultDeviceLabel('Mozilla/5.0 (X11; Linux x86_64) Chrome'), 'Linux')
})

test('★★ the name to send is normalised (control characters stripped, length capped)', () => {
  const label = sendLabel(`  ぼくの\u0000スマホ\u007f${'あ'.repeat(200)}  `, '')
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(label), false)
  assert.ok(label.length <= MAX_SEND_LABEL)
  assert.ok(label.startsWith('ぼくのスマホ'))
})

test('★★ an empty name falls back to the default (no "no name" on the PC)', () => {
  assert.equal(sendLabel('', 'Android 14'), 'Android')
  assert.equal(sendLabel('   ', 'iPhone'), 'iPhone')
  assert.equal(sendLabel('\u0000', ''), 'この端末')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Text (one place)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ the success text says "which route it connects by" (⚠️ does not urge what is already done)', () => {
  const viaRelay = pairText({ kind: 'done', deviceId: 'abcdefgh1234', machine: 'pc-a', relay: true })
  assert.match(viaRelay, /pc-a に登録しました/)
  assert.match(viaRelay, /relay で繋ぎます/)
  // ⚠️⚠️ Registered via relay means the endpoint is already saved with the relay route ⇒ do not urge switching (2026-09-23 real device)
  assert.doesNotMatch(viaRelay, /経路を relay に/)
  const local = pairText({ kind: 'done', deviceId: 'abcdefgh1234', machine: 'pc-a' })
  assert.match(local, /Tailscale で繋ぎます/)
})

test('★★ already registered ⇒ "already registered" wording (⚠️ the old wording was unnatural Japanese)', () => {
  const text = pairText({ kind: 'done', deviceId: 'abcdefgh1234', machine: 'k', already: true, relay: true })
  assert.match(text, /k には、この端末はもう登録されています/)
  assert.doesNotMatch(text, /既に登録しました/)
})

test('★★ no destination ⇒ says "add it to endpoints first" (shows how to fix)', () => {
  const text = pairText({ kind: 'no-target', machine: 'pc-b' })
  assert.match(text, /pc-b/)
  assert.match(text, /接続先/)
})

test('★★ the agent\'s refusal reason is shown as-is (so you know to re-show the QR)', () => {
  const text = pairText({ kind: 'refused', reason: 'ワンタイムが正しくありません' })
  assert.match(text, /ワンタイムが正しくありません/)
})

test('★ every branch has text (the table\'s holes are closed by types, and the real output is checked too)', () => {
  const outcomes = [
    { kind: 'unreadable' },
    { kind: 'no-target', machine: '' },
    { kind: 'no-identity', reason: 'x' },
    { kind: 'refused', reason: 'x' },
    { kind: 'error', reason: 'x' },
    { kind: 'done', deviceId: 'abcdefgh', machine: '' },
  ] as const
  for (const o of outcomes) {
    const text = pairText(o)
    assert.ok(text.length > 0, `empty text for ${o.kind}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Feature marks (fail-closed)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ nothing shown for agents without the mark (old ones) (no buttons that 404)', () => {
  assert.deepEqual(pairAbility(undefined), { pair: false, verify: false })
  assert.deepEqual(pairAbility([]), { pair: false, verify: false })
  assert.deepEqual(pairAbility(['slash-commands']), { pair: false, verify: false })
})

test('★★ pair and verify are separate (an agent may register but lack the handshake endpoint)', () => {
  assert.deepEqual(pairAbility(['device-pairing']), { pair: true, verify: false })
  assert.deepEqual(pairAbility(['device-handshake']), { pair: false, verify: true })
  assert.deepEqual(pairAbility(['device-pairing', 'device-handshake']), {
    pair: true,
    verify: true,
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Handshake connectivity check (steps moved into .ts and exercised in Node)
// ─────────────────────────────────────────────────────────────────────────────

/** ★ Wire the agent side's real implementation (`acceptHandshake`) in port form (base64url) */
async function agentSide(opts: { authorize?: boolean } = {}) {
  const { acceptHandshake, exportPublicKey, fromBase64Url, generateDeviceKey, toBase64Url } =
    await import('../../../shared/crypto.ts')
  const agent = await generateDeviceKey()
  const agentPublicKey = toBase64Url(await exportPublicKey(agent.publicKey))
  const send = async (init: string) => {
    try {
      const a = await acceptHandshake(agent, fromBase64Url(init), () => opts.authorize !== false)
      return {
        ok: true as const,
        reply: toBase64Url(a.message),
        confirm: toBase64Url(a.confirm),
        deviceId: a.deviceId,
      }
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) }
    }
  }
  return { agentPublicKey, send }
}

test('★★ the handshake succeeds and returns the key length and deviceId (proof of reaching the same key)', async () => {
  const { generateDeviceKey, exportPublicKey, fingerprint } = await import(
    '../../../shared/crypto.ts'
  )
  const me = await generateDeviceKey()
  const { agentPublicKey, send } = await agentSide()

  const out = await verifyHandshake(me, agentPublicKey, send)
  assert.equal(out.kind, 'ok')
  assert.ok(out.kind === 'ok')
  assert.equal(out.keyBits, 256, '★ must be 256 bits')
  assert.equal(out.deviceId, await fingerprint(await exportPublicKey(me.publicKey)))
})

test('★★ if the agent refuses, the reason is returned as-is (the user can fix it)', async () => {
  const { generateDeviceKey } = await import('../../../shared/crypto.ts')
  const me = await generateDeviceKey()
  const { agentPublicKey, send } = await agentSide({ authorize: false })

  const out = await verifyHandshake(me, agentPublicKey, send)
  assert.equal(out.kind, 'refused')
  assert.ok(out.kind === 'refused')
  assert.match(out.reason, /登録/)
})

test('★★ addressing another agent\'s key fails (destination matching works)', async () => {
  const { generateDeviceKey, exportPublicKey, toBase64Url } = await import(
    '../../../shared/crypto.ts'
  )
  const me = await generateDeviceKey()
  const { send } = await agentSide()
  const other = toBase64Url(await exportPublicKey((await generateDeviceKey()).publicKey))

  const out = await verifyHandshake(me, other, send)
  assert.equal(out.kind, 'refused')
})

test('★★ does not throw on broken input (the screen does not freeze)', async () => {
  const { generateDeviceKey } = await import('../../../shared/crypto.ts')
  const me = await generateDeviceKey()
  const { send } = await agentSide()

  for (const bad of ['', '!!!', 'AAA']) {
    const out = await verifyHandshake(me, bad, send)
    assert.notEqual(out.kind, 'ok', `must refuse: ${bad}`)
  }
  // Swallows even if the sender throws
  const out = await verifyHandshake(me, (await agentSide()).agentPublicKey, () => {
    throw new Error('通信できません')
  })
  assert.equal(out.kind, 'failed')
})

test('★★ a broken confirm is not a success (proof it goes through accept)', async () => {
  const { generateDeviceKey, toBase64Url } = await import('../../../shared/crypto.ts')
  const me = await generateDeviceKey()
  const { agentPublicKey, send } = await agentSide()

  const broken = async (init: string) => {
    const res = await send(init)
    if (!res.ok) return res
    // ⚠️ Replace confirm (= did not reach the same key)
    return { ...res, confirm: toBase64Url(new Uint8Array(40)) }
  }
  const out = await verifyHandshake(me, agentPublicKey, broken)
  assert.equal(out.kind, 'failed')
})

test('★★ the connectivity-check text also says "no route yet"', () => {
  const text = verifyText({ kind: 'ok', deviceId: 'abcdefgh1234', keyBits: 256 })
  assert.match(text, /握手できました/)
  assert.match(text, /256/)
  assert.match(text, /経路/)
  assert.match(text, /まだ/)
  assert.match(verifyText({ kind: 'refused', reason: 'x' }), /断りました/)
  assert.match(verifyText({ kind: 'failed', reason: 'x' }), /できませんでした/)
})
