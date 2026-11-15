// ★ The roadmap is said in two places — the README and the landing page — from one list (`landing/roadmap.mjs`).
//   They had drifted (an item twice, a shipped one still listed / 2026-11-15). These tests keep them equal.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ROADMAP, readmeRoadmap } from '../landing/roadmap.mjs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('the roadmap has no item twice', () => {
  const titles = ROADMAP.map((r) => r.title)
  assert.equal(new Set(titles).size, titles.length)
})

test("the README's roadmap is exactly the list", () => {
  const readme = read('README.md')
  const block = readme.slice(readme.indexOf('## Roadmap\n'), readme.indexOf('\n---', readme.indexOf('## Roadmap\n')))
  const lines = block.split('\n').filter((l) => l.startsWith('- '))
  assert.deepEqual(lines, readmeRoadmap())
})

test('the built landing page lists each roadmap item once (rebuild with `node landing/build.mjs`)', () => {
  const html = read('landing/public/index.html')
  const block = html.slice(html.indexOf('<ul class="roadmap">'), html.indexOf('</ul>', html.indexOf('<ul class="roadmap">')))
  for (const r of ROADMAP) assert.equal(block.split(`<strong>${r.title}</strong>`).length - 1, 1, r.title)
  assert.equal(block.split('<li>').length - 1, ROADMAP.length)
})

test('★ Codex is on by default, so both pages say what it changes and how to turn it off', () => {
  for (const [name, text] of [['README.md', read('README.md')], ['landing', read('landing/public/index.html')]]) {
    assert.match(text, /"codex": \{ "enabled": false \}/, name)
    assert.match(text, /User-Agent/, name)
    assert.match(text, /experimental/i, name)
  }
})
