import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { claimMachine, LEDGER_MAX, ledgerSweepAt, releaseCredential, MACHINE_IDLE_MS, pruneLedger, readLedger, REVOKED_KEEP_MS, revokeCredential, type Ledger } from './ledger.ts'

const T = 1_800_000_000_000
const empty = (): Ledger => ({ machines: {}, revoked: {} })
/** Passphrase numbers (⚠️ only tickets with removed numbers are refused) */
const ISSUED = 'm_first'
const release = (l: Ledger, key: string, now: number, mid = ISSUED, keepSlot = false) => {
  const r = revokeCredential(l, key, mid, keepSlot, now)
  assert.ok(r.ok)
  return r.ledger
}

test('★★ Free (1 machine): the first passes, the second is refused, the same machine passes any number of times', () => {
  let l = empty()
  const a = claimMachine(l, 'A', 1, T, ISSUED)
  assert.equal(a.ok, true)
  l = a.ledger
  assert.equal(claimMachine(l, 'B', 1, T + 1, ISSUED).ok, false, '⚠️⚠️ let a second machine through on Free')
  assert.equal(claimMachine(l, 'A', 1, T + 2, ISSUED).ok, true)
})

test('★★ a refusal leaves the ledger unchanged; a pass updates the last-seen time', () => {
  const l: Ledger = { machines: { A: { first: T, last: T, mids: {} } }, revoked: {} }
  const r = claimMachine(l, 'B', 1, T + 5, ISSUED)
  assert.deepEqual(r.ledger.machines, { A: { first: T, last: T, mids: {} } })
  assert.deepEqual(claimMachine(l, 'A', 1, T + 9, ISSUED).ledger.machines['A'], { first: T, last: T + 9, mids: { [ISSUED]: T + 9 } })
  assert.deepEqual(l.machines, { A: { first: T, last: T, mids: {} } }, '⚠️ rewrote the original ledger')
})

test('★★ the limit applies even when registered: 5 on Plus → back to Free, only the first one passes (codex round 26, high #4)', () => {
  let l = empty()
  for (const [i, k] of ['A', 'B', 'C', 'D', 'E'].entries()) l = claimMachine(l, k, 5, T + i, ISSUED).ledger
  assert.equal(claimMachine(l, 'A', 1, T + 100, ISSUED).ok, true)
  for (const k of ['B', 'C', 'D', 'E']) {
    const r = claimMachine(l, k, 1, T + 100, ISSUED)
    assert.equal(r.ok, false, `⚠️⚠️ let ${k} through after going back to Free`)
    assert.equal(r.ledger.machines[k]!.last, l.machines[k]!.last, '⚠️ updated the time of a refused machine (it would never drop out after 30 days)')
  }
  // ★ A machine that keeps being refused drops out after 30 days
  assert.equal(Object.keys(pruneLedger(l, T + 4 + MACHINE_IDLE_MS + 1).machines).length, 0)
})

test('★★ a ticket from a removed passphrase cannot re-register (codex round 26, high #3 / round 27, medium #6)', () => {
  let l = claimMachine(empty(), 'A', 1, T, 'm_a1').ledger
  l = release(l, 'A', T + 10, 'm_a1')
  // B takes the slot
  l = claimMachine(l, 'B', 1, T + 20, 'm_b1').ledger
  // Stop the "remove A, then B, then..." loop: A cannot come back with the old ticket it holds
  const freed = release(l, 'B', T + 30, 'm_b1')
  assert.equal(claimMachine(freed, 'A', 1, T + 40, 'm_a1').ok, false, '⚠️⚠️ came back with a ticket from a removed passphrase')
  // ★ A ticket from a fresh login (a different number) can take a free slot even at the same instant (no clock comparison)
  const back = claimMachine(freed, 'A', 1, T + 30, 'm_a2')
  assert.equal(back.ok, true)
  // ⚠️⚠️ Even after coming back, the old number stays refused (codex round 27, medium #7)
  assert.equal(claimMachine(back.ledger, 'A', 1, T + 50, 'm_a1').ok, false, '⚠️⚠️ after coming back, the old ticket started passing')
  // ⚠️ If the slots are full, even a new ticket cannot get in
  assert.equal(claimMachine(l, 'A', 1, T + 40, 'm_a3').ok, false)
})

test('★★ if another passphrase of the same machine remains, the slot is not freed', () => {
  const l = claimMachine(empty(), 'A', 1, T, 'm_a1').ledger
  const kept = release(l, 'A', T + 1, 'm_a1', true)
  assert.ok('A' in kept.machines)
  assert.equal(claimMachine(kept, 'A', 1, T + 2, 'm_a2').ok, true)
})

