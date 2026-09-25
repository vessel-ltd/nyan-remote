import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostAllowed } from './hostCheck.ts'

test('★★ only our own Host names reach the agent over TCP (DNS rebinding / codex security review)', () => {
  for (const ok of ['127.0.0.1:7777', '127.0.0.1', 'localhost:7777', 'LOCALHOST', '[::1]:7777', 'pc-a.example.ts.net', 'pc-a.example.ts.net:443', 'pc-a.example.ts.net.', 'pc-a.example.beta.tailscale.net'])
    assert.equal(hostAllowed(ok), true, ok)
  for (const bad of [undefined, '', 'evil.example:7777', 'evil.example', '127.0.0.1.evil.example', 'localhost.evil.example', 'ts.net', '.ts.net', 'evilts.net', 'pc-a.example.ts.net.evil.example', '127.0.0.2:7777', '0.0.0.0:7777', 'tunnel', '[::1', 'a:b:c'])
    assert.equal(hostAllowed(bad), false, String(bad))
})

test('★ wiring: the HTTP server refuses other Host names before the pipeline', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  const check = src.indexOf('if (!hostAllowed(req.headers.host)) {')
  assert.ok(check > 0, 'no Host check')
  assert.ok(check < src.indexOf('handleRequest({ router, req, res, allowStatic: true })'), 'checked after the pipeline started')
})
