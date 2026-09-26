#!/usr/bin/env node
// ★ Build the landing, pricing and legal pages (2026-09-24 / item 6 of docs/BILLING.md §5). `node landing/build.mjs` ⇒ `landing/public/`
//   ★★ **The site is English only** (2026-09-25 / user decision: show no trace of Japanese to foreign users).
//   ⚠️ The only exception is **the Japanese version of the Specified Commercial Transactions Act notice**, `/ja/legal/law/` (Japanese consumers need it in Japanese).
//      It is linked only from the English notice page (nowhere else).
// ⚠️ Pages that hold no secrets (a different origin from the PWA = apex / CLAUDE.md §1). ⚠️ No scripts.
// ⚠️ Prices and limits are built from `PLAN_LIMITS` in `shared/license.ts` (never copied by hand).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLAN_LIMITS } from '../shared/license.ts'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'public')

/** ★ Business information (for the Specified Commercial Transactions Act notice / same wording as the operator's other sites) */
const COMPANY = {
  ja: { name: 'Vessel合同会社', manager: '大澤 広輔', address: '〒142-0062 東京都品川区小山5-3-10' },
  en: { name: 'Vessel Ltd.', manager: 'Kosuke Osawa', address: '5-3-10 Koyama, Shinagawa-ku, Tokyo 142-0062, Japan' },
}
const UPDATED = '2026-09-25'
const APP = 'https://app.nyan-remote.app'
const ACCOUNT = 'https://account.nyan-remote.app'
const REPO = 'https://github.com/vessel-ltd/nyan-remote'
/**
 * ★ Contacting the operator (2026-09-25 / user decision: avoid spam).
 *   - paying or signed-in users ⇒ the form on the account page (`SUPPORT_FORM`)
 *   - the email address appears **only in the legal notice** (required by law / forwarded to the operator's mailbox via Email Routing)
 */
const SUPPORT = 'support@nyan-remote.app'
const SUPPORT_FORM = `${ACCOUNT}/#support`
const FREE = PLAN_LIMITS.free
const PLUS = PLAN_LIMITS.plus

const SITE = 'https://nyan-remote.app'

/**
 * ★ Link previews (X, Slack, LINE, Discord …). The image is the same as the GitHub social preview
 *   (`landing/public/og.png`, 1280×640 — made from `docs/brand/social-preview.html`). ⚠️ Absolute URLs only.
 */
function ogTags(url, title, description, lang) {
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="nyan-remote">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:image" content="${SITE}/og.png">`,
    `<meta property="og:image:width" content="1280">`,
    `<meta property="og:image:height" content="640">`,
    `<meta property="og:image:alt" content="nyan-remote — Claude Code sessions on your phone">`,
    `<meta property="og:locale" content="${lang === 'ja' ? 'ja_JP' : 'en_US'}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join('\n')
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function page(lang, path, title, body) {
  const t = (ja, en) => (lang === 'ja' ? ja : en)
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(t('いつもの claude のまま、全部のマシンと全部のアカウントの Claude Code を、ねこと一緒にスマホで。', 'Your Claude Code sessions on every machine and every account, on your phone — keep starting claude as usual.'))}">
${ogTags(`${SITE}${path}`, title, t('いつもの claude のまま、全部のマシンと全部のアカウントの Claude Code を、ねこと一緒にスマホで。', 'Your Claude Code sessions on every machine and every account, on your phone — keep starting claude as usual.'), lang)}
<link rel="icon" href="/favicon.png"><link rel="stylesheet" href="/style.css">
</head><body>
<header class="top"><a href="/"><img src="/icon.png" alt=""></a><a class="grow" href="/"><strong>nyan-remote</strong></a><a class="navlink" href="${REPO}">GitHub</a><a class="btn ghost" href="${ACCOUNT}">Account</a></header>
<main>${body}</main>
<footer>
<a href="/legal/terms/">Terms</a> ·
<a href="/legal/privacy/">Privacy</a> ·
<a href="/legal/law/">Legal notice</a> ·
<a href="${REPO}">GitHub</a> ·
<a href="${SUPPORT_FORM}">Support</a><br>© 2026 ${esc(COMPANY.en.name)}
</footer></body></html>
`
}

