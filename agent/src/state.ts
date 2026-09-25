// State files under ~/.nyan-remote/.
//
// ⚠️ /tmp is wiped on reboot (loss confirmed in practice), so state lives here.
// ⚠️ Always write via temp file → rename, so as not to repeat the accident that broke .claude.json.

import { t } from '../../shared/i18n.ts'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'

export function stateDir(): string {
  return process.env.NYAN_REMOTE_STATE_DIR ?? join(homedir(), '.nyan-remote')
}

export function statePath(name: string): string {
  return join(stateDir(), name)
}

/* LEGACY-NAMES-BEGIN ⚠️ old names are written here on purpose (to detect migration; excluded from the watcher) */
/** ⚠️ Names before the rename (used until stage 2+3 on 2026-09-19) */
const LEGACY_DIR = '.tmux-agent'
const LEGACY_ENV = 'TMUX_AGENT_STATE_DIR'
/* LEGACY-NAMES-END */

/**
 * ★★ **Report a leftover from the rename by refusing to start** (2026-09-19 / as specified in CLAUDE.md §0).
 *
 * ⚠️⚠️ Without this, on a machine with the old state directory the agent **creates a new empty directory**.
 *    What follows "looks like it works but cannot be recovered":
 *      - recreating `vapid.json` = **every existing subscription dies (unrecoverable)**
 *      - recreating `device-key.json` = **no registered device can connect** (the QR is remade too)
 *      - recreating `hook-token` = mismatch with the installed hooks' Bearer, **approvals completely lost**
 *    ⇒ **Do not create it silently. Refuse to start and have a person `mv` it.**
 *
 * ★ The fix is **moving**, not recreating (the contents can be used as is).
 * ⚠️ Environment variables are checked too (installed shims / hooks passing the old name = a sign the hooks need reinstalling).
 */
export async function legacyStateProblem(): Promise<string | undefined> {
  // ⚠️ an old environment variable arrived = what is installed is old (⇒ it will not mesh until reinstalled)
  if (process.env[LEGACY_ENV] !== undefined && process.env['NYAN_REMOTE_STATE_DIR'] === undefined) {
    return t(
      `古い環境変数 ${LEGACY_ENV} が渡されています（いまは NYAN_REMOTE_STATE_DIR）。` +
        'フックと shim を再設置してください: node scripts/install-permission-hook.mjs / node scripts/install-relay.mjs',
      `The old environment variable ${LEGACY_ENV} is set (it is now NYAN_REMOTE_STATE_DIR). ` +
        'Reinstall the hooks and the shim: node scripts/install-permission-hook.mjs / node scripts/install-relay.mjs',
    )
  }
  const legacy = join(homedir(), LEGACY_DIR)
  const now = stateDir()
  // ⚠️⚠️ **Check even an explicitly given location** (2026-09-19 / codex round 10, medium #2).
  //    It used to pass unconditionally whenever `NYAN_REMOTE_STATE_DIR` was set, so
  //    **explicitly naming the same destination as the default bypassed the guard**.
  //    ★ It only does not matter when "you decided to use another place" ⇒ **only skip when the destination differs**.
  if (now !== legacy && process.env['NYAN_REMOTE_STATE_DIR'] !== undefined && now !== defaultDir()) {
    return undefined
  }
  const [oldOk, newOk] = await Promise.all([hasState(legacy), hasState(now)])
  if (oldOk && !newOk) {
    return t(
      `古い状態ディレクトリ ${legacy} が残っていて、新しい ${now} がありません。` +
        `⚠️ 作り直すと購読とペアリングが復旧不能に失われます。**移動**してください: mv ${legacy} ${now}`,
      `The old state directory ${legacy} still exists and the new ${now} does not. ` +
        `⚠️ Recreating it would lose subscriptions and pairings for good. **Move** it: mv ${legacy} ${now}`,
    )
  }
  return undefined
}

function defaultDir(): string {
  return join(homedir(), '.nyan-remote')
}

/**
 * ★★ **Check "whether there is content", not whether the directory exists** (codex round 10, medium #2).
 *
 * ⚠️⚠️ It used to be just `lstat(dir)`, so **as soon as `install-relay.mjs` created `~/.nyan-remote/bin/`
 *    it was judged "migrated"** (= doing the steps in the wrong order silently slips through).
 *    ⇒ Check **whether `config.json` exists** (the state itself, created first by the agent).
 * ⚠️ `lstat` (does not follow links) = a link whose target is gone also counts as "exists"
 *    (do not turn `ENOENT` into "absent" / CLAUDE.md §2).
 */
async function hasState(dir: string): Promise<boolean> {
  try {
    await lstat(join(dir, FILE_MARK))
    return true
  } catch {
    return false
  }
}

/** ⚠️ The state file the agent creates first (= the marker that "this is the state directory") */
const FILE_MARK = 'config.json'

