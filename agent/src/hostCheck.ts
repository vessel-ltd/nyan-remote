// ★★ Which `Host` a TCP request may carry (2026-09-25 / codex security review: DNS rebinding).
//
// ⚠️⚠️ A page on `http://evil.example:7777` whose name the attacker re-points at 127.0.0.1 becomes **same-origin** with the agent:
//    no CORS preflight, custom headers allowed ⇒ it could read `/sessions` with forged identity headers.
//    Its requests still carry `Host: evil.example:7777` ⇒ refuse every Host that is not ours.
// ★ Ours: the loopback names (the CLI, hooks, the agent-served app on this PC) and Tailscale names (`tailscale serve`).
//   ⚠️ Tailscale names are matched by the `ts.net` suffix, **not** by asking Tailscale for this tailnet's suffix:
//      an attacker cannot make a `ts.net` name resolve to 127.0.0.1, and not depending on `tailscale status` means a hiccup
//      there cannot lock out a Tailscale user.
// ⚠️ Tunnel requests (relay) never come over TCP (`Host: tunnel` is set by `agent/src/tunnel.ts`), so this is only for TCP.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const TAILSCALE_SUFFIXES = ['.ts.net', '.beta.tailscale.net']

export function hostAllowed(host: string | undefined): boolean {
  if (typeof host !== 'string' || host === '') return false
  const h = host.trim().toLowerCase()
  // ★ Split off the port (IPv6 literals keep their brackets)
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(h)
  if (!m) return false
  const name = m[1]!.replace(/\.$/, '')
  if (LOOPBACK.has(name)) return true
  return TAILSCALE_SUFFIXES.some((s) => name.endsWith(s) && name.length > s.length)
}