function home(lang) {
  const t = (ja, en) => (lang === 'ja' ? ja : en)
  return page(
    lang,
    lang === 'ja' ? '/ja/' : '/',
    t('nyan-remote — Claude Code をスマホで', 'nyan-remote — Claude Code on your phone'),
    `<section class="hero">
<div class="text">
<h1>${t('いつもの claude のまま、<br>スマホから。', 'Keep running claude.<br>Use it from your phone.')}</h1>
<p class="lead">${t('もう始めてあるセッションを、全部のアカウント・全部のマシンから、1つの画面に。', 'The sessions you already started, from every account and every machine, in one place.')}</p>
<p class="chips"><span>${t('tmux なし', 'No tmux')}</span><span>${t('SSH なし', 'No SSH')}</span><span>${t('起動し直しなし', 'No relaunching')}</span></p>
<p><a class="btn" href="#install">${t('はじめる', 'Get started')}</a> <a class="btn ghost" href="#pricing">${t('料金', 'Pricing')}</a></p>
<p class="small dim">${t(`無料から始められます・<a href="${REPO}">オープンソース（MIT）</a>・E2E で暗号化`, `Free to start · <a href="${REPO}">Open source (MIT)</a> · End-to-end encrypted`)}</p>
</div>
<figure class="phone hero-shot"><img class="peek" src="/icon.png" width="512" height="512" alt=""><img src="/shots/list.png" width="390" height="780" alt="${t('2台のマシンと2つのアカウントのセッションが1つの一覧に', 'Sessions from two machines and two accounts in one list')}"></figure>
</section>

<h2>${t('しくみ', 'How it works')}</h2>
<ol class="steps">
<li><strong>${t('PC に入れる', 'Install on your PC')}</strong><span>${t('1行のコマンドで。WSL・macOS・Linux。', 'One command. WSL, macOS or Linux.')}</span></li>
<li><strong>${t('いつもどおり <code>claude</code>', 'Use <code>claude</code> as usual')}</strong><span>${t('起動のしかたも、アカウントの分け方もそのまま。', 'Same command, same accounts, nothing to relaunch.')}</span></li>
<li><strong>${t('スマホを開く', 'Open your phone')}</strong><span>${t('リンクを開いてホーム画面に追加するだけ（ストアは要りません）。全部のセッションが並び、どれにでも返事ができます。', 'Open a link and add it to your home screen, no app store. Every session is there, and you can reply to any of them.')}</span></li>
</ol>

<h2>${t('ほかと違うところ', 'Why it is different')}</h2>
<div class="pillars">
<div class="card"><h3>${t('始めてあるセッションのまま', 'Your sessions, as they are')}</h3><p>${t('専用のコマンドで起動し直したり、tmux の中で動かしたりする必要はありません。出かける前に何も準備しなくていい。', 'No wrapper command to start under, no tmux, no SSH. Nothing to prepare before you leave.')}</p></div>
<div class="card"><h3>${t('全部のアカウント・全部のマシン', 'Every account, every machine')}</h3><p>${t('どの PC の <code>~/.claude</code> も <code>~/.claude-*</code> も自動で見つけて、1つの一覧に。承認待ちが先頭に来ます。', '<code>~/.claude</code> and every <code>~/.claude-*</code> on every PC, found automatically and merged into one list. Waiting approvals come first.')}</p></div>
<div class="card"><h3>${t('オープンソースで、中身は見せない', 'Open source and private')}</h3><p>${t(`PC で動く agent も、Web アプリも、relay も、全部 MIT のオープンソースで <a href="${REPO}">GitHub</a> で読めます。スマホと PC の間は E2E で暗号化され、relay が運ぶのは暗号文だけ。Tailscale や自分の relay でも使えます。`, `The agent on your PC, the web app and the relay are all open source (MIT) — <a href="${REPO}">read them on GitHub</a>. End-to-end encrypted between your phone and your PC; the relay only passes ciphertext. Or run it over Tailscale or your own relay.`)}</p></div>
</div>

<div class="split">
<figure class="phone"><img src="/shots/thread.png" width="390" height="780" loading="lazy" alt="${t('スマホからセッションに返事をしている画面', 'Replying to a running session from the phone')}"></figure>
<div>
<h2>${t('スマホでできること', 'On your phone')}</h2>
<ul class="also">
<li><strong>${t('通知', 'Notifications')}</strong> ${t('ターンが終わったとき、Claude が呼んでいるとき（iPhone・Android）。', 'When a turn ends or Claude needs you, on iPhone and Android.')}</li>
<li><strong>${t('承認と質問', 'Approvals and questions')}</strong> ${t('許可も、選択肢への回答も、その場で。', 'Allow, deny, or pick an answer right there.')}</li>
<li><strong>${t('返事と停止', 'Reply and stop')}</strong> ${t('動いているセッションに打ち込んだり、止めたり。', 'Type into a running session, or stop it.')}</li>
<li><strong>${t('条件つきの自動承認', 'Auto-approve, on your terms')}</strong> ${t('1つのセッションを3時間か24時間だけ。オンの間はずっと見えていて、1タップで止まります。', 'One session, for 3 or 24 hours. Always visible, one tap to turn off.')}</li>
<li><strong>${t('ストアは要らない', 'No app store')}</strong> ${t('ホーム画面に追加する Web アプリ。', 'A web app you add to your home screen.')}</li>
<li><strong>${t('ねこ', 'A cat')}</strong> ${t('7匹から選べて、Claude が動いている間だけ走ります。', 'Pick one of seven. It runs while Claude is working.')}</li>
</ul>
</div>
</div>

<h2 id="install">${t('はじめかた', 'Get started')}</h2>
<p>${t('PC（WSL / macOS / Linux・Node 24）で:', 'On your PC (WSL / macOS / Linux, Node 24):')}</p>
<pre><code>curl -fsSL ${APP}/install.sh | bash</code></pre>
<p>${t('新しい端末で、こちらの relay を使うならログインしてから、スマホを登録します:', 'In a new terminal, sign in if you use our relay, then register your phone:')}</p>
<pre><code>nyan login
nyan pair</code></pre>
<p>${t(`スマホで <a href="${APP}">${APP.replace('https://', '')}</a> を開き、ホーム画面に追加して、QR を読みます。`, `On your phone, open <a href="${APP}">${APP.replace('https://', '')}</a>, add it to your home screen, and scan the QR code.`)}</p>

<h2 id="pricing">${t('料金', 'Pricing')}</h2>
<div class="grid">
<div class="card"><h3>Free</h3><p class="price">$0</p><p>${t(`マシン ${FREE.maxMachines}台・スマホ ${FREE.maxDevices}台（こちらの relay）`, `${FREE.maxMachines} machine, ${FREE.maxDevices} phones (our relay)`)}</p><p class="dim">${t('機能は全部使えます', 'All features included')}</p></div>
<div class="card"><h3>Plus</h3><p class="price">$24 / ${t('年', 'year')}</p><p class="dim">${t('または $2.99 / 月', 'or $2.99 / month')}</p><p>${t(`マシン ${PLUS.maxMachines}台・スマホ ${PLUS.maxDevices}台`, `${PLUS.maxMachines} machines, ${PLUS.maxDevices} phones`)}</p><p><a class="btn" href="${ACCOUNT}">${t('アカウントへ', 'Go to account')}</a></p></div>
<div class="card"><h3>${t('自分で運用', 'Self-hosted')}</h3><p class="price">$0</p><p>${t('Tailscale か、自分の Cloudflare の relay。台数の制限なし・アカウント不要', 'Tailscale or your own Cloudflare relay. No limits, no account')}</p><p><a href="${REPO}">GitHub</a></p></div>
</div>
<p class="dim">${t('価格は税込み・米ドルです（日本円のカードでは、カード会社の換算レートが適用されます）。いつでも解約でき、次の更新日から請求されません。', 'Prices are in US dollars and include tax. Cancel anytime; you will not be charged from the next renewal.')}</p>
<h2 id="soon">${t('これから', 'Roadmap')}</h2>
<ul class="roadmap">
<li><strong>Codex</strong> ${t('OpenAI Codex のセッションも同じ画面に。', 'OpenAI Codex sessions in the same view.')}</li>
<li><strong>${t('スマホのアプリ', 'Phone apps')}</strong> ${t('iPhone と Android のネイティブアプリ。', 'Native apps for iPhone and Android.')}</li>
<li><strong>${t('デスクトップ', 'Desktop')}</strong> ${t('PC 向けの画面。Windows・macOS・Linux にインストールできる形で。', 'A desktop layout, installable on Windows, macOS and Linux.')}</li>
<li><strong>${t('WSL なしの Windows', 'Windows without WSL')}</strong> ${t('Windows の上で直接 agent を動かす。', 'Run the agent on Windows directly.')}</li>
<li><strong>Homebrew</strong> ${t('macOS で Homebrew から入れて更新。', 'Install and update with Homebrew on macOS.')}</li>
</ul>
<p class="dim">${t('nyan-remote は Anthropic の公式製品ではありません。Claude と Claude Code は Anthropic の商標です。', 'nyan-remote is not an official Anthropic product. Claude and Claude Code are trademarks of Anthropic.')}</p>`,
  )
}

