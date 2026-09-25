// This device's (phone / app) static key = ③'s identity (ARCHITECTURE §14.1.2.3).
//
// ★★ **The private key stays `extractable: false` in IndexedDB.**
//   `CryptoKey` is structured-cloneable, so **a key whose contents JS can't extract** can be stored.
//   ⇒ Even under XSS it **can't be exfiltrated** (⚠️ it can still be **used** while the page is open,
//     so the `innerHTML` ban and the `safeHref` discipline are still needed).
//   ⚠️⚠️ **Never create keys other than with `generateDeviceKey()`** (it takes no arguments and is always
//     `extractable:false`). ★ The agent-side key module (the one in `agent/src/`, which
//     creates and writes out extractable keys) is **never imported from the PWA**
//     — `web/src/discipline.test.ts` guards this mechanically **by string**, so
//     ⚠️ even writing its name here fails the test (the guard is deliberately broad in the safe direction).
//
// ★★ **Storage (IndexedDB) and decisions are separated.**
//   ⚠️ Node has no IndexedDB, so the decisions (create if absent / don't recreate if broken) are
//      tested by swapping `KeyStore` (the same split as `timeBound.mjs`).
//
// ⚠️⚠️ **If broken, don't silently recreate.** Recreating changes the public key, so
//    the user thinks they're "paired" but **can't connect** (a dead registration stays on the agent side).
//    ⇒ **Return the reason, show it on screen, and let a human decide whether to recreate** (`resetIdentity()`).

import {
  exportPublicKey,
  fingerprint,
  generateDeviceKey,
  matchesKeyPair,
  toBase64Url,
  type KeyPair,
} from '../../shared/crypto.ts'
import { t } from '../../shared/i18n.ts'

/**
 * ⚠️ **Don't rename** (renaming loses the saved key and forces re-pairing).
 *    Treated like the protected names in CLAUDE.md §0 (aligned with `tmux-agent.endpoints.v1`).
 */
export const IDENTITY_DB = 'tmux-agent.identity.v1'
export const IDENTITY_STORE = 'keys'
export const IDENTITY_ID = 'device'

/**
 * The storage interface (so IndexedDB can be swapped).
 *
 * ★★ **No `put` (save-only)** (codex medium #1, 2026-09-08).
 *   ⚠️⚠️ Splitting into `get → generate → put` means that **when two tabs of the same origin open for the first time at once**,
 *      both read "no key" and can save different keys = **two identities are created, and only one
 *      remains saved** (reproduced by measurement). Registering with the key that returned first makes you someone else after a reload.
 *   ⇒ Only **`getOrPut`** (in one transaction: "insert if absent and return **the settled value**").
 *      This **enforces by type** that "the first one wins, and the later one also receives **the same key**".
 *   ⚠️ Sharing a Promise inside the module **doesn't protect other tabs** (it's decided on the store side).
 */
export interface KeyStore {
  get(id: string): Promise<unknown>
  /** ★ If absent, insert `candidate` and return **the settled value** (the first one's) */
  getOrPut(id: string, candidate: unknown): Promise<unknown>
  del(id: string): Promise<void>
}

export type Identity =
  | { kind: 'ok'; pair: KeyPair; deviceId: string; publicKey: string }
  /** ⚠️ What's stored can't be used as a key. **Don't silently recreate** */
  | { kind: 'broken'; reason: string }
  /** Can't save or read (private mode etc.). ⚠️ Without a key, pairing is impossible */
  | { kind: 'unavailable'; reason: string }

/**
 * Get this device's identity (**create and save it if absent**).
 *
 * ⚠️⚠️ If created but not saved, `unavailable` (**don't proceed with an in-memory-only key**).
 *    Proceeding would lose the key right after registering, leaving **only a dead registration** on the agent.
 */
