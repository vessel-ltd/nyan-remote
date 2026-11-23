import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, test } from 'node:test'
import type { PermissionRequest } from '../../shared/types.ts'
import { aliveProcStartFreshSync } from './claude/sessionIndex.ts'
import { resetPending, waitForDecision, type Decision } from './permission.ts'
import { createTeam, resetTeamsForTest } from './team.ts'
import { cardRef } from './teamHooks.ts'
import { answersFromChoices, limitsOf, refOf, withoutSharedLabels } from './routes/team.ts'
import { dirProblem, startTeamSocket, teamSocketPath } from './teamSocket.ts'

const root = mkdtempSync(join(tmpdir(), 'nr-team-'))
after(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => {
  resetTeamsForTest()
  resetPending()
})

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

async function open(): Promise<{ dir: string; sock: string; server: Server }> {
  const dir = mkdtempSync(join(root, 's'))
  chmodSync(dir, 0o700)
  const server = await startTeamSocket(dir)
  assert.ok(server, 'the socket opens in a private directory')
  return { dir, sock: teamSocketPath(dir), server }
}

const ME = process.pid
// ★ The leader's profile with its own index entry (the final answer guard reads it / r12 high #3)
const LEADER_DIR = join(root, '.claude-r')
mkdirSync(join(LEADER_DIR, 'sessions'), { recursive: true })
writeFileSync(join(LEADER_DIR, 'sessions', `${ME}.json`), JSON.stringify({ pid: ME, sessionId: 'lead-x' }))
const LEADER = () => ({ sessionId: 'lead-x', account: '.claude-r', configDir: LEADER_DIR, pid: ME, procStart: String(aliveProcStartFreshSync(ME)) })

function pending(over: Partial<PermissionRequest> = {}): { info: PermissionRequest; decided: Promise<Decision | undefined> } {
  const info: PermissionRequest = {
    key: `k-${Math.random().toString(16).slice(2)}#1`,
    machine: 'pc-a',
    account: '.claude-s',
    project: 'p',
    sessionId: 'mem-1',
    tool: 'codex',
    toolName: 'Bash',
    summary: 'ls',
    at: new Date().toISOString(),
    ...over,
  }
  // ★ As the real cards are: the exact input beside the card (the leader judges by it)
  const decided = waitForDecision(info, () => {}, { toolInput: { command: info.summary } })
  return { info, decided }
}

test('★★ the directory must be ours, a real directory, and closed to others — otherwise no socket', async () => {
  const d = mkdtempSync(join(root, 'p'))
  chmodSync(d, 0o755)
  assert.equal(await dirProblem(d), 'open to other users')
  assert.equal(await startTeamSocket(d), undefined)
  const link = join(root, 'link')
  symlinkSync(d, link)
  // a link resolves to its target, which is then judged (here: open to others)
  assert.ok(await dirProblem(link))
  const { dir, sock, server } = await open()
  try {
    // ⚠️ the socket itself is this user's only
    assert.equal(statSync(sock).mode & 0o777, 0o600)
    assert.equal(dir.length > 0, true)
  } finally {
    server.close()
  }
})

test('★ a leftover non-socket file at the socket path is never removed (the socket is not opened)', async () => {
  const d = mkdtempSync(join(root, 'f'))
  chmodSync(d, 0o700)
  mkdirSync(teamSocketPath(d))
  assert.equal(await startTeamSocket(d), undefined)
  assert.ok(statSync(teamSocketPath(d)).isDirectory())
})

test('★★★ the leader answers a delegated member approval through the same answer path as the phone', async () => {
  const { sock, server } = await open()
  try {
    assert.ok(createTeam(LEADER(), [{ sessionId: 'mem-1', tool: 'codex', account: '.codex' }], '3h', Date.now() - 1000).ok)
    const p = pending()
    const r = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME, ref: cardRef(p.info), behavior: 'allow' })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, { ok: true })
    const d = await p.decided
    assert.equal(d?.behavior, 'allow')
    // ★ a later key (agy) asks again whether the team still holds the grant (codex review 2026-11-22)
    assert.equal(d?.stillValid?.(), true)
    resetTeamsForTest()
    assert.equal(d?.stillValid?.(), false, 'disbanded ⇒ the key is not typed')
  } finally {
    server.close()
  }
})

