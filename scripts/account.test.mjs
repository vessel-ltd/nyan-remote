// ★★★ Exercise `nyan login` / `logout` (scripts/account.mjs) against a fake GitHub and account (2026-09-24).
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setLang } from '../shared/i18n.ts'
import { githubDeviceToken, login, logout } from './account.mjs'

setLang('en')
const quiet = async (fn) => {
  const [log, err] = [console.log, console.error]
  console.log = console.error = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
    console.error = err
  }
}

function fakeFetch(script) {
  const calls = []
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body, headers: init.headers })
    const h = script(String(url), init)
    return h instanceof Response ? h : new Response(JSON.stringify(h))
  }
  return { f, calls }
}

test('★★★ Device Flow: waits while pending, widens the interval on slow_down, receives the token', async () => {
  const answers = [{ error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'gho_x' }]
  const waits = []
  const { f } = fakeFetch((url) =>
    url.includes('/device/code')
      ? { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 }
      : answers.shift(),
  )
  const shown = []
  const opened = []
  const tok = await githubDeviceToken(f, async (ms) => void waits.push(ms), (s) => shown.push(s), (u) => opened.push(u))
  assert.deepEqual(opened, ['https://github.com/login/device'], '★ opens the page to enter the code')
  assert.equal(tok, 'gho_x')
  assert.deepEqual(waits, [5000, 5000, 10000], '⚠️ did not widen the interval on slow_down (GitHub will refuse)')
  assert.ok(shown.join('\n').includes('ABCD-1234'))
})

test('★★ Device Flow: stops on cancellation or an unknown error (returns no token)', async () => {
  for (const e of ['access_denied', 'incorrect_client_credentials']) {
    const { f } = fakeFetch((url) => (url.includes('/device/code') ? { device_code: 'dc', user_code: 'X', interval: 5 } : { error: e }))
    assert.equal(await quiet(() => githubDeviceToken(f, async () => {}, () => {}, () => {})), undefined)
  }
})

test('★★ login: writes the credential with 0600, never stores the GitHub token, logout removes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-login-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  writeFileSync(join(dir, 'hook-token'), 'hooktok\n')
  try {
    const { f, calls } = fakeFetch((url) => {
      if (url.includes('/device/code')) return { device_code: 'dc', user_code: 'X', interval: 5 }
      if (url.includes('/access_token')) return { access_token: 'gho_secret_token' }
      if (url.includes('/health')) return { agentPublicKey: 'K'.repeat(87) }
      // (★ identifies to /health with the hook token = checked below)
      if (url.endsWith('/api/login')) return { credential: 'c'.repeat(43), account: { id: 'acct_12345678', login: 'nyan', plan: 'free' } }
      if (url.endsWith('/api/logout')) return { ok: true }
      return new Response('?', { status: 404 })
    })
    const opened = []
    assert.equal(await quiet(() => login(f, async () => {}, (u) => opened.push(u))), 0)
    assert.equal(opened.at(-1), 'https://account.nyan-remote.app', '★ opens the account page after login')
    const path = join(dir, 'account.json')
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(saved.credential, 'c'.repeat(43))
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.doesNotMatch(readFileSync(path, 'utf8'), /gho_secret_token/, '⚠️⚠️ stored the GitHub token')
    const health = calls.find((c) => c.url.includes('/health'))
    assert.equal(health.headers['x-nyan-remote-token'], 'hooktok', '⚠️⚠️ did not identify to /health (the agent refuses and the key cannot be fetched)')
    const sent = JSON.parse(calls.find((c) => c.url.endsWith('/api/login')).body)
    assert.equal(sent.agentKey, 'K'.repeat(87), '⚠️ did not pass the key for the relay ledger')
    writeFileSync(join(dir, 'license.json'), '{}')
    // ⚠️⚠️ If account could not unlink it, keep the local login (do not lie "unlinked" / codex round 26, medium #12)
    const down = async () => new Response('err', { status: 500 })
    assert.equal(await quiet(() => logout(down)), 1)
    assert.equal(existsSync(path), true, '⚠️⚠️ removed the local login even though unlinking failed')
    assert.equal(await quiet(() => logout(async () => { throw new Error('offline') })), 1)
    assert.equal(existsSync(path), true)
    assert.equal(await quiet(() => logout(f)), 0)
    assert.equal(existsSync(path), false)
    assert.equal(existsSync(join(dir, 'license.json')), false)
    // ★ --force removes only the local copy (says so and returns 1)
    writeFileSync(path, JSON.stringify(saved))
    assert.equal(await quiet(() => logout(down, { force: true })), 1)
    assert.equal(existsSync(path), false)
  } finally {
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ how the browser is opened: WSL uses explorer.exe, mac uses open, Linux without a display does not open, https only', async () => {
  const { urlOpeners } = await import('./lib/openUrl.mjs')
  const u = 'https://account.nyan-remote.app'
  assert.deepEqual(urlOpeners({ platform: 'darwin', env: {}, url: u }), [['open', [u]]])
  assert.deepEqual(urlOpeners({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, url: u })[0]?.[0], '/mnt/c/Windows/explorer.exe')
  assert.deepEqual(urlOpeners({ platform: 'linux', env: {}, url: u }), [])
  assert.deepEqual(urlOpeners({ platform: 'darwin', env: {}, url: 'javascript:alert(1)' }), [], '⚠️ does not open anything but https')
})

test('★★ if a new login is written during logout, it is not removed (codex round 31, medium #2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-logout-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  try {
    const path = join(dir, 'account.json')
    writeFileSync(path, JSON.stringify({ v: 1, origin: 'https://account.nyan-remote.app', credential: 'a'.repeat(43), account: { id: 'acct_12345678', login: 'nyan' } }))
    const f = async () => {
      writeFileSync(path, JSON.stringify({ v: 1, origin: 'https://account.nyan-remote.app', credential: 'b'.repeat(43), account: { id: 'acct_12345678', login: 'nyan' } }))
      return new Response('{"ok":true}')
    }
    await quiet(() => logout(f))
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).credential, 'b'.repeat(43), '⚠️⚠️ removed the new login')
  } finally {
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ while logout checks and removes, login cannot write (lock / codex round 32)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-lock-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  try {
    writeFileSync(join(dir, 'account.json'), JSON.stringify({ v: 1, origin: 'https://account.nyan-remote.app', credential: 'a'.repeat(43), account: { id: 'acct_12345678', login: 'nyan' } }))
    // Another process holds the lock ⇒ logout waits (does not remove until the lock is gone)
    writeFileSync(join(dir, 'account.lock'), '')
    let done = false
    const p = quiet(() => logout(async () => new Response('{"ok":true}'))).then(() => (done = true))
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(done, false, '⚠️⚠️ ignored the lock and removed it')
    assert.equal(existsSync(join(dir, 'account.json')), true)
    rmSync(join(dir, 'account.lock'))
    await p
    assert.equal(existsSync(join(dir, 'account.json')), false)
    assert.equal(existsSync(join(dir, 'account.lock')), false, '⚠️ left the lock behind')
  } finally {
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})