export async function loadIdentity(store: KeyStore): Promise<Identity> {
  let stored: unknown
  try {
    stored = await store.get(IDENTITY_ID)
  } catch (err) {
    return { kind: 'unavailable', reason: t(`鍵の保管庫を読めません（${errText(err)}）`, `Cannot read the key store (${errText(err)})`) }
  }

  // ⚠️⚠️ **Unsaved is only `undefined`** (codex medium #3, 2026-09-08).
  //    It used to treat `null` as "first time" too and **overwrite with a new key** (reproduced by measurement).
  //    ★ Now `getOrPut` (insert if absent = `null` counts as "present") gives the same result, so
  //      a mutation changing this line back to `&& stored !== null` is **equivalent** (unkillable by tests).
  //      ⇒ What protects it is **`getOrPut`'s semantics**. This line stays for readability.
  if (stored !== undefined) return await adopt(stored)

  // First time. ⚠️ **Use only the settled value** (`getOrPut` returns the first one)
  let candidate: KeyPair
  try {
    candidate = await generateDeviceKey()
  } catch (err) {
    return { kind: 'unavailable', reason: t(`鍵を作れません（${errText(err)}）`, `Cannot create a key (${errText(err)})`) }
  }
  let settled: unknown
  try {
    settled = await store.getOrPut(IDENTITY_ID, candidate)
  } catch (err) {
    return { kind: 'unavailable', reason: t(`鍵を保存できません（${errText(err)}）`, `Cannot save the key (${errText(err)})`) }
  }
  // ⚠️ **Take the returned settled value** (not our own candidate = the same key even if concurrent)
  return await adopt(settled)
}

/**
 * Turn the stored (or settled) value into an identity.
 *
 * ⚠️ "Present" and "usable" differ. **If broken, don't silently recreate** (return the reason).
 */
async function adopt(stored: unknown): Promise<Identity> {
  const pair = asKeyPair(stored)
  if (!pair) return { kind: 'broken', reason: t('保存されている鍵の形が違います', 'The saved key has the wrong format') }
  // ★★ **Also check that the public and private keys are the same pair** (codex medium #3, 2026-09-08).
  //   ⚠️⚠️ `describe()` only uses the public key, so **mismatched pairs** passed.
  //      Only the handshake failed, so it wasn't recognized as a "broken key" and no recreate button appeared.
  //   ⚠️ The private key can't be exported (`extractable:false`), so check via ECDH commutativity.
  if (!(await matchesKeyPair(pair))) {
    return { kind: 'broken', reason: t('公開鍵と秘密鍵が対応していません', 'The public and private keys do not match') }
  }
  try {
    return await describe(pair)
  } catch (err) {
    return { kind: 'broken', reason: t(`保存されている鍵を使えません（${errText(err)}）`, `Cannot use the saved key (${errText(err)})`) }
  }
}

/**
 * Discard the key and recreate it (★ **only when a human presses it**).
 *
 * ⚠️⚠️ This makes you **someone else to registered peers** (registrations on the agent side die).
 *    ⇒ The screen must say "pairing is needed again" and "old registrations can be removed on the PC".
 */
export async function resetIdentity(store: KeyStore): Promise<Identity> {
  try {
    await store.del(IDENTITY_ID)
  } catch (err) {
    return { kind: 'unavailable', reason: t(`古い鍵を消せません（${errText(err)}）`, `Cannot delete the old key (${errText(err)})`) }
  }
  return await loadIdentity(store)
}

async function describe(pair: KeyPair): Promise<Identity> {
  const raw = await exportPublicKey(pair.publicKey)
  return {
    kind: 'ok',
    pair,
    deviceId: await fingerprint(raw),
    publicKey: toBase64Url(raw),
  }
}

/**
 * ⚠️ Shape checks happen **once at the entrance**. Only **what `matchesKeyPair` can't see** is checked here.
 *
 * ⚠️⚠️ **Private keys with `extractable` true are rejected** (`generateDeviceKey()` is always false, so
 *    true means **a key made by another path** = an exfiltratable key. Don't keep using it).
 *    ★ `matchesKeyPair` can't tell this (a correct pair would pass), so **it's needed here**.
 *
 * ⚠️⚠️ **No checks on algorithm, `type` or `usages`** (2026-09-08; **mutations slipped past**).
 *    Shape-only values like ECDSA, P-384, or `{ type:'private', extractable:false }`
 *    are all rejected by `deriveBits` in `matchesKeyPair` = **unreachable checks**.
 *    ⚠️⚠️ Made the same mistake **4 times** on 2026-09-07–08 (two on the agent side, the branch in `Pairing.tsx`, and here).
 *    ⇒ Decide by **whether it's reachable**, not "for safety" (VERIFY "my mistake patterns").
 */
