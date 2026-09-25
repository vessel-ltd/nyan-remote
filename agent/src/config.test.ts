// ★★ Config fail-open (2026-08-13 external review finding).
//
// Mistaking a broken config.json for a "first run" means:
//   1. allowedLogins becomes [] and **the next login to arrive is recorded and locked in** (pairing reopens)
//   2. hookToken is recreated too, diverging from the Bearer of the installed approval hooks
//   3. and the broken file is **overwritten** with defaults (= no recovery possible)
// This project has actually suffered config corruption twice (.claude.json 167KB → 309B).

import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { config, configProblem, loadConfig, problemMessage, rememberLogin, validateConfig } from './config.ts'
import { appendJsonl, readJsonFile, writeJson } from './state.ts'

/** Use a temp directory as the state dir and load. The point is to go through the real fs error classification */
async function withStateDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-config-'))
  const before = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  try {
    return await fn(dir)
  } finally {
    if (before === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = before
    await rm(dir, { recursive: true, force: true })
  }
}

test('★ the state directory is created with 0700 (it holds hookToken and the VAPID private key / R)', async () => {
  // ⚠️ `mkdir(dirname(path), { recursive: true })` had no mode, so it depended
  //    on the umask (measured 0755). Files are 0600 so contents are unreadable, but
  //    **names and sizes are visible to others**. ⚠️ Existing directories keep their permissions,
  //    so the install script (install-relay.mjs) also tightens them.
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-mode-'))
  const before = process.env.NYAN_REMOTE_STATE_DIR
  // ⚠️⚠️ **Pin the umask to the loose side** (codex finding). If the test environment's umask is 077,
  //    it becomes 0700 even without `mode`, and **a mutation removing the mode survives** (false green)
  const prevUmask = process.umask(0o022)
  try {
    // ★ Check each path (fixing just one leaves the others loose)
    for (const [name, write] of [
      ['writeJson', (n: string) => writeJson(n, { a: 1 })],
      ['appendJsonl', (n: string) => appendJsonl(n, { a: 1 })],
    ] as const) {
      const dir = join(base, name)
      process.env.NYAN_REMOTE_STATE_DIR = dir
      await write('x.json')
      assert.equal((await stat(dir)).mode & 0o777, 0o700, `${name}: state directory is too permissive`)
      assert.equal((await stat(join(dir, 'x.json'))).mode & 0o777, 0o600, `${name}: file is too permissive`)
    }
  } finally {
    process.umask(prevUmask)
    if (before === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = before
    await rm(base, { recursive: true, force: true })
  }
})

test('readJsonFile: distinguishes missing / ok / broken', async () => {
  await withStateDir(async (dir) => {
    assert.equal((await readJsonFile('none.json')).kind, 'missing')

    await writeFile(join(dir, 'ok.json'), '{"a":1}')
    const ok = await readJsonFile<{ a: number }>('ok.json')
    assert.equal(ok.kind, 'ok')
    assert.equal(ok.kind === 'ok' ? ok.value.a : undefined, 1)

    await writeFile(join(dir, 'bad.json'), '{ 途中で切れて')
    assert.equal((await readJsonFile('bad.json')).kind, 'broken')

    // ★ An empty file (power lost mid-write) is broken too. It must not fall through to defaults
    await writeFile(join(dir, 'empty.json'), '')
    assert.equal((await readJsonFile('empty.json')).kind, 'broken')

    // ★ Valid JSON that is not an object is broken
    //   (prevents silently becoming defaults via {...DEFAULTS, ...[]})
    for (const [name, text] of [
      ['array.json', '[]'],
      ['null.json', 'null'],
      ['num.json', '42'],
    ] as const) {
      await writeFile(join(dir, name), text)
      assert.equal((await readJsonFile(name)).kind, 'broken', name)
    }
  })
})

test('loadConfig: a missing file is a first run; creates and writes hookToken', async () => {
  await withStateDir(async (dir) => {
    const cfg = await loadConfig()
    assert.equal(configProblem(), null, 'missing is not an error')
    assert.ok(cfg.hookToken.length > 20)
    // It has been written (hook-token too)
    const written = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as {
      hookToken: string
    }
    assert.equal(written.hookToken, cfg.hookToken)
    assert.equal((await readFile(join(dir, 'hook-token'), 'utf8')).trim(), cfg.hookToken)
  })
})

test('★★ loadConfig: if broken, starts in "refuse mode" instead of treating it as a first run', async () => {
  await withStateDir(async (dir) => {
    const path = join(dir, 'config.json')
    const broken = '{"allowedLogins":["real@github"], ここで壊れている'
    await writeFile(path, broken)

    const cfg = await loadConfig()
    const p = configProblem()
    assert.ok(p, 'it must be observable that the file is broken')
    assert.equal(p?.path, path)
    assert.match(problemMessage(p!), /拒否/)

    // ⚠️ **Do not rewrite** the broken file (keep the evidence and a way to recover)
    assert.equal(await readFile(path, 'utf8'), broken)
    // ⚠️ Do not create hook-token either (do not break the Bearer of installed hooks)
    await assert.rejects(() => readFile(join(dir, 'hook-token'), 'utf8'))
    // ⚠️ Do not fall into TOFU
    assert.deepEqual(cfg.allowedLogins, [])
    assert.equal(cfg.hookToken, '', 'must not recreate the token')
  })
})

test('★ in refuse mode rememberLogin does not record a login (second barrier)', async () => {
  await withStateDir(async (dir) => {
    const path = join(dir, 'config.json')
    await writeFile(path, 'これは JSON ではない')
    await loadConfig()
    assert.ok(configProblem())

    await rememberLogin('attacker@github')
    assert.deepEqual(config().allowedLogins, [])
    assert.equal(await readFile(path, 'utf8'), 'これは JSON ではない', 'must not overwrite')
  })
})

test('loadConfig: problem clears once it reads correctly (no carry-over from the previous state)', async () => {
  await withStateDir(async (dir) => {
    await writeFile(join(dir, 'config.json'), '壊れている')
    await loadConfig()
    assert.ok(configProblem())
    // Fix it and reload
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ allowedLogins: ['me@github'], hookToken: 'tok'.repeat(10) }),
    )
    const cfg = await loadConfig()
    assert.equal(configProblem(), null)
    assert.deepEqual(cfg.allowedLogins, ['me@github'])
  })
})