test('★★★ refused: no delegation, a plan approval, one that waited before the grant, another pid, a non-member', async () => {
  const { sock, server } = await open()
  try {
    const grant = Date.now()
    assert.ok(createTeam(LEADER(), [{ sessionId: 'mem-1', tool: 'codex', account: '.codex' }], '3h', grant).ok)
    const plan = pending({ toolName: 'ExitPlanMode', interaction: { kind: 'plan' } })
    const r1 = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME, ref: cardRef(plan.info), behavior: 'allow' })
    assert.equal(r1.json['ok'], false)
    const early = pending({ at: new Date(grant - 60_000).toISOString() })
    const r2 = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME, ref: cardRef(early.info), behavior: 'allow' })
    assert.equal(r2.json['ok'], false)
    const other = pending({ sessionId: 'stranger' })
    const r3 = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME, ref: cardRef(other.info), behavior: 'allow' })
    assert.equal(r3.json['ok'], false)
    const ok = pending()
    const r4 = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME + 1, ref: cardRef(ok.info), behavior: 'allow' })
    assert.equal(r4.status, 409)
    // ⚠️ none of them was answered
    for (const x of [plan, early, other, ok]) {
      const settled = await Promise.race([x.decided.then(() => true), new Promise((r) => setTimeout(() => r(false), 30))])
      assert.equal(settled, false)
    }
    resetTeamsForTest()
    assert.ok(createTeam(LEADER(), [{ sessionId: 'mem-1', tool: 'codex', account: '.codex' }], undefined).ok)
    const r5 = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME, ref: cardRef(ok.info), behavior: 'allow' })
    assert.equal(r5.json['ok'], false)
  } finally {
    server.close()
  }
})

test('★★ send: a body starting with / or ! is refused before any frame is added; Claude members are told to use SendMessage', async () => {
  const { sock, server } = await open()
  try {
    assert.ok(
      createTeam(LEADER(), [{ sessionId: 'mem-1', tool: 'claude', account: '.claude-s' }, { sessionId: 'codex-0123456789abcdef-t1', tool: 'codex', account: '.codex' }], undefined).ok,
    )
    const r1 = await call(sock, 'POST', '/team/send', { leader: 'lead-x', pid: ME, member: 'm2', text: '/exit' })
    assert.equal(r1.status, 400)
    const r2 = await call(sock, 'POST', '/team/send', { leader: 'lead-x', pid: ME, member: 'm2', text: '  !rm -rf x' })
    assert.equal(r2.status, 400)
    const r3 = await call(sock, 'POST', '/team/send', { leader: 'lead-x', pid: ME, member: 'm1', text: 'hello' })
    assert.equal(r3.status, 400)
    assert.match(String(r3.json['error']), /SendMessage/)
  } finally {
    server.close()
  }
})

test('★ a Codex session cannot lead (phase 1); no team ⇒ 404; disband by id works from a plain terminal', async () => {
  const { sock, server } = await open()
  try {
    const r1 = await call(sock, 'GET', '/team/status?leader=codex-0123456789abcdef-t1&pid=5')
    assert.equal(r1.status, 400)
    const r2 = await call(sock, 'GET', `/team/status?leader=lead-x&pid=${ME}`)
    assert.equal(r2.status, 404)
    const made = createTeam(LEADER(), [{ sessionId: 'mem-1', tool: 'claude', account: '.claude-s' }], undefined)
    assert.ok(made.ok)
    const r3 = await call(sock, 'POST', '/team/disband', { team: made.team.id })
    assert.equal(r3.status, 200)
    const r4 = await call(sock, 'GET', '/team/list')
    assert.deepEqual(r4.json, { teams: [] })
  } finally {
    server.close()
  }
})

test('★★ the leader answers with labels only (notes refused) and never a clipped command', async () => {
  const { sock, server } = await open()
  try {
    assert.ok(createTeam(LEADER(), [{ sessionId: 'mem-1', tool: 'codex', account: '.codex' }], '3h', Date.now() - 1000).ok)
    const p = pending()
    const r1 = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME, ref: cardRef(p.info), behavior: 'allow', notes: { Q: 'free text' } })
    assert.equal(r1.status, 400)
    const long = pending({ detailClipped: true, summary: 'x'.repeat(10) })
    const r2 = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME, ref: cardRef(long.info), behavior: 'allow' })
    assert.equal(r2.json['ok'], false)
    const list = await call(sock, 'GET', `/team/pending?leader=lead-x&pid=${ME}`)
    const row = (list.json['pending'] as { ref: string; clipped?: boolean; mayAnswer: boolean }[]).find((x) => x.ref === cardRef(long.info))
    assert.equal(row?.clipped, true)
    assert.equal(row?.mayAnswer, false)
  } finally {
    server.close()
  }
})

