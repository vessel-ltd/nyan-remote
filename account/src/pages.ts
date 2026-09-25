// ★ The account pages (2026-09-24). ⚠️ No scripts (forms only = CSP can refuse all scripts).
// ⚠️ Text from outside (GitHub login names, machine names) **always goes through `esc`**.
// ⚠️ Text is English / Japanese (Japanese if Accept-Language is `ja` / CLAUDE.md §1.9).

import { PLAN_LIMITS, type Plan } from '../../shared/license.ts'
import type { AccountRow, MachineRow } from './store.ts'

export type Lang = 'ja' | 'en'

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const tr = (lang: Lang, ja: string, en: string) => (lang === 'ja' ? ja : en)

function page(lang: Lang, body: string): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>nyan-remote account</title>
<style>
:root{color-scheme:light dark;--bg:#0b0d10;--fg:#e8edf2;--dim:#9aa4af;--card:#151a20;--line:#27303a;--acc:#7ab8ff}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--fg:#15191e;--dim:#5b6570;--card:#fff;--line:#dfe3e8;--acc:#1f6fd1}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.05rem;margin:28px 0 8px}
.dim{color:var(--dim);font-size:.9rem}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:10px 0}
button,.btn{font:inherit;padding:10px 14px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-block}
.primary{background:var(--acc);border-color:var(--acc);color:#fff}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.grow{flex:1;min-width:0}
ul{list-style:none;padding:0;margin:0}li{display:flex;gap:8px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}li:first-child{border-top:0}
.name{overflow-wrap:anywhere}
h1 a.home{color:inherit;text-decoration:none}
footer{margin-top:40px;color:var(--dim);font-size:.85rem}footer a{color:inherit}
</style></head><body><main>${body}
<footer><a href="https://nyan-remote.app/">nyan-remote.app</a> · <a href="/#support">${lang === 'ja' ? 'お問い合わせ' : 'Support'}</a> · ${lang === 'ja'
    ? // ⚠️ The landing site is English only (the only Japanese page is the one for the Specified Commercial Transactions Act / landing/build.mjs)
      '<a href="https://nyan-remote.app/legal/terms/">利用規約（英語）</a> · <a href="https://nyan-remote.app/legal/privacy/">プライバシーポリシー（英語）</a> · <a href="https://nyan-remote.app/ja/legal/law/">特定商取引法に基づく表記</a>'
    : '<a href="https://nyan-remote.app/legal/terms/">Terms</a> · <a href="https://nyan-remote.app/legal/privacy/">Privacy</a> · <a href="https://nyan-remote.app/legal/law/">Legal notice</a>'}</footer>
</main></body></html>`
}

export function landingPage(lang: Lang, loginFailed: boolean): string {
  return page(
    lang,
    `<h1><a class="home" href="https://nyan-remote.app/">nyan-remote</a></h1>
<p class="dim">${tr(lang, 'アカウントとプランの管理', 'Account and plan')}</p>
${loginFailed ? `<p class="card">${tr(lang, 'ログインできませんでした。もう一度お試しください。', 'Sign-in failed. Please try again.')}</p>` : ''}
<p><a class="btn primary" href="/auth/github">${tr(lang, 'GitHub でログイン', 'Sign in with GitHub')}</a></p>
<p class="dim">${tr(lang, 'お問い合わせは、ログインしてからアカウントの画面で受け付けています。', 'To contact support, sign in and use the form on your account page.')}</p>
<p class="dim">${tr(
      lang,
      'PC では <code>nyan login</code> でログインします。Tailscale や自分の relay で使う場合、アカウントは要りません。',
      'On your PC, sign in with <code>nyan login</code>. No account is needed with Tailscale or your own relay.',
    )}</p>`,
  )
}

const NOTICE: Record<string, [string, string]> = {
  thanks: [
    'ありがとうございます。Plus になりました。PC で nyan account を打つとすぐ反映されます（打たなくても1時間以内に反映されます）。',
    'Thank you! Your plan is now Plus. Run nyan account on your PC to apply it now (otherwise it applies within an hour).',
  ],
  revoked: ['マシンを外しました。', 'The machine was removed.'],
  'bad-price': ['その料金は選べません。', 'That price is not available.'],
  'support-sent': ['送りました。返事はいただいたメールアドレスに届きます。', 'Sent. We will reply to the email address you gave.'],
  'support-empty': ['本文が空です。', 'The message is empty.'],
  'support-email': ['メールアドレスの形が違います。', 'That email address does not look right.'],
  'support-limit': ['今日はこれ以上送れません（1日5通まで）。明日また送ってください。', 'You have reached today’s limit (5 messages). Please try again tomorrow.'],
  'support-failed': ['送れませんでした。少し待ってから、もう一度 送ってください。', 'Could not send. Please try again in a moment.'],
  busy: ['いま別の画面で処理しています。少し待ってから、もう一度 押してください。', 'Another request is in progress. Wait a moment and try again.'],
  'revoke-failed': ['マシンを外せませんでした（relay に届きませんでした）。少し待ってから、もう一度 押してください。', 'Could not remove the machine (the relay did not respond). Wait a moment and try again.'],
}

export function accountPage(
  lang: Lang,
  o: { account: AccountRow; plan: Plan; machines: MachineRow[]; notice?: string; admin?: boolean },
): string {
  const lim = PLAN_LIMITS[o.plan]
  const n = o.notice ? NOTICE[o.notice] : undefined
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const machines = o.machines.length
    ? `<ul>${o.machines
        .map(
          (m) => `<li><span class="grow name">${esc(m.label)}<br><span class="dim">${tr(lang, '最後に使った日', 'Last used')} ${date(m.lastSeen)}</span></span>
<form method="post" action="/machines/revoke"><input type="hidden" name="id" value="${esc(m.id)}"><button>${tr(lang, '外す', 'Remove')}</button></form></li>`,
        )
        .join('')}</ul>`
    : `<p class="dim">${tr(lang, 'まだありません。PC で nyan login を打ってください。', 'None yet. Run nyan login on your PC.')}</p>`
  // ⚠️⚠️ Two or more subscriptions = paying twice (bought from an old tab etc. / codex round 26, high #8) ⇒ always tell the user
  const dup =
    (o.account.subscriptionCount ?? 0) > 1
      ? `<p class="card">${tr(
          lang,
          `契約が ${o.account.subscriptionCount} つあります（二重に請求されています）。「支払いの管理」から1つを解約してください。`,
          `You have ${o.account.subscriptionCount} subscriptions (you are being charged twice). Cancel one under “Manage billing”.`,
        )}</p>`
      : ''
  const upgrade =
    o.plan === 'plus' || (o.account.subscriptionCount ?? 0) > 0
      ? `${dup}<form method="post" action="/billing/portal"><button>${tr(lang, '支払いの管理・解約', 'Manage billing / cancel')}</button></form>`
      : `<p>${tr(lang, 'Plus: マシン5台・スマホ5台', 'Plus: 5 machines and 5 phones')}</p>
<div class="row">
${[
  ['usd-year', lang === 'ja' ? '$24 / 年' : '$24 / year'],
  ['usd-month', lang === 'ja' ? '$2.99 / 月' : '$2.99 / month'],
]
  .map(([v, label], i) => `<form method="post" action="/billing/checkout"><input type="hidden" name="price" value="${v}"><button class="${i === 0 ? 'primary' : ''}">${label}</button></form>`)
  .join('')}
</div>
<p class="dim">${tr(lang, '年払いがお得です（月あたり $2）。米ドルでの請求です。いつでも解約できます。', 'Yearly is cheaper ($2/month). Cancel anytime.')}</p>`
  return page(
    lang,
    `<div class="row"><h1 class="grow"><a class="home" href="https://nyan-remote.app/">nyan-remote</a></h1>${o.admin ? '<a class="btn" href="/admin">Admin</a>' : ''}<form method="post" action="/logout"><button>${tr(lang, 'ログアウト', 'Sign out')}</button></form></div>
<p class="dim">GitHub: ${esc(o.account.githubLogin)}</p>
${n ? `<p class="card">${tr(lang, n[0], n[1])}</p>` : ''}
<h2>${tr(lang, 'プラン', 'Plan')}</h2>
<div class="card"><strong>${o.plan === 'plus' ? 'Plus' : 'Free'}</strong> · ${tr(lang, `マシン ${o.machines.length}/${lim.maxMachines}台・スマホ ${lim.maxDevices}台まで`, `Machines ${o.machines.length}/${lim.maxMachines} · up to ${lim.maxDevices} phones`)}
${upgrade}</div>
<h2>${tr(lang, 'マシン', 'Machines')}</h2>
<div class="card">${machines}</div>
<p class="dim">${tr(lang, '使わなくなったマシンは「外す」で枠を空けられます（30日使わないと自動で外れます）。', 'Remove machines you no longer use to free a slot (unused for 30 days, they are removed automatically).')}</p>
<h2 id="support">${tr(lang, 'お問い合わせ', 'Contact support')}</h2>
<form class="card" method="post" action="/support">
<p class="dim">${tr(lang, 'お支払い・アカウント・不具合のご相談はこちらから。返事をお送りするメールアドレスを書いてください（書かなければ GitHub でご連絡します）。', 'Questions about billing, your account or a problem. Leave an email address for our reply (otherwise we will reach you on GitHub).')}</p>
<p><input name="email" type="email" maxlength="254" autocomplete="email" placeholder="${tr(lang, 'メールアドレス', 'Email address')}" style="width:100%;font:inherit;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg)"></p>
<p><textarea name="message" required maxlength="3000" rows="6" placeholder="${tr(lang, 'ご用件', 'How can we help?')}" style="width:100%;font:inherit;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg)"></textarea></p>
<p><button class="primary">${tr(lang, '送る', 'Send')}</button></p>
</form>`,
  )
}
