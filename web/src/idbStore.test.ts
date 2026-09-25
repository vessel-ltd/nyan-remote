// Internals of `idbKeyStore()` (IndexedDB handling).
//
// ★★ **Why test with a fake IndexedDB at all** (2026-09-08 / codex medium #2, slip-past mutation ⑤):
//   `request.onsuccess` isn't "**committed**". It counted as success there, so
//   **even if it aborted afterwards it was treated as "saved"** and proceeded with the in-memory key
//   (= the key vanished right after registering, leaving **only a dead registration** on the agent).
//   ⚠️⚠️ Node has no IndexedDB, so **this path couldn't be hit by mutations**
//      (codex named "emptying `put` stays green"). ⇒ **Made it injectable.**
//
// ⚠️ **The fake covers "only what `run` uses"** (open / transaction / objectStore / get / put / delete and
//    `oncomplete` `onabort` `onerror`). It doesn't pretend to reproduce the real semantics.
//    ⇒ Only **how events are received** is checked here. The real thing is ⬜ verified on a device.
//
// ⚠️⚠️ **Every test has a timeout (5s)**. A mutation that doesn't resolve on `tx.oncomplete`
//    doesn't "fail" but **never returns** (on 2026-09-08 the mutation test was cut off at 300s).
//    ⇒ A hang isn't green, but **without a timeout the mutation tooling itself stalls**.
//
// ★★ **Mutations killed by name** here:
//   ① succeed on `request.onsuccess` instead of `tx.oncomplete` (reads an abort as success)
//   ② ignore `tx.onabort` (never returns = the screen freezes)
//   ③ `getOrPut` ignores the existing value and overwrites (first one doesn't win)
//   ④ `getOrPut` returns success even if it skips saving entirely
//   ⑤ don't close the connection

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IDENTITY_ID, IDENTITY_STORE, idbKeyStore } from './identity.ts'

interface FakeReq {
  result?: unknown
  error?: unknown
  onsuccess?: () => void
  onerror?: () => void
  onupgradeneeded?: () => void
  onblocked?: () => void
}

/**
 * A fake covering only what `run` uses.
 *
 * ★ `mode` decides "how it ends": `complete` (commit) / `abort` / `error`.
 * ★ `closed` shows whether the connection was closed.
 */
function fakeIdb(opts: { data?: Map<string, unknown>; end?: 'complete' | 'abort' | 'error' } = {}) {
  const data = opts.data ?? new Map<string, unknown>()
  const end = opts.end ?? 'complete'
  const state = { closed: 0, puts: 0, aborted: 0 }

  /**
   * ★★ **Real semantics**: a transaction completes "**after all pending requests finish**".
   *    ⚠️ Without counting them, we'd test **an impossible world** where `oncomplete` fires before `put`'s `onsuccess`
   *       (on 2026-09-08 it was first written that way and failed = the fake was too lax).
   */
  let pending = 0
  let finish = (): void => {}
  const req = (result?: unknown): FakeReq => {
    const r: FakeReq = { result }
    pending += 1
    queueMicrotask(() => {
      r.onsuccess?.()
      pending -= 1
      // ★ New requests can be queued inside success handlers, so recount **afterwards**
      queueMicrotask(() => {
        if (pending === 0) finish()
      })
    })
    return r
  }

  const factory = {
    open() {
      const r: FakeReq = {}
      queueMicrotask(() => {
        r.result = {
          objectStoreNames: { contains: () => true },
          close: () => void (state.closed += 1),
          transaction() {
            const tx: {
              error?: unknown
              oncomplete?: () => void
              onabort?: () => void
              onerror?: () => void
              abort?: () => void
              objectStore: () => unknown
            } = {
              abort: () => void (state.aborted += 1),
              objectStore: () => ({
                get: (id: string) => req(data.get(id)),
                put: (v: unknown, id: string) => {
                  state.puts += 1
                  data.set(id, v)
                  return req(undefined)
                },
                delete: (id: string) => {
                  data.delete(id)
                  return req(undefined)
                },
              }),
            }
            // ★ When pending requests run out, fire "done" (same order as the real one)
            let done = false
            finish = () => {
              if (done) return
              done = true
              if (end === 'complete') tx.oncomplete?.()
              else if (end === 'abort') {
                tx.error = new Error('abort されました')
                tx.onabort?.()
              } else {
                tx.error = new Error('壊れました')
                tx.onerror?.()
              }
            }
            // ⚠️ No usage queues zero requests, but don't hang if it happens
            queueMicrotask(() =>
              queueMicrotask(() => {
                if (pending === 0) finish()
              }),
            )
            return tx
          },
        }
        r.onsuccess?.()
      })
      return r
    },
  } as unknown as IDBFactory

  return { factory, data, state }
}