test('★★ options are chosen by number and mapped to the card’s own labels by the agent (never typed by the leader)', () => {
  const info = { interaction: { kind: 'question' as const, questions: [
    { question: 'Q1', multiSelect: false, options: [{ label: '$(rm -rf ~)' }, { label: 'B' }] },
    { question: 'Q2', multiSelect: true, options: [{ label: 'C' }] },
  ] } }
  const r = answersFromChoices(info, ['1', '2:1'])
  assert.ok(r.ok)
  assert.deepEqual({ ...r.answers }, { Q1: ['$(rm -rf ~)'], Q2: ['C'] })
  // a question named like an Object property is just a question (r3 low #1)
  const proto = { interaction: { kind: 'question' as const, questions: [{ question: '__proto__', multiSelect: false, options: [{ label: 'x' }] }] } }
  const r2 = answersFromChoices(proto, ['1'])
  assert.ok(r2.ok)
  assert.deepEqual(r2.answers?.['__proto__'], ['x'])
  assert.equal(answersFromChoices(info, ['B']).ok, false)
  assert.equal(answersFromChoices(info, ['3']).ok, false)
  assert.equal(answersFromChoices(info, ['9:1']).ok, false)
  assert.deepEqual(answersFromChoices(info, undefined), { ok: true })
})

test('★★★ a request waiting before the grant stays with the human even when replayed with a new key and time', async () => {
  const { sock, server } = await open()
  try {
    const before = pending({ origin: 'codex:same-request' })
    assert.ok(createTeam(LEADER(), [{ sessionId: 'mem-1', tool: 'codex', account: '.codex' }], '3h', Date.now(), [before.info.origin!]).ok)
    await new Promise((r) => setTimeout(r, 5))
    // the daemon reconnects and replays the same request: new key (generation), new `at`
    const replay = pending({ origin: 'codex:same-request', at: new Date(Date.now() + 1000).toISOString() })
    const r = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME, ref: cardRef(replay.info), behavior: 'allow' })
    assert.equal(r.json['ok'], false)
    const fresh = pending({ origin: 'codex:another', at: new Date(Date.now() + 1000).toISOString() })
    const r2 = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME, ref: cardRef(fresh.info), behavior: 'allow' })
    assert.deepEqual(r2.json, { ok: true })
  } finally {
    server.close()
  }
})

test('★★ the walk refuses a link on the way and a directory above that others can change (r3 high #5)', async () => {
  const { walkPrivate } = await import('./privateDir.ts')
  const base = mkdtempSync(join(root, 'w'))
  chmodSync(base, 0o700)
  const target = join(base, 'state')
  mkdirSync(target, { mode: 0o700 })
  assert.equal(walkPrivate(target), undefined)
  const shared = join(base, 'shared')
  mkdirSync(shared)
  chmodSync(shared, 0o777)
  const inner = join(shared, 'state')
  mkdirSync(inner, { mode: 0o700 })
  assert.match(String(walkPrivate(inner)), /ancestor/)
  symlinkSync(target, join(base, 'via-link'))
  assert.match(String(walkPrivate(join(base, 'via-link'))), /link/)
  assert.equal(walkPrivate('relative/path'), 'not an absolute path')
})

test('★ a second agent never takes a live team socket away (r5 medium #5)', async () => {
  const { dir, sock, server } = await open()
  try {
    assert.equal(await startTeamSocket(dir), undefined)
    const r = await call(sock, 'GET', '/team/list')
    assert.equal(r.status, 200)
  } finally {
    server.close()
  }
})

