// Output of `npm run pair`.
//
// ★★ The mutations **targeted by name** here:
//   ① rounding the remaining time up ("5 min left" with only 4.5 min)
//   ② falling back to 0 for an unreadable time (**lying that it has expired**)
//   ③ printing a negative number when already past
//   ④ not printing the URL when the QR cannot be drawn (**pairing becomes impossible**)
//   ⑤ not printing why the QR failed and how to fix it (people cannot find the cause)
//   ⑥ printing the one-time token outside the URL too (creates a forgot-to-remove shape)
//   ⑦ not waiting for the agent to start (★ hit for real on 2026-09-08: `fetch failed` right after restart)
//   ⑧ waiting forever / waiting although the first try passed / waiting silently

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectWithRetry, minutesLeft, recreatedText, renderPair } from './pairPrint.mjs'
import { setLang } from '../../shared/i18n.ts'

// ★ Tests that look at Japanese text pin the language (do not rely on the default)
setLang('ja')

const NOW = Date.parse('2026-09-07T10:00:00.000Z')
const URL_ = 'nyan://pair?v=1&a=BEiiii&t=XkTOKENxx&n=pc-a'

test('★★ remaining time is rounded down (never suggest "still time")', () => {
  assert.equal(minutesLeft('2026-09-07T10:04:59.000Z', NOW), 4)
  assert.equal(minutesLeft('2026-09-07T10:05:00.000Z', NOW), 5)
  assert.equal(minutesLeft('2026-09-07T10:00:59.000Z', NOW), 0)
})

test('★★★ an unreadable time is undefined (falling back to 0 would lie "expired")', () => {
  assert.equal(minutesLeft('きのう', NOW), undefined)
  assert.equal(minutesLeft('', NOW), undefined)
})

test('★ past deadlines give 0 (no negative numbers)', () => {
  assert.equal(minutesLeft('2026-09-07T09:00:00.000Z', NOW), 0)
})

test('★★★ always prints the URL and expiry even without a QR (never blocks pairing)', () => {
  const out = renderPair({
    url: URL_,
    expiresAt: '2026-09-07T10:05:00.000Z',
    machine: 'pc-a',
    now: NOW,
  })
  assert.ok(out.includes(URL_), '★ the URL must be printed')
  assert.match(out, /あと 5 分/)
  // ⚠️⚠️ **Never suggest `apt install`** (2026-09-19). It was decided on 2026-09-16 to draw the QR ourselves with
  //    `shared/qr.ts`, yet real machines kept saying "`sudo apt install qrencode`".
  assert.doesNotMatch(out, /apt install/, '⚠️⚠️ suggests installing an external command')
  assert.doesNotMatch(out, /qrencode/, '⚠️⚠️ names something we decided not to use')
  assert.match(out, /貼り付け/, '★ must say what to do instead')
})

test('★★ prints the QR when there is one (and then no "please install")', () => {
  const qr = '████\n█  █\n████\n\n'
  const out = renderPair({
    url: URL_,
    expiresAt: '2026-09-07T10:05:00.000Z',
    machine: 'pc-a',
    qr,
    now: NOW,
  })
  assert.ok(out.includes('████'))
  assert.equal(out.includes('apt install'), false, '⚠️ no unnecessary instructions')
  assert.equal(/\n\n\n/.test(out), false, '★ trailing blank lines are collapsed')
  assert.ok(out.includes(URL_), '⚠️ also print the URL for devices that cannot scan the QR')
})

test('★★ says so when expired (never silently shows an old QR)', () => {
  const out = renderPair({
    url: URL_,
    expiresAt: '2026-09-07T09:00:00.000Z',
    machine: 'k',
    now: NOW,
  })
  assert.match(out, /切れています/)
})

