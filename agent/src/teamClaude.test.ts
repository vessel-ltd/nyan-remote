// ★ Claude members reached and heard through nyan (2026-11-27 / user decision: every member, Claude ↔ Claude too).
//   `nyan team send` writes to a Claude member's inbox; its turn end and its stop on an error go to the leader.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server as HttpServer } from 'node:http'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import { aliveProcStartFreshSync } from './claude/sessionIndex.ts'
import { config, configProblem, loadConfig } from './config.ts'
import { createTeam, resetTeamsForTest, type Team } from './team.ts'
import { claudeMemberReport, codexMemberLimited, TEAM_SENDER } from './teamHooks.ts'
import { startTeamSocket, teamSocketPath } from './teamSocket.ts'
import { hasTurnEndHook } from './routes/team.ts'

const root = mkdtempSync(join(tmpdir(), 'nr-tc-'))
const ME = process.pid
const START = String(aliveProcStartFreshSync(ME))
const LEADER_DIR = join(root, '.claude-r')
const MEMBER_DIR = join(root, '.claude-s')
const INBOX = join(root, 'm.sock')
const prevState = process.env['NYAN_REMOTE_STATE_DIR']
let inbox: { server: Server; lines: string[] }
let team: { server: HttpServer; sock: string }

function fakeInbox(path: string): Promise<{ server: Server; lines: string[] }> {
  const lines: string[] = []
  const server = createServer((sock) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) lines.push(line)
      }
    })
  })
  return new Promise((resolve) => server.listen(path, () => resolve({ server, lines })))
}

function call(sock: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = request({ socketPath: sock, method, path, headers: data ? { 'content-type': 'application/json' } : {} }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && !cond()) await new Promise((r) => setTimeout(r, 20))
  return cond()
}

before(async () => {
  for (const d of [LEADER_DIR, MEMBER_DIR]) {
    mkdirSync(join(d, 'sessions'), { recursive: true })
    mkdirSync(join(d, 'projects'), { recursive: true })
  }
  writeFileSync(join(LEADER_DIR, 'sessions', `${ME}.json`), JSON.stringify({ pid: ME, sessionId: 'lead-x' }))
  writeFileSync(join(MEMBER_DIR, 'sessions', `${ME}.json`), JSON.stringify({ pid: ME, sessionId: 'mem-1', procStart: START, messagingSocketPath: INBOX }))
  const state = join(root, 'state')
  mkdirSync(state, { recursive: true })
  chmodSync(state, 0o700)
  // ⚠️⚠️ `hookToken` is required: without it the config is "corrupt" and `discoverConfigDirs` looks at the real ~/.claude*
  writeFileSync(join(state, 'config.json'), JSON.stringify({ allowedLogins: ['test@example.com'], configDirs: [LEADER_DIR, MEMBER_DIR], hookToken: 'x'.repeat(40) }))
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  await loadConfig()
  assert.equal(configProblem(), null)
  assert.deepEqual(config().configDirs, [LEADER_DIR, MEMBER_DIR], '⚠️ looking at the real profiles')
  inbox = await fakeInbox(INBOX)
  const server = await startTeamSocket(state)
  assert.ok(server)
  team = { server, sock: teamSocketPath(state) }
})

