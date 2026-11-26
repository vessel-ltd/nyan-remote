import assert from 'node:assert/strict'
import { test } from 'node:test'
test('★★ CTL-2: a hook body over 256 KB is read for the hook routes (it used to be a 413: no card, a silent wait)', async () => {
  const { Readable } = await import('node:stream')
  const { readJsonBody, HOOK_BODY_MAX } = await import('./router.ts')
  const big = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'x', content: 'あ'.repeat(200_000) } })
  assert.ok(Buffer.byteLength(big) > 256 * 1024)
  const req = (): never => Object.assign(Readable.from([Buffer.from(big)]), { headers: { 'content-type': 'application/json' } }) as never
  await assert.rejects(readJsonBody(req()), /too large/, 'the default stays 256 KB for every other route')
  const got = await readJsonBody<{ tool_name: string }>(req(), HOOK_BODY_MAX)
  assert.equal(got.tool_name, 'Write')
  // wired on both hook routes
  const { readFileSync } = await import('node:fs')
  for (const f of ['./routes/permission.ts', './routes/hook.ts']) {
    assert.match(readFileSync(new URL(f, import.meta.url), 'utf8'), /readJsonBody<HookPayload>\(ctx\.req, HOOK_BODY_MAX\)/, f)
  }
})
