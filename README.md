# nyan-remote

**Run Claude Code on your PCs. Watch and answer it from your phone.**

`nyan-remote` puts a small agent next to each of your Claude Code sessions and gives you a
phone-friendly web app that shows all of them at once — across several machines and several
accounts — with push notifications when a session finishes, fails, or needs your approval.

> **Status: pre-release.** It runs every day on the author's machines, but interfaces and
> defaults still change. Read [What it does not do](#what-it-does-not-do) before you rely on it.

---

## Why

Claude Code runs in a terminal on a machine you are not always sitting at. When it finishes,
hits an error, or asks for permission to run a command, you only find out when you come back.

nyan-remote makes those moments reach your phone, and lets you answer:

- **See every session** across machines and accounts in one list, with its current state.
- **Get notified** when a turn ends, a run fails, or a tool needs approval.
- **Approve or deny** permission prompts from your phone — including ones that would otherwise
  be auto-denied for background agents.
- **Reply, stop, or run a slash command** in a running session.

---

## Requirements

| | |
|---|---|
| **Agent (your PC)** | **Node.js 24+ only.** No npm, no git, no build step. Linux (systemd), macOS (launchd), or Windows through WSL. |
| **Phone** | Safari on iOS 16.4+ (add to Home Screen for notifications) or Chrome on Android. |

## Install

```bash
curl -fsSL https://app.nyan-remote.app/install.sh | bash
```

This downloads a ~3 MB tarball (sources, a prebuilt web app, and the runtime dependencies),
installs it under `~/nyan-remote`, registers a background service (`systemd --user` or launchd),
and wires up the Claude Code hooks. Then, in a new terminal:

```bash
nyan login     # only if you use our hosted relay (GitHub sign-in; not needed for Tailscale or your own relay)
nyan pair      # shows a QR code; scan it with https://app.nyan-remote.app on your phone
```

Everyday commands (`nyan help` lists them all):

| | |
|---|---|
| `nyan update` | update in place (pending approvals are checked first) |
| `nyan status` / `nyan logs` | service state and logs |
| `nyan devices` | registered phones (`--revoke` to remove one) |
| `nyan account` | your plan and limits on the hosted relay |

> Your state directory (`~/.nyan-remote`) is never touched by an update, and the previous tree is
> kept as `~/nyan-remote.old-<timestamp>` so you can go back.

### Adding a second machine

Run the same installer and pair your phone with it. That is all — there is no key to copy and
nothing to keep in sync. Each machine keeps its own notification key, and your phone holds a
separate push subscription per machine.

---

## How it connects

Each agent dials **out** over WSS to a rendezvous relay; your phone connects to the same relay.
Neither side needs an inbound port, a certificate, or a fixed address.

```
 phone  ──WSS──▶  relay (Cloudflare Worker + Durable Object)  ◀──WSS──  agent (your PC)
            └──────────── end-to-end encrypted ─────────────┘
```

Three ways to connect, chosen **per machine**, so a mesh of several PCs can mix them:

| Route | What it needs | Notes |
|---|---|---|
| **`relay`** (default) | nothing | The agent only makes outbound connections. |
| **`relay`, self-hosted** | a Cloudflare account | Deploy `relay/` yourself, then set `relayUrl` in `config.json`. |
| **`local`** | Tailscale | Direct; nothing leaves your machines. |

> `local` needs the agent to have a **real HTTPS name**, not just a LAN address: this page is
> served over HTTPS, so browsers refuse to talk to `http://192.168.x.x`, and a LAN address cannot
> get a certificate. Tailscale is what gives the agent that name, and it is the supported way.

## Security model

- **Every device has its own key pair.** Pairing exchanges public keys through a QR code shown on
  the machine itself; a one-time code (5 minutes, single use, memory only) authorises exactly one
  registration. Revoking a device takes effect on connections that are already open.
- **Over `relay`, traffic is end-to-end encrypted** between the phone and the agent (ECDH P-256 +
  AES-GCM, with per-direction keys, transcript-bound key derivation, and replay protection). The
  whole implementation is one file, `shared/crypto.ts`, shared by both sides.
  **Over `local` there is no second layer**: requests go straight to your agent over HTTPS, so you
  are trusting TLS and your own network — which is the point of that route, since nothing leaves
  your machines.
- **The phone's private key is non-extractable** and stays in IndexedDB; it cannot be exported.
- **Notifications are per-machine too.** Your phone registers one service worker per paired
  machine and subscribes with *that machine's* key, so nothing is shared between agents.
- **The relay carries ciphertext.** It can see which public key talks to which, message sizes and
  timing — nothing else. It cannot read your code, prompts, or output.
- **No runtime dependencies** except `web-push` (so we do not hand-roll RFC 8291).

> We deliberately **do not** claim "zero third parties" or "no server". Strictly speaking that only
> holds for a private CA on a LAN, which a PWA cannot use. The honest claim is: *with `local`, your
> code and prompts never pass through anyone else; with `relay`, only ciphertext and metadata do.*

### What we ask of Claude Code

nyan-remote does **not** wrap or take ownership of the CLI. You keep starting sessions the way you
already do. It observes through the documented hook points, and sends input through a pty relay
only for sessions you started through its shim.

---

## Hosting the relay

The default relay is operated by us:

| Plan | Price | Limits |
|---|---|---|
| **Free** | $0 | 1 machine, 2 phones |
| **Plus** | $2.99/month or $24/year | 5 machines, 5 phones |

Sign in with `nyan login`; manage your plan at <https://account.nyan-remote.app>. Every feature works
on the free plan. If you would rather not depend on our relay, you have three alternatives, all free,
without an account and without limits:

1. **`local`** — give your machine an HTTPS name (Tailscale is the easy path) and skip the relay.
2. **Run the relay in your own Cloudflare account** — it is a single Worker plus a Durable Object;
   a personal deployment fits inside Cloudflare's free tier with room to spare.
3. Set `"relayUrl": ""` in `~/.nyan-remote/config.json` to turn the relay off entirely.

Measured on the author's setup (3 machines, a full working day): the Durable Object was awake for
**69 seconds per day** — the hibernation design is what keeps self-hosting essentially free.

---

## What it does not do

- **iOS notification stacking.** iOS ignores notification `tag` replacement, so repeated updates
  pile up instead of replacing each other. Android replaces them as intended.
- **Serving the web app offline-first from the relay.** The app itself is served over HTTPS from a
  public origin; the relay only carries traffic once the app is already running.
- **Multi-user.** One person, several machines. There are no accounts, roles, or sharing.

---

## Development

```bash
npm install
npm test                # node:test, no watch mode magic
npm run typecheck
NYAN_REMOTE_DEV=1 npm run dev
```

The repository keeps its reasoning in `CLAUDE.md` (working rules), `docs/ARCHITECTURE.md` (the
source of truth for design) and `docs/HANDOFF.md` (what happened and why). Several rules are
enforced by tests rather than by convention — if `npm test` fails on a discipline test, the fix is
to change the code, not the test.

## License

MIT © Vessel Ltd. (Vessel合同会社). See [LICENSE](LICENSE).

The cat sprites in `web/public/cats/` and `web/public/manul-cat.svg` are original artwork made for
this project and are covered by the same license.