function law(lang) {
  const t = (ja, en) => (lang === 'ja' ? ja : en)
  const c = COMPANY[lang]
  const rows = [
    [t('販売業者', 'Seller'), c.name],
    [t('運営統括責任者', 'Operations manager'), c.manager],
    [t('所在地', 'Address'), c.address],
    [t('電話番号', 'Phone'), t(`請求があった場合は遅滞なく開示いたします（${SUPPORT} までご連絡ください）`, `Disclosed without delay upon request (write to ${SUPPORT}).`)],
    [t('メールアドレス', 'Email'), SUPPORT],
    [t('販売価格', 'Price'), t('料金ページに表示（税込・米ドル）: Plus 月額 $2.99・年額 $24', 'Shown on the pricing page (tax included, US dollars): Plus $2.99/month or $24/year.')],
    [t('通貨', 'Currency'), t('米ドルでの請求です。日本円のカードでお支払いの場合、カード会社の換算レートと手数料が適用されます', 'Charged in US dollars. If your card is in another currency, your card issuer’s exchange rate and fees apply.')],
    [t('商品代金以外の必要料金', 'Additional fees'), t('インターネットの通信料金はお客様のご負担です', 'Internet connection fees are borne by the customer.')],
    [t('支払方法', 'Payment method'), t('クレジットカード・デビットカード（Stripe）', 'Credit or debit card (Stripe)')],
    [t('支払時期', 'Payment timing'), t('お申し込み時にお支払い。以後は更新日（毎月または毎年）に自動で請求します', 'Charged at sign-up, then automatically on each renewal date (monthly or yearly).')],
    [t('サービスの提供時期', 'Service delivery'), t('決済の完了後、すぐにご利用いただけます（PC で nyan account を打つとその場で反映されます。打たなくても1時間以内に反映されます）', 'Available right after payment (run nyan account on your PC to apply it at once; otherwise it applies within an hour).')],
    [t('解約', 'Cancellation'), t('アカウントの画面からいつでも解約できます。次の更新日以降は請求されません。期間の途中の解約による日割りの返金はありません', 'Cancel anytime from the account page. You will not be charged from the next renewal. No prorated refunds for the remainder of a period.')],
    [t('返品・返金', 'Returns and refunds'), t('デジタルサービスの性質上、お支払い後の返金は原則としてお受けしておりません。不具合によりご利用いただけない場合はお問い合わせください', 'Due to the nature of digital services, payments are generally non-refundable. If you cannot use the service because of a defect, please contact us.')],
    [t('動作環境', 'Requirements'), t('PC: WSL・macOS・Linux（Node.js 24）／スマホ: iOS 16.4 以降の Safari、または Android の Chrome', 'PC: WSL, macOS or Linux (Node.js 24) / Phone: Safari on iOS 16.4 or later, or Chrome on Android')],
  ]
  return page(
    lang,
    lang === 'ja' ? '/ja/legal/law/' : '/legal/law/',
    t('特定商取引法に基づく表記 — nyan-remote', 'Legal notice (Specified Commercial Transactions Act) — nyan-remote'),
    `<h1>${t('特定商取引法に基づく表記', 'Legal notice under the Specified Commercial Transactions Act')}</h1>
<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
${lang === 'en' ? '<p class="dim">For customers in Japan: <a href="/ja/legal/law/" hreflang="ja" lang="ja">特定商取引法に基づく表記</a></p>' : ''}
<p class="dim">${t('最終更新', 'Last updated')}: ${UPDATED}</p>`,
  )
}

