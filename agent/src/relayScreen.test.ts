// ★★ The relay's screen for agy (2026-11-21 / docs/AGY.md §14).
//
// The relay rebuilds what an agy shows from its output (`Screen` in scripts/relay.py) and answers a connection that
// starts with 0x02 with that text. The agent reads it before typing an answer into a question.
// ⚠️ Checked against real agy output by hand (tmux recordings, every checkpoint equal); these tests pin the sequences
//    agy was seen to use, and the socket behaviour (agy only; never typed; an older relay would type the byte, so the
//    registration says when it is understood).

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const RELAY = new URL('../../scripts/relay.py', import.meta.url).pathname
const hasScript = spawnSync('script', ['--version']).status === 0
const hasPython = spawnSync('python3', ['-c', 'pass']).status === 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Feeds bytes (as Python bytes literals) to a `Screen` one byte at a time, then prints its text */
function screen(rows: number, cols: number, chunks: string[]): string {
  const code = [
    'import importlib.util, sys',
    `spec = importlib.util.spec_from_file_location("relay", ${JSON.stringify(RELAY)})`,
    'r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)',
    `s = r.Screen(${rows}, ${cols})`,
    ...chunks.map((c) => `d = ${c}\nfor i in range(len(d)): s.feed(d[i:i+1])`),
    'sys.stdout.write(s.text())',
  ].join('\n')
  return execFileSync('python3', ['-c', code], { encoding: 'utf8' })
}

test('★ screen: inline redraws (cursor up, erase, rewrite) as agy draws a question', { skip: !hasPython }, () => {
  const out = screen(6, 30, [
    String.raw`b"> ask me\r\n\r\nQuestion 1/2: Which?\x1b[K\r\n> 1. apple\r\n  2. banana"`,
    // the answer moved on: cursor up 2, erase, the next question drawn in place
    String.raw`b"\r\x1b[2A\x1b[JQuestion 2/2: Colors?\r\n> 1. [x] red"`,
  ])
  assert.deepEqual(out.split('\n'), ['> ask me', '', 'Question 2/2: Colors?', '> 1. [x] red', '', ''])
})

test('★ screen: wide characters take two columns; repeat, erase and delete characters; cut UTF-8 and sequences', { skip: !hasPython }, () => {
  const out = screen(2, 12, [String.raw`b"\xe6\x97\xa5\xe6\x9c\xac-\x1b[3b|\x1b[2D\x1b[1X\x1b[1P"`, String.raw`b"\r\n\x1b[94mab\x1b[mc"`])
  // 日本 is four columns, "-" repeated 3 more times, then 2 left, one erased, one deleted
  assert.deepEqual(out.split('\n'), ['日本---|', 'abc'])
})

test('★ screen: a subagent view on the alternate screen (absolute moves, a scroll region) leaves the main one as it was', { skip: !hasPython }, () => {
  const out = screen(4, 20, [
    String.raw`b"main 1\r\nmain 2"`,
    String.raw`b"\x1b[?1049h\x1b[H\x1b[2Jchild view\x1b[4;1Hesc back\x1b[2;3r\x1b[2;1Ha\r\nb\r\nc\x1b[;r"`,
  ])
  assert.deepEqual(out.split('\n'), ['child view', 'b', 'c', 'esc back'])
  const back = screen(4, 20, [String.raw`b"main 1\r\nmain 2"`, String.raw`b"\x1b[?1049hchild\x1b[?1049l"`])
  assert.deepEqual(back.split('\n'), ['main 1', 'main 2', '', ''])
})

test('★ screen: a combining accent stays on its letter (also at the right edge and after a wide character)', { skip: !hasPython }, () => {
  const out = screen(2, 5, [String.raw`b"Cafe\xcc\x81!\r\n\xe6\x97\xa5\xcc\x81\xe2\x80\x8bab"`])
  assert.deepEqual(out.split('\n'), ['Cafe\u0301!', '日\u0301\u200bab'])
  const edge = screen(2, 4, [String.raw`b"abcd\xcc\x81"`])
  assert.equal(edge.split('\n')[0], 'abcd\u0301')
})

test('★ screen: an OSC cut between its ESC and "\\", colors with ":" sub-parameters, a huge insert count', { skip: !hasPython }, () => {
  const out = screen(2, 10, [String.raw`b"a\x1b]0;title\x1b"`, String.raw`b"\\b\x1b[38:2:1:2:3mc\x1b[99999999@"`])
  assert.equal(out.split('\n')[0], 'abc')
})

test('★ screen: a color change at the right edge keeps the wrap pending', { skip: !hasPython }, () => {
  const out = screen(2, 10, [String.raw`b"\x1b[32m0123456789\x1b[0mabc"`])
  assert.deepEqual(out.split('\n'), ['0123456789', 'abc'])
})