test('★★ if the record of removed numbers is full, the removal itself is refused (never silently skip recording / codex round 27, medium #7)', () => {
  let l = empty()
  for (let i = 0; i < LEDGER_MAX; i++) l = release(l, 'K', T, `m_fill${i}`)
  const r = revokeCredential(l, 'K', 'm_onemore', false, T)
  assert.equal(r.ok, false, '⚠️⚠️ claimed it was removed although it could not be recorded')
  // ★ Space frees up once entries expire
  assert.equal(revokeCredential(l, 'K', 'm_onemore', false, T + REVOKED_KEEP_MS + 1).ok, true)
})

test('★★ removed numbers are remembered longer than a ticket lifetime, then dropped', () => {
  const l = release(empty(), 'A', T, 'm_x')
  assert.ok('m_x' in pruneLedger(l, T + REVOKED_KEEP_MS).revoked)
  assert.equal('m_x' in pruneLedger(l, T + REVOKED_KEEP_MS + 1).revoked, false)
})

test('★★ machines not connected for 30 days drop out of the slots (replacing a PC does not leave the slot filled)', () => {
  const l: Ledger = { machines: { OLD: { first: T, last: T, mids: {} } }, revoked: {} }
  assert.equal(claimMachine(l, 'NEW', 1, T + MACHINE_IDLE_MS, ISSUED).ok, false)
  assert.equal(claimMachine(l, 'NEW', 1, T + MACHINE_IDLE_MS + 1, ISSUED).ok, true)
})

test('★★ reads the previous shape (key → time) and drops broken values', () => {
  assert.deepEqual(readLedger({ A: T, B: 'x', C: Number.NaN }), { machines: { A: { first: T, last: T, mids: {} } }, revoked: {} })
  assert.deepEqual(readLedger(null), empty())
  assert.deepEqual(readLedger({ machines: { A: { first: T, last: 'x' } }, revoked: { m_b: T, m_c: 'x' } }), { machines: {}, revoked: { m_b: T } })
  assert.deepEqual(release(readLedger({ A: T, B: T }), 'A', T).machines, { B: { first: T, last: T, mids: {} } })
})

test('★★ removal order: record → room → slot. If the room cannot be reached, throw without freeing the slot (codex round 27, high #3)', async () => {
  let l = claimMachine(empty(), 'A', 1, T, 'm_a1').ledger
  const io = (roomDown: boolean) => ({
    read: async () => l,
    write: async (x: Ledger) => void (l = x),
    revokeRoom: async () => {
      if (roomDown) throw new Error('room down')
    },
    now: () => T + 1,
  })
  await assert.rejects(releaseCredential(io(true), 'A', 'm_a1'))
  assert.ok('A' in l.machines, '⚠️⚠️ freed the slot before reaching the room (the room ticket remains and another machine can get in)')
  assert.ok('m_a1' in l.revoked, '⚠️ did not record "reject" first')
  // ★ Retrying frees it
  await releaseCredential(io(false), 'A', 'm_a1')
  assert.equal('A' in l.machines, false)
  assert.equal(claimMachine(l, 'B', 1, T + 2, 'm_b1').ok, true)
})

test('★★ if a passphrase re-logged in on the same machine is in use, removing the old passphrase keeps the slot (codex round 28, high #3)', () => {
  let l = claimMachine(empty(), 'A', 1, T, 'm_old').ledger
  // Re-logged in on the same machine, and the ticket of the new passphrase passed
  l = claimMachine(l, 'A', 1, T + 1, 'm_new').ledger
  // account assumed "no other passphrase for the same key" (a stale read) and came to free the slot
  l = release(l, 'A', T + 2, 'm_old', false)
  assert.ok('A' in l.machines, '⚠️⚠️ freed the slot although a passphrase is in use (another machine can get in)')
  assert.equal(claimMachine(l, 'B', 1, T + 3, 'm_b').ok, false)
  // ★ Removing the last passphrase frees it
  l = release(l, 'A', T + 4, 'm_new', false)
  assert.equal('A' in l.machines, false)
})

test('★★ two removals for the same slot: while one is stalled contacting its room, the other finishing does not free the slot (codex round 29, high #2)', async () => {
  let l = claimMachine(empty(), 'K', 1, T, 'm_a').ledger
  l = claimMachine(l, 'K', 1, T, 'm_b').ledger
  let releaseA!: () => void
  let aEntered!: () => void
  const aInRoom = new Promise<void>((ok) => (aEntered = ok))
  const aStuck = new Promise<void>((ok) => (releaseA = ok))
  const io = (room: () => Promise<void>) => ({ read: async () => l, write: async (x: Ledger) => void (l = x), revokeRoom: room, now: () => T + 1 })
  // ⚠️ Start B after A has begun contacting its room (a real DO does not interleave other events between reads and writes)
  const a = releaseCredential(io(() => (aEntered(), aStuck.then(() => { throw new Error('room down') }))), 'K', 'm_a')
  await aInRoom
  await releaseCredential(io(async () => {}), 'K', 'm_b')
  assert.ok('K' in l.machines, '⚠️⚠️ freed the slot while the room of A still has a ticket')
  releaseA()
  await assert.rejects(a)
  assert.ok('K' in l.machines, '⚠️⚠️ freed the slot although the room of A was not reached')
  assert.equal(claimMachine(l, 'OTHER', 1, T + 2, 'm_o').ok, false)
})