test('★★ a hook or card is a member’s only from its own profile directory (two profiles can share a base name / r6 high #1)', async () => {
  const { sameProfile, underDir } = await import('./teamHooks.ts')
  assert.equal(underDir('/home/user/a/.claude/projects/p/x.jsonl', '/home/user/a/.claude'), true)
  assert.equal(underDir('/home/user/b/.claude/projects/p/x.jsonl', '/home/user/a/.claude'), false)
  assert.equal(underDir('/home/user/a/.claude-x/projects/p/x.jsonl', '/home/user/a/.claude'), false)
  assert.equal(underDir(undefined, '/home/user/a/.claude'), false)
  // ⚠️ a profile nested inside another is another profile; `..` and other shapes are unknown (r7 high #1)
  assert.equal(underDir('/home/user/a/.claude/archive/.claude/projects/p/x.jsonl', '/home/user/a/.claude'), false)
  assert.equal(underDir('/home/user/a/.claude/projects/../projects/p/x.jsonl', '/home/user/a/.claude'), false)
  assert.equal(underDir('/home/user/a/.claude/projects/p/sub/x.jsonl', '/home/user/a/.claude'), false)
  const rec = { account: '.claude', configDir: '/home/user/a/.claude' }
  assert.equal(sameProfile(rec, '.claude', '/home/user/b/.claude/projects/p/x.jsonl'), false)
  assert.equal(sameProfile(rec, '.claude', '/home/user/a/.claude/projects/p/x.jsonl'), true)
  // no transcript to compare: not trusted (the sweep handles a missed end; a quiet "done" rings instead)
  assert.equal(sameProfile(rec, '.claude', undefined), false)
})

test('★ macOS ACLs: no ACL or only deny entries pass; any allow entry (also under an @ suffix), an unreadable line, stderr, or a + with nothing printed is refused (r8–r10)', async () => {
  const { macAclProblem } = await import('./privateDir.ts')
  const ls = (mode: string, lines: string[], stderr = '') => () => ({ stdout: [`${mode} 5 me staff 160 Nov 19 00:00 /x`, ...lines].join('\n'), stderr })
  assert.equal(macAclProblem('/x', ls('drwx------', [])), undefined)
  assert.equal(macAclProblem('/x', ls('drwx------@', [])), undefined)
  assert.equal(macAclProblem('/x', ls('drwxr-xr-x+', [' 0: group:everyone deny delete'])), undefined)
  assert.match(String(macAclProblem('/x', ls('drwx------@', [' 0: user:other allow add_file']))), /ACL/)
  assert.match(String(macAclProblem('/x', ls('drwx------+', [' 0: user:me allow add_file']))), /ACL/)
  assert.match(String(macAclProblem('/x', ls('drwx------+', [' 0: group:Domain Users allow add_file,delete_child']))), /ACL/)
  assert.match(String(macAclProblem('/x', ls('drwx------+', [' 0: 7A1B2C3D-0000-0000-0000-000000000000 allow delete_child']))), /ACL/)
  assert.match(String(macAclProblem('/x', ls('drwx------+', []))), /cannot read/)
  assert.match(String(macAclProblem('/x', ls('drwx------', [], 'ls: acl: Permission denied'))), /cannot read/)
  assert.match(String(macAclProblem('/x', () => undefined)), /cannot read/)
})

test('★★★ the leader sees a Claude card’s whole input (a Write’s contents); one too long to show whole is the human’s (r9 high #3)', async () => {
  const { cardText } = await import('./teamHooks.ts')
  const info: PermissionRequest = { key: 'w#1', machine: 'pc-a', account: '.claude-s', project: 'p', sessionId: 'mem-9', toolName: 'Write', summary: 'settings.json', at: new Date().toISOString(), cwd: '/srv/live' }
  void waitForDecision(info, () => {}, { toolInput: { file_path: 'settings.json', content: 'DANGER=1' } })
  const shown = cardText(info)
  assert.match(shown.text, /DANGER=1/)
  assert.match(shown.text, /cwd: \/srv\/live/)
  assert.equal(shown.clipped, false)
  const big: PermissionRequest = { ...info, key: 'w#2' }
  void waitForDecision(big, () => {}, { toolInput: { file_path: 'settings.json', content: 'x'.repeat(20_000) } })
  assert.equal(cardText(big).clipped, true)
  // no input known ⇒ cannot be shown whole
  assert.equal(cardText({ ...info, key: 'w#3' }).clipped, true)
})

