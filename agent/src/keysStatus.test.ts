// The tool that shows "which sessions can take keystrokes" (`scripts/keys-status.mjs`).
//
// ★★ Two things to protect:
//   1. **Say 0 when there are 0** (2026-08-23: a hand-written one-liner with an unexpanded glob
//      showed **every session as "keys OK"** = fail-open on the diagnostic side)
//   2. ★★ **Don't own the decision** (in the same day's review, the independent `classifyPane`
//      **disagreed with the real `findPane` in 6 cases**; on mac it printed "✅ N" and
//      not one keystroke got through) => rebuilt to call `findPane` directly

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// @ts-expect-error — plain .mjs (no types)
import { inspect, summarize } from '../../scripts/keys-status.mjs'
import { aliveProcStartSync } from './claude/sessionIndex.ts'
import type { ConfigDir } from './claude/configDirs.ts'

const RELAY = join(fileURLToPath(new URL('../../scripts/', import.meta.url)), 'relay.py')

const row = (over: Record<string, unknown> = {}) => ({
  pid: 1234,
  sessionId: 'abcd1234-0000-0000-0000-000000000000',
  account: '[.claude-r]',
  name: 'テスト',
  cwd: '/w',
  ok: true,
  ...over,
})

test('★★ summarize: says "0" for zero (the diagnostic does not fail open)', () => {
  const out = (summarize([]) as string[]).join('\n')
  assert.match(out, /0 件/)
  assert.ok(!out.includes('✅'), '⚠️⚠️ must not show ✅ with zero (exactly the original incident)')
  assert.match(out, /新しい窓/, 'also shows how to fix it (so it gets noticed)')
})

test('★★ summarize: sessions that cannot take keys alone do not yield ✅', () => {
  // ⚠️ "live sessions exist but none can take keys" must be reported as **0**
  const out = (summarize([row({ ok: false, reason: 'no-relay' })]) as string[]).join('\n')
  assert.match(out, /0 件/)
  assert.match(out, /1 件ありますが、どれも打鍵できません/)
  assert.match(out, /no-relay/, 'shows the reason (used for triage)')
})

test('summarize: usable sessions show count and identity', () => {
  const out = (summarize([row(), row({ pid: 2 })]) as string[]).join('\n')
  assert.match(out, /✅ 打鍵できるセッション 2 件/)
  assert.match(out, /abcd1234/)
  assert.match(out, /\[\.claude-r\]/)
})

test('★ summarize: mixed usable and unusable sessions are counted separately', () => {
  const out = (summarize([row(), row({ pid: 2, ok: false, reason: 'waiting' })]) as string[]).join('\n')
  assert.match(out, /✅ 打鍵できるセッション 1 件（ほか 1 件は不可）/)
  assert.match(out, /ダイアログ/, 'explains what waiting means')
})

test('★★ inspect: asks findPane for the decision (does not own it)', { skip: process.platform !== 'linux' }, async (t) => {
  // ⚠️⚠️ An independent implementation always drifts (it actually disagreed in 6 cases).
  //    => Here we check with real objects that it **never says "can type" when the real one says it can't**.
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-ks-'))
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-ks-state-'))
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  const pid = process.pid
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  await mkdir(join(base, 'sessions'), { recursive: true })
  await writeFile(
    join(base, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: '/tmp', status: 'idle', procStart: aliveProcStartSync(pid) }),
  )
  const dirs: ConfigDir[] = [{ account: '.claude-test', dir: base, projectsDir: join(base, 'projects') }]
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  try {
    // (1) No announcement -> cannot type (not via relay)
    const a = await inspect(dirs, { sessionId, pid })
    assert.equal(a.ok, false, 'said it can type without an announcement')
    assert.equal(a.reason, 'no-relay')

    // (2) Have **relay.py itself write** the announcement -> can type
    execFileSync(
      'python3',
      [
        '-c',
        `import importlib.util as u; spec=u.spec_from_file_location('r', ${JSON.stringify(RELAY)}); m=u.module_from_spec(spec); spec.loader.exec_module(m); m.register(${pid}, ${JSON.stringify(join(state, 's.sock'))})`,
      ],
      { env: { ...process.env, NYAN_REMOTE_STATE_DIR: state, PYTHONDONTWRITEBYTECODE: '1' } },
    )
    const b = await inspect(dirs, { sessionId, pid })
    assert.equal(b.ok, true, `said it cannot type despite an announcement: ${JSON.stringify(b)}`)

    // (3) ★ Remove the announced socket -> **the real one says broken**; the diagnostic must also say it can't type
    const paneFile = join(state, 'panes', `${pid}.json`)
    const rec = JSON.parse(readFileSync(paneFile, 'utf8'))
    delete rec.socket
    await writeFile(paneFile, JSON.stringify(rec))
    const c = await inspect(dirs, { sessionId, pid })
    assert.equal(c.ok, false, '⚠️ said an announcement without a socket can type (the old classifyPane did this)')
    assert.equal(c.reason, 'broken')
  } finally {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
  }
})