test('★★ once both removals for the same slot finish, the slot is freed (do not keep it based on the view at removal start / codex round 30, medium #2)', async () => {
  let l = claimMachine(empty(), 'K', 1, T, 'm_a').ledger
  l = claimMachine(l, 'K', 1, T, 'm_b').ledger
  const io = { read: async () => l, write: async (x: Ledger) => void (l = x), revokeRoom: async () => {}, now: () => T + 1 }
  await releaseCredential(io, 'K', 'm_b')
  assert.ok('K' in l.machines, '★ A is still using it')
  await releaseCredential(io, 'K', 'm_a')
  assert.equal('K' in l.machines, false, '⚠️⚠️ the slot stayed although no passphrase is left (cannot replace the machine)')
})

// ── Timed sweep (2026-11-26 / review ACC-3) ─────────────────────────────────────────────

test('★★ ACC-3: the sweep time is the first expiry (machine, passphrase number or removed number); nothing left = undefined', () => {
  assert.equal(ledgerSweepAt(empty()), undefined)
  const l: Ledger = {
    machines: { A: { first: T, last: T + 5, mids: { m1: T + 3, m2: T + 5 } } },
    revoked: {},
  }
  assert.equal(ledgerSweepAt(l), T + 3 + MACHINE_IDLE_MS + 1, '⚠️ the old passphrase number runs out first')
  // ★ At that time pruning really changes something (the alarm must not fire one tick early and find nothing to do)
  assert.deepEqual(Object.keys(pruneLedger(l, T + 3 + MACHINE_IDLE_MS).machines.A!.mids), ['m1', 'm2'])
  assert.deepEqual(Object.keys(pruneLedger(l, T + 3 + MACHINE_IDLE_MS + 1).machines.A!.mids), ['m2'])
  const r: Ledger = { machines: {}, revoked: { mOld: T + REVOKED_KEEP_MS } }
  assert.equal(ledgerSweepAt(r), T + REVOKED_KEEP_MS + 1)
  assert.deepEqual(pruneLedger(r, T + REVOKED_KEEP_MS + 1).revoked, {})
  // Everything ran out ⇒ the next sweep finds nothing (the DO deletes its storage)
  assert.equal(ledgerSweepAt(pruneLedger(l, T + 6 + MACHINE_IDLE_MS)), undefined)
})

test('★★ ACC-3: the Accounts and Phones DOs set an alarm on every write and prune in alarm() (worker.ts is not run by npm test)', () => {
  const src = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  const cls = (name: string) => src.slice(src.indexOf(`export class ${name} `), src.indexOf('\nexport class', src.indexOf(`export class ${name} `) + 1))
  const accounts = cls('Accounts')
  const phones = cls('Phones')
  assert.doesNotMatch(accounts + phones, /storage\.put\(/, '⚠️⚠️ a ledger write that sets no alarm (the ledger would never be swept)')
  assert.match(accounts, /keepLedger\(this\.ctx\.storage, 'machines', l, ledgerSweepAt\(l\)\)/)
  assert.match(accounts, /async alarm\(\)[\s\S]*pruneLedger\(await this\.#read\(\), Date\.now\(\)\)/)
  assert.match(phones, /keepLedger\(this\.ctx\.storage, 'rooms', r\.ledger, phoneSweepAt\(r\.ledger\)\)/)
  assert.match(phones, /async alarm\(\)[\s\S]*blockConcurrencyWhile[\s\S]*prunePhoneLedger\([\s\S]*keepLedger\(this\.ctx\.storage, 'rooms', l, phoneSweepAt\(l\)\)/)
  const keep = src.slice(src.indexOf('async function keepLedger'), src.indexOf('\n}\n', src.indexOf('async function keepLedger')))
  assert.match(keep, /if \(sweepAt === undefined\) \{\s*await storage\.deleteAll\(\)\s*return/, '⚠️ an empty ledger must leave no storage (one deleteAll, which also drops the alarm)')
  assert.doesNotMatch(keep, /deleteAlarm/, '⚠️ deleteAlarm after deleteAll writes the alarm metadata back')
  for (const name of ['wrangler.jsonc', 'wrangler.selfhost.jsonc']) {
    const cfg = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    assert.match(cfg, /"compatibility_flags":\s*\[[^\]]*"delete_all_deletes_alarm"/, `⚠️⚠️ ${name}: deleteAll() keeps the alarm without this flag`)
  }
  assert.match(keep, /const wrote = storage\.put\(name, value\)\s*const armed = storage\.setAlarm\(sweepAt\)\s*await Promise\.all\(\[wrote, armed\]\)/, '⚠️⚠️ an await between the write and the alarm (they must commit together)')
})