test('★★ an answered request starts a new first-seen lifetime; a re-entry of a waiting one keeps it (r11 medium #2)', async () => {
  const { firstSeenAt, answer } = await import('./permission.ts')
  const t0 = new Date(Date.now() - 60_000).toISOString()
  const a: PermissionRequest = { key: 'same-fp#g1', machine: 'pc-a', account: '.claude-s', project: 'p', sessionId: 's', toolName: 'Bash', summary: 'ls', at: t0 }
  const first = waitForDecision(a, () => {})
  // a re-entry of the same waiting request (same fingerprint, new generation): keeps the first time
  const b = { ...a, key: 'same-fp#g2', at: new Date().toISOString() }
  const second = waitForDecision(b, () => {})
  assert.equal(await first, undefined)
  assert.equal(firstSeenAt(b), t0)
  // answered: the same command asked again later is new
  assert.ok(answer(b.key, 'allow'))
  await second
  const later = new Date().toISOString()
  const c = { ...a, key: 'same-fp#g3', at: later }
  void waitForDecision(c, () => {})
  assert.equal(firstSeenAt(c), later)
})

test('★★ an invisible character and the text that names it never print alike (r12 high #2)', async () => {
  const { revealed } = await import('./teamHooks.ts')
  const real = revealed('rm "a\u200Bb"')
  const typed = revealed('rm "a[U+200B]b"')
  assert.equal(real, 'rm "a[U+200B]b"')
  assert.equal(typed, 'rm "a[[U+200B]b"')
  assert.notEqual(real, typed)
  assert.equal(revealed('[[U+1]'), '[[[[U+1]')
  assert.equal(revealed('plain [x] text'), 'plain [x] text')
  // ⚠️ a typed '[' right before an invisible character (r13 high #3)
  assert.equal(revealed('[\u200B'), '[[[U+200B]')
  assert.notEqual(revealed('[\u200B'), revealed('[U+200B]'))
  // linear: a very long run of '[' is quick (r17 medium #4)
  const t0 = Date.now()
  assert.equal(revealed('['.repeat(200_000) + 'x').length, 200_001)
  assert.ok(Date.now() - t0 < 1000)
})

test('★★ the final guard refuses once the leader process carries another session (r12 high #3)', async () => {
  const { sock, server } = await open()
  try {
    assert.ok(createTeam(LEADER(), [{ sessionId: 'mem-1', tool: 'codex', account: '.codex' }], '3h', Date.now() - 1000).ok)
    writeFileSync(join(LEADER_DIR, 'sessions', `${ME}.json`), JSON.stringify({ pid: ME, sessionId: 'after-clear' }))
    const p = pending()
    const r = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME, ref: cardRef(p.info), behavior: 'allow' })
    assert.equal(r.json['ok'], false)
  } finally {
    writeFileSync(join(LEADER_DIR, 'sessions', `${ME}.json`), JSON.stringify({ pid: ME, sessionId: 'lead-x' }))
    server.close()
  }
})

test('★★ a lost hook connection is not a settlement: the request keeps its first-seen time when it comes back (r13 high #2)', async () => {
  const { firstSeenAt } = await import('./permission.ts')
  const t0 = new Date(Date.now() - 60_000).toISOString()
  const a: PermissionRequest = { key: 'lost-fp#g1', machine: 'pc-a', account: '.claude-s', project: 'p', sessionId: 's', toolName: 'Bash', summary: 'ls', at: t0 }
  let drop: () => void = () => {}
  const first = waitForDecision(a, (onAbort) => {
    drop = onAbort
  })
  drop()
  assert.equal(await first, undefined)
  const back = { ...a, key: 'lost-fp#g2', at: new Date().toISOString() }
  void waitForDecision(back, () => {})
  assert.equal(firstSeenAt(back), t0)
})


