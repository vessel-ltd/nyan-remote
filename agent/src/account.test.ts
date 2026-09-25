// ★★ The agent's account and usage ticket (`account.ts`), and handing it over on the relay link (`Licensing` in `relayLink.ts`).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decodeRelayFrame, encodeRelayFrame, RELAY_FRAME } from '../../shared/relayFrame.ts'
import { toBase64Url } from '../../shared/crypto.ts'
import { accountFileOf, accountHealth, accountLicensing, refreshAccountNow, refreshLicense, resetAccount, startAccount, stopAccount, watchAccount } from './account.ts'
import { agentPublicRaw, loadAgentKey, resetAgentKey } from './deviceKey.ts'
import { openRelayLink } from './relayLink.ts'
import { buildRouter } from './routes/index.ts'

const CRED = 'c'.repeat(43)

async function inDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-account-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  resetAccount()
  resetAgentKey()
  await loadAgentKey()
  try {
    await fn(dir)
  } finally {
    stopAccount()
    resetAccount()
    resetAgentKey()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  }
}

const exp = () => Math.floor(Date.now() / 1000) + 3600
const okFetch = (token = 'TOKEN.SIG', plan = 'free') => async (url: string, init: { headers: Record<string, string> }) => {
  assert.equal(url, 'https://account.nyan-remote.app/api/license')
  assert.equal(init.headers['authorization'], `Bearer ${CRED}`)
  assert.equal(init.headers['x-nyan-agent-key'], toBase64Url(agentPublicRaw()), '⚠️⚠️ did not identify with this machine\'s key (the ticket would not be bound to the key)')
  return new Response(JSON.stringify({ license: token, plan, maxMachines: 1, maxDevices: 2, exp: exp(), login: 'nyan' }))
}

test('★★ not signed in ⇒ no usage ticket (a normal state); /health is signedIn:false', async () => {
  await inDir(async () => {
    await startAccount({ fetch: async () => assert.fail('fetched even though not signed in') })
    assert.equal(accountLicensing.current(), undefined)
    assert.deepEqual(accountHealth(), { signedIn: false })
  })
})

test('★★ signed in ⇒ fetch the ticket, write the copy, show the plan in /health (never the credential or the ticket)', async () => {
  await inDir(async (dir) => {
    await writeFile(join(dir, 'account.json'), JSON.stringify(accountFileOf(CRED, { id: 'acct_12345678', login: 'nyan' })))
    await startAccount({ fetch: okFetch() })
    await refreshLicense(okFetch())
    assert.equal(accountLicensing.current(), 'TOKEN.SIG')
    const h = accountHealth()
    assert.equal(h.signedIn, true)
    assert.equal(h.plan, 'free')
    assert.doesNotMatch(JSON.stringify(h), /TOKEN|ccccc/, '⚠️⚠️ the ticket or the credential leaked into /health')
    const saved = JSON.parse(await readFile(join(dir, 'license.json'), 'utf8')) as { token: string }
    assert.equal(saved.token, 'TOKEN.SIG')
    assert.equal((await stat(join(dir, 'license.json'))).mode & 0o777, 0o600)
  })
})

test('★★ keep going with the valid copy on hand while account is down; drop it on 401 (removed)', async () => {
  await inDir(async (dir) => {
    await writeFile(join(dir, 'account.json'), JSON.stringify(accountFileOf(CRED, { id: 'acct_12345678', login: 'nyan' })))
    // ★ The copy is written with the credential it was fetched with (fetch once with `okFetch` and use that copy)
    await startAccount({ fetch: okFetch('SAVED.SIG', 'plus') })
    await refreshLicense(okFetch('SAVED.SIG', 'plus'))
    resetAccount()
    await startAccount({ fetch: async () => new Response('down', { status: 503 }) })
    await refreshLicense(async () => new Response('down', { status: 503 }))
    assert.equal(accountLicensing.current(), 'SAVED.SIG', '⚠️ dropped the ticket just because account was down')
    assert.match(accountHealth().problem ?? '', /503/)
    await refreshLicense(async () => new Response('', { status: 401 }))
    assert.equal(accountLicensing.current(), undefined, '⚠️⚠️ kept using it after being removed')
    await assert.rejects(stat(join(dir, 'license.json')), '⚠️⚠️ the copy survived removal (it would come back after a restart)')
  })
})

test('★★ a copy fetched with a different credential is not used (codex round 26, medium #13)', async () => {
  await inDir(async (dir) => {
    await writeFile(join(dir, 'account.json'), JSON.stringify(accountFileOf(CRED, { id: 'acct_12345678', login: 'nyan' })))
    await startAccount({ fetch: okFetch('A.SIG', 'plus') })
    await refreshLicense(okFetch('A.SIG', 'plus'))
    resetAccount()
    // Signed in again as B (the copy is still A's) ⇒ A's ticket is not used even after a restart
    await writeFile(join(dir, 'account.json'), JSON.stringify(accountFileOf('d'.repeat(43), { id: 'acct_87654321', login: 'b' })))
    await startAccount({ fetch: async () => new Response('down', { status: 503 }) })
    assert.equal(accountLicensing.current(), undefined, '⚠️⚠️ displayed B while using A\'s ticket')
  })
})