/**
 * Result of reading a state file.
 *
 * ★★ **Distinguish "absent" from "broken".** (2026-08-13 external review finding = fail-open)
 *
 * Previously `readJson(name, fallback)` returned **the fallback for both**. That is quietly dangerous:
 *
 *   - `config.json` breaks → `allowedLogins: []`, mistaken for "first start" →
 *     **records and pins the next login that arrives** (= pairing silently reopens).
 *     It also recreates `hookToken`, so the installed permission hooks' Bearer no longer matches
 *   - `vapid.json` breaks → the key is recreated and **overwritten** → every existing subscription dies (unrecoverable)
 *   - `subscriptions.json` breaks → overwritten as empty → subscriptions disappear
 *
 * This project has actually experienced config file corruption twice (`.claude.json` 167KB → 309B).
 * **"Could not read" is not "was absent".** Let the caller decide.
 */
/**
 * ⚠️⚠️ Why `reason` and `detail` are separate (2026-08-14 review, high):
 *
 *   `reason` … **only a classification that may go outside**. The broken-config 503 is returned **before authentication**,
 *              so mixing absolute paths or contents in here **shows them to parties we have not allowed**.
 *   `detail` … for logs. Holds things like `EACCES: … open '/home/<someone>/.nyan-remote/config.json'`, or
 *              **the first 10 characters of the file** included in V8's JSON errors.
 *
 * ★ Once these two were mixed, and although I thought I had removed only `${p.path}`, **the same information leaked via `reason`**.
 */
export type JsonFile<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  | { kind: 'broken'; reason: string; detail: string }

/**
 * Reads a state file.
 *
 * ⚠️ Never go back to returning a fallback here (fail-open). As explained above,
 *    mistaking a broken file for "first start" recreates authentication and keys.
 * ⚠️ Content that is not an object (array, number, `null`, empty file) is treated as broken too,
 *    to prevent silently becoming the defaults via something like `{...DEFAULTS, ...[]}`.
 */
export async function readJsonFile<T>(name: string): Promise<JsonFile<T>> {
  const path = statePath(name)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    // absence is normal (first start). Anything else (permissions, directory, I/O) is treated as broken
    //
    // ★★ But **`ENOENT` does not always mean "nothing is there"** (2026-09-08 codex round 2, medium #1).
    //   ⚠️⚠️ `readFile` returns `ENOENT` for **a symlink whose target is gone** too.
    //      Treating that as "first start" made `deviceKey.ts` **recreate the key and replace the link
    //      itself with a regular file via `rename`** (reproduced by measurement ⇒ no registered device
    //      could connect, and the link vanished too = even the clue for recovery was lost).
    //   ⇒ **If the link itself exists, it is "broken"** (= do not write, do not create).
    //   ★ `lstat` does not follow links, so this is the only place to tell them apart.
    if ((err as { code?: string }).code === 'ENOENT') {
      if (await danglingLink(path)) {
        return {
          kind: 'broken',
          reason: 'リンク先が見つかりません',
          detail: t(`${path} はシンボリックリンクですが宛先が読めません`, `${path} is a symlink whose target cannot be read`),
        }
      }
      return { kind: 'missing' }
    }
    // ⚠️ do not put the raw error in `reason` (EACCES contains the absolute home path)
    return { kind: 'broken', reason: '読み取りに失敗しました', detail: errText(err) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // ⚠️ V8's JSON errors contain **the first 10 characters of the file verbatim**. Never send them out
    return { kind: 'broken', reason: 'JSON として読めません', detail: errText(err) }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'broken', reason: 'JSON オブジェクトではありません', detail: t('型: ', 'type: ') + (Array.isArray(parsed) ? 'array' : typeof parsed) }
  }
  return { kind: 'ok', value: parsed as T }
}

/**
 * ★ Whether "a symlink with no target" exists at that path.
 *
 * ⚠️ `lstat` does not follow links, so it tells **whether the link itself exists**.
 * ⚠️ Do not throw here (if `lstat` also fails, treat it as "absent" = first start as before).
 */
async function danglingLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Atomic write via temp file → rename. Mode 600 by default (subscription records and keys go here). */
export async function writeJson(name: string, value: unknown, mode = 0o600): Promise<void> {
  const path = statePath(name)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  // ★ rename alone does not survive power loss (metadata may be persisted first, leaving zero-filled contents).
  //   ⚠️ fsync **so that we never create the very "empty config.json" this feature deals with**
  //      (2026-08-14 review, low).
  const fh = await open(tmp, 'w', mode)
  try {
    await fh.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, path)
}

/** Append-only log (hook records etc.). Failures do not stop the process. */
export async function appendJsonl(name: string, value: unknown): Promise<void> {
  try {
    const path = statePath(name)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(value)}\n`, { flag: 'a', mode: 0o600 })
  } catch {
    // failing to record does not stop the main work
  }
}
