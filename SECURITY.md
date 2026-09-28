# Security policy

nyan-remote lets a phone send keystrokes and approvals to Claude Code sessions on your computers,
so we treat security reports as our top priority.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub:

**[Report a vulnerability](https://github.com/vessel-ltd/nyan-remote/security/advisories/new)**

Include what you found, how to reproduce it, and what an attacker could do with it.
We aim to reply within 5 business days and will keep you updated until it is fixed.
We are happy to credit you in the release notes if you wish.

## Scope

- the agent that runs on your computer (`agent/`, `scripts/`, `hooks/`, `install.sh`)
- the web app (`web/`) served at `app.nyan-remote.app`
- the relay (`relay/`) at `relay.nyan-remote.app`
- the account and billing service (`account/`) at `account.nyan-remote.app`
- the end-to-end encryption and pairing (`shared/`)

Especially interesting: anything that lets someone other than the owner read a session,
type into it, answer an approval, pair a device, or use a paid plan without paying.

## Assumptions and known limitations

What each route relies on, so you can pick the one that fits your machine:

- **The nyan-remote relay (the default)** carries only end-to-end encrypted traffic between your phone and your PC.
  It sees which machine and which phone connect, when, and how much, but not what is sent. Each phone proves it holds
  its key, and a registered phone can be revoked from the phone or with `nyan devices`.
- **The Tailscale route** (self-hosting with `tailscale serve`) trusts the identity headers that `tailscale serve`
  adds, and assumes **you are the only OS user on that PC**: anyone logged in to the same PC can reach
  `127.0.0.1:7777` and send those headers. On a shared PC, use the relay route instead.
  Planned: device keys on the Tailscale route too, which removes this assumption.
- **Anything running as your own OS user is trusted.** It can already run Claude Code and read your sessions; the
  hook token in `~/.nyan-remote/` only lets your own hooks talk to the agent.

Reports that go beyond these limits are especially welcome.

## Please do not

- access, change or delete data that is not yours
- run load or denial-of-service tests against the hosted relay or account service
- use social engineering against us or our users

Testing against your own machines, your own account and a relay you deploy yourself is welcome.

## Supported versions

The hosted services always run the latest release. For the agent, please test with the latest release
(`nyan update`); fixes are not backported.
