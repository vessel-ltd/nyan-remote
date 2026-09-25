// ★ When the tailscale serve config counts as "forwarding to this agent" (servesPort / codex security review)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { servesPort } from './tailscale.ts'

test('★★ a raw TCP forward to our port does not count (it passes client-sent identity headers through)', () => {
  assert.equal(servesPort({ TCP: { '7000': { TCPForward: '127.0.0.1:7777' } } }, 7777), false)
  assert.equal(servesPort({ TCP: { '443': { HTTPS: true } }, Web: { 'pc-a.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } } } }, 7777), true)
})

test('★★ an HTTPS proxy next to a raw TCP forward to our port does not count either (codex round 3)', () => {
  const both = { TCP: { '443': { HTTPS: true }, '7000': { TCPForward: '127.0.0.1:7777' } }, Web: { 'pc-a.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } } } }
  assert.equal(servesPort(both, 7777), false)
  // ★ A TCP forward to another port does not matter
  assert.equal(servesPort({ ...both, TCP: { '443': { HTTPS: true }, '7000': { TCPForward: '127.0.0.1:22' } } }, 7777), true)
})

test('★★ a raw forward counts by its port however the host is spelt, and only an HTTPS listener counts (codex round 4)', () => {
  const https = { TCP: { '443': { HTTPS: true } }, Web: { 'pc-a.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } } } }
  for (const fwd of ['[::ffff:127.0.0.1]:7777', '0.0.0.0:7777', 'pc-a:7777', '[::1]:7777']) {
    assert.equal(servesPort({ ...https, TCP: { ...https.TCP, '7000': { TCPForward: fwd } } }, 7777), false, fwd)
  }
  // ⚠️ An HTTP-only listener is not HTTPS (no identity guarantee there)
  assert.equal(servesPort({ TCP: { '80': { HTTP: true } }, Web: { 'pc-a.example.ts.net:80': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } } } }, 7777), false)
  assert.equal(servesPort(https, 7777), true)
})

test('★★★ every mention of our port must be a counted HTTPS proxy — unknown shapes veto (codex round 5)', () => {
  const https = { TCP: { '443': { HTTPS: true } }, Web: { 'pc-a.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } } } }
  const cases: [string, unknown][] = [
    ['raw forward under Services', { ...https, Services: { 'svc:raw': { TCP: { '7000': { TCPForward: '127.0.0.1:7777' } } } } }],
    ['HTTP proxy next to the HTTPS one', { ...https, TCP: { ...https.TCP, '80': { HTTP: true } }, Web: { ...https.Web, 'pc-a.example.ts.net:80': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } } } }],
    ['HTTP proxy in Foreground', { ...https, Foreground: { s: { TCP: { '80': { HTTP: true } }, Web: { 'x:80': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777' } } } } } } }],
    ['an unknown future key', { ...https, Future: { anything: 'tcp://127.0.0.1:7777' } }],
  ]
  for (const [name, cfg] of cases) assert.equal(servesPort(cfg, 7777), false, name)
  // ★ Two HTTPS hosts proxying to us are fine
  assert.equal(servesPort({ ...https, Web: { ...https.Web, 'pc-a-2.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7777/' } } } } }, 7777), true)
  // ★ Mentions of other ports do not matter
  assert.equal(servesPort({ ...https, Services: { 'svc:ssh': { TCP: { '22': { TCPForward: '127.0.0.1:22' } } } } }, 7777), true)
})

test('★ an agent on a default web port is never trusted (implied ports escape the count / codex round 6)', () => {
  const cfg = { TCP: { '8443': { HTTPS: true }, '8080': { HTTP: true } }, Web: { 'pc.example.ts.net:8443': { Handlers: { '/': { Proxy: 'https://127.0.0.1:80' } } }, 'pc.example.ts.net:8080': { Handlers: { '/': { Proxy: 'http://127.0.0.1' } } } } }
  assert.equal(servesPort(cfg, 80), false)
  assert.equal(servesPort({ TCP: { '443': { HTTPS: true } }, Web: { 'x:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:443' } } } } }, 443), false)
})