test('★★ credential bound to another machine (409) ⇒ drop both the ticket and the copy', async () => {
  await inDir(async (dir) => {
    await writeFile(join(dir, 'account.json'), JSON.stringify(accountFileOf(CRED, { id: 'acct_12345678', login: 'nyan' })))
    await startAccount({ fetch: okFetch() })
    await refreshLicense(okFetch())
    await refreshLicense(async () => new Response('', { status: 409 }))
    assert.equal(accountLicensing.current(), undefined)
    await assert.rejects(stat(join(dir, 'license.json')))
    assert.match(accountHealth().problem ?? '', /another machine|別のマシン/)
  })
})

test('★★ re-fetch right now (nyan account / no hour-long wait right after purchase / codex round 26, low #14)', async () => {
  await inDir(async (dir) => {
    await writeFile(join(dir, 'account.json'), JSON.stringify(accountFileOf(CRED, { id: 'acct_12345678', login: 'nyan' })))
    await startAccount({ fetch: okFetch('OLD.SIG', 'free') })
    await refreshLicense(okFetch('OLD.SIG', 'free'))
    const h = await refreshAccountNow(okFetch('NEW.SIG', 'plus'))
    assert.equal(h.plan, 'plus')
    assert.equal(accountLicensing.current(), 'NEW.SIG')
    // ★ Registered as a local-only route
    assert.ok(buildRouter().match('POST', '/account/refresh'))
  })
})

test('★★ a broken account.json is not used, not rewritten, and the reason is surfaced', async () => {
  await inDir(async (dir) => {
    await writeFile(join(dir, 'account.json'), '{ broken')
    await startAccount({ fetch: async () => assert.fail('fetched even though the file is broken') })
    assert.equal(accountHealth().signedIn, false)
    assert.ok(accountHealth().problem)
    assert.equal(await readFile(join(dir, 'account.json'), 'utf8'), '{ broken', '⚠️ overwrote the evidence of breakage')
  })
})

test('★★ pick up after nyan login (account.json changed ⇒ re-fetch and tell the relay)', async () => {
  await inDir(async (dir) => {
    await startAccount({ fetch: okFetch() })
    let told = 0
    const off = accountLicensing.subscribe(() => told++)
    await writeFile(join(dir, 'account.json'), JSON.stringify(accountFileOf(CRED, { id: 'acct_12345678', login: 'nyan' })))
    await watchAccount(okFetch('NEW.SIG'))
    assert.equal(accountLicensing.current(), 'NEW.SIG')
    assert.ok(told >= 1, '⚠️ the relay was not told about the new ticket')
    off()
  })
})

// ── handing over on the relay link ────────────────────────────────────────

function frame(type: number, payload?: string): Uint8Array {
  return encodeRelayFrame({ type: type as never, connId: 0, ...(payload ? { payload: new TextEncoder().encode(payload) } : {}) })
}

test('★★ do not send the ticket until the relay says want; then send it, resend on each change, and report replies', async () => {
  const sent: Uint8Array[] = []
  let token: string | undefined = 'T1'
  const subs = new Set<() => void>()
  const reports: string[] = []
  const link = openRelayLink({
    router: buildRouter(),
    socket: { send: (b) => void sent.push(b), close: () => undefined },
    licensing: {
      current: () => token,
      subscribe: (fn) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
      report: (s) => void reports.push(s),
    },
  })
  const licenses = () =>
    sent.flatMap((b) => {
      const d = decodeRelayFrame(b)
      return d.ok && d.value.type === RELAY_FRAME.license ? [new TextDecoder().decode(d.value.payload)] : []
    })
  await link.receive(frame(RELAY_FRAME.ready))
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(licenses(), [], '⚠️⚠️ sent before want (an old relay cuts the whole link)')
  await link.receive(frame(RELAY_FRAME.licenseResult, 'want'))
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(licenses(), ['T1'])
  token = 'T2'
  for (const fn of subs) fn()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(licenses(), ['T1', 'T2'])
  await link.receive(frame(RELAY_FRAME.licenseResult, 'machine-limit'))
  assert.deepEqual(reports, ['machine-limit'])
  // ⚠️ Ignore unknown replies (don't cut the link)
  await link.receive(frame(RELAY_FRAME.licenseResult, 'surprise'))
  assert.deepEqual(reports, ['machine-limit'])
  await link.down()
  assert.equal(subs.size, 0, '⚠️ subscription left behind after the link went down')
})

test('★★ signed in again while waiting for the body ⇒ the old sign-in\'s ticket is not used (codex round 27, medium #9)', async () => {
  await inDir(async (dir) => {
    await writeFile(join(dir, 'account.json'), JSON.stringify(accountFileOf(CRED, { id: 'acct_12345678', login: 'nyan' })))
    await startAccount({ fetch: async () => new Response('down', { status: 503 }) })
    let release!: () => void
    const gate = new Promise<void>((ok) => (release = ok))
    const slowBody = async () =>
      new Response(
        new ReadableStream({
          async start(c) {
            await gate
            c.enqueue(new TextEncoder().encode(JSON.stringify({ license: 'OLD.SIG', plan: 'plus', maxMachines: 5, maxDevices: 5, exp: exp(), login: 'nyan' })))
            c.close()
          },
        }),
      )
    const pending = refreshLicense(slowBody)
    await new Promise((r) => setTimeout(r, 10))
    // Signed in again as B
    await writeFile(join(dir, 'account.json'), JSON.stringify(accountFileOf('d'.repeat(43), { id: 'acct_87654321', login: 'b' })))
    await watchAccount(async () => new Response('down', { status: 503 }))
    release()
    await pending
    assert.equal(accountLicensing.current(), undefined, '⚠️⚠️ used A\'s ticket after signing in again as B')
  })
})