// ── Configs with correct syntax but missing contents (2026-08-14 external review, high) ──────────────

test('★★ validateConfig: refuses a file without allowedLogins (TOFU would reopen)', () => {
  // ⚠️ `{"hookToken":"…"}` is valid JSON, but if it falls back to the default `[]`
  //    **it claims "first run" again and locks in the next login to arrive**
  assert.match(validateConfig({ hookToken: 'x' } as never) ?? '', /allowedLogins/)
  assert.match(validateConfig({ allowedLogins: ['me'] } as never) ?? '', /hookToken/)
  assert.equal(validateConfig({ allowedLogins: ['me'], hookToken: 'x' } as never), null)
})

test('★ validateConfig: also refuses wrong types', () => {
  const base = { allowedLogins: ['me'], hookToken: 'x' }
  assert.ok(validateConfig({ ...base, allowedLogins: 'me' } as never), 'not an array')
  assert.ok(validateConfig({ ...base, allowedLogins: [1] } as never), 'non-string element')
  assert.ok(validateConfig({ ...base, hookToken: '' } as never), 'empty token')
  assert.ok(validateConfig({ ...base, allowedOrigins: 'https://x' } as never))
  assert.ok(validateConfig({ ...base, configDirs: 'x' } as never))
  assert.ok(validateConfig({ ...base, maxSessionsPerAccount: 0 } as never))
  assert.ok(validateConfig({ ...base, port: 1.5 } as never))
  // Optional keys may be absent (falling back to defaults is harmless for them)
  assert.equal(validateConfig({ ...base, configDirs: null } as never), null)
  assert.equal(validateConfig(base as never), null)
})

test('★★ loadConfig: a file with missing contents also enters refuse mode and is not overwritten', async () => {
  await withStateDir(async (dir) => {
    const path = join(dir, 'config.json')
    const partial = JSON.stringify({ hookToken: 'もとからあるトークン' })
    await writeFile(path, partial)
    const cfg = await loadConfig()
    assert.ok(configProblem(), 'must not claim a "first run"')
    assert.deepEqual(cfg.allowedLogins, [])
    assert.equal(await readFile(path, 'utf8'), partial, 'must not rewrite')
    await assert.rejects(() => readFile(join(dir, 'hook-token'), 'utf8'), 'must not create')
  })
})

test('★★ the refuse-mode response contains neither the path nor file contents (checked on the text the implementation builds)', async () => {
  // ⚠️ The earlier test **built the reason by hand** as `problemMessage({reason:'<test>', …})`,
  //    so the `reason` assembled by the implementation was never exercised and **the leak slipped through** (false green).
  //    Here we always look at the real thing produced via `loadConfig()`.
  await withStateDir(async (dir) => {
    const path = join(dir, 'config.json')

    // (1) Broken as JSON (V8's error contains **the first 10 characters of the file**)
    await writeFile(path, 'hookToken=ひみつの値です')
    await loadConfig()
    let msg = problemMessage(configProblem()!)
    assert.equal(msg.includes('hookToken='), false, `contents leaked: ${msg}`)
    assert.equal(msg.includes('/home/'), false, `absolute path leaked: ${msg}`)
    assert.equal(msg.includes(dir), false, `state directory leaked: ${msg}`)

    // (2) Unreadable (the EACCES message contains an absolute path)
    await chmod(path, 0o000)
    await loadConfig()
    msg = problemMessage(configProblem()!)
    // ⚠️ Running as root can read it anyway, so check only when refuse mode was entered
    if (configProblem()) {
      assert.equal(msg.includes('/home/'), false, `absolute path leaked: ${msg}`)
      assert.equal(msg.includes(dir), false, `state directory leaked: ${msg}`)
    }
    await chmod(path, 0o600)

    // (3) Contents missing
    await writeFile(path, JSON.stringify({ hookToken: 'x' }))
    await loadConfig()
    msg = problemMessage(configProblem()!)
    assert.equal(msg.includes('/home/'), false, `absolute path leaked: ${msg}`)
    assert.match(msg, /config\.json/, 'says which file it is')
  })
})

test('★ the fix instructions depend on how it is broken (if readable, do not say "move it aside")', async () => {
  await withStateDir(async (dir) => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hookToken: 'x' }))
    await loadConfig()
    assert.equal(configProblem()?.kind, 'invalid', 'readable but incomplete')
    await writeFile(join(dir, 'config.json'), '壊れている')
    await loadConfig()
    assert.equal(configProblem()?.kind, 'unreadable')
  })
})
