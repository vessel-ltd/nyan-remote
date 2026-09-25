// ★★ `/push/status` returns "the markers for this device's endpoints" (2026-09-23 / codex round 13, high #3).
//
// ⚠️⚠️ `subscribed` means "does this device have **any** subscription at all", so even if registering the new endpoint
//   failed, it was true while the old one remained ⇒ the PWA did not resend, and **even deleted the old subscription**.
// ★ What is checked here: ① **only this device's markers** are returned (if other devices' markers were mixed in, another
//   device's registration would look like "it's arriving") ② the endpoint cannot be read from a marker (no capability URL is returned).
// ⚠️ This route had **not a single test**.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { endpointTag } from '../../../shared/pushTag.ts'
import { addSubscription, ensureVapid, resetVapidCacheForTest, type StoredSubscription } from '../push.ts'
import { pushStatus } from './push.ts'

const sub = (endpoint: string, deviceId: string): StoredSubscription => ({
  endpoint,
  keys: { p256dh: 'p', auth: 'a' },
  deviceId,
  login: 'user@example',
  createdAt: '2026-09-23T00:00:00.000Z',
})

test('★★ returns only this device\'s markers, never the endpoint itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-pushstatus-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  try {
    // ★ A subscription always comes after the key (a subscription without a key is removed as "the key was lost" / 2026-09-24)
    resetVapidCacheForTest()
    await ensureVapid()
    await addSubscription(sub('https://fcm/mine', 'dev-me'))
    await addSubscription(sub('https://fcm/other', 'dev-other'))
    const ctx = { identity: { deviceId: 'dev-me' } } as unknown as Parameters<typeof pushStatus>[0]
    const st = await pushStatus(ctx)
    assert.deepEqual(st.endpointTags, [await endpointTag('https://fcm/mine')], '⚠️⚠️ not this device\'s markers')
    assert.ok(
      !(st.endpointTags ?? []).includes(await endpointTag('https://fcm/other')),
      '⚠️⚠️ another device\'s marker is mixed in (another device\'s registration looks like "it\'s arriving")',
    )
    assert.ok(!JSON.stringify(st).includes('https://fcm/'), '⚠️⚠️ returns the endpoint itself (a capability URL)')
    assert.equal(st.subscribed, true)
  } finally {
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★ the register endpoint records the kind of identity (via) (⚠️ without it, even device-key identities are not collapsed and old subscriptions pile up)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./push.ts', import.meta.url), 'utf8')
  // ⚠️ Look only at lines that execute (comments contain the same text / CLAUDE.md §2)
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  const body = code.slice(code.indexOf('export async function pushSubscribe'), code.indexOf('addSubscription(sub)'))
  assert.match(body, /via: ctx\.identity\.via,/, '⚠️⚠️ the subscription does not record the kind of identity')
})

