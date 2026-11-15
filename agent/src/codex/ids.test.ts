import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codexSessionPrefix } from './daemon.ts'
import { isCodexSessionId, shortSessionId } from './ids.ts'

test('a Codex row id: 16 hex of the home, then the thread; never the form of a Claude id', () => {
  const p = codexSessionPrefix('/home/user/.codex')
  assert.match(p, /^codex-[0-9a-f]{16}-$/)
  assert.notEqual(p, codexSessionPrefix('/home/user/other/.codex'))
  const id = `${p}01a1d8d9-66fc-7823-968f-c97d7234176e`
  assert.equal(isCodexSessionId(id), true)
  assert.equal(isCodexSessionId('01a1d8d9-66fc-7823-968f-c97d7234176e'), false)
  assert.equal(isCodexSessionId(p), false, 'a prefix alone is no id')
  assert.equal(isCodexSessionId('codex-0123abcd-x'), false, 'the old 8-hex form is not ours any more')
})

test('★ journals keep the home and the thread apart (second review, low #5)', () => {
  const p = codexSessionPrefix('/home/user/.codex')
  const a = shortSessionId(`${p}aaaaaaaa-1111`)
  const b = shortSessionId(`${p}bbbbbbbb-1111`)
  assert.notEqual(a, b)
  assert.equal(a, `${p}aaaaaaaa`)
  assert.equal(shortSessionId('01a1d8d9-66fc-7823-968f-c97d7234176e'), '01a1d8d9', 'Claude ids as before')
})