function asKeyPair(v: unknown): KeyPair | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as { publicKey?: unknown; privateKey?: unknown }
  if (!o.publicKey || !o.privateKey) return undefined
  const priv = o.privateKey as { extractable?: unknown }
  if (priv.extractable !== false) return undefined
  return { publicKey: o.publicKey, privateKey: o.privateKey } as KeyPair
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The IndexedDB implementation. ⚠️ **No decisions here** (the functions above decide everything).
 *
 * ⚠️ In private mode or with "clear site data" settings it may not open
 *    (`loadIdentity` returns `unavailable`).
 */
export function idbKeyStore(factory?: IDBFactory): KeyStore {
  // ★ Swappable **for tests** (default is the real one). ⚠️ No decisions here.
  //   ⚠️⚠️ Without this, the mutation "treat abort as success" can't be hit
  //      (Node has no IndexedDB = the slip-past mutation codex named / 2026-09-08).
  const idb = (): IDBFactory => factory ?? indexedDB
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = idb().open(IDENTITY_DB, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(IDENTITY_STORE)) db.createObjectStore(IDENTITY_STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error(t('IndexedDB を開けません', 'Cannot open IndexedDB')))
      req.onblocked = () => reject(new Error(t('IndexedDB が別のタブに掴まれています', 'IndexedDB is held by another tab')))
    })

  /**
   * Run one transaction.
   *
   * ★★ **`request.onsuccess` isn't "committed"** (codex medium #2, 2026-09-08).
   *   ⚠️⚠️ It resolved there, so **even if it aborted afterwards it counted as "saved"**
   *      and proceeded with the in-memory key (= the key vanished right after registering, leaving a dead registration on the agent).
   *   ⇒ **Resolve on `tx.oncomplete`, reject on `tx.onabort` / `tx.onerror`**.
   *      The request's result is **only held**.
   *   ⚠️ The connection is closed **on both success and failure**.
   */
  const run = <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore, keep: (v: unknown) => void) => void,
  ): Promise<T> =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          let held: unknown
          let tx: IDBTransaction
          try {
            tx = db.transaction(IDENTITY_STORE, mode)
          } catch (err) {
            db.close()
            reject(err instanceof Error ? err : new Error(String(err)))
            return
          }
          // ★ Success only on commit (reads use the same shape)
          tx.oncomplete = () => {
            db.close()
            resolve(held as T)
          }
          tx.onabort = () => {
            db.close()
            reject(tx.error ?? new Error(t('IndexedDB の書き込みが取り消されました', 'The IndexedDB write was aborted')))
          }
          tx.onerror = () => {
            db.close()
            reject(tx.error ?? new Error(t('IndexedDB の操作に失敗しました', 'The IndexedDB operation failed')))
          }
          try {
            fn(tx.objectStore(IDENTITY_STORE), (v) => void (held = v))
          } catch (err) {
            // ⚠️ Even if this throws, `onabort` comes, so leave the reject to it
            try {
              tx.abort()
            } catch {
              // Already finished
            }
            void err
          }
        }),
    )

  const request = (req: IDBRequest, keep: (v: unknown) => void): void => {
    req.onsuccess = () => keep(req.result)
  }

  return {
    get: (id) => run('readonly', (s, keep) => request(s.get(id), keep)),

    /**
     * ★★ **Insert if absent and return the settled value** (one transaction = first one wins).
     *
     * ⚠️ Key generation is **done by the caller beforehand** (an `await` in between auto-closes the IndexedDB
     *    transaction, so don't generate inside this).
     */
    getOrPut: (id, candidate) =>
      run('readwrite', (s, keep) => {
        const got = s.get(id)
        got.onsuccess = () => {
          if (got.result !== undefined) {
            keep(got.result)
            return
          }
          const put = s.put(candidate, id)
          put.onsuccess = () => keep(candidate)
        }
      }),

    del: (id) => run<void>('readwrite', (s, keep) => request(s.delete(id), keep)),
  }
}
