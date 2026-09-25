#!/usr/bin/env node
// ★★ List and revoke the devices registered on this machine, **from this machine** (2026-09-21).
//
// ★ Why it is needed (we got stuck in practice): `/devices` and `/devices/revoke` could only be called
//   from **a registered phone**, so **if the phone was revoked, lost, or had its site data cleared,
//   there was no way at all to clean up** (two dead registrations from two days earlier stayed on machine B).
//   ⚠️ It matters for distribution too: otherwise **a user who loses their phone has no way to recover**.
//
// ⚠️ No new privilege: anyone who can read `~/.nyan-remote/hook-token` (0600) **can already inject fake approvals
//    and events**, so listing and revoking registrations is weaker than that (`isLocalAlsoPath` in `auth.ts`).
//
// Usage:
//   nyan devices                      list (same as npm run devices)
//   nyan devices --revoke <prefix>    revoke (id or key prefix; only when it narrows to one)
//   nyan devices --revoke all      revoke all (⚠️ every phone gets disconnected)

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connectWithRetry, recreatedText } from './lib/pairPrint.mjs'
import { hints, serviceKind } from './lib/service.mjs'
import { t } from '../shared/i18n.ts'
import { initCliLang, agentUrl } from './lib/lang.mjs'

// ★ Language first (before any message is built)
initCliLang()

// ★ Instructions matching the service type (⚠️ never suggest systemctl on mac / 2026-09-23)
const svc = hints(serviceKind(process.platform, homedir()))

const stateDir = process.env.NYAN_REMOTE_STATE_DIR ?? join(homedir(), '.nyan-remote')

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

const port = Number(process.env.NYAN_REMOTE_PORT ?? readConfig().port ?? 7777)

let token
try {
  token = readFileSync(join(stateDir, 'hook-token'), 'utf8').trim()
} catch (err) {
  console.error(t(`✗ ${join(stateDir, 'hook-token')} が読めません: ${err.message}`, `✗ Cannot read ${join(stateDir, 'hook-token')}: ${err.message}`))
  // ⚠️ Never print **instructions that cannot run** (mac has no systemctl) ⇒ the wording lives in one place, service.mjs
  console.error(t(`  agent を一度起動すると作られます（${svc.start}）`, `  It is created when the agent starts once (${svc.start})`))
  process.exit(1)
}
if (!token) {
  console.error(t('✗ hook-token が空です（agent を再起動してください）', '✗ hook-token is empty (restart the agent)'))
  process.exit(1)
}

const headers = { 'x-nyan-remote-token': token }

async function call(path, init) {
  // ⚠️ `connectWithRetry` returns **{ res, waited }** (not the response itself)
  const { res } = await connectWithRetry(() =>
    fetch(agentUrl(port, path), { ...init, headers: { ...headers, ...init?.headers } }),
  )
  const text = await res.text()
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

const args = process.argv.slice(2)
const at = args.indexOf('--revoke')
const want = at >= 0 ? args[at + 1] : undefined

let list
try {
  list = await call('/devices')
} catch (err) {
  console.error(t(`✗ agent に繋がりません: ${err.message}`, `✗ Cannot reach the agent: ${err.message}`))
  console.error(t(`  起動しているか: ${svc.status}`, `  Is it running? ${svc.status}`))
  process.exit(1)
}

// ⚠️⚠️ **Distinguish "0 devices" from "corrupted, so everything is refused"** (the fixes differ / §14.1.2.15)
if (list.broken) {
  console.error(t(`⚠️⚠️ 登録の記録が壊れています: ${list.broken}`, `⚠️⚠️ The device registry is corrupted: ${list.broken}`))
  console.error(
    t(
      '  ⚠️ この状態ではデバイス鍵の接続を全部 断っています（書き込みもしません）',
      '  ⚠️ While it is in this state, all device-key connections are refused (and nothing is written)',
    ),
  )
  process.exit(1)
}
if (list.keyProblem) {
  console.error(t(`⚠️ agent の鍵に問題があります: ${list.keyProblem}`, `⚠️ Problem with the agent's key: ${list.keyProblem}`))
}
// ★★★ Say so if a lost key was regenerated (2026-09-24 / `recreated` in `deviceKey.ts`)
if (list.keyRecreated) console.error(recreatedText(list.keyRecreated))

const devices = list.devices ?? []

function show() {
  if (devices.length === 0) {
    console.log(t('登録されている端末はありません（`nyan pair` で登録します）', 'No phones are registered (register one with `nyan pair`)'))
    return
  }
  console.log(t(`登録されている端末: ${devices.length} 台\n`, `Registered phones: ${devices.length}\n`))
  for (const d of devices) {
    console.log(`  ${d.deviceId}`)
    console.log(
      t(
        `    名前: ${d.label || '(名前なし)'}   登録: ${d.addedAt}`,
        `    Name: ${d.label || '(no name)'}   Added: ${d.addedAt}`,
      ),
    )
  }
  console.log(t('\n失効: nyan devices --revoke <id の先頭>', '\nRevoke: nyan devices --revoke <id prefix>'))
}

if (at < 0) {
  show()
  process.exit(0)
}

if (want === undefined || want === '') {
  console.error(t('✗ --revoke には id の先頭か all を渡します', '✗ --revoke takes an id prefix or all'))
  show()
  process.exit(1)
}

// ⚠️ **Revoke only when it narrows to one** (if a prefix matches several, you cannot tell which was removed)
const targets =
  want === 'all' ? devices : devices.filter((d) => d.deviceId.startsWith(want) || d.key.startsWith(want))
if (targets.length === 0) {
  console.error(t(`✗ ${want} に当たる端末がありません`, `✗ No phone matches ${want}`))
  show()
  process.exit(1)
}
if (want !== 'all' && targets.length > 1) {
  console.error(
    t(
      `✗ ${want} が ${targets.length} 台に当たります（もっと長く指定してください）`,
      `✗ ${want} matches ${targets.length} phones (give a longer prefix)`,
    ),
  )
  for (const d of targets) console.error(`  ${d.deviceId}  ${d.label}`)
  process.exit(1)
}

let failed = 0
for (const d of targets) {
  const res = await call('/devices/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: d.key }),
  })
  if (res.ok) {
    console.log(t(`✔ 失効: ${d.deviceId}  ${d.label || '(名前なし)'}`, `✔ Revoked: ${d.deviceId}  ${d.label || '(no name)'}`))
  } else {
    // ⚠️ **Never silently treat `saved:false` as success** (dropped from memory, but it comes back on restart)
    failed++
    console.error(t(`✗ 失効できませんでした: ${d.deviceId}  ${res.reason ?? ''}`, `✗ Could not revoke: ${d.deviceId}  ${res.reason ?? ''}`))
    if (res.saved === false) {
      console.error(
        t(
          '  ⚠️⚠️ 保存できていません ＝ **agent を再起動すると復活します**',
          '  ⚠️⚠️ Not saved = **it comes back when the agent restarts**',
        ),
      )
    }
  }
}
if (failed > 0) process.exit(1)
console.log(
  t(
    '\n⚠️ その端末は次の要求から繋がりません（もう一度使うには再ペアリング）',
    '\n⚠️ That phone is refused from its next request (pair it again to use it)',
  ),
)