after(() => {
  inbox?.server.close()
  team?.server.close()
  if (prevState === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
  else process.env['NYAN_REMOTE_STATE_DIR'] = prevState
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  resetTeamsForTest()
  inbox.lines.length = 0
})

function makeTeam(member: { pid?: number; procStart?: string; busyAtJoin?: boolean } = { pid: ME, procStart: START }): Team {
  const made = createTeam(
    { sessionId: 'lead-x', account: '.claude-r', configDir: LEADER_DIR, pid: ME, procStart: START },
    [{ sessionId: 'mem-1', tool: 'claude', account: '.claude-s', configDir: MEMBER_DIR, ...member }],
    undefined,
  )
  assert.ok(made.ok)
  return made.team
}

test('★★ send: a Claude member gets the framed instruction in its inbox, from nyan-team', async () => {
  makeTeam()
  const r = await call(team.sock, 'POST', '/team/send', { leader: 'lead-x', pid: ME, member: 'm1', text: 'please run the tests' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.ok(await waitFor(() => inbox.lines.length > 0))
  const msg = JSON.parse(inbox.lines.at(-1)!) as { type: string; from: string; message: { content: string } }
  assert.equal(msg.type, 'user')
  assert.equal(msg.from, TEAM_SENDER)
  assert.match(msg.message.content, /^\[nyan-team\] /)
  assert.match(msg.message.content, /please run the tests/)
  // ★ told not to reply to nyan-team (a guessed recipient would get the work / codex review r6)
  assert.match(msg.message.content, /Do not send a reply with SendMessage|SendMessage などで返事を送らないで/)
})

test('★★ send: a command-like body is refused before the frame; a member that is not the recorded process is not written to', async () => {
  makeTeam()
  const r1 = await call(team.sock, 'POST', '/team/send', { leader: 'lead-x', pid: ME, member: 'm1', text: '/exit' })
  assert.equal(r1.status, 400)
  resetTeamsForTest()
  // another process instance than the one the index names (a resume / pid reuse)
  makeTeam({ pid: ME, procStart: '1' })
  const r2 = await call(team.sock, 'POST', '/team/send', { leader: 'lead-x', pid: ME, member: 'm1', text: 'hello' })
  assert.equal(r2.status, 409)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(inbox.lines.length, 0)
})

test('★★ turn end: the leader is told with the last words fenced as data, once per turn; a non-member or another profile is not', async () => {
  makeTeam()
  const told: string[] = []
  const tell = async (_t: Team, text: string, guard?: () => boolean): Promise<boolean> => {
    if (guard && !guard()) return false
    told.push(text)
    return true
  }
  const origin = { account: '.claude-s', transcriptPath: join(MEMBER_DIR, 'projects', 'p', 'mem-1.jsonl') }
  assert.equal(await claudeMemberReport('done', 'mem-1', origin, 'All 12 tests pass.', 'turn-1', tell), true)
  assert.match(told[0]!, /m1 \(Claude, team [0-9a-f]{8}\) finished its turn|m1（Claude・チーム [0-9a-f]{8}）のターンが終わりました/)
  assert.match(told[0]!, /All 12 tests pass\./)
  assert.match(told[0]!, /<<</, 'fenced as data')
  // a replayed hook of the same turn: not told again
  assert.equal(await claudeMemberReport('done', 'mem-1', origin, 'All 12 tests pass.', 'turn-1', tell), true)
  assert.equal(told.length, 1)
  // no text in the last message: said
  assert.equal(await claudeMemberReport('done', 'mem-1', origin, '  ', 'turn-2', tell), true)
  assert.match(told[1]!, /nyan team read/)
  // another profile with the same id, a stranger: not a member's turn at all
  assert.equal(claudeMemberReport('done', 'mem-1', { account: '.claude', transcriptPath: join(root, '.claude', 'projects', 'p', 'mem-1.jsonl') }, 'x', 'turn-3', tell), undefined)
  assert.equal(claudeMemberReport('done', 'stranger', origin, 'x', 'turn-3', tell), undefined)
  assert.equal(told.length, 2)
  // not delivered ⇒ false (the caller rings the phone), and a replay that came while it was in flight gets false too
  let fail: (v: boolean) => void = () => {}
  const pendingWrite = new Promise<boolean>((r) => (fail = r))
  const first = claudeMemberReport('done', 'mem-1', origin, 'x', 'turn-4', () => pendingWrite)
  const replay = claudeMemberReport('done', 'mem-1', origin, 'x', 'turn-4', tell)
  fail(false)
  assert.equal(await first, false)
  assert.equal(await replay, false)
  // the same turn going on after a blocking Stop hook (a revised answer), then stopping on an error: both reported
  assert.equal(await claudeMemberReport('done', 'mem-1', origin, 'revised answer', 'turn-1', tell), true)
  assert.equal(await claudeMemberReport('error', 'mem-1', origin, 'revised answer', 'turn-1', tell), true)
  assert.equal(told.length, 4)
  assert.match(told[2]!, /revised answer/)
  // A → B → A within one turn: the final A is sent again (only the last report counts as the same)
  assert.equal(await claudeMemberReport('done', 'mem-1', origin, 'All 12 tests pass.', 'turn-1', tell), true)
  assert.equal(told.length, 5)
})

test('★ one member\'s reports reach the leader in the order the hooks came', async () => {
  makeTeam()
  const order: string[] = []
  let release: () => void = () => {}
  const slow = new Promise<void>((r) => (release = r))
  const origin = { account: '.claude-s', transcriptPath: join(MEMBER_DIR, 'projects', 'p', 'mem-1.jsonl') }
  const a = claudeMemberReport('done', 'mem-1', origin, 'first', 'o-1', async () => {
    await slow
    order.push('first')
    return true
  })
  const b = claudeMemberReport('error', 'mem-1', origin, 'second', 'o-1', async () => {
    order.push('second')
    return true
  })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(order, [], 'the second waits for the first')
  release()
  await Promise.all([a, b])
  assert.deepEqual(order, ['first', 'second'])
})

test('★★ /clear on the member (same process, another session): no report, and a send is not written', async () => {
  makeTeam()
  const entry = join(MEMBER_DIR, 'sessions', `${ME}.json`)
  writeFileSync(entry, JSON.stringify({ pid: ME, sessionId: 'mem-new', procStart: START, messagingSocketPath: INBOX }))
  try {
    const told: string[] = []
    const origin = { account: '.claude-s', transcriptPath: join(MEMBER_DIR, 'projects', 'p', 'mem-1.jsonl') }
    assert.equal(await claudeMemberReport('done', 'mem-1', origin, 'x', 'turn-c', async (_t, text) => (told.push(text), true)), false)
    assert.equal(told.length, 0)
    const r = await call(team.sock, 'POST', '/team/send', { leader: 'lead-x', pid: ME, member: 'm1', text: 'hello' })
    assert.notEqual(r.status, 200)
    await new Promise((res) => setTimeout(res, 50))
    assert.equal(inbox.lines.length, 0)
  } finally {
    writeFileSync(entry, JSON.stringify({ pid: ME, sessionId: 'mem-1', procStart: START, messagingSocketPath: INBOX }))
  }
})

test('★ stop on an error: the leader is told, saying whether it was the plan limit', async () => {
  makeTeam()
  const told: string[] = []
  const tell = async (_t: Team, text: string): Promise<boolean> => {
    told.push(text)
    return true
  }
  const origin = { account: '.claude-s', transcriptPath: join(MEMBER_DIR, 'projects', 'p', 'mem-1.jsonl') }
  await claudeMemberReport('limit', 'mem-1', origin, "You've hit your 5-hour limit · resets 3pm", 'f-1', tell)
  await claudeMemberReport('error', 'mem-1', origin, undefined, 'f-2', tell)
  assert.equal(told.length, 2)
  assert.match(told[0]!, /plan limit|プランの上限/)
  assert.match(told[0]!, /resets 3pm/)
  assert.match(told[1]!, /stopped on an error|エラーで止まりました/)
  assert.doesNotMatch(told[1]!, /nyan team read/)
})

test('★ a Codex member stopped at its limit: the leader is told once per turn', async () => {
  const made = createTeam(
    { sessionId: 'lead-x', account: '.claude-r', configDir: LEADER_DIR, pid: ME, procStart: START },
    [{ sessionId: 'codex-0123456789abcdef-t1', tool: 'codex', account: '.codex' }],
    undefined,
  )
  assert.ok(made.ok)
  const told: string[] = []
  const tell = async (_t: Team, text: string): Promise<boolean> => {
    told.push(text)
    return true
  }
  codexMemberLimited('codex-0123456789abcdef-t1', 't1:turn-1', tell)
  codexMemberLimited('codex-0123456789abcdef-t1', 't1:turn-1', tell)
  codexMemberLimited('codex-0123456789abcdef-t1', 't1:turn-2', tell)
  codexMemberLimited('codex-stranger', 'x:1', tell)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(told.length, 2)
  assert.match(told[0]!, /m1 \(Codex, team [0-9a-f]{8}\) stopped at its plan limit|m1（Codex・チーム [0-9a-f]{8}）がプランの上限で止まりました/)
})

test('★ a member busy when the team was made: its first report says so; later ones do not', async () => {
  makeTeam({ pid: ME, procStart: START, busyAtJoin: true })
  const told: string[] = []
  const tell = async (_t: Team, text: string): Promise<boolean> => (told.push(text), true)
  const origin = { account: '.claude-s', transcriptPath: join(MEMBER_DIR, 'projects', 'p', 'mem-1.jsonl') }
  await claudeMemberReport('done', 'mem-1', origin, 'old work', 'b-1', tell)
  await claudeMemberReport('done', 'mem-1', origin, 'new work', 'b-2', tell)
  assert.match(told[0]!, /busy when the team was made|チームを作ったとき作業中でした/)
  assert.doesNotMatch(told[1]!, /busy when the team was made|チームを作ったとき作業中でした/)
})

test('★ the busy-at-join caution stays until a report gets through', async () => {
  makeTeam({ pid: ME, procStart: START, busyAtJoin: true })
  const origin = { account: '.claude-s', transcriptPath: join(MEMBER_DIR, 'projects', 'p', 'mem-1.jsonl') }
  const seen: string[] = []
  assert.equal(await claudeMemberReport('done', 'mem-1', origin, 'first', 'c-1', async (_t, text) => (seen.push(text), false)), false)
  assert.equal(await claudeMemberReport('done', 'mem-1', origin, 'revised', 'c-1', async (_t, text) => (seen.push(text), true)), true)
  assert.match(seen[1]!, /busy when the team was made|チームを作ったとき作業中でした/)
})

test('★ a Claude profile without the turn-end hook (or without a runnable notify.sh) is told apart (hasTurnEndHook)', () => {
  const home = mkdtempSync(join(root, 'h-'))
  const dir = join(home, '.claude-x')
  mkdirSync(join(home, '.claude', 'hooks'), { recursive: true })
  mkdirSync(dir)
  const script = join(home, '.claude', 'hooks', 'notify.sh')
  writeFileSync(script, '#!/bin/sh\n')
  chmodSync(script, 0o755)
  const entry = (command: string) => [{ matcher: '', hooks: [{ type: 'command', command }] }]
  const stop = (command: string) => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { Stop: entry(command), StopFailure: entry(command) } }))
  assert.equal(hasTurnEndHook(dir, home), false, 'no settings')
  // the installer's forms
  for (const c of ['"$HOME/.claude/hooks/notify.sh"', script, `'${script}'`]) {
    stop(c)
    assert.equal(hasTurnEndHook(dir, home), true, c)
  }
  // Stop wired but StopFailure missing: stops on errors and limits would go unheard
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { Stop: entry(script) } }))
  assert.equal(hasTurnEndHook(dir, home), false)
  // a moved profile's stale path names notify.sh but is not ours
  stop('/old/home/.claude/hooks/notify.sh')
  assert.equal(hasTurnEndHook(dir, home), false)
  // the entry is there but the script is not runnable / not a file
  stop('"$HOME/.claude/hooks/notify.sh"')
  chmodSync(script, 0o644)
  assert.equal(hasTurnEndHook(dir, home), false)
  rmSync(script)
  mkdirSync(script)
  assert.equal(hasTurnEndHook(dir, home), false)
  // on another event only
  rmSync(script, { recursive: true })
  writeFileSync(script, '#!/bin/sh\n')
  chmodSync(script, 0o755)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { Notification: [{ matcher: '', hooks: [{ type: 'command', command: '"$HOME/.claude/hooks/notify.sh"' }] }] } }))
  assert.equal(hasTurnEndHook(dir, home), false)
})