test('★★ says so when the expiry cannot be read (never confused with "0 min left")', () => {
  const out = renderPair({ url: URL_, expiresAt: 'こわれ', machine: 'k', now: NOW })
  assert.match(out, /期限が読めません/)
  assert.equal(out.includes('切れています'), false)
})

test('★★ the one-time token appears only inside the URL (never in two places)', () => {
  const out = renderPair({
    url: URL_,
    expiresAt: '2026-09-07T10:05:00.000Z',
    machine: 'k',
    now: NOW,
  })
  const hits = out.split('XkTOKENxx').length - 1
  assert.equal(hits, 1, `the one-time token appears in ${hits} places`)
})

test('★★★ waits until it connects (absorbs the moment right after restart)', async () => {
  let calls = 0
  const slept = []
  const { res, waited } = await connectWithRetry(
    async () => {
      calls += 1
      if (calls < 3) throw new Error('fetch failed')
      return { ok: true }
    },
    { waitMs: 1, sleep: async (ms) => void slept.push(ms) },
  )
  assert.deepEqual(res, { ok: true })
  assert.equal(waited, 2, '★ must return the number of waits (never slow down silently)')
  assert.deepEqual(slept, [1, 1])
})

test('★★★ if it fails up to the limit, throws the last reason (never waits forever)', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      connectWithRetry(
        async () => {
          calls += 1
          throw new Error(`だめ${calls}`)
        },
        { tries: 3, waitMs: 1, sleep: async () => {} },
      ),
    /だめ3/,
  )
  assert.equal(calls, 3, '★ must try exactly the limit number of times')
})

test('★★ no wait if the first try passes', async () => {
  const slept = []
  const { waited } = await connectWithRetry(async () => ({ ok: true }), {
    sleep: async (ms) => void slept.push(ms),
  })
  assert.equal(waited, 0)
  assert.deepEqual(slept, [], '⚠️ must not wait needlessly')
})

test('★★★ if the key was regenerated, says "rescan" before the QR and never suggests revoking (2026-09-24)', () => {
  const r = { at: '2026-09-24T01:00:00.000Z', registered: 2 }
  const out = renderPair({ url: 'nyan://pair?x', expiresAt: new Date(Date.now() + 300_000).toISOString(), machine: 'm', qr: 'QRART', keyRecreated: r })
  assert.ok(out.includes('作り直されました'), out)
  assert.ok(out.includes('2 台'), out)
  assert.ok(out.indexOf('作り直されました') < out.indexOf('QRART'), '⚠️ printed after the QR (the QR scrolls off the screen)')
  assert.ok(!recreatedText(r).includes('--revoke'), '⚠️⚠️ suggests revoking (would remove the current registration too)')
  assert.ok(recreatedText({ at: 'x', registered: null }).includes('それより前に登録したスマホ'))
  // ★ Says nothing if it was not regenerated
  assert.ok(!renderPair({ url: 'u', expiresAt: new Date(Date.now() + 300_000).toISOString(), machine: 'm' }).includes('作り直され'))
})

test('★★ in English no Japanese is printed (⚠️ overseas users / 2026-09-24)', () => {
  setLang('en')
  try {
    const jp = /[\u3040-\u30ff\u4e00-\u9fff]/
    const out = renderPair({
      url: URL_,
      expiresAt: new Date(NOW + 5 * 60000).toISOString(),
      machine: 'pc-a',
      now: NOW,
      keyRecreated: { at: '2026-09-07T09:00:00.000Z', registered: 2 },
    })
    assert.doesNotMatch(out, jp, out)
    assert.match(out, /Expires in 5 min/)
    assert.doesNotMatch(renderPair({ url: URL_, expiresAt: 'x', machine: 'm', now: NOW }), jp)
    assert.doesNotMatch(recreatedText({ at: 'x', registered: null }), jp)
    assert.ok(!recreatedText({ at: 'x', registered: 1 }).includes('--revoke'), '⚠️⚠️ suggests revoking')
  } finally {
    setLang('ja')
  }
})
