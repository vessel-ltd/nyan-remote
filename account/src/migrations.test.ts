import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'
import { appliedFromJson, deployedVersion, missingMigrations } from './migrations.ts'

test('★★ deploy stops while a migration file is not applied (answering No to the prompt still exits 0)', () => {
  const files = readdirSync(new URL('../migrations/', import.meta.url))
  assert.deepEqual(missingMigrations(files, files), [])
  const last = [...files].sort().at(-1)!
  assert.deepEqual(missingMigrations(files, files.filter((f) => f !== last)), [last])
  assert.deepEqual(missingMigrations(['0001_a.sql', 'README', '0002_b.sql'], []), ['0001_a.sql', '0002_b.sql'])
})

test('★ the wrangler answer is read strictly (an unreadable answer throws, never "nothing missing")', () => {
  const ok = 'Executing…\n[{"results":[{"name":"0001_init.sql"}],"success":true,"meta":{}}]'
  assert.deepEqual(appliedFromJson(ok), ['0001_init.sql'])
  for (const bad of ['', 'error', '[]', '[{"success":false,"results":[]}]', '[{"success":true,"results":[{}]}]']) {
    assert.throws(() => appliedFromJson(bad), Error, `⚠️ read ${JSON.stringify(bad)}`)
  }
})

test('★★ "deployed" only with a deploy entry of this Worker carrying a version id (a declined prompt can exit 0)', () => {
  const ok = '{"type":"wrangler-session","version":1}\n{"type":"deploy","version":1,"worker_name":"nyan-account","version_id":"v-123"}\n'
  assert.equal(deployedVersion(ok, 'nyan-account'), 'v-123')
  assert.equal(deployedVersion('', 'nyan-account'), undefined)
  assert.equal(deployedVersion('{"type":"wrangler-session","version":1}\n', 'nyan-account'), undefined)
  assert.equal(deployedVersion('{"type":"deploy","worker_name":"nyan-account","version_id":null}', 'nyan-account'), undefined)
  assert.equal(deployedVersion('{"type":"deploy","worker_name":"other","version_id":"v"}', 'nyan-account'), undefined)
  assert.equal(deployedVersion('not json\n{"type":"deploy","worker_name":"nyan-account","version_id":"v-9"}', 'nyan-account'), 'v-9')
})