test('★ screen: autowrap off keeps a long line on its row; a resize keeps the bottom rows', { skip: !hasPython }, () => {
  const out = screen(2, 5, [String.raw`b"\x1b[?7labcdefg\x1b[?7h"`])
  assert.equal(out.split('\n')[0], 'abcdg')
})

/** Runs the relay in a pty around a fake child (`name` decides whether the relay keeps a screen) */
async function relayWith(t: { after(fn: () => void): void }, name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-relay-screen-'))
  mkdirSync(join(dir, 'bin'))
  const child = join(dir, 'bin', name)
  const keys = join(dir, 'keys.log')
  // draws a question, then records every byte it is given
  writeFileSync(child, `#!/bin/sh\nprintf 'Question 1/1: Which?\\r\\n> 1. apple\\r\\n'\nstty raw -echo 2>/dev/null\nexec cat > ${JSON.stringify(keys)}\n`)
  chmodSync(child, 0o755)
  const proc = spawn('script', ['-qec', `python3 ${RELAY} -- ${child}`, '/dev/null'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, NYAN_REMOTE_STATE_DIR: dir, RELAY_LOG: join(dir, 'relay.log') },
  })
  proc.stdout.resume()
  t.after(() => {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true })
  })
  let reg: { socket: string; screen?: boolean; pid: number } | undefined
  for (let i = 0; i < 80 && !reg; i++) {
    await sleep(100)
    const panes = join(dir, 'panes')
    const f = existsSync(panes) ? readdirSync(panes).find((n) => n.endsWith('.json')) : undefined
    if (f) reg = JSON.parse(readFileSync(join(panes, f), 'utf8')) as { socket: string; screen?: boolean; pid: number }
  }
  assert.ok(reg, 'the relay registered')
  await sleep(300)
  return { reg: reg!, keys }
}

function ask(sock: string, bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect(sock)
    let got = ''
    c.on('connect', () => c.write(bytes))
    c.on('data', (d) => (got += d.toString('utf8')))
    c.on('end', () => resolve(got))
    c.on('close', () => resolve(got))
    c.on('error', reject)
    setTimeout(() => {
      c.destroy()
      resolve(got)
    }, 2000).unref()
  })
}

test('★★ an agy relay answers 0x02 with the screen and types nothing; its registration says so', { skip: !hasScript || !hasPython }, async (t) => {
  const { reg, keys } = await relayWith(t, 'agy')
  assert.equal(reg.screen, true)
  const text = await ask(reg.socket, Buffer.from([0x02]))
  assert.match(text, /Question 1\/1: Which\?/)
  assert.match(text, /> 1\. apple/)
  await sleep(200)
  assert.doesNotMatch(existsSync(keys) ? readFileSync(keys, 'latin1') : '', /\x02/, 'the request was typed')
})

test('★★ a relay around anything else keeps no screen and does not say so (the agent never asks it)', { skip: !hasScript || !hasPython }, async (t) => {
  const { reg } = await relayWith(t, 'claude')
  assert.equal(reg.screen, undefined)
})

test('★★ screen: never breaks the relay — a wide character on a one-column screen, a restore outside it, anything raising', { skip: !hasPython }, () => {
  const code = [
    'import importlib.util, sys',
    `spec = importlib.util.spec_from_file_location("relay", ${JSON.stringify(RELAY)})`,
    'r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)',
    's = r.Screen(5, 40)',
    's.safe_feed(b"\\x1b7")',
    's.safe_resize(2, 1)',
    's.safe_feed("日本\\x1b8x".encode())',
    'print("alive", s.broken)',
    't = r.Screen(2, 10)',
    't.feed = lambda d: 1 / 0',
    't.safe_feed(b"x")',
    'print("broken", t.broken, repr(t.text()))',
  ].join('\n')
  const out = execFileSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env, RELAY_LOG: '/dev/null' } }).trim().split('\n')
  assert.deepEqual(out, ['alive False', "broken True ''"])
})

test('★★ right after a resize the screen is not answered (agy redraws for it: a snapshot then could mix two views)', { skip: !hasScript || !hasPython }, async (t) => {
  const { reg } = await relayWith(t, 'agy')
  // the relay is the child's parent
  const relayPid = Number(readFileSync(`/proc/${reg.pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[1])
  process.kill(relayPid, 'SIGWINCH')
  await sleep(100)
  assert.equal(await ask(reg.socket, Buffer.from([0x02])), '', 'not readable just after the resize')
  await sleep(1100)
  assert.match(await ask(reg.socket, Buffer.from([0x02])), /Question 1\/1: Which\?/)
})
