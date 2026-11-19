// ★★ "Only this user can change this directory or what leads to it" — the check behind the team socket
//    (`teamSocket.ts` before listening, `scripts/team.mjs` before connecting / codex review r1 medium #5, r2 high #2,
//    r3 high #5).
//
// ⚠️ A private leaf is not enough: if any directory on the way can be changed by another user, they can swap the leaf
//    (or a link on the way) between our check and our connect, and the CLI would talk to their socket.
// ⇒ Resolve the path **once**, then walk **that exact string** from the root down with `lstat`: no component may be a
//    link; every directory above the leaf is owned by us or root and not writable by group/others unless sticky
//    (`/tmp`: then nobody else can rename what is ours); the leaf is ours and closed to group and others.
//    The caller binds and connects with **the returned string** — the one that was walked.
// ★ The same rule as the uploads folder (`uploads.ts` `ensureDir`). Synchronous so the CLI can use it as is.

import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'

/**
 * ★ macOS ACLs (codex review r8 high #1, r9 high #1, r10 high #1): an `allow` entry can let another user change a
 *   directory whose mode looks private. Read with `ls -lde` (C locale) and judged **strictly**:
 *   - any output on stderr, or a failed run ⇒ unreadable ⇒ a problem (absence and failure are told apart this way)
 *   - every ACL entry line must be a `deny` entry (the principal's spelling never matters); any `allow`, or any line
 *     after the first that is not an entry, is a problem (macOS homes carry only `group:everyone deny delete`)
 *   - a `+` after the mode with no entry printed ⇒ unreadable. ⚠️ The suffix is not trusted otherwise: `@` (extended
 *     attributes) hides the `+` of an ACL, so the entry lines decide
 *   ⚠️ Linux: POSIX ACLs are bounded by the mask (the group bits), so the mode check already covers them.
 * @returns a reason, or undefined
 */
export function macAclProblem(path: string, run: (p: string) => { stdout: string; stderr: string } | undefined = lsAcl): string | undefined {
  const r = run(path)
  if (!r || r.stderr.trim() !== '') return `cannot read the ACL of ${path}`
  const [first = '', ...rest] = r.stdout.split('\n')
  const mode = first.split(/\s+/)[0] ?? ''
  if (mode.length < 10) return `cannot read the ACL of ${path}`
  const entries = rest.filter((l) => l.trim() !== '')
  if (mode.endsWith('+') && entries.length === 0) return `cannot read the ACL of ${path}`
  for (const line of entries) {
    if (!/^\s*\d+:\s/.test(line) || /\ballow\b/.test(line) || !/\bdeny\b/.test(line)) return `an ACL entry may let someone else change ${path}`
  }
  return undefined
}

function lsAcl(path: string): { stdout: string; stderr: string } | undefined {
  const r = spawnSync('/bin/ls', ['-lde', path], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  if (r.error || r.status !== 0) return undefined
  return { stdout: r.stdout, stderr: r.stderr }
}

/** Walk an absolute, link-free path from the root; a reason it is not private, or undefined */
export function walkPrivate(
  path: string,
  uid: number | undefined = process.getuid?.(),
  lstat = lstatSync,
  /** `private`: the leaf closed to group and others (the socket's directory); `ours`: ours and not writable by them (a home) */
  leafRule: 'private' | 'ours' = 'private',
  /** ACL check per component (macOS only by default) */
  acl: ((p: string) => string | undefined) | undefined = process.platform === 'darwin' ? (p) => macAclProblem(p) : undefined,
): string | undefined {
  if (!isAbsolute(path)) return 'not an absolute path'
  const parts = path.split(sep).filter(Boolean)
  let at: string = sep
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) at = at === sep ? `${sep}${parts[i - 1]}` : `${at}${sep}${parts[i - 1]}`
    let st
    try {
      st = lstat(at)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    if (st.isSymbolicLink()) return `a link on the way (${at})`
    if (!st.isDirectory()) return `not a directory (${at})`
    const aclBad = acl?.(at)
    if (aclBad) return aclBad
    const leaf = i === parts.length
    if (leaf) {
      if (uid !== undefined && st.uid !== uid) return 'not owned by this user'
      if ((st.mode & (leafRule === 'private' ? 0o077 : 0o022)) !== 0) return 'open to other users'
    } else {
      const owner = uid === undefined || st.uid === uid || st.uid === 0
      const othersWrite = (st.mode & 0o022) !== 0
      const sticky = (st.mode & 0o1000) !== 0
      if (!owner || (othersWrite && !sticky)) return `an ancestor (${at}) can be changed by someone else`
    }
  }
  return undefined
}

/**
 * ★★ The directory's real path, walked and found private: bind and connect **with this string** (never the path as
 *    given — a link on the way could be replaced after the check).
 */
export function privateDirReal(dir: string, uid: number | undefined = process.getuid?.()): { ok: true; real: string } | { ok: false; problem: string } {
  let real: string
  try {
    real = realpathSync(dir)
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) }
  }
  const problem = walkPrivate(real, uid)
  return problem ? { ok: false, problem } : { ok: true, real }
}

/** A reason the directory is not private, or undefined (`privateDirReal` without the path) */
export function privateDirProblem(dir: string, uid: number | undefined = process.getuid?.()): string | undefined {
  const r = privateDirReal(dir, uid)
  return r.ok ? undefined : r.problem
}