test('★ limits carry each window’s reset time and the reading time, longest first, from that tool and profile only (2026-11-19)', () => {
  const u = {
    usage: [
      { tool: 'claude' as const, account: '.claude-r', at: '2026-11-19T11:48:00Z', windows: [
        { minutes: 300, usedPercent: 10.4, resetsAt: '2026-11-19T14:30:00Z' },
        { minutes: 10080, usedPercent: 41.6, resetsAt: '2026-11-22T12:00:00Z' },
      ] },
      { tool: 'codex' as const, account: '.claude-r', at: '2026-11-19T11:59:00Z', windows: [{ minutes: 10080, usedPercent: 90, resetsAt: '2026-11-20T00:00:00Z' }] },
      { tool: 'claude' as const, account: '.claude-s', at: '2026-11-19T11:00:00Z', windows: [] },
    ],
  }
  assert.deepEqual(limitsOf(u, 'claude', '.claude-r'), {
    windows: [
      { minutes: 10080, usedPercent: 42, resetsAt: '2026-11-22T12:00:00Z' },
      { minutes: 300, usedPercent: 10, resetsAt: '2026-11-19T14:30:00Z' },
    ],
    at: '2026-11-19T11:48:00Z',
  })
  // the tool must match too (a Codex home and a Claude profile can share a label)
  assert.equal(limitsOf(u, 'codex', '.claude-r')?.windows[0]?.usedPercent, 90)
  // every window reset since the reading, or nothing read: unknown, never "0%"
  assert.equal(limitsOf(u, 'claude', '.claude-s'), undefined)
  assert.equal(limitsOf(u, 'claude', '.claude'), undefined)
  // ★ two Codex homes with one label: unknown, never the first one's numbers (codex review r1)
  const twin = { usage: [...u.usage, { tool: 'codex' as const, account: '.claude-r', at: '2026-11-19T11:59:00Z', windows: [{ minutes: 10080, usedPercent: 5, resetsAt: '2026-11-20T00:00:00Z' }] }] }
  assert.equal(limitsOf(twin, 'codex', '.claude-r'), undefined)
  // ★ one reading of a label two watched homes share: dropped (only one read succeeded / codex review r2–r3)
  const one = withoutSharedLabels(u, (label) => label === '.claude-r')
  assert.equal(limitsOf(one, 'codex', '.claude-r'), undefined)
  assert.ok(limitsOf(one, 'claude', '.claude-r'), 'a Claude profile with the same label is not a Codex home')
  assert.ok(limitsOf(withoutSharedLabels(u, () => false), 'codex', '.claude-r'))
  // ★★ two profiles on one account: one quota ⇒ both show the newest reading and name each other (codex review r4)
  const one2 = {
    usage: [
      { tool: 'claude' as const, account: '.claude-r', accountKey: 'k1', at: '2026-11-19T11:00:00Z', windows: [{ minutes: 300, usedPercent: 12, resetsAt: '2026-11-19T14:30:00Z' }] },
      { tool: 'claude' as const, account: '.claude-rs', accountKey: 'k1', at: '2026-11-19T11:55:00Z', windows: [{ minutes: 300, usedPercent: 96, resetsAt: '2026-11-19T14:30:00Z' }] },
      { tool: 'claude' as const, account: '.claude-s', accountKey: 'k2', at: '2026-11-19T11:58:00Z', windows: [{ minutes: 300, usedPercent: 1, resetsAt: '2026-11-19T14:30:00Z' }] },
    ],
  }
  for (const [profile, other] of [['.claude-r', '.claude-rs'], ['.claude-rs', '.claude-r']] as const) {
    const l = limitsOf(one2, 'claude', profile)
    assert.equal(l?.windows[0]?.usedPercent, 96, profile)
    assert.equal(l?.at, '2026-11-19T11:55:00Z')
    assert.deepEqual(l?.sameLoginAs, [other])
  }
  assert.equal(limitsOf(one2, 'claude', '.claude-s')?.sameLoginAs, undefined)
  assert.equal(limitsOf(one2, 'claude', '.claude-s')?.windows[0]?.usedPercent, 1)
  // the newest reading of the account has no window left: unknown, never an older window (codex review r5)
  const emptied = { usage: [...one2.usage, { tool: 'claude' as const, account: '.claude-rt', accountKey: 'k1', at: '2026-11-19T11:59:00Z', windows: [] }] }
  assert.equal(limitsOf(emptied, 'claude', '.claude-r'), undefined)
})