function terms(lang) {
  const t = (ja, en) => (lang === 'ja' ? ja : en)
  const c = COMPANY[lang].name
  const s = (h, ...ps) => `<h2>${h}</h2>${ps.map((p) => `<p>${p}</p>`).join('')}`
  return page(
    lang,
    lang === 'ja' ? '/ja/legal/terms/' : '/legal/terms/',
    t('利用規約 — nyan-remote', 'Terms of Service — nyan-remote'),
    `<h1>${t('利用規約', 'Terms of Service')}</h1>
<p>${t(`この規約は、${c}（以下「当社」）が提供する nyan-remote のホスティングサービス（こちらの relay・アカウント・有料プラン。以下「本サービス」）の利用条件を定めます。`, `These terms govern your use of the hosted services for nyan-remote (our relay, accounts and paid plans; the "Service") provided by ${c} ("we").`)}</p>
${s(t('1. 本サービスとソフトウェア', '1. The Service and the software'),
  t('nyan-remote のソフトウェア（agent・アプリ・relay のコード）は MIT ライセンスで公開されており、その利用にはそのライセンスが適用されます。この規約は、当社が運営するホスティングサービスの利用に適用されます。', 'The nyan-remote software (agent, app and relay code) is published under the MIT License, which governs its use. These terms apply to the hosted services we operate.'))}
${s(t('2. アカウント', '2. Accounts'),
  t('本サービスの一部は GitHub のアカウントでのログインが必要です。アカウントとマシンの合言葉の管理はお客様の責任で行ってください。', 'Parts of the Service require signing in with a GitHub account. You are responsible for keeping your account and machine credentials secure.'))}
${s(t('3. プランと料金', '3. Plans and fees'),
  t(`無料プランではマシン ${FREE.maxMachines}台・スマホ ${FREE.maxDevices}台まで、Plus ではマシン ${PLUS.maxMachines}台・スマホ ${PLUS.maxDevices}台までご利用いただけます。Plus の料金は料金ページに表示のとおりで、Stripe を通じて更新日ごとに自動で請求されます。`, `The free plan allows up to ${FREE.maxMachines} machine and ${FREE.maxDevices} phones; Plus allows up to ${PLUS.maxMachines} machines and ${PLUS.maxDevices} phones. Plus fees are as shown on the pricing page and are charged automatically through Stripe on each renewal date.`),
  t('解約はアカウントの画面からいつでもでき、次の更新日以降は請求されません。期間の途中の解約による日割りの返金はありません。当社は、30日前までに通知することで料金とプランの内容を変更できます。', 'You can cancel anytime from the account page and will not be charged from the next renewal. There are no prorated refunds. We may change fees or plan contents with 30 days’ notice.'))}
${s(t('4. 禁止事項', '4. Prohibited use'),
  t('本サービスを、法令に反する目的、他人の権利を侵害する目的、relay を大容量のファイル転送や本来の目的以外の中継に使う目的、または本サービスの運営を妨げる方法で利用してはなりません。当社は、これに当たると判断した場合、事前の通知なく利用を制限または停止できます。', 'You may not use the Service for unlawful purposes, to infringe others’ rights, to use the relay for bulk file transfer or relaying unrelated to its purpose, or in any way that disrupts its operation. We may restrict or suspend use without notice if we determine this applies.'))}
${s(t('5. 保証の否認', '5. No warranty'),
  t('本サービスは現状のまま提供され、当社は、中断しないこと、誤りがないこと、特定の目的に適合することを保証しません。本サービスは Cloudflare などの第三者の基盤の上で動いており、その障害の影響を受けることがあります。', 'The Service is provided "as is". We do not warrant that it will be uninterrupted, error-free or fit for a particular purpose. It runs on third-party infrastructure such as Cloudflare and may be affected by their outages.'))}
${s(t('6. 責任の制限', '6. Limitation of liability'),
  t('当社の故意または重大な過失による場合を除き、本サービスに関して当社が負う責任は、直前の12か月にお客様が当社に支払った金額を上限とします。', 'Except in cases of our wilful misconduct or gross negligence, our liability in connection with the Service is limited to the amount you paid us in the preceding 12 months.'))}
${s(t('7. 規約の変更', '7. Changes'),
  t('当社は、必要に応じてこの規約を変更できます。重要な変更は本サイトでお知らせします。変更後に本サービスを利用した場合、変更後の規約に同意したものとみなします。', 'We may change these terms as needed and will announce material changes on this site. Continued use after a change means you accept the updated terms.'))}
${s(t('8. 準拠法と裁判所', '8. Governing law and jurisdiction'),
  t('この規約は日本法に準拠し、本サービスに関する紛争は東京地方裁判所を第一審の専属的合意管轄裁判所とします。', 'These terms are governed by the laws of Japan, and the Tokyo District Court has exclusive jurisdiction in the first instance over disputes relating to the Service.'))}
${s(t('9. お問い合わせ', '9. Contact'), `Use the contact form on your <a href="${SUPPORT_FORM}">account page</a>.`)}
<p class="dim">${t('最終更新', 'Last updated')}: ${UPDATED}</p>`,
  )
}