test('★★ a pick from the numbered table: the agent turns the numbers into the very sessions of that table (2026-11-28)', async () => {
  const { rememberTable, rowsFromPick } = await import('./routes/team.ts')
  const t0 = Date.parse('2026-11-28T00:00:00Z')
  const row = (ref: string, sessionId = `${ref}-full`) => ({ ref, sessionId })
  const shown = rememberTable('lead-p', [row('cx-bbbb2222'), row('aaaa1111'), row('ag-cccc3333')], t0)!
  assert.deepEqual(shown.refs, ['cx-bbbb2222', 'aaaa1111', 'ag-cccc3333'])
  assert.deepEqual(rowsFromPick('lead-p', { id: shown.id, numbers: [3, 1] }, t0), [row('ag-cccc3333'), row('cx-bbbb2222')])
  // ⚠️ two sessions sharing a short ref stay two rows, each its own session (codex review)
  const twins = rememberTable('lead-t', [row('aaaa1111', 'aaaa1111-one'), row('aaaa1111', 'aaaa1111-two')], t0)!
  assert.deepEqual(rowsFromPick('lead-t', { id: twins.id, numbers: [2] }, t0), [row('aaaa1111', 'aaaa1111-two')])
  // ⚠️ another lead's table, an older table, a stale one: never used
  const is409 = (e: { status?: number }) => e.status === 409
  assert.throws(() => rowsFromPick('lead-q', { id: shown.id, numbers: [1] }, t0), is409)
  const again = rememberTable('lead-p', [row('aaaa1111')], t0)!
  assert.throws(() => rowsFromPick('lead-p', { id: shown.id, numbers: [1] }, t0), is409)
  assert.throws(() => rowsFromPick('lead-p', { id: again.id, numbers: [1] }, t0 + 31 * 60_000), is409)
  // out of range, twice, none, not numbers
  assert.throws(() => rowsFromPick('lead-p', { id: again.id, numbers: [2] }, t0), is409)
  const now = rememberTable('lead-p', [row('aaaa1111'), row('cx-bbbb2222')], t0)!
  assert.throws(() => rowsFromPick('lead-p', { id: now.id, numbers: [1, 1] }, t0), is409)
  assert.throws(() => rowsFromPick('lead-p', { id: now.id, numbers: [] }, t0), is409)
  assert.throws(() => rowsFromPick('lead-p', { id: now.id, numbers: ['1'] }, t0), (e: { status?: number }) => e.status === 400)
  assert.deepEqual(rowsFromPick('lead-p', { id: now.id, numbers: [2] }, t0), [row('cx-bbbb2222')])
  // nothing to pick: the table is forgotten
  assert.equal(rememberTable('lead-p', [], t0), undefined)
  assert.throws(() => rowsFromPick('lead-p', { id: now.id, numbers: [1] }, t0), is409)
})
