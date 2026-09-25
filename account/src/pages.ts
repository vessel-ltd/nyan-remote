// ★ The account pages (2026-09-24). ⚠️ No scripts (forms only = CSP can refuse all scripts).
// ⚠️ Text from outside (GitHub login names, machine names) **always goes through `esc`**.
// ★ English only (2026-09-25 / user decision: same as the landing site; the only Japanese page is the legal notice there).

import { PLAN_LIMITS, type Plan } from '../../shared/license.ts'
import type { AccountRow, MachineRow } from './store.ts'

/** ★ The optional name on the contact form (characters) */
export const SUPPORT_NAME_MAX = 100

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** ★ The cat and the favicon come from the PWA's origin (the only image source the CSP allows / `app.ts`) */
const ICONS = 'https://app.nyan-remote.app/icons'
const HOME = `<a class="home" href="https://nyan-remote.app/"><img src="${ICONS}/icon-any-192.png" alt="" width="32" height="32">nyan-remote</a>`

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>nyan-remote account</title>
<link rel="icon" href="${ICONS}/favicon-64.png">
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
h1 a.home{color:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:10px}h1 a.home img{border-radius:8px}
footer{margin-top:40px;color:var(--dim);font-size:.85rem}footer a{color:inherit}
.field{box-sizing:border-box;width:100%;font:inherit;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
details>summary{cursor:pointer;font-weight:600;font-size:1.05rem;margin:28px 0 8px}
</style></head><body><main>${body}
<footer><a href="https://nyan-remote.app/">nyan-remote.app</a> · <a href="/#support">Support</a> · <a href="https://nyan-remote.app/legal/terms/">Terms</a> · <a href="https://nyan-remote.app/legal/privacy/">Privacy</a> · <a href="https://nyan-remote.app/legal/law/">Legal notice</a></footer>
</main></body></html>`
}

export function landingPage(loginFailed: boolean): string {
  return page(
    `<h1>${HOME}</h1>
<p class="dim">Account and plan</p>
${loginFailed ? `<p class="card">Sign-in failed. Please try again.</p>` : ''}
<p><a class="btn primary" href="/auth/github">Sign in with GitHub</a></p>
<p class="dim">To contact support, sign in and use the form on your account page.</p>
<p class="dim">On your PC, sign in with <code>nyan login</code>. No account is needed with Tailscale or your own relay.</p>`,
  )
}

const NOTICE: Record<string, string> = {
  thanks: 'Thank you! Your plan is now Plus. Run nyan account on your PC to apply it now (otherwise it applies within an hour).',
  revoked: 'The machine was removed.',
  'bad-price': 'That price is not available.',
  'support-sent': 'Sent. We will reply to the email address you gave (or on GitHub if you left none).',
  'support-empty': 'The message is empty.',
  'support-email': 'That email address does not look right.',
  'support-limit': 'You have reached today’s limit (5 messages). Please try again tomorrow.',
  'support-failed': 'Could not send. Please try again in a moment.',
  busy: 'Another request is in progress. Wait a moment and try again.',
  'revoke-failed': 'Could not remove the machine (the relay did not respond). Wait a moment and try again.',
}

export function accountPage(
  o: { account: AccountRow; plan: Plan; machines: MachineRow[]; notice?: string; admin?: boolean },
): string {
  const lim = PLAN_LIMITS[o.plan]
  // ⚠️ Own keys only (`n=constructor` would otherwise print `function Object() …` / codex)
  const n = o.notice && Object.hasOwn(NOTICE, o.notice) ? NOTICE[o.notice] : undefined
  // ★ Contact-form notices are shown by the form (not at the top), and an error opens the form again
  const forSupport = o.notice?.startsWith('support-') === true
  const top = n && !forSupport ? `<p class="card">${n}</p>` : ''
  const supportNote = n && forSupport ? `<p class="card">${n}</p>` : ''
  const supportOpen = forSupport && o.notice !== 'support-sent' ? ' open' : ''
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const machines = o.machines.length
    ? `<ul>${o.machines
        .map(
          (m) => `<li><span class="grow name">${esc(m.label)}<br><span class="dim">Last used ${date(m.lastSeen)}</span></span>
<form method="post" action="/machines/revoke"><input type="hidden" name="id" value="${esc(m.id)}"><button>Remove</button></form></li>`,
        )
        .join('')}</ul>`
    : `<p class="dim">None yet. Run nyan login on your PC.</p>`
  // ⚠️⚠️ Two or more subscriptions = paying twice (bought from an old tab etc. / codex round 26, high #8) ⇒ always tell the user
  const dup =
    (o.account.subscriptionCount ?? 0) > 1
      ? `<p class="card">${`You have ${o.account.subscriptionCount} subscriptions (you are being charged twice). Cancel one under “Manage billing”.`}</p>`
      : ''
  const upgrade =
    o.plan === 'plus' || (o.account.subscriptionCount ?? 0) > 0
      ? `${dup}<form method="post" action="/billing/portal"><button>Manage billing / cancel</button></form>`
      : `<p>Plus: 5 machines and 5 phones</p>
<div class="row">
${[
  ['usd-year', '$24 / year'],
  ['usd-month', '$2.99 / month'],
]
  .map(([v, label], i) => `<form method="post" action="/billing/checkout"><input type="hidden" name="price" value="${v}"><button class="${i === 0 ? 'primary' : ''}">${label}</button></form>`)
  .join('')}
</div>
<p class="dim">Yearly is cheaper ($2/month). Cancel anytime.</p>`
  return page(
    `<div class="row"><h1 class="grow">${HOME}</h1>${o.admin ? '<a class="btn" href="/admin">Admin</a>' : ''}<form method="post" action="/logout"><button>Sign out</button></form></div>
<p class="dim">GitHub: ${esc(o.account.githubLogin)}</p>
${top}
<h2>Plan</h2>
<div class="card"><strong>${o.plan === 'plus' ? 'Plus' : 'Free'}</strong> · ${`Machines ${o.machines.length}/${lim.maxMachines} · up to ${lim.maxDevices} phones`}
${upgrade}</div>
<h2>Machines</h2>
<div class="card">${machines}</div>
<p class="dim">Remove machines you no longer use to free a slot (unused for 30 days, they are removed automatically).</p>
<details id="support"${supportOpen}><summary>Contact support</summary>
${supportOpen ? supportNote : ''}
<form class="card" method="post" action="/support">
<p class="dim">Questions about billing, your account or a problem. Leave an email address for our reply (otherwise we will reach you on GitHub).</p>
<p><input class="field" name="name" maxlength="${SUPPORT_NAME_MAX}" autocomplete="name" placeholder="Name (optional)"></p>
<p><input class="field" name="email" type="email" maxlength="254" autocomplete="email" placeholder="Email address"></p>
<p><textarea class="field" name="message" required maxlength="3000" rows="6" placeholder="How can we help?"></textarea></p>
<p><button class="primary">Send</button></p>
</form>
</details>
${forSupport && !supportOpen ? supportNote : ''}`,
  )
}