function privacy(lang) {
  const t = (ja, en) => (lang === 'ja' ? ja : en)
  const c = COMPANY[lang].name
  const s = (h, ...ps) => `<h2>${h}</h2>${ps.map((p) => `<p>${p}</p>`).join('')}`
  const li = (items) => `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`
  return page(
    lang,
    lang === 'ja' ? '/ja/legal/privacy/' : '/legal/privacy/',
    t('プライバシーポリシー — nyan-remote', 'Privacy Policy — nyan-remote'),
    `<h1>${t('プライバシーポリシー', 'Privacy Policy')}</h1>
<p>${t(`${c}（以下「当社」）は、nyan-remote のホスティングサービスで取り扱う情報を、次のとおり扱います。`, `This policy explains how ${c} ("we") handles information in the nyan-remote hosted services.`)}</p>
${s(t('1. 取り扱わないもの', '1. What we do not handle'),
  t('Claude Code の会話・プロンプト・コード・ファイルの中身は、スマホと PC の間で端から端まで暗号化されており、当社の relay を通っても当社には読めません。当社はそれを保存しません。', 'Your Claude Code conversations, prompts, code and file contents are end-to-end encrypted between your phone and PC. They pass through our relay but we cannot read them, and we do not store them.'))}
<h2>${t('2. 取り扱う情報', '2. Information we handle')}</h2>
${li([
  t('GitHub のアカウントの id と表示名（ログインのため）。GitHub のトークンは確認に一度使うだけで保存しません。パスワードは受け取りません', 'Your GitHub account id and username (for sign-in). GitHub tokens are used once for verification and not stored. We do not receive your password'),
  t('登録したマシンの名前・公開鍵・最後に使った日時（台数の管理のため）。マシンの合言葉はハッシュだけを保存します', 'Names, public keys and last-used times of your registered machines (to manage limits). Machine credentials are stored only as hashes'),
  t('Stripe の顧客 id と契約の状態（お支払いのため）。カードの情報は Stripe が扱い、当社は受け取りません。Stripe から届く決済の通知には、メールアドレスなどお支払いの際に入力された情報が含まれることがありますが、当社はそれを保存しません', 'Your Stripe customer id and subscription status (for billing). Card details are handled by Stripe; we do not receive them. Payment notifications from Stripe may include details you entered at checkout, such as your email address; we do not store them'),
  t('relay への接続の記録（接続の時刻・送受信の量・IP アドレスなど。障害の調査と不正な利用の防止のため。Cloudflare の記録として短期間だけ残ります）', 'Relay connection metadata (times, traffic volume, IP addresses and similar; for troubleshooting and abuse prevention; kept briefly in Cloudflare logs)'),
])}
${s(t('3. 第三者', '3. Third parties'),
  t('本サービスは Cloudflare（基盤）・Stripe（決済）・GitHub（ログイン）を利用しています。当社は、法令に基づく場合を除き、お客様の情報をこれら以外の第三者に提供しません。広告や解析のための外部のスクリプトは使っていません。', 'The Service uses Cloudflare (infrastructure), Stripe (payments) and GitHub (sign-in). Except as required by law, we do not share your information with other third parties. We use no third-party advertising or analytics scripts.'))}
${s(t('4. 削除', '4. Deletion'),
  t('<code>nyan logout</code> またはアカウントの画面でマシンを外すと、そのマシンの情報（合言葉のハッシュを含む）は削除されます。90日使われなかったマシンの情報も自動で削除します。relay の台数の記録は、マシンを外したときか、30日使われなかったときに消えます。アカウント全体の削除をご希望の場合はお問い合わせください。', 'Removing a machine with <code>nyan logout</code> or on the account page deletes its information (including the credential hash). Machines unused for 90 days are also deleted automatically. The relay’s machine count forgets a machine when you remove it or after 30 days unused. To delete your whole account, please contact us.'))}
${s(t('5. お問い合わせ', '5. Contact'),
  t(`${c}（アカウントの画面のお問い合わせフォーム）`, `${c} — use the contact form on your <a href="${SUPPORT_FORM}">account page</a>.`))}
<p class="dim">${t('最終更新', 'Last updated')}: ${UPDATED}</p>`,
  )
}

const pages = {
  '/index.html': home('en'),
  '/legal/law/index.html': law('en'),
  // ⚠️ Japanese only on this one page (explained above)
  '/ja/legal/law/index.html': law('ja'),
  '/legal/terms/index.html': terms('en'),
  '/legal/privacy/index.html': privacy('en'),
}
// ⚠️ Remove Japanese pages built earlier (left behind, old versions would keep being served)
rmSync(join(OUT, 'ja'), { recursive: true, force: true })
for (const [p, html] of Object.entries(pages)) {
  const to = join(OUT, p)
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, html)
}
console.log(`landing: ${Object.keys(pages).length} pages → ${OUT}`)
