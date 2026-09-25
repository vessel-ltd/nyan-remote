// ★★ **Pin the names of keys stored on the device to the values the implementation produces** (codex high #5, 2026-08-31).
//
// If the rename (`tmux-agent` → `nyan-remote`) also changed the `localStorage` keys,
// **the saved endpoint list and drafts would vanish** (to the user: "all my registrations are gone").
//
// ⚠️⚠️ **The string table in `agent/src/rename.test.ts` alone can't protect this.**
//    Writing `const KEY = ['nyan-remote', 'endpoints', 'v1'].join('.')`
//    **slips past the table** because `<new-name>.endpoints` never appears contiguously in the source,
//    yet the runtime key changes. ⇒ **Have the implementation build the key and check that value.**
//
// ★ This is "test the value the implementation actually produces" (VERIFY.md / tests that pass hand-made values are false greens).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { loadEndpoints, saveEndpoints } from './endpoints.ts'

/** node has no localStorage, so install a minimal real one (a Map is enough) */
function installFakeStorage(): Map<string, string> {
  const store = new Map<string, string>()
  const fake: Storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }
  ;(globalThis as { localStorage?: Storage }).localStorage = fake
  return store
}

test('★★ measured: the endpoint-list key is tmux-agent.endpoints.v1 (changing it wipes all registrations)', () => {
  const store = installFakeStorage()
  // ⚠️ Don't write the key in the test and compare; **have the implementation write it** and look at that key
  saveEndpoints([{ id: 'x', url: 'https://example.invalid', label: 'x' }])
  assert.deepEqual(
    [...store.keys()],
    ['tmux-agent.endpoints.v1'],
    '⚠️⚠️ the storage key changed. Stage 1 does not change it (CLAUDE.md §0)',
  )
})

test('★★ measured: data saved under the old key can be read (the shape on real devices)', () => {
  const store = installFakeStorage()
  // ★ This is the shape already on phones. If unreadable, it looks like "registrations vanished"
  store.set('tmux-agent.endpoints.v1', JSON.stringify([{ id: 'a', url: 'https://a.invalid', label: 'A' }]))
  const got = loadEndpoints()
  assert.equal(got.length, 1)
  assert.equal(got[0]?.id, 'a', 'saved endpoints not read (the key changed)')
})

test('★★ the draft key prefix also stays on the tmux-agent side', () => {
  // ⚠️ `Composer.tsx` is `.tsx`, so it can't be imported directly from `node --test` (can't measure).
  //    ⇒ Only here do we read the source. ⚠️ **Splitting the string would slip past**, so
  //      check the `DRAFT_PREFIX` definition itself (the producer, not the users).
  const src = readFileSync(new URL('./ui/Composer.tsx', import.meta.url), 'utf8')
  const m = src.match(/const DRAFT_PREFIX = '([^']+)'/)
  assert.ok(m, 'cannot read the DRAFT_PREFIX definition (its shape changed)')
  assert.equal(m[1], 'tmux-agent.draft.', 'the draft key changed (half-typed text would be lost)')
})

test('★★ measured: this device key store is tmux-agent.identity.v1 (changing it forces re-pairing on every machine)', async () => {
  // ⚠️⚠️ **Never change this in a rename** (stages 2+3 on 2026-09-19 kept only this).
  //    IndexedDB is **per origin**, so it can't be moved with `mv` = the moment it changes,
  //    **the user's device becomes "someone else" and must re-pair with every registered machine**.
  //    ⚠️ Moreover **dead registrations remain on the agent side** (the user can't see why).
  // ★ Look at **the value the implementation exports**, not a string table (a table can be bypassed with `join('.')`).
  const { IDENTITY_DB } = await import('./identity.ts')
  assert.equal(IDENTITY_DB, 'tmux-agent.identity.v1', '⚠️⚠️ the device private key store changed')
})
