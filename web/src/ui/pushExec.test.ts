// ★★ **Executing** the push subscription plan (2026-09-23 / codex round 13, high #2, a hole in the tests).
//
// ⚠️⚠️ It used to live in `PushPanel.tsx` with **not a single behavioural test**:
//   - removing the "never remove the shell SW (`/`)" check **failed no test**
//   - the "stopped?" check ran only once at the start ⇒ stopping in another tab **revived the subscription**
// ★ Here fake ports are passed in, and we check **the call order and what was not called**.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executePlan, makeSerializer, stopAll, type PushDeps, type PushSub, type PushTarget } from './pushExec.ts'
import type { PushPlan } from './pushScopes.ts'

function world(opts: { stopAfterSubscribe?: boolean; subscribeFails?: string[]; unsubscribeFails?: string[] } = {}) {
  const log: string[] = []
  let stopped = false
  const sub = (endpoint: string): PushSub => ({
    endpoint,
    toJSON: () => ({ endpoint }),
    unsubscribe: async () => {
      log.push(`unsubscribe ${endpoint}`)
      return !(opts.unsubscribeFails ?? []).includes(endpoint)
    },
  })
  const target = (id: string): PushTarget => ({
    id,
    label: id,
    registerPush: async (s) => void log.push(`register ${id} ${(s as { endpoint: string }).endpoint}`),
    unregisterPush: async (e) => void log.push(`unregisterPush ${id} ${e}`),
  })
  const deps: PushDeps = {
    subscribe: async (scope) => {
      if ((opts.subscribeFails ?? []).includes(scope)) throw new Error('Service Worker が有効になりません')
      log.push(`subscribe ${scope}`)
      // ★ While the subscription was being created, "Stop" was pressed in another tab
      if (opts.stopAfterSubscribe) stopped = true
      return sub(`ep:${scope}`)
    },
    unregisterScope: async (scope) => void log.push(`unregisterScope ${scope}`),
    stopped: () => stopped,
  }
  return { log, deps, sub, target, setStopped: (v: boolean) => (stopped = v) }
}

const plan = (p: Partial<PushPlan>): PushPlan => ({ subscribe: [], reregister: [], drop: [], ...p })

test('★★ create first, discard after (codex round 12, high #3)', async () => {
  const w = world()
  await executePlan(
    plan({ subscribe: [{ id: 'A', scope: '/push/a/', publicKey: 'KA' }], drop: ['/push/gone/'] }),
    [{ scope: '/push/gone/', sub: w.sub('ep:gone') }],
    [w.target('A')],
    w.deps,
  )
  const made = w.log.indexOf('register A ep:/push/a/')
  const gone = w.log.indexOf('unsubscribe ep:gone')
  assert.ok(made >= 0 && gone >= 0, `not called: ${w.log.join(' / ')}`)
  assert.ok(made < gone, '⚠️⚠️ discards the old subscription before creating its replacement')
})

test('★★ the shell SW (`/`) is never unregistered (⚠️ a test hole codex found)', async () => {
  const w = world()
  await executePlan(
    plan({ drop: ['/', '/push/old/'] }),
    [
      { scope: '/', sub: w.sub('ep:root') },
      { scope: '/push/old/', sub: w.sub('ep:old') },
    ],
    [w.target('A')],
    w.deps,
  )
  assert.ok(!w.log.includes('unregisterScope /'), '⚠️⚠️ unregistered the shell SW (offline startup breaks)')
  assert.ok(w.log.includes('unregisterScope /push/old/'), 'did not clean up a scope we created')
  // ★ The subscription itself is unsubscribed even for `/` (it is in the discard plan)
  assert.ok(w.log.includes('unsubscribe ep:root'))
})

test('★★ if stopped while creating a subscription, do not register, and delete the created subscription (codex round 13, high #2)', async () => {
  const w = world({ stopAfterSubscribe: true })
  await executePlan(
    plan({ subscribe: [{ id: 'A', scope: '/push/a/', publicKey: 'KA' }, { id: 'B', scope: '/push/b/', publicKey: 'KB' }] }),
    [],
    [w.target('A'), w.target('B')],
    w.deps,
  )
  assert.ok(!w.log.some((l) => l.startsWith('register')), `⚠️⚠️ registered although stopped (the subscription revives): ${w.log.join(' / ')}`)
  assert.ok(w.log.includes('unsubscribe ep:/push/a/'), '⚠️⚠️ left the just-created subscription')
  assert.ok(!w.log.includes('subscribe /push/b/'), 'creates the next subscription although stopped')
})

test('★★ no resend when stopped (codex round 13, high #2)', async () => {
  const w = world()
  w.setStopped(true)
  await executePlan(
    plan({ reregister: [{ id: 'A', scope: '/push/a/' }] }),
    [{ scope: '/push/a/', sub: w.sub('ep:a') }],
    [w.target('A')],
    w.deps,
  )
  assert.ok(!w.log.some((l) => l.startsWith('register')), '⚠️⚠️ resent although stopped')
})