test('★★ agy members (docs/TEAM.md §9): refs are ours; send refuses / ! ? before anything, and an agy it cannot confirm; approvals likewise', async () => {
  // ★ a ref of our own making, hex only, with its kind
  assert.match(refOf({ sessionId: 'agy-0f0e0d0c-0b0a-4909-8807-060504030201' }), /^ag-[0-9a-f]{8}$/)
  assert.match(refOf({ sessionId: 'codex-0123456789abcdef-t1' }), /^cx-[0-9a-f]{8}$/)
  const { sock, server } = await open()
  try {
    // an agy process that is not reachable through a relay here: its identity cannot be confirmed
    const agy = { sessionId: 'agy-0f0e0d0c-0b0a-4909-8807-060504030201', tool: 'agy' as const, account: 'agy', pid: ME, procStart: String(aliveProcStartFreshSync(ME)) }
    assert.ok(createTeam(LEADER(), [agy], '3h', Date.now() - 1000).ok)
    for (const text of ['/exit', '!ls', '?', '  ?help']) {
      const r = await call(sock, 'POST', '/team/send', { leader: 'lead-x', pid: ME, member: 'm1', text })
      assert.equal(r.status, 400, text)
    }
    const r = await call(sock, 'POST', '/team/send', { leader: 'lead-x', pid: ME, member: 'm1', text: 'hello' })
    assert.equal(r.status, 409, 'not confirmed as the member ⇒ nothing typed')
    // ⚠️ its card: listed, but the human answers it while the member cannot be confirmed
    const info: PermissionRequest = { key: 'agy:k#1', machine: 'pc-a', account: 'agy', project: 'p', sessionId: agy.sessionId, tool: 'agy', toolName: 'Bash', summary: 'date', at: new Date().toISOString() }
    const p = { info, decided: waitForDecision(info, () => {}, { toolInput: { command: 'date' }, requestedAt: Date.now(), agyPid: ME }) }
    const list = await call(sock, 'GET', `/team/pending?leader=lead-x&pid=${ME}`)
    const row = (list.json['pending'] as { mayAnswer: boolean; why?: string; memberTool: string }[])[0]
    assert.deepEqual([row?.memberTool, row?.mayAnswer, row?.why], ['agy', false, 'member-gone'])
    const a = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME, ref: cardRef(p.info), behavior: 'allow' })
    assert.equal(a.json['ok'], false)
    const settled = await Promise.race([p.decided.then(() => true), new Promise((res) => setTimeout(() => res(false), 30))])
    assert.equal(settled, false)
  } finally {
    server.close()
  }
})

test('★★ an agy card\'s ref stays valid when the same call comes back under a new key (measured 2026-11-23)', async () => {
  const { sock, server } = await open()
  try {
    assert.ok(createTeam(LEADER(), [{ sessionId: 'agy-0f0e0d0c-0b0a-4909-8807-060504030201', tool: 'agy', account: 'agy', pid: ME, procStart: String(aliveProcStartFreshSync(ME)) }], '3h', Date.now() - 1000).ok)
    let withdraw: (() => void) | undefined
    const first: PermissionRequest = { key: 'k-old#1', origin: 'agy:call-1', machine: 'pc-a', account: 'agy', project: 'p', sessionId: 'agy-0f0e0d0c-0b0a-4909-8807-060504030201', tool: 'agy', toolName: 'Bash', summary: 'ls', at: new Date().toISOString() }
    void waitForDecision(first, (w) => (withdraw = w), { toolInput: { command: 'ls' } })
    const told = cardRef(first)
    withdraw?.()
    const again = { ...first, key: 'k-new#1' }
    const decided = waitForDecision(again, () => {}, { toolInput: { command: 'ls' } })
    // (the member cannot be confirmed here — no relay — so the answer is refused, but by the member check: the old ref
    //  found the card that waits now, not "gone")
    const r = await call(sock, 'POST', '/team/approve', { leader: 'lead-x', pid: ME, ref: told, behavior: 'allow' })
    assert.equal(r.json['ok'], false)
    assert.match(String(r.json['reason']), /no longer the session|作ったときのセッション/)
    void decided
  } finally {
    server.close()
  }
})

test('★★★ a Claude card\'s ref is its exact key: a retry after a denial (same fingerprint) is not answered by the old ref (codex · agy review)', () => {
  // a Claude card has no origin; a retry in the same turn gets the next generation of the same fingerprint
  assert.notEqual(cardRef({ key: 'prompt-1#1' }), cardRef({ key: 'prompt-1#2' }))
  // an agy card names its call: the same ref under a new key
  assert.equal(cardRef({ key: 'a#1', origin: 'agy:x', tool: 'agy' }), cardRef({ key: 'b#1', origin: 'agy:x', tool: 'agy' }))
  // ⚠️ a Codex card's origin can be shared by sub-approvals of one item: its exact key (codex review round 12)
  assert.notEqual(cardRef({ key: 'c1#1', origin: 'codex:item', tool: 'codex' }), cardRef({ key: 'c2#1', origin: 'codex:item', tool: 'codex' }))
})
