// ★ The self-hosted relay config (`relay/wrangler.selfhost.jsonc` / 2026-09-25).
//   ⚠️ It must stay deployable by anyone: none of our production-only settings, and the same Durable Objects as production.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** ⚠️ Our files use whole-line `//` comments only (no trailing commas) */
const jsonc = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n'),
  ) as Record<string, unknown>

test('★★ the self-hosted relay config carries none of our production settings and matches its Durable Objects', () => {
  const self = jsonc('wrangler.selfhost.jsonc')
  const prod = jsonc('wrangler.jsonc')
  // ⚠️⚠️ With LICENSE_REQUIRED_FROM, phones on a self-hosted relay are refused (402): tickets only come from our account service
  assert.equal((self['vars'] as Record<string, unknown> | undefined)?.['LICENSE_REQUIRED_FROM'], undefined)
  // ★★ …and it runs without plans (a signed-in PC's ticket would otherwise put our Free limits on it)
  assert.equal((self['vars'] as Record<string, unknown> | undefined)?.['SELF_HOSTED'], '1')
  assert.equal((prod['vars'] as Record<string, unknown> | undefined)?.['SELF_HOSTED'], undefined, '⚠️⚠️ our production relay would drop plans')
  assert.equal(self['account_id'], undefined, '⚠️ pins our account (deploy fails for anyone else)')
  assert.equal(self['routes'], undefined, '⚠️ points at our domain')
  assert.equal(self['main'], prod['main'])
  assert.deepEqual(self['durable_objects'], prod['durable_objects'])
  assert.deepEqual(self['migrations'], prod['migrations'])
  // ★ The production config really has them (so this test notices if the two files are swapped)
  assert.ok(prod['account_id'] && prod['routes'])
})
