import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  addSubscription,
  ensureVapid,
  resetVapidCacheForTest,
  listSubscriptions,
  newestPerDevice,
  isAllowedPushHost,
  isUsableSubject,
  lastFailureForDevice,
  resetFailuresForTest,
  sendToAll,
  validateSubscription,
  type StoredSubscription,
} from './push.ts'

// ★ the default is `device` (device-key identity = one browser). Tests about "cleaning up the same browser's old subscriptions" use this.
//   ⚠️ tailnet (source IP) identities are checked separately below (must not be collapsed / codex round 14, medium #2)
const sub = (endpoint: string, deviceId: string, createdAt: string, via = 'device'): StoredSubscription => ({
  endpoint,
  keys: { p256dh: 'p', auth: 'a' },
  deviceId,
  login: 'user@example',
  createdAt,
  via,
})

test('★ newestPerDevice: keep only the newest subscription per device (prevents double notifications)', () => {
  // each machine's agent serves the PWA, so there are several URLs. Installing from two origins
  // gives the same device two subscriptions, and notifications arrive twice.
  const old = sub('https://fcm/old', '100.67.123.108', '2026-08-11T10:00:00.000Z')
  const now = sub('https://fcm/new', '100.67.123.108', '2026-08-12T10:00:00.000Z')
  const result = newestPerDevice([old, now])
  assert.equal(result.length, 1)
  assert.equal(result[0]?.endpoint, 'https://fcm/new')
})

test('newestPerDevice: picks the newest even in reverse order', () => {
  const old = sub('https://fcm/old', 'dev-1', '2026-08-11T10:00:00.000Z')
  const now = sub('https://fcm/new', 'dev-1', '2026-08-12T10:00:00.000Z')
  assert.equal(newestPerDevice([now, old])[0]?.endpoint, 'https://fcm/new')
})

test('newestPerDevice: different devices both get it', () => {
  const phone = sub('https://fcm/phone', '100.67.123.108', '2026-08-12T10:00:00.000Z')
  const tablet = sub('https://fcm/tablet', '100.99.1.1', '2026-08-12T09:00:00.000Z')
  const result = newestPerDevice([phone, tablet])
  assert.equal(result.length, 2)
  assert.deepEqual(new Set(result.map((s) => s.endpoint)), new Set([phone.endpoint, tablet.endpoint]))
})

test('newestPerDevice: entries without a deviceId are sent as is without collapsing', () => {
  const a = sub('https://fcm/a', 'unknown', '2026-08-12T10:00:00.000Z')
  const b = sub('https://fcm/b', 'unknown', '2026-08-12T11:00:00.000Z')
  assert.equal(newestPerDevice([a, b]).length, 2)
})

test('newestPerDevice: empty in, empty out', () => {
  assert.deepEqual(newestPerDevice([]), [])
})

