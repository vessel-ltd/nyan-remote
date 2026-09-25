import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBlocks, parseInline, safeHref } from './markdown-parse.ts'

test('safeHref: allows only http/https and relative paths', () => {
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a')
  assert.equal(safeHref('http://example.com'), 'http://example.com')
  assert.equal(safeHref('/docs/HANDOFF.md'), '/docs/HANDOFF.md')
  assert.equal(safeHref('#/s/abc'), '#/s/abc')
})

test('safeHref: rejects dangerous schemes (the core of the XSS defense)', () => {
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref('JavaScript:alert(1)'), null)
  assert.equal(safeHref('  javascript:alert(1)  '), null)
  assert.equal(safeHref('data:text/html,<script>alert(1)</script>'), null)
  assert.equal(safeHref('vbscript:msgbox(1)'), null)
  assert.equal(safeHref('file:///etc/passwd'), null)
  // Protocol-relative goes off-site, so reject
  assert.equal(safeHref('//evil.example/x'), null)
  assert.equal(safeHref(''), null)
})

test('parseInline: code / bold / em / strike / link', () => {
  assert.deepEqual(parseInline('これは `code` です'), [
    { t: 'text', v: 'これは ' },
    { t: 'code', v: 'code' },
    { t: 'text', v: ' です' },
  ])
  assert.deepEqual(parseInline('**太字**と*斜体*と~~打消~~'), [
    { t: 'bold', v: '太字' },
    { t: 'text', v: 'と' },
    { t: 'em', v: '斜体' },
    { t: 'text', v: 'と' },
    { t: 'strike', v: '打消' },
  ])
  assert.deepEqual(parseInline('[docs](https://example.com)'), [
    { t: 'link', v: 'docs', href: 'https://example.com' },
  ])
})

test('parseInline: dangerous links get a null href', () => {
  // A ')' in the URL shifts the closing paren and leaves the tail as plain text (a common
  // Markdown ambiguity). What we want to guard is "no dangerous scheme in href", so
  // check the property rather than an exact token sequence.
  for (const src of [
    '[押すな](javascript:alert(1))',
    '[押すな](javascript:alert)',
    '[x](data:text/html,hi)',
    '[y](//evil.example/z)',
  ]) {
    const tokens = parseInline(src)
    const links = tokens.filter((t) => t.t === 'link')
    assert.ok(links.length > 0, `not parsed as a link: ${src}`)
    for (const l of links) {
      assert.equal(l.t === 'link' ? l.href : 'x', null, `href is not null: ${src}`)
    }
  }
})

test('parseInline: HTML-like strings are treated as plain text', () => {
  // The renderer passes them as JSX children, so they are escaped. Here we only check the structure
  const tokens = parseInline('<img src=x onerror="alert(1)">')
  assert.deepEqual(tokens, [{ t: 'text', v: '<img src=x onerror="alert(1)">' }])
})

test('parseBlocks: heading / paragraph / rule', () => {
  const blocks = parseBlocks('# 見出し\n\n本文です\nつづき\n\n---\n')
  assert.deepEqual(blocks, [
    { t: 'h', level: 1, text: '見出し' },
    { t: 'p', text: '本文です\nつづき' },
    { t: 'hr' },
  ])
})

test('parseBlocks: code fence (everything inside except ``` is kept as is)', () => {
  const blocks = parseBlocks('```bash\nls -la\necho "# これは見出しではない"\n```')
  assert.deepEqual(blocks, [{ t: 'pre', lang: 'bash', code: 'ls -la\necho "# これは見出しではない"' }])
})

test('parseBlocks: bullets and numbered lists, one level of nesting', () => {
  const blocks = parseBlocks('- 一つ\n- 二つ\n  - 子\n')
  assert.deepEqual(blocks, [
    {
      t: 'list',
      ordered: false,
      items: [
        { depth: 0, text: '一つ' },
        { depth: 0, text: '二つ' },
        { depth: 1, text: '子' },
      ],
    },
  ])
  const ol = parseBlocks('1. 最初\n2. 次')
  assert.equal(ol[0]?.t, 'list')
  assert.ok(ol[0]?.t === 'list' && ol[0].ordered)
})

test('parseBlocks: table', () => {
  const blocks = parseBlocks('| 項目 | 値 |\n|---|---|\n| a | 1 |\n| b | 2 |')
  assert.deepEqual(blocks, [
    {
      t: 'table',
      header: ['項目', '値'],
      rows: [
        ['a', '1'],
        ['b', '2'],
      ],
    },
  ])
})

test('parseBlocks: quotes are parsed recursively', () => {
  const blocks = parseBlocks('> **重要**\n> つづき')
  assert.equal(blocks.length, 1)
  const q = blocks[0]
  assert.ok(q && q.t === 'quote')
  assert.deepEqual(q.blocks, [{ t: 'p', text: '**重要**\nつづき' }])
})

test('parseBlocks: does not confuse a rule with a bullet', () => {
  // '- item' is a list, '---' is a rule
  assert.equal(parseBlocks('---')[0]?.t, 'hr')
  assert.equal(parseBlocks('- 項目')[0]?.t, 'list')
})

test('parseBlocks: stops even without a closing fence (no infinite loop)', () => {
  const blocks = parseBlocks('```\nunterminated\n')
  assert.deepEqual(blocks, [{ t: 'pre', lang: '', code: 'unterminated\n' }])
})

test('★★ safeHref decides on what the browser parses: control characters, backslashes and hidden schemes are refused (codex security review)', () => {
  for (const bad of ['blob:https://base.invalid/id', '//base.invalid/x', 'https:x', 'https:/x', 'HTTP:x', '\u0001https:x', '\\/evil.example', 'a\u007fb',
    '\u0001javascript:alert(1)', '\u0000javascript:x', 'java\tscript:x', '/\\evil.example/x', '\\\\evil.example', 'https:\\\\evil.example', ' //evil.example', 'JAVASCRIPT:x', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', 'https://a\u0085b.example']) {
    assert.equal(safeHref(bad), null, JSON.stringify(bad))
  }
  // ★ codex's exact probe, through the parser
  const node = parseInline('[open report](\u0001javascript:alert%281%29)').find((n) => n.t === 'link')
  assert.ok(node && node.t === 'link' && node.href === null, '⚠️⚠️ javascript: reached href')
  for (const ok of ['https://example.com/a?b=c#d', 'http://example.com', '/docs/x', 'docs/x', '#top', '?q=1', '../up']) assert.equal(safeHref(ok), ok, ok)
})
