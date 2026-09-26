// ★ "Could not reach the machine" is decided by type (`transport/unreachable.ts`).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { httpWire, probeUrl } from './http.ts'
import { isUnreachable, UnreachableError } from './unreachable.ts'

test('★ the type decides, not the text', () => {
  assert.equal(isUnreachable(new UnreachableError('x')), true)
  assert.equal(isUnreachable(new Error('Cannot reach it')), false)
})

test('★★ the local route: a network failure is unreachable, an HTTP error response is not', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
    await assert.rejects(httpWire('https://pc-a.example.ts.net').request({ method: 'GET', path: '/health' }), (e) => isUnreachable(e))
    globalThis.fetch = async () => new Response('{}', { status: 503 })
    const r = await httpWire('https://pc-a.example.ts.net').request({ method: 'GET', path: '/health' })
    assert.equal(r.status, 503, 'reaching the machine and getting an error is a different thing (stays an error in the list)')
  } finally {
    globalThis.fetch = real
  }
})

test('★★ the connections page probe tells "nothing answered" from "answered with an error"', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch') }
    assert.equal((await probeUrl('https://pc-a.example.ts.net')).unreachable, true)
    globalThis.fetch = async () => new Response('{}', { status: 503 })
    const r = await probeUrl('https://pc-a.example.ts.net')
    assert.equal(r.ok, false)
    assert.equal(r.unreachable, undefined, 'a 503 answered: stays a red error')
  } finally {
    globalThis.fetch = real
  }
})

test('★★ something that answered is never "offline", even with a broken body (codex)', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } })
    const p = await probeUrl('https://pc-a.example.ts.net')
    assert.equal(p.ok, false)
    assert.equal(p.unreachable, undefined, '/health answering null reached the machine')
    globalThis.fetch = async () => new Response('{not json', { status: 200 })
    await assert.rejects(httpWire('https://pc-a.example.ts.net').request({ method: 'GET', path: '/health' }).then((r) => {
      if (r.body === undefined) throw new Error('unreadable body')
    }), (e) => !isUnreachable(e))
  } finally {
    globalThis.fetch = real
  }
})
