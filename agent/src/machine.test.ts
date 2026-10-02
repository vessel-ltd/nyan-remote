// ★ The machine's display name (`machine.ts` / 2026-10-02).
//   Mutations aimed at: control characters or `/` let through, the config ignored, a second place reading the hostname.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { loadConfig } from './config.ts'
import { MACHINE_NAME_MAX, checkMachineName, machineName, machineNameProblem, resolveMachineName } from './machine.ts'
import { autoApproveOffPayload } from './routes/autoApprove.ts'

test('★ a usable name is trimmed; empty, too long, control/format characters, line breaks and / are refused', () => {
  assert.equal(checkMachineName('  laptop '), 'laptop')
  assert.equal(checkMachineName('仕事の PC'), '仕事の PC')
  assert.equal(checkMachineName('x'.repeat(MACHINE_NAME_MAX)), 'x'.repeat(MACHINE_NAME_MAX))
  for (const bad of ['', '   ', 'x'.repeat(MACHINE_NAME_MAX + 1), 'a\nb', 'a\u2028b', 'a\u001bb', 'a\u200eb', 'pc/a', 'perm-laptop', 3, null, {}]) {
    assert.equal(checkMachineName(bad), null, `accepted ${JSON.stringify(bad)}`)
  }
})

test('★ absent or unusable ⇒ the hostname (never refuses); usable ⇒ that name', () => {
  assert.equal(resolveMachineName(undefined, 'host-1'), 'host-1')
  assert.equal(resolveMachineName('pc/a', 'host-1'), 'host-1')
  assert.equal(resolveMachineName('laptop', 'host-1'), 'laptop')
  assert.equal(machineNameProblem(undefined), null)
  assert.equal(machineNameProblem('laptop'), null)
  assert.ok(machineNameProblem('a\nb'))
})

test('★★ the configured name reaches what the agent sends (notification payloads take it by default)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-machine-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  })
  await writeFile(join(dir, 'config.json'), JSON.stringify({ allowedLogins: [], hookToken: 'tok', machineName: 'laptop' }))
  await loadConfig()
  assert.equal(machineName(), 'laptop')
  const p = autoApproveOffPayload({ scope: 'session', id: 'sess-1', until: '2026-01-01T00:00:00.000Z', at: '2026-01-01T00:00:00.000Z' })
  assert.equal(p.tag, 'auto-approve:laptop:sess-1')
  assert.ok(!p.tag?.includes(hostname()) || hostname() === 'laptop')
})

test('★★ only machine.ts (and the inbox sender, on purpose) read the hostname', async () => {
  const root = fileURLToPath(new URL('.', import.meta.url))
  const files: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p)
    }
  }
  await walk(root)
  const allowed = new Set([join(root, 'machine.ts'), join(root, 'claude', 'inbox.ts')])
  const offenders: string[] = []
  for (const f of files) {
    if (allowed.has(f)) continue
    const code = (await readFile(f, 'utf8')).split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    if (code.some((l) => /\bhostname\(\)/.test(l) && !/machineName\(\)/.test(l))) offenders.push(f.slice(root.length))
  }
  assert.deepEqual(offenders, [], 'a second source of the machine name (the phone would see two names for one machine)')
})