test('★★ "registered" means only those registered in this screen\'s language (switching triggers re-registration / 2026-09-23)', async () => {
  const { setLang } = await import('../../../shared/i18n.ts')
  const { pushSubscribe } = await import('./push.ts')
  const { Readable } = await import('node:stream')
  const { listSubscriptions } = await import('../push.ts')
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-pushlang-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  try {
    // Records without a language (from before it was added) count as Japanese
    await addSubscription(sub('https://fcm.googleapis.com/x/old', 'dev-me'))
    const ctx = { identity: { deviceId: 'dev-me' } } as unknown as Parameters<typeof pushStatus>[0]
    setLang('ja')
    assert.equal((await pushStatus(ctx)).endpointTags?.length, 1, '⚠️ on a Japanese UI, a record without a language was called unregistered (needless re-registration)')
    setLang('en')
    assert.equal((await pushStatus(ctx)).endpointTags?.length, 0, '⚠️⚠️ on an English UI, a Japanese registration was called "registered" (notifications stay in Japanese)')
    // ★ Re-registering from an English UI records it in English
    const body = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/x/old', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } })
    const req = Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': 'application/json', 'user-agent': 't' } })
    await pushSubscribe({ req, identity: { deviceId: 'dev-me', login: 'u', via: 'device' } } as unknown as Parameters<typeof pushSubscribe>[0])
    const stored = await listSubscriptions()
    assert.equal(stored.find((s) => s.endpoint.endsWith('/old'))?.lang, 'en')
    assert.equal((await pushStatus(ctx)).endpointTags?.length, 1)
  } finally {
    setLang('ja')
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★★ even when the load is shared, the 503 body is in that request\'s language (codex round 17, low #4)', async () => {
  // ⚠️ Set up an English request arriving mid-load of a Japanese request, so both wait on the same `vapidInFlight`
  const { writeFile } = await import('node:fs/promises')
  const { setLangProvider } = await import('../../../shared/i18n.ts')
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const { ensureVapid, resetVapidCacheForTest } = await import('../push.ts')
  const als = new AsyncLocalStorage<'ja' | 'en'>()
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-pushlang-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  const origErr = console.error
  console.error = () => {}
  setLangProvider(() => als.getStore())
  try {
    await writeFile(join(dir, 'vapid.json'), '{ こわれ')
    resetVapidCacheForTest()
    const ja = als.run('ja', () => ensureVapid().then(() => '', (e: Error) => e))
    const en = als.run('en', () => ensureVapid().then(() => '', (e: Error) => e))
    const [ej, ee] = await Promise.all([ja, en])
    assert.ok(ej instanceof Error && ee instanceof Error, 'read although it is corrupt (this check is a no-op)')
    assert.equal(ej, ee, '⚠️ the load is not shared (this check is a no-op)')
    // ★ The body is built **in the language of the request that reads it** (`orExplain` reads `message` inside the request)
    assert.match(als.run('ja', () => ej.message), /読めません/)
    assert.match(als.run('en', () => ee.message), /cannot be read/, '⚠️⚠️ a Japanese 503 for an English request')
  } finally {
    setLangProvider(undefined)
    console.error = origErr
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★★ the 503 body for corrupt config contains no absolute path (name only; the location goes to the log / 2026-09-23)', async () => {
  // ⚠️ CLAUDE.md §2 "do not mix details into outward-facing text". `orExplain` puts the exception message as is into the 503 body
  const { writeFile } = await import('node:fs/promises')
  const { pushSubscribe } = await import('./push.ts')
  const { resetVapidCacheForTest } = await import('../push.ts')
  const { Readable } = await import('node:stream')
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-pushpath-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  const origErr = console.error
  console.error = () => {}
  try {
    await writeFile(join(dir, 'vapid.json'), '{ こわれ')
    await writeFile(join(dir, 'subscriptions.json'), '{ こわれ')
    resetVapidCacheForTest()
    const ctx = { identity: { deviceId: 'dev-me' } } as unknown as Parameters<typeof pushStatus>[0]
    const status = await pushStatus(ctx).then(
      () => undefined,
      (e: Error) => e.message,
    )
    assert.ok(status, 'not a 503 although it is corrupt (this check is a no-op)')
    assert.ok(!status.includes(dir), `⚠️⚠️ the 503 body contains an absolute path: ${status}`)
    assert.match(status, /vapid\.json/, '⚠️ cannot tell which file')
    const body = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/x/a', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } })
    const req = Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': 'application/json' } })
    const sub = await pushSubscribe({ req, identity: { deviceId: 'dev-me', login: 'u', via: 'device' } } as unknown as Parameters<typeof pushSubscribe>[0]).then(
      () => undefined,
      (e: Error) => e.message,
    )
    assert.ok(sub, 'registration went through although it is corrupt')
    assert.ok(!sub.includes(dir), `⚠️⚠️ the 503 body contains an absolute path: ${sub}`)
  } finally {
    console.error = origErr
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    await rm(dir, { recursive: true, force: true })
  }
})
