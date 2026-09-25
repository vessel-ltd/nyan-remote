// Output of `npm run pair`.
//
// ⚠️ **Split out of `scripts/pair.mjs`** so it can be tested
//    (same reason as `timeBound.mjs` / VERIFY "the kinds of mistakes I make").
//
// ★★ Only **pure assembly** lives here (no QR generation, no queries to the agent).

import { currentLang, t } from '../../shared/i18n.ts'

// ★★ **We draw the QR ourselves** (2026-09-19 / `shared/qr.ts`).
//   ⚠️⚠️ It used to call `qrencode` and, if missing, said "`sudo apt install qrencode`", but
//      **that directly contradicted the 2026-09-16 user decision (= never make users run apt)**, and
//      it kept saying so on real machines (pointed out on 2026-09-19). ⇒ The external command was **removed**.
//   ⚠️ No third-party dependency was added either (`shared/qr.ts` is our own implementation, not even using WebCrypto).

/**
 * Turn the remaining time into "N min left".
 *
 * ⚠️⚠️ **Never round up** (if it says "5 min left" but only 4:30 remains,
 *    people think "still time" and do not reissue the QR). ⇒ **Round down**.
 * ⚠️ Past deadlines give `0` (no negative numbers). An unreadable time gives `undefined`
 *    (**never silently 0** — 0 means "expired", so it would be a lie).
 */
export function minutesLeft(expiresAt, now = Date.now()) {
  const ms = Date.parse(expiresAt)
  if (!Number.isFinite(ms)) return undefined
  return Math.max(0, Math.floor((ms - now) / 60000))
}

/**
 * Build the string printed to the terminal.
 *
 * @param p.url        the string put in the QR (`nyan://pair?...`)
 * @param p.expiresAt  ISO8601
 * @param p.machine    machine name
 * @param p.qr         the QR drawn for the terminal (`shared/qr.ts`; `undefined` if it could not be drawn)
 * @param p.now        now (for tests)
 *
 * ⚠️⚠️ **Always print "usable steps" even without a QR** (the URL and the one-time token).
 *    Giving up here would make **pairing itself impossible** when it is too long for a QR.
 * ⚠️ **The one-time token appears only inside the URL** (printing it in two places means that after removing one,
 *    it "looks hidden but is still there". The QR is a paper anyone can read, so it is treated the same).
 */
export function renderPair(p) {
  const left = minutesLeft(p.expiresAt, p.now)
  const out = []
  out.push(t(`ペアリング（${p.machine}）`, `Pairing (${p.machine})`))
  out.push('')
  // ★ If a lost key was regenerated, ask previously registered phones to rescan too (⚠️ print it before the QR = the QR comes last)
  if (p.keyRecreated) {
    out.push(recreatedText(p.keyRecreated))
    out.push('')
  }
  if (!p.qr && p.imageNote) {
    // ★ When opening as an image (not drawn in the terminal. ⚠️ do not say "could not draw" = it would be a lie)
    out.push(`★ ${p.imageNote}`)
    out.push('')
  } else if (!p.qr) {
    // ⚠️ The QR can only fail when "too long to fit" (the version limit in `shared/qr.ts`).
    //    ⇒ **Print that reason** (do not silently print only the URL). ⚠️ Always keep the paste option.
    out.push(t('⚠️ QR を描けませんでした（下の文字列を貼り付けてください）', '⚠️ Could not draw the QR code (paste the text below instead)'))
    out.push('')
  }
  out.push(p.url)
  out.push('')
  out.push(
    left === undefined
      ? t('⚠️ 期限が読めません（agent の応答がおかしい）', '⚠️ Cannot read the expiry (unexpected response from the agent)')
      : left === 0
        ? t('⚠️ もう切れています（もう一度実行してください）', '⚠️ Already expired (run it again)')
        : t(`有効期限: あと ${left} 分（1回だけ使えます）`, `Expires in ${left} min (single use)`),
  )
  // ★★★ **The QR goes last** (codex round 15, low #5). ⚠️ If guidance follows it, even on a terminal it fits,
  //    **the top of the QR scrolls off the screen**. At most `QR_TRAILING_LINES` lines may follow (qrMode.mjs).
  if (p.qr) {
    out.push('')
    out.push(p.qr.replace(/\n+$/, ''))
    out.push(t('★ スマホのカメラで読んでください', '★ Scan it with the phone camera'))
  }
  return out.join('\n')
}

/**
 * ★★★ Say that a lost key was regenerated (2026-09-24 / `recreated` in `agent/src/deviceKey.ts`).
 * ⚠️ Include the fix (rescan the QR, remove the old endpoint). ⚠️⚠️ **Never suggest revoking (`--revoke`)**
 *    (if only the key file was lost, the phone's registration is still alive with the same device key = revoking makes it unable to connect even after rescanning).
 * @param r `{ at, registered }` (`registered` is `null` when it could not be counted)
 */
export function recreatedText(r) {
  const when = (() => {
    const d = new Date(r.at)
    return Number.isNaN(d.getTime()) ? r.at : d.toLocaleString(currentLang() === 'en' ? 'en-US' : 'ja-JP')
  })()
  const n = r.registered
  const who =
    typeof n === 'number'
      ? t(`その時に登録されていた ${n} 台`, `The ${n} phone(s) registered at that time`)
      : t('それより前に登録したスマホ', 'Phones registered before then')
  return [
    t(`⚠️⚠️ このマシンの鍵は ${when} に作り直されました（鍵のファイルを失っていたため）。`,
      `⚠️⚠️ This machine's key was recreated at ${when} (the key file had been lost).`),
    t(`   ${who}は、この QR を読み直すまで繋がりません（nyan pair）。`,
      `   ${who} cannot connect until they scan a new QR (nyan pair).`),
    t('   読み直したら、スマホの「⚙ 設定」の接続先に残る古い同じ名前の接続先（応答なし）は消してかまいません。',
      '   After rescanning, you can delete the old connection with the same name (no response) under "⚙ Settings" → "Connections" on the phone.'),
  ].join('\n')
}

/**
 * ★★ Wait a little until it connects (right after `systemctl restart` it **is not bound yet**).
 *
 * ⚠️⚠️ Hit for real on 2026-09-08: the instructions had
 *   **`npm run pair` on the line after** `… && systemctl --user restart nyan-remote`,
 *   so it was called right after restart returned and got `fetch failed` (the agent was fine).
 *   ⇒ **Absorb it in the tool** (do not make users remember "wait a bit" / the approach of CLAUDE.md §3).
 *
 * ⚠️ Failures **other than** "cannot connect" (403, 503, etc.) **return immediately** (waiting will not fix them).
 * ⚠️ Has an upper bound (never waits forever). ⚠️ Returns the number of waits to the caller (never slows down silently).
 *
 * @param attempt one attempt. Returns a response with `{ ok }`, or throws when it cannot connect
 */
export async function connectWithRetry(attempt, opts = {}) {
  const tries = opts.tries ?? 6
  const waitMs = opts.waitMs ?? 500
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return { res: await attempt(), waited: i }
    } catch (err) {
      last = err
      if (i < tries - 1) await sleep(waitMs)
    }
  }
  throw last
}