test('★ addSubscription: concurrent registrations do not lose subscriptions (read-modify-write race)', async () => {
  // ⚠️ on 2026-08-12 a subscription was actually lost and notifications stopped. The PWA re-registers with every agent
  //    at startup, so with two origins open, concurrent registration is normal.
  //    Even with atomic writes via rename, a cut-in between read → modify → write rolls things back.
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-subs-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  try {
    const subs = Array.from({ length: 8 }, (_, i) =>
      sub(`https://fcm/ep-${i}`, `dev-${i}`, `2026-08-12T10:0${i}:00.000Z`),
    )
    await Promise.all(subs.map((s) => addSubscription(s)))

    const stored = await listSubscriptions()
    assert.equal(stored.length, subs.length)
    assert.deepEqual(
      new Set(stored.map((s) => s.endpoint)),
      new Set(subs.map((s) => s.endpoint)),
    )
  } finally {
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('addSubscription: re-registering the same endpoint overwrites instead of adding (last-write-wins)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-subs-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  try {
    await addSubscription(sub('https://fcm/same', 'dev-1', '2026-08-12T10:00:00.000Z'))
    await addSubscription(sub('https://fcm/same', 'dev-1', '2026-08-12T11:00:00.000Z'))
    const stored = await listSubscriptions()
    assert.equal(stored.length, 1)
    assert.equal(stored[0]?.createdAt, '2026-08-12T11:00:00.000Z')
  } finally {
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Subscription validation (pins the holes found in the 2026-08-12 review) ──────────────────

const P256 = 'B'.repeat(87)
const AUTH = 'A'.repeat(22)

test('★★ validateSubscription: an attacker URL cannot be registered (prevents the send path from hanging)', () => {
  // if this passes, the agent POSTs there on every notification, and sending does not finish while no response comes back.
  // ⚠️ at first it only checked "https, no port, not an IP", but attacker.example went through and
  //    could actually be registered in the production subscription file (2026-08-12). Switched to allowed hosts.
  assert.equal(validateSubscription('https://fcm.googleapis.com/fcm/send/x', P256, AUTH), null)
  assert.ok(validateSubscription('https://attacker.example/hold', P256, AUTH), 'unknown hosts are rejected')
  assert.ok(validateSubscription('http://fcm.googleapis.com/x', P256, AUTH), 'http is rejected')
  assert.ok(validateSubscription('https://fcm.googleapis.com:8443/x', P256, AUTH), 'a port is rejected')
  assert.ok(validateSubscription('https://127.0.0.1/x', P256, AUTH), 'IPs are rejected')
  assert.ok(validateSubscription('https://localhost/x', P256, AUTH), 'localhost is rejected')
  assert.ok(validateSubscription('https://nas.local/x', P256, AUTH), '.local is rejected')
  assert.ok(validateSubscription('https://intranet/x', P256, AUTH), 'host names without a dot are rejected')
  assert.ok(validateSubscription('not a url', P256, AUTH), 'non-URLs are rejected')
  assert.ok(validateSubscription(`https://a.example/${'x'.repeat(600)}`, P256, AUTH), 'too long is rejected')
})

test('★ validateSubscription: checks the shape of the keys', () => {
  assert.ok(validateSubscription('https://a.example/x', 'short', AUTH), 'p256dh is too short')
  assert.ok(validateSubscription('https://a.example/x', P256, 'short'), 'auth is too short')
  assert.ok(validateSubscription('https://a.example/x', `${'B'.repeat(86)}+/`, AUTH), 'characters outside base64url')
})

// ── Broken files do not lose subscriptions or keys (2026-08-13 fail-open fix) ──────────────

async function withStateDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-broken-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  try {
    return await fn(dir)
  } finally {
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
}

test('★★ a broken subscription file is not overwritten (not read as empty and erased)', async () => {
  await withStateDir(async (dir) => {
    const path = join(dir, 'subscriptions.json')
    const broken = '{"subscriptions":[{"endpoint":"https://fcm/real"} ここで切れている'
    await writeFile(path, broken)
    // reading gives up (it just cannot send; other features keep working)
    assert.deepEqual(await listSubscriptions(), [])
    // ⚠️ writing is refused. Letting it through would erase the real subscriptions
    await assert.rejects(
      () => addSubscription(sub('https://fcm/new', 'dev-1', '2026-08-13T10:00:00.000Z')),
      /購読ファイルが読めない/,
    )
    assert.equal(await readFile(path, 'utf8'), broken, 'the file is unchanged')
  })
})

test('★★ a broken VAPID file does not recreate the keys (every subscription would die)', async () => {
  await withStateDir(async (dir) => {
    const path = join(dir, 'vapid.json')
    const broken = '{"publicKey":"BJ...", "privateKey" 壊れている'
    await writeFile(path, broken)
    await assert.rejects(() => ensureVapid(), /VAPID 鍵のファイルが読めません/)
    assert.equal(await readFile(path, 'utf8'), broken, 'must not overwrite (unrecoverable)')
  })
})

test('★★ VAPID: a file with only one half left is not overwritten with new keys (unrecoverable)', async () => {
  // ⚠️ this is not the "broken JSON" path but **syntactically valid with missing contents**.
  //    There was no test, so deleting the one guarding line stayed all green (2026-08-14 review, medium)
  await withStateDir(async (dir) => {
    resetVapidCacheForTest()
    const path = join(dir, 'vapid.json')
    const partial = JSON.stringify({ privateKey: 'もとの秘密鍵', subject: 'mailto:x' })
    await writeFile(path, partial)
    await assert.rejects(() => ensureVapid(), /VAPID/)
    assert.equal(await readFile(path, 'utf8'), partial, 'must not overwrite')
    resetVapidCacheForTest()
  })
})

test('★★ subscriptions: a file whose subscriptions is not an array is not overwritten as empty', async () => {
  await withStateDir(async (dir) => {
    const path = join(dir, 'subscriptions.json')
    // valid JSON. A shape whose contents may still be alive
    const odd = JSON.stringify({ subscriptions: { '0': { endpoint: 'https://fcm/x' } } })
    await writeFile(path, odd)
    await assert.rejects(
      () => addSubscription(sub('https://fcm/new', 'dev-1', '2026-08-14T10:00:00.000Z')),
      /購読ファイル/,
    )
    assert.equal(await readFile(path, 'utf8'), odd, 'the file is unchanged')
  })
})

test('★ division of labour between newestPerDevice and addSubscription', () => {
  // newestPerDevice only "collapses at send time". Without removal on the storage side the file grows forever
  // (changing the endpoint stacks separate records even for the same device), so
  // addSubscription removes deviceId duplicates. This makes that premise explicit.
  const a = sub('https://fcm/a', 'dev-1', '2026-08-12T10:00:00.000Z')
  const b = sub('https://fcm/b', 'dev-1', '2026-08-12T11:00:00.000Z')
  assert.equal(newestPerDevice([a, b]).length, 1)
})

test('★ isAllowedPushHost: only known push services are allowed, judged at dot boundaries', () => {
  assert.equal(isAllowedPushHost('fcm.googleapis.com'), true)
  assert.equal(isAllowedPushHost('updates.push.services.mozilla.com'), true)
  assert.equal(isAllowedPushHost('web.push.apple.com'), true)
  // a leading `.` allows subdomains
  assert.equal(isAllowedPushHost('abc.notify.windows.com'), true)
  // rejects spoofing that merely "ends the same"
  assert.equal(isAllowedPushHost('evilfcm.googleapis.com'), false)
  assert.equal(isAllowedPushHost('fcm.googleapis.com.evil.example'), false)
  assert.equal(isAllowedPushHost('evil-notify.windows.com.attacker.example'), false)
  assert.equal(isAllowedPushHost('attacker.example'), false)
  // the escape-hatch form (when passed as an argument)
  assert.equal(isAllowedPushHost('my.push.example', ['my.push.example']), true)
})

test('★★ isUsableSubject: rejects the shapes Apple rejects (the real 403 BadJwtToken)', () => {
  // ⚠️⚠️ measured 2026-08-21. Apple rejected `mailto:nyan-remote@localhost` with 403, and
  //    with the same key `https://example.com/...` passed with 201.
  //    Do not confuse "readable as a string" with "usable" (CLAUDE.md).
  for (const bad of [
    'mailto:nyan-remote@localhost',
    'mailto:localhost',
    'mailto:@example.com',
    'mailto:x@',
    'mailto:x@.com',
    'mailto:x@example.com.',
    'https://localhost/x',
    'https://localhost:7777/x',
    'http://example.com/x', // anything but https is rejected
    'example.com',
    '',
    '   ',
    undefined,
    null,
    42,
  ]) {
    assert.equal(isUsableSubject(bad), false, `must not be usable: ${JSON.stringify(bad)}`)
  }
  for (const good of [
    'https://example.com/tmux-agent',
    'https://sub.example.co.jp/a/b',
    'mailto:nyan-remote@example.com',
    'mailto:a.b+c@mail.example.org',
  ]) {
    assert.equal(isUsableSubject(good), true, `should be usable: ${good}`)
  }
})

test('★★ ensureVapid: fixes a broken subject and **does not change the keys**', async () => {
  // ⚠️⚠️ recreating the keys kills every existing subscription (unrecoverable / CLAUDE.md).
  //    Confirm, **using the file the implementation actually wrote**, that only the subject is fixed.
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-vapid-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  const prevSubj = process.env.NYAN_REMOTE_VAPID_SUBJECT
  process.env.NYAN_REMOTE_STATE_DIR = dir
  delete process.env.NYAN_REMOTE_VAPID_SUBJECT
  resetVapidCacheForTest()
  try {
    const before = {
      publicKey: 'PUB-do-not-change',
      privateKey: 'PRIV-do-not-change',
      subject: 'mailto:nyan-remote@localhost',
    }
    await writeFile(join(dir, 'vapid.json'), JSON.stringify(before), 'utf8')

    const got = await ensureVapid()
    assert.equal(got.publicKey, before.publicKey, 'the public key changed')
    assert.equal(got.privateKey, before.privateKey, '★★ the private key changed (every subscription dies)')
    assert.equal(isUsableSubject(got.subject), true, `subject not fixed: ${got.subject}`)

    // ★ it is also written to the file (so the next start does not get 403 again)
    const onDisk = JSON.parse(await readFile(join(dir, 'vapid.json'), 'utf8'))
    assert.equal(onDisk.publicKey, before.publicKey)
    assert.equal(onDisk.privateKey, before.privateKey)
    assert.equal(onDisk.subject, got.subject)
    assert.notEqual(onDisk.subject, before.subject)
  } finally {
    resetVapidCacheForTest()
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    if (prevSubj !== undefined) process.env.NYAN_REMOTE_VAPID_SUBJECT = prevSubj
    await rm(dir, { recursive: true, force: true })
  }
})

test('★ ensureVapid: a usable subject is left as is (not rewritten on its own)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-vapid-keep-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  resetVapidCacheForTest()
  try {
    const keep = 'mailto:me@example.org'
    await writeFile(
      join(dir, 'vapid.json'),
      JSON.stringify({ publicKey: 'P', privateKey: 'K', subject: keep }),
      'utf8',
    )
    assert.equal((await ensureVapid()).subject, keep)
  } finally {
    resetVapidCacheForTest()
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★ the default subject is a shape push services accept (if this breaks, nothing reaches the iPhone)', async () => {
  // ⚠️ the subject of keys generated on a new installation. Check **the value the implementation actually builds**
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-vapid-new-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  const prevSubj = process.env.NYAN_REMOTE_VAPID_SUBJECT
  process.env.NYAN_REMOTE_STATE_DIR = dir
  delete process.env.NYAN_REMOTE_VAPID_SUBJECT
  resetVapidCacheForTest()
  try {
    const v = await ensureVapid()
    assert.equal(isUsableSubject(v.subject), true, `the default is unusable: ${v.subject}`)
    // ⚠️ do not mix in user information (it goes to Apple / Google)
    assert.ok(!v.subject.includes('@localhost'), 'the default reverted to localhost')
  } finally {
    resetVapidCacheForTest()
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    if (prevSubj !== undefined) process.env.NYAN_REMOTE_VAPID_SUBJECT = prevSubj
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★ a 403 does not delete the subscription and is kept as "not delivered" (so it can be noticed)', async () => {
  // ⚠️⚠️ 2026-08-21: 171 failures over 3 days to the iPhone went unnoticed.
  //    404/410 delete the subscription so they are noticeable, but **403 does not**, so the screen stays "enabled".
  //    ⇒ record it and show it in `/push/status`. Verified **through the implementation's own send path**.
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-fail-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  resetVapidCacheForTest()
  resetFailuresForTest()
  try {
    // ★ subscriptions always come after the key (subscriptions without a key are deleted as "key lost" / 2026-09-24)
    await ensureVapid()
    await addSubscription(sub('https://fcm.googleapis.com/x/a', 'dev-a', '2026-08-21T10:00:00.000Z'))
    await addSubscription(sub('https://fcm.googleapis.com/x/b', 'dev-b', '2026-08-21T10:00:00.000Z'))

    // only dev-a gets 403, dev-b succeeds
    const r = await sendToAll({ title: 't', body: 'b' }, async (s) => {
      if (s.endpoint.endsWith('/a')) throw Object.assign(new Error('nope'), { statusCode: 403 })
      return undefined
    })
    assert.deepEqual(r, { sent: 1, pruned: 0, failed: 1 })

    // ★ the subscription is not deleted (deleting it would be unrecoverable)
    assert.equal((await listSubscriptions()).length, 2)

    const bad = await lastFailureForDevice('dev-a')
    assert.equal(bad?.status, 403)
    assert.ok(bad && !Number.isNaN(Date.parse(bad.at)), `at is not a timestamp: ${bad?.at}`)
    // ⚠️ do not make a device that did not fail look broken
    assert.equal(await lastFailureForDevice('dev-b'), undefined)

    // ★ cleared once it recovers (showing it forever hides real failures)
    await sendToAll({ title: 't', body: 'b' }, async () => undefined)
    assert.equal(await lastFailureForDevice('dev-a'), undefined)
  } finally {
    resetFailuresForTest()
    resetVapidCacheForTest()
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('★ a 404 deletes the subscription (treated differently from 403)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-gone-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  resetVapidCacheForTest()
  resetFailuresForTest()
  try {
    // ★ subscriptions always come after the key (subscriptions without a key are deleted as "key lost" / 2026-09-24)
    await ensureVapid()
    await addSubscription(sub('https://fcm.googleapis.com/x/a', 'dev-a', '2026-08-21T10:00:00.000Z'))
    const r = await sendToAll({ title: 't', body: 'b' }, async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 })
    })
    assert.deepEqual(r, { sent: 0, pruned: 1, failed: 0 })
    assert.equal((await listSubscriptions()).length, 0)
    // no warning is kept for a deleted subscription
    assert.equal(await lastFailureForDevice('dev-a'), undefined)
  } finally {
    resetFailuresForTest()
    resetVapidCacheForTest()
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

// ★★ codex round 14, medium #2: a tailnet identity is **the source IP** = the same value for other browsers on the same device.
//   Collapsing by "one per device" makes them **fight over the subscription** on every sync (only the last to sync receives).
test('★★★★ tailnet (IP identity) subscriptions are not collapsed even with the same identity (no fighting)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-subs-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  try {
    await addSubscription(sub('https://fcm/browserA', '100.64.0.5', '2026-09-23T00:00:00.000Z', 'tailscale'))
    await addSubscription(sub('https://fcm/browserB', '100.64.0.5', '2026-09-23T00:01:00.000Z', 'tailscale'))
    const stored = await listSubscriptions()
    assert.deepEqual(
      stored.map((s) => s.endpoint).sort(),
      ['https://fcm/browserA', 'https://fcm/browserB'],
      '⚠️⚠️ deleted another browser\'s subscription with the same IP (they would fight over it)',
    )
    // ★ send to both as well (limiting to one stops the fight but one of them gets nothing)
    assert.equal(newestPerDevice(stored).length, 2, '⚠️⚠️ narrowed to one when sending')
  } finally {
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★★★ device-key identities are collapsed as before (cleans up the same browser\'s old subscriptions)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-subs-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  try {
    await addSubscription(sub('https://fcm/old', 'fp-abc', '2026-09-23T00:00:00.000Z', 'device'))
    await addSubscription(sub('https://fcm/new', 'fp-abc', '2026-09-23T00:01:00.000Z', 'device'))
    assert.deepEqual((await listSubscriptions()).map((s) => s.endpoint), ['https://fcm/new'])
  } finally {
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★★ old records without an identity kind are not collapsed when sending (⚠️ do not mix them up so one gets nothing)', () => {
  const a = { ...sub('https://fcm/a', '100.64.0.5', '2026-09-23T00:00:00.000Z'), via: undefined }
  const b = { ...sub('https://fcm/b', '100.64.0.5', '2026-09-23T00:01:00.000Z'), via: undefined }
  assert.equal(newestPerDevice([a, b]).length, 2)
})

test('★★★★ send in each subscription\'s language (only the body\'s fixed words are translated; broken languages get Japanese / 2026-09-23)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-lang-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  resetVapidCacheForTest()
  resetFailuresForTest()
  try {
    await addSubscription({ ...sub('https://fcm.googleapis.com/x/ja', 'dev-ja', '2026-09-23T10:00:00.000Z'), lang: 'ja' })
    await addSubscription({ ...sub('https://fcm.googleapis.com/x/en', 'dev-en', '2026-09-23T10:00:00.000Z'), lang: 'en' })
    await addSubscription({ ...sub('https://fcm.googleapis.com/x/old', 'dev-old', '2026-09-23T10:00:00.000Z') })
    await addSubscription({
      ...sub('https://fcm.googleapis.com/x/bad', 'dev-bad', '2026-09-23T10:00:00.000Z'),
      lang: 'fr' as never,
    })
    const got: Record<string, { title: string; body: string }> = {}
    await sendToAll({ title: 'GYG テスト', body: '要対応（承認プロンプト）· PC-B' }, async (s, body) => {
      got[s.endpoint.split('/').pop()!] = JSON.parse(body)
    })
    assert.equal(got['ja']!.body, '要対応（承認プロンプト）· PC-B')
    assert.equal(got['en']!.body, 'Needs you (permission prompt) · PC-B')
    // ⚠️ line 1 (title) is not translated (it is the user's content)
    assert.equal(got['en']!.title, 'GYG テスト')
    // ★ records without a language (from before it was added) and broken values get Japanese (⚠️ never send a notification without a body)
    assert.equal(got['old']!.body, '要対応（承認プロンプト）· PC-B')
    assert.equal(got['bad']!.body, '要対応（承認プロンプト）· PC-B')
  } finally {
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★★ if subscriptions remain while the key file is missing (key lost), delete the old-key subscriptions and create a new key (2026-09-24)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-lostvapid-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  const warn = console.warn
  const warned: string[] = []
  console.warn = (m: string) => void warned.push(String(m))
  try {
    resetVapidCacheForTest()
    const first = await ensureVapid()
    await addSubscription(sub('https://fcm.googleapis.com/x/a', 'dev-a', '2026-08-21T10:00:00.000Z'))
    assert.equal(warned.length, 0, '⚠️ says "lost" on first start (no subscriptions)')
    // ★ lose only the key file
    const { rm: remove } = await import('node:fs/promises')
    await remove(join(dir, 'vapid.json'))
    resetVapidCacheForTest()
    const again = await ensureVapid()
    assert.notEqual(again.publicKey, first.publicKey)
    assert.deepEqual(await listSubscriptions(), [], '⚠️⚠️ old-key subscriptions remain (they will never be delivered)')
    assert.ok(warned.some((m) => m.includes('1 件')), `⚠️ the loss is not logged: ${warned.join(' / ')}`)
  } finally {
    console.warn = warn
    resetVapidCacheForTest()
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★★ if the subscription file is broken, creating a key does not touch subscriptions (keeps the evidence)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-lostvapid2-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  const err = console.error
  console.error = () => undefined
  try {
    await writeFile(join(dir, 'subscriptions.json'), '{ こわれ')
    resetVapidCacheForTest()
    await ensureVapid()
    assert.equal(await readFile(join(dir, 'subscriptions.json'), 'utf8'), '{ こわれ', '⚠️⚠️ overwrote the broken subscription file')
  } finally {
    console.error = err
    resetVapidCacheForTest()
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★★★ requests arriving while the key is being recreated do not get the new key until cleanup finishes (codex round 18, medium #3)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-lostvapid3-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  const warn = console.warn
  console.warn = () => undefined
  try {
    // ★ the key-lost state (only subscriptions remain)
    resetVapidCacheForTest()
    await ensureVapid()
    await addSubscription(sub('https://fcm.googleapis.com/x/old', 'dev-old', '2026-08-21T10:00:00.000Z'))
    const { rm: remove } = await import('node:fs/promises')
    await remove(join(dir, 'vapid.json'))
    resetVapidCacheForTest()

    // ⚠️ during recreation, another request registers a subscription as soon as it gets the key
    let done = false
    const first = ensureVapid().then(() => {
      done = true
    })
    const late: Promise<unknown>[] = []
    // ⚠️ insert only as many as fit under the subscription limit (32) (exceeding it drops old ones = decreases for another reason)
    while (!done && late.length < 20) {
      const n = late.length
      late.push(
        ensureVapid().then(() =>
          addSubscription(sub(`https://fcm.googleapis.com/x/new${n}`, `dev-new-${n}`, '2026-09-24T10:00:00.000Z')),
        ),
      )
      await new Promise((r) => setImmediate(r))
    }
    await first
    await Promise.all(late)
    const left = await listSubscriptions()
    // ⚠️⚠️ **every single** subscription registered midway remains (lose even one and that device gets no notifications)
    assert.equal(left.length, late.length, `⚠️⚠️ deleted subscriptions registered with the new key too (${left.length} of ${late.length} left)`)
    assert.ok(late.length > 1, '⚠️ could not insert requests during recreation (this check is idle)')
    assert.ok(left.every((s) => s.deviceId.startsWith('dev-new')), '⚠️ old-key subscriptions remain')
  } finally {
    console.warn = warn
    resetVapidCacheForTest()
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})