test('★★ success once committed (read)', { timeout: 5000 }, async () => {
  const { factory, data } = fakeIdb({ data: new Map([[IDENTITY_ID, 'ほぞん']]) })
  assert.equal(await idbKeyStore(factory).get(IDENTITY_ID), 'ほぞん')
  assert.equal(data.size, 1)
})

test('★★ even if the request succeeds, an abort means failure (not confused with commit)', { timeout: 5000 }, async () => {
  // ⚠️⚠️ This is the point. It used to resolve on `request.onsuccess`, so
  //    **even when aborted it proceeded as "saved"** (= a dead registration remains).
  const { factory } = fakeIdb({ end: 'abort' })
  await assert.rejects(() => idbKeyStore(factory).getOrPut(IDENTITY_ID, 'あたらしい'), /abort/)
})

test('★★ a transaction ending in error is a failure', { timeout: 5000 }, async () => {
  const { factory } = fakeIdb({ end: 'error' })
  await assert.rejects(() => idbKeyStore(factory).get(IDENTITY_ID))
})

test('★★ getOrPut: first one wins (doesn\'t overwrite an existing value)', { timeout: 5000 }, async () => {
  const { factory, data, state } = fakeIdb({ data: new Map([[IDENTITY_ID, 'せんちゃく']]) })
  const got = await idbKeyStore(factory).getOrPut(IDENTITY_ID, 'あとから')
  assert.equal(got, 'せんちゃく', '★ returns the settled value (the first one)')
  assert.equal(data.get(IDENTITY_ID), 'せんちゃく', '★ not overwritten')
  assert.equal(state.puts, 0, '★ did not go to write')
})

test('★★ getOrPut inserts if absent and returns the inserted value', { timeout: 5000 }, async () => {
  const { factory, data, state } = fakeIdb()
  const got = await idbKeyStore(factory).getOrPut(IDENTITY_ID, 'はじめて')
  assert.equal(got, 'はじめて')
  assert.equal(data.get(IDENTITY_ID), 'はじめて', '★ actually saved')
  assert.equal(state.puts, 1)
})

test('★★ the connection is closed on both success and failure', { timeout: 5000 }, async () => {
  const ok = fakeIdb()
  await idbKeyStore(ok.factory).get(IDENTITY_ID)
  assert.equal(ok.state.closed, 1)

  const bad = fakeIdb({ end: 'abort' })
  await idbKeyStore(bad.factory).get(IDENTITY_ID).catch(() => undefined)
  assert.equal(bad.state.closed, 1, '★ closed even on failure')
})

test('★★ delete also waits for commit', { timeout: 5000 }, async () => {
  const { factory, data } = fakeIdb({ data: new Map([[IDENTITY_ID, 'x']]) })
  await idbKeyStore(factory).del(IDENTITY_ID)
  assert.equal(data.has(IDENTITY_ID), false)

  const aborted = fakeIdb({ data: new Map([[IDENTITY_ID, 'x']]), end: 'abort' })
  await assert.rejects(() => idbKeyStore(aborted.factory).del(IDENTITY_ID))
})

test('★ the store name doesn\'t change (changing it loses the saved key)', { timeout: 5000 }, () => {
  // ⚠️ Treated like the protected names in CLAUDE.md §0
  assert.equal(IDENTITY_STORE, 'keys')
  assert.equal(IDENTITY_ID, 'device')
})
