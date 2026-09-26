// ★★ The free tier without sign-in: one machine per phone (`relay/src/phoneLedger.ts` / 2026-09-27).
//
// ★★ Mutations targeted by name here:
//   ① a second machine passes on the free tier (the limit is not applied)
//   ② a room with a plan ticket is counted against the phone (a signed-in machine would use up the free slot)
//   ③ a room with a ticket does not release the slot (a machine that signs in later keeps holding it)
//   ④ idle rooms never drop out (a replaced PC holds the slot forever)
//   ⑤ broken input inflates the ledger / throws

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PLAN_LIMITS } from '../../shared/license.ts'
import { FREE_MACHINES_PER_PHONE, PHONE_IDLE_MS, PHONE_ROOMS_MAX, claimRoom, prunePhoneLedger, readPhoneLedger, type PhoneLedger } from './phoneLedger.ts'

const EMPTY: PhoneLedger = { rooms: {} }
const T0 = 1_700_000_000_000

test('★ the free tier per phone is the plan table (never written by hand)', () => {
  assert.equal(FREE_MACHINES_PER_PHONE, PLAN_LIMITS.free.maxMachines)
  assert.equal(FREE_MACHINES_PER_PHONE, 1)
})

test('★★ one machine passes and is remembered; a second machine is refused (①)', () => {
  const a = claimRoom(EMPTY, 'A', false, T0)
  assert.equal(a.ok, true)
  assert.deepEqual(a.ledger.rooms, { A: { first: T0, last: T0 } })
  const b = claimRoom(a.ledger, 'B', false, T0 + 1)
  assert.equal(b.ok, false, '⚠️⚠️ a second machine passed on the free tier')
  assert.deepEqual(b.ledger.rooms, a.ledger.rooms, '⚠️ a refusal changed the ledger')
  // ★ The same machine keeps passing (and its time moves on)
  const again = claimRoom(b.ledger, 'A', false, T0 + 5)
  assert.equal(again.ok, true)
  assert.deepEqual(again.ledger.rooms, { A: { first: T0, last: T0 + 5 } })
})

test('★★ a room with a plan ticket always passes, is not counted, and releases the slot it held (② ③)', () => {
  const a = claimRoom(EMPTY, 'A', false, T0)
  // A signed-in machine B: passes without touching the slot A holds
  const b = claimRoom(a.ledger, 'B', true, T0 + 1)
  assert.equal(b.ok, true, '⚠️⚠️ a signed-in machine was refused')
  assert.deepEqual(b.ledger.rooms, { A: { first: T0, last: T0 } }, '⚠️⚠️ a licensed room was counted against the phone')
  // ★ A signs in later and the phone connects to it again ⇒ the slot is released, so a new machine C may take it
  const aLicensed = claimRoom(b.ledger, 'A', true, T0 + 2)
  assert.deepEqual(aLicensed.ledger.rooms, {}, '⚠️⚠️ a machine that signed in kept holding the free slot')
  assert.equal(claimRoom(aLicensed.ledger, 'C', false, T0 + 3).ok, true)
})

test('★★ rooms not used for a long time drop out (④)', () => {
  const a = claimRoom(EMPTY, 'A', false, T0)
  assert.equal(claimRoom(a.ledger, 'B', false, T0 + PHONE_IDLE_MS).ok, false, 'dropped out too early')
  const b = claimRoom(a.ledger, 'B', false, T0 + PHONE_IDLE_MS + 1)
  assert.equal(b.ok, true, '⚠️⚠️ an idle room still holds the slot')
  assert.deepEqual(Object.keys(b.ledger.rooms), ['B'])
  assert.deepEqual(prunePhoneLedger(a.ledger, T0 + PHONE_IDLE_MS + 1).rooms, {})
})

test('★★ over the limit, only the oldest claims pass (a raised-then-lowered limit does not keep extra machines)', () => {
  let l = claimRoom(EMPTY, 'A', false, T0, 2).ledger
  l = claimRoom(l, 'B', false, T0 + 1, 2).ledger
  assert.equal(claimRoom(l, 'B', false, T0 + 2).ok, false, '⚠️ a later claim passed after the limit went down')
  assert.equal(claimRoom(l, 'A', false, T0 + 2).ok, true)
})

test('★★ broken input is dropped, never throws, and the ledger is capped (⑤)', () => {
  assert.deepEqual(readPhoneLedger(null), EMPTY)
  assert.deepEqual(readPhoneLedger({ rooms: [] }), EMPTY)
  assert.deepEqual(readPhoneLedger({ rooms: { A: { first: 'x', last: 1 }, B: { first: 1, last: 2 }, C: 5 } }), { rooms: { B: { first: 1, last: 2 } } })
  const big: PhoneLedger = { rooms: {} }
  for (let i = 0; i < PHONE_ROOMS_MAX; i++) big.rooms[`k${i}`] = { first: T0, last: T0 }
  assert.equal(claimRoom(big, 'new', false, T0, 1000).ok, false)
})