test('★★ if a subscription cannot be created, collect the reason and continue (⚠️ not treated as success / round 12, medium #6)', async () => {
  const w = world({ subscribeFails: ['/push/a/'] })
  const problems = await executePlan(
    plan({ subscribe: [{ id: 'A', scope: '/push/a/', publicKey: 'KA' }, { id: 'B', scope: '/push/b/', publicKey: 'KB' }] }),
    [],
    [w.target('A'), w.target('B')],
    w.deps,
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? '', /A: Service Worker が有効になりません/)
  assert.ok(!w.log.some((l) => l.startsWith('register A')), '⚠️⚠️ registered although not created')
  assert.ok(w.log.includes('register B ep:/push/b/'), 'one machine\'s failure stopped the others')
})

test('★★ stop all: returns what could not be unsubscribed, never removes the shell SW', async () => {
  const w = world({ unsubscribeFails: ['ep:b'] })
  const left = await stopAll(
    [
      { scope: '/', sub: w.sub('ep:root') },
      { scope: '/push/a/', sub: w.sub('ep:a') },
      { scope: '/push/b/', sub: w.sub('ep:b') },
      { scope: '/push/none/', sub: null },
    ],
    [w.target('A')],
    w.deps,
  )
  assert.deepEqual(left, ['/push/b/'], '⚠️ shaped so it could say "Stopped" although not unsubscribed')
  assert.ok(!w.log.includes('unregisterScope /'), '⚠️⚠️ unregistered the shell SW')
})

test('★★ uses the cross-tab lock when available (codex round 13, high #2)', async () => {
  const names: string[] = []
  const serialize = makeSerializer({
    request: async (name, fn) => {
      names.push(name)
      return fn()
    },
  })
  await serialize(async () => {})
  assert.deepEqual(names, ['nyan-remote.push-sync'], '⚠️⚠️ not using Web Locks (does not span tabs)')
})

test('★★ without the lock, serialise within the page (as before)', async () => {
  const serialize = makeSerializer(undefined)
  const order: string[] = []
  let release!: () => void
  const first = serialize(async () => {
    order.push('1 始')
    await new Promise<void>((r) => (release = r))
    order.push('1 終')
  })
  const second = serialize(async () => void order.push('2'))
  await new Promise((r) => setTimeout(r, 10))
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ['1 始', '1 終', '2'], '⚠️ running overlapped')
})

test('★★ even after a machine whose creation failed, do not create the next if stopped (codex round 14, medium #3)', async () => {
  // ⚠️ It only checked "after creating" ⇒ for a failed machine it moved on to the next SW startup wait without checking
  const w = world({ subscribeFails: ['/push/a/'] })
  const deps = {
    ...w.deps,
    subscribe: async (scope: string, key: string) => {
      try {
        return await w.deps.subscribe(scope, key)
      } finally {
        w.setStopped(true) // ★ stopped in another tab while the first machine's creation (failing) was in progress
      }
    },
  }
  await executePlan(
    plan({ subscribe: [{ id: 'A', scope: '/push/a/', publicKey: 'KA' }, { id: 'B', scope: '/push/b/', publicKey: 'KB' }] }),
    [],
    [w.target('A'), w.target('B')],
    deps,
  )
  assert.ok(!w.log.includes('subscribe /push/b/'), '⚠️⚠️ went on to create the next machine\'s subscription although stopped (delays the stop)')
})

test('★★ a registration failure returns its reason (⚠️ a mutant swallowing it slipped past the tests / codex round 14)', async () => {
  const w = world()
  const failing: PushTarget = { ...w.target('A'), registerPush: async () => { throw new Error('agent が断った') } }
  const problems = await executePlan(
    plan({ subscribe: [{ id: 'A', scope: '/push/a/', publicKey: 'KA' }], reregister: [] }),
    [],
    [failing],
    w.deps,
  )
  assert.deepEqual(problems, ['A: agent が断った'], '⚠️⚠️ silently swallows the registration failure (no reason on screen)')
})

test('★★ a resend failure returns its reason', async () => {
  const w = world()
  const failing: PushTarget = { ...w.target('A'), registerPush: async () => { throw new Error('届かない') } }
  const problems = await executePlan(
    plan({ reregister: [{ id: 'A', scope: '/push/a/' }] }),
    [{ scope: '/push/a/', sub: w.sub('ep:a') }],
    [failing],
    w.deps,
  )
  assert.deepEqual(problems, ['A: 届かない'])
})

test('★★ after recreating, remove the old endpoint from that agent (⚠️ do not accumulate dead endpoints)', async () => {
  const w = world()
  await executePlan(
    plan({ subscribe: [{ id: 'A', scope: '/push/a/', publicKey: 'KA2' }] }), // ★ key changed, so recreated
    [{ scope: '/push/a/', sub: w.sub('ep:old') }],
    [w.target('A')],
    w.deps,
  )
  const reg = w.log.indexOf('register A ep:/push/a/')
  const drop = w.log.indexOf('unregisterPush A ep:old')
  assert.ok(reg >= 0, 'did not register the new subscription')
  assert.ok(drop > reg, '⚠️⚠️ did not remove the old endpoint (or removed it before registering the new one)')
})

test('★★ if registration fails, the old endpoint is not removed either', async () => {
  const w = world()
  const failing: PushTarget = { ...w.target('A'), registerPush: async () => { throw new Error('x') } }
  await executePlan(
    plan({ subscribe: [{ id: 'A', scope: '/push/a/', publicKey: 'KA2' }] }),
    [{ scope: '/push/a/', sub: w.sub('ep:old') }],
    [failing],
    w.deps,
  )
  assert.ok(!w.log.includes('unregisterPush A ep:old'))
})
