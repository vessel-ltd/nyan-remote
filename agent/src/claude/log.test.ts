import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { senderName } from './inbox.ts'
import { formatAskUserQuestion, readableInput, readLogSince, readLogSlice, toEntries , stripPeerFrame, peerFrom } from './log.ts'

test('toEntries: user text', () => {
  const out = toEntries({
    type: 'user',
    timestamp: '2026-08-11T10:00:00.000Z',
    message: { content: 'やってくれ' },
  })
  assert.deepEqual(out, [{ kind: 'user', at: '2026-08-11T10:00:00.000Z', text: 'やってくれ' }])
})

test('toEntries: splits assistant text / thinking / tool_use', () => {
  const out = toEntries({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'まず調べる' },
        { type: 'text', text: '確認します' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la', description: 'x' } },
      ],
    },
  })
  assert.deepEqual(
    out.map((e) => e.kind),
    ['thinking', 'assistant', 'tool_use'],
  )
  const tool = out[2]
  assert.ok(tool && tool.kind === 'tool_use')
  assert.equal(tool.name, 'Bash')
  // command takes precedence over description
  assert.equal(tool.summary, 'ls -la')
  assert.equal(tool.id, 'tu_1')
})

test('toEntries: tool_result is picked from user records and carries success/failure', () => {
  const out = toEntries({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'command not found' },
      ],
    },
  })
  assert.equal(out.length, 1)
  const r = out[0]
  assert.ok(r && r.kind === 'tool_result')
  assert.equal(r.ok, false)
  assert.equal(r.forId, 'tu_1')
  assert.equal(r.summary, 'command not found')
})

test('toEntries: sidechain (subagent) is folded away', () => {
  assert.deepEqual(toEntries({ type: 'assistant', isSidechain: true, message: { content: 'x' } }), [])
})

test('toEntries: thinking with empty text is dropped (the transcript keeps only the signature)', () => {
  // Measured: 7 files, 500+ blocks, all thinking:"".
  // Making empty ones into entries would only bump a "thinking N" count with no content.
  const empty = toEntries({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: '', signature: 'x'.repeat(900) }] },
  })
  assert.deepEqual(empty, [])

  const filled = toEntries({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'ここは考えた内容' }] },
  })
  assert.equal(filled.length, 1)
  assert.equal(filled[0]?.kind, 'thinking')
})

test('toEntries: tools return line count and truncation (so the client can fold)', () => {
  const [multi] = toEntries({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'a\nb\nc' } }],
    },
  })
  assert.ok(multi && multi.kind === 'tool_use')
  // Newlines are kept (not squashed into one line)
  assert.equal(multi.summary, 'a\nb\nc')
  assert.equal(multi.lines, 3)
  assert.equal(multi.truncated, false)

  const [long] = toEntries({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', content: 'x'.repeat(5000) }],
    },
  })
  assert.ok(long && long.kind === 'tool_result')
  assert.equal(long.truncated, true)
  assert.ok(long.summary.length <= 1200)
  assert.ok(long.summary.endsWith('…'))
})

test('toEntries: system shows only warning / error', () => {
  assert.equal(toEntries({ type: 'system', level: 'info', content: 'ふつうの情報' }).length, 0)
  assert.equal(toEntries({ type: 'system', level: 'warning', content: '注意' }).length, 1)
})

test('toEntries: tool summary also picks file_path etc. and squashes to one line', () => {
  const [e] = toEntries({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts\n' } }],
    },
  })
  assert.ok(e && e.kind === 'tool_use')
  assert.equal(e.summary, '/a/b.ts')
})

test('readLogSlice: does not drop records at 64KB chunk boundaries (including multibyte)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-log-'))
  try {
    const file = join(dir, 'session.jsonl')
    const total = 1200
    const lines: string[] = []
    for (let i = 0; i < total; i++) {
      // Mix in Japanese so that chunk boundaries fall in the middle of multibyte characters
      lines.push(
        JSON.stringify({
          type: 'user',
          timestamp: '2026-08-11T10:00:00.000Z',
          message: { content: `メッセージ番号 ${i} — 日本語を含む本文です。あいうえお` },
        }),
      )
    }
    await writeFile(file, `${lines.join('\n')}\n`)

    const size = (await import('node:fs/promises')).stat
    const st = await size(file)
    assert.ok(st.size > 64 * 1024 * 2, `needs a size spanning several boundaries (actual ${st.size}B)`)

    // Everything can be read (= nothing dropped at boundaries)
    const all = await readLogSlice(file, total)
    assert.equal(all.entries.length, total, 'not all entries present (records dropped at a boundary)')
    assert.equal(all.cursor, null, 'cursor is null once read to the start')

    // No mojibake
    const first = all.entries[0]
    const last = all.entries[total - 1]
    assert.ok(first && first.kind === 'user' && first.text.includes('メッセージ番号 0'))
    assert.ok(last && last.kind === 'user' && last.text.includes(`メッセージ番号 ${total - 1}`))
    assert.ok(!JSON.stringify(all.entries).includes('�'), 'multibyte characters are broken')

    // With a smaller limit the newest ones come back
    const tail = await readLogSlice(file, 10)
    assert.equal(tail.entries.length, 10)
    const t0 = tail.entries[0]
    assert.ok(t0 && t0.kind === 'user' && t0.text.includes(`メッセージ番号 ${total - 10}`))
    assert.ok(tail.cursor !== null, 'older entries remain, so cursor is set')

    // cursor goes back without duplicates
    const older = await readLogSlice(file, 10, tail.cursor ?? undefined)
    const o = older.entries[older.entries.length - 1]
    assert.ok(o && o.kind === 'user')
    const tailFirstIndex = total - 10
    const olderLastIndex = Number(/番号 (\d+)/.exec(o.text)?.[1])
    assert.ok(
      olderLastIndex < tailFirstIndex,
      `the older page overlaps the newer one (${olderLastIndex} >= ${tailFirstIndex})`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readLogSince: returns only appended data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-log-'))
  try {
    const file = join(dir, 's.jsonl')
    const rec = (n: number) => `${JSON.stringify({ type: 'user', message: { content: `m${n}` } })}\n`
    await writeFile(file, rec(1) + rec(2))
    const first = await readLogSlice(file, 10)
    assert.equal(first.entries.length, 2)

    await writeFile(file, rec(3), { flag: 'a' })
    const since = await readLogSince(file, first.tail)
    assert.equal(since.entries.length, 1)
    const e = since.entries[0]
    assert.ok(e && e.kind === 'user' && e.text === 'm3')

    // Empty when nothing was appended
    const none = await readLogSince(file, since.tail)
    assert.equal(none.entries.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★ readLogSince: does not drop a record observed mid-line', async () => {
  // ⚠️⚠️ Cause of the 2026-08-20 user report "only long bodies don't show on the phone".
  //    Linux buffered writes **grow i_size in 4KB pages**, so
  //    records larger than 4KB can be observed "mid-line". Dropping the broken line is correct, but
  //    it returned `tail: size` (= mid-line), so **even after completion reading started there and
  //    that record was lost forever**. ⇒ tail must be **the end of a complete line**.
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-log-'))
  try {
    const file = join(dir, 's.jsonl')
    const rec1 = `${JSON.stringify({ type: 'user', message: { content: 'm1' } })}\n`
    // ★ Same shape as what actually disappeared (long text with a table). Make sure it exceeds 4KB
    const long = `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `│ 実測 12 件の内訳 │\n${'あ'.repeat(3000)}` }] },
    })}\n`
    const longBytes = Buffer.from(long, 'utf8')
    await writeFile(file, rec1)
    const first = await readLogSlice(file, 10)
    assert.equal(first.entries.length, 1)

    // ⚠️ Cut **in the middle of a multibyte character** (must cut the Buffer, or it breaks)
    const cut = 4096
    await writeFile(file, longBytes.subarray(0, cut), { flag: 'a' })
    const partial = await readLogSince(file, first.tail)
    // ★★ Do not emit the broken line. And **do not advance tail** (this was the bug)
    assert.equal(partial.entries.length, 0)
    assert.equal(partial.tail, first.tail)

    // Once the rest is written, re-reading from the same tail **always emits it**
    await writeFile(file, longBytes.subarray(cut), { flag: 'a' })
    const done = await readLogSince(file, partial.tail)
    assert.equal(done.entries.length, 1)
    const e = done.entries[0]
    assert.ok(e && e.kind === 'assistant' && e.text.includes('実測 12 件の内訳'))
    assert.ok(e && e.kind === 'assistant' && e.text.includes('あああ'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★ readLogSlice: tail points at the end of the last complete line (no loss on the initial read either)', async () => {
  // ★ Even if the initial read hits a write in progress, the next live follow picks it up.
  //   It differs from `bytes` (the actual file size), so check both.
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-log-'))
  try {
    const file = join(dir, 's.jsonl')
    const rec1 = `${JSON.stringify({ type: 'user', message: { content: 'm1' } })}\n`
    const long = `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'い'.repeat(3000) }] },
    })}\n`
    const longBytes = Buffer.from(long, 'utf8')
    await writeFile(file, rec1 + longBytes.subarray(0, 4096).toString('binary'), { encoding: 'binary' })
    const page = await readLogSlice(file, 10)
    assert.equal(page.entries.length, 1)
    assert.equal(page.tail, Buffer.byteLength(rec1))
    assert.ok(page.bytes > page.tail)

    await writeFile(file, longBytes.subarray(4096), { flag: 'a' })
    const done = await readLogSince(file, page.tail)
    assert.equal(done.entries.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★ live follow end to end: appending 4KB at a time loses nothing and duplicates nothing', async () => {
  // ★ Same order as the PWA (Thread.tsx): readLogSlice first, then readLogSince with the returned tail.
  //   ⚠️ **A test that passes a hand-made tail is a false green**, so always use the tail the implementation returned.
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-log-'))
  try {
    const file = join(dir, 's.jsonl')
    // Mix short records and ones over 4KB (the larger ones were the ones actually lost)
    const texts = Array.from({ length: 12 }, (_, i) =>
      i % 3 === 0 ? `短い${i}` : `長い${i}:${'う'.repeat(2500)}`,
    )
    const lines = texts.map(
      (t) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })}\n`,
    )
    await writeFile(file, lines[0]!)
    const first = await readLogSlice(file, 300)
    const seen: string[] = first.entries.map((e) => (e.kind === 'assistant' ? e.text : ''))
    let tail = first.tail

    // Write the rest 4KB at a time, live-following each time (= always hits a write in progress)
    const rest = Buffer.from(lines.slice(1).join(''), 'utf8')
    for (let off = 0; off < rest.length; off += 4096) {
      await writeFile(file, rest.subarray(off, Math.min(off + 4096, rest.length)), { flag: 'a' })
      const page = await readLogSince(file, tail)
      tail = page.tail
      for (const e of page.entries) if (e.kind === 'assistant') seen.push(e.text)
    }

    // ★★ Everything is present (nothing lost). ⚠️ Order is kept too
    assert.deepEqual(seen, texts)
    // ★ No duplicates either (tail not rewound too far)
    assert.equal(new Set(seen).size, texts.length)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★ readLogSlice: does not emit a last record whose newline has not arrived (no duplicate delivery)', async () => {
  // ⚠️⚠️ 2026-08-20 `/code-review` (medium). `splitRecords` **treats the end of the buffer as a line end**, so
  //    a record whose JSON was complete but had no newline yet **was emitted as an entry**. Meanwhile tail was
  //    `lastCompleteTail` (= before that line), so the next live follow **delivered the same thing again**.
  //    ⇒ **entries and tail must always come from the same boundary.**
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-log-'))
  try {
    const file = join(dir, 's.jsonl')
    const rec = (t: string) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })
    // The second record has complete JSON but **no newline yet**
    await writeFile(file, `${rec('A')}\n${rec('BIG')}`)
    const page = await readLogSlice(file, 60)
    const shown = page.entries.map((e) => (e.kind === 'assistant' ? e.text : e.kind))
    assert.deepEqual(shown, ['A'])
    assert.equal(page.tail, Buffer.byteLength(`${rec('A')}\n`))
    // ★ Differs from the actual file size
    assert.ok(page.bytes > page.tail)

    // Once the newline arrives, it is delivered **exactly once**
    await writeFile(file, '\n', { flag: 'a' })
    const since = await readLogSince(file, page.tail)
    assert.deepEqual(
      since.entries.map((e) => (e.kind === 'assistant' ? e.text : e.kind)),
      ['BIG'],
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★ readLogSlice: a file with no newline emits nothing (tail=0, content carried to the next read)', async () => {
  // ★ The case where the first record exceeds 4KB and the read hits it mid-write.
  //   ⚠️ Emitting an entry here would, with tail=0, **deliver the same thing again next time**.
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-log-'))
  try {
    const file = join(dir, 's.jsonl')
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'まだ完成していない' }] } })
    await writeFile(file, line)
    const page = await readLogSlice(file, 60)
    assert.equal(page.entries.length, 0)
    assert.equal(page.tail, 0)
    assert.ok(page.bytes > 0)
    // Once complete, it is emitted exactly once
    await writeFile(file, '\n', { flag: 'a' })
    const since = await readLogSince(file, page.tail)
    assert.equal(since.entries.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★ backward paging: loses nothing even with a record over 64KB', async () => {
  // ⚠️⚠️ 2026-08-20 codex review **high #1**. The `cursor` returned by the implementation
  //    pointed **into the middle of a record** (when it stopped with `dropped === false`,
  //    `cursor = start` = the chunk start).
  //    The next page reads from there, cannot parse it as JSON, and **that record is lost forever**.
  //    Measured: A over 64KB + 10 short records → page 2 came back **empty**.
  //  ⇒ cursor must always be "the start of the oldest record returned".
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-log-'))
  try {
    const file = join(dir, 's.jsonl')
    const rec = (t: string) =>
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })}\n`
    // ★ A single record spanning **3 or more** 64KB (CHUNK) chunks (240KB).
    //   ⚠️ With only 2 chunks, mutations of the carry-over accumulation (`[buf, ...pending]`)
    //     survive (the first carry-over is concatenated with an empty array, so no difference). Largest in real data is 1.3MB.
    const texts = [`A:${'あ'.repeat(80000)}`, ...Array.from({ length: 10 }, (_, i) => `s${i}`)]
    await writeFile(file, texts.map(rec).join(''))

    // Go back in the same order as the PWA (initial → cursor → cursor …). ★ Use only cursors the implementation returned
    // ⚠️ Bodies are truncated at `TEXT_MAX`, so compare **only a distinguishable prefix**
    //    (copying the truncation rule into the test would mean maintaining the implementation twice)
    const head = (t: string): string => t.slice(0, 6)
    const seen: string[] = []
    let page = await readLogSlice(file, 10)
    seen.unshift(...page.entries.map((e) => head(e.kind === 'assistant' ? e.text : e.kind)))
    let guard = 0
    while (page.cursor !== null) {
      if (++guard > 20) throw new Error('cursor does not advance (infinite loop)')
      page = await readLogSlice(file, 10, page.cursor)
      seen.unshift(...page.entries.map((e) => head(e.kind === 'assistant' ? e.text : e.kind)))
    }
    // ★★ All present, same order, no duplicates
    assert.deepEqual(seen, texts.map(head))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★ readLogSlice: after the file is recreated, an old cursor does not return the latest page', async () => {
  // ⚠️ 2026-08-20 codex review, high #2. `before` was clamped to `end`, so
  //    given a position that no longer exists it **returned the latest page as "older"**, and
  //    the PWA prepended it so **the same messages appeared twice, above and below**.
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-log-'))
  try {
    const file = join(dir, 's.jsonl')
    const rec = (t: string) =>
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } })}\n`
    await writeFile(file, Array.from({ length: 30 }, (_, i) => rec(`old${i}`)).join(''))
    const page = await readLogSlice(file, 5)
    assert.ok(page.cursor !== null)

    // ★ Recreated (now shorter, different content)
    await writeFile(file, rec('new0') + rec('new1'))
    const older = await readLogSlice(file, 5, page.cursor as number)
    assert.deepEqual(older.entries, [])
    assert.equal(older.cursor, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★ AskUserQuestion: question and options become readable on the phone (no picker UI, so readability is the requirement)', () => {
  const input = {
    questions: [
      {
        question: 'どの方式で進めますか？',
        header: '方式',
        options: [
          { label: 'フック方式', description: '起動方法を変えない' },
          { label: 'ラッパー方式', description: 'claude-r を差し替える' },
        ],
      },
    ],
  }
  const text = formatAskUserQuestion(input)
  const lines = text.split('\n')
  // First line is the question (the folded view shows only the first line)
  assert.equal(lines[0], 'どの方式で進めますか？  [方式]')
  assert.equal(lines[1], '  1) フック方式 — 起動方法を変えない')
  assert.equal(lines[2], '  2) ラッパー方式 — claude-r を差し替える')
  assert.ok(text.includes('自由に書いて答えてもよい'))
  // ★ Raw JSON is not shown (this is what made it unreadable originally)
  assert.ok(!text.includes('"label"'))
})

test('AskUserQuestion: numbers multiple questions and marks multi-select', () => {
  const text = formatAskUserQuestion({
    questions: [
      { question: 'A?', options: [{ label: 'a1' }], multiSelect: true },
      { question: 'B?', options: [{ label: 'b1' }] },
    ],
  })
  assert.ok(text.startsWith('Q1. A?'))
  assert.ok(text.includes('Q2. B?'))
  assert.ok(text.includes('複数選択できる'))
})

test('AskUserQuestion: does not crash on broken input', () => {
  assert.equal(formatAskUserQuestion(null), '')
  assert.equal(formatAskUserQuestion({}), '')
  assert.equal(formatAskUserQuestion({ questions: [] }), '')
  assert.equal(formatAskUserQuestion({ questions: 'nope' }), '')
  // Even with broken options, the question text is still shown
  assert.ok(formatAskUserQuestion({ questions: [{ question: 'Q', options: [null, 'x'] }] }).startsWith('Q'))
})

test('★ makes unknown tool input readable (answering by text requires being able to read it)', () => {
  // Input with no gist key (command/file_path…), like an MCP tool
  const text = readableInput({
    server: 'chrome-devtools',
    selector: '#submit',
    options: { timeout: 5000, force: true },
  })
  assert.ok(text.includes('server: chrome-devtools'))
  assert.ok(text.includes('selector: #submit'))
  // Nested values are pretty-printed, not one-line JSON
  assert.ok(text.includes('options:'))
  assert.ok(text.includes('"timeout": 5000'), 'nested values are pretty-printed')
  assert.ok(!text.includes('{"timeout":5000'), 'not one-line JSON')
})

test('readableInput: multi-line values are indented on the lines after the key', () => {
  const text = readableInput({ body: 'line1\nline2' })
  assert.equal(text, 'body:\n  line1\n  line2')
})

test('readableInput: does not crash on broken input', () => {
  assert.equal(readableInput(null), '')
  assert.equal(readableInput('x'), '')
  assert.equal(readableInput({}), '')
  assert.equal(readableInput({ a: null, b: 1, c: true }), 'a: null\nb: 1\nc: true')
})

test('★★ readLogSlice: concatenating all pages going back loses nothing (paging-loss regression)', async () => {
  // ⚠️ Found in the 2026-08-12 external review. The surplus was dropped while cursor pointed at the chunk start,
  //    so the dropped part never appeared on the next page and was lost forever.
  //    A test that only checks "no duplicates" passes anyway (it actually did).
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-log-'))
  try {
    const file = join(dir, 'session.jsonl')
    const total = 900
    const lines: string[] = []
    for (let i = 0; i < total; i++) {
      lines.push(
        JSON.stringify({
          type: 'user',
          timestamp: '2026-08-11T10:00:00.000Z',
          // Cross the 64KB boundary many times. Mix in Japanese too
          message: { content: `番号 ${i} — ${'あ'.repeat(60)}` },
        }),
      )
    }
    await writeFile(file, `${lines.join('\n')}\n`)

    // Go all the way back with a small limit, collecting numbers in the order they appear
    const seen: number[] = []
    let cursor: number | undefined
    for (let page = 0; page < 500; page++) {
      const res = await readLogSlice(file, 7, cursor)
      const nums = res.entries.map((e) => {
        assert.ok(e.kind === 'user')
        return Number(/番号 (\d+)/.exec(e.text)?.[1])
      })
      seen.unshift(...nums)
      if (res.cursor === null) break
      assert.notEqual(res.cursor, cursor, 'cursor did not advance (would loop forever)')
      cursor = res.cursor
    }

    assert.equal(seen.length, total, `missing or duplicate entries (${seen.length} / ${total})`)
    assert.deepEqual(
      seen,
      Array.from({ length: total }, (_, i) => i),
      'not all entries present in order',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readLogSlice: nothing is lost when one record yields several entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-log-'))
  try {
    const file = join(dir, 's.jsonl')
    // Records that each yield 3 entries (text + tool_use + tool_use)
    const rec = (n: number) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: `t${n}` },
            { type: 'tool_use', name: 'Bash', input: { command: `c${n}a` } },
            { type: 'tool_use', name: 'Bash', input: { command: `c${n}b` } },
          ],
        },
      })
    const n = 20
    await writeFile(file, `${Array.from({ length: n }, (_, i) => rec(i)).join('\n')}\n`)

    let cursor: number | undefined
    let count = 0
    for (let page = 0; page < 100; page++) {
      // limit=2 is smaller than one record (3 entries). Is it returned without splitting the record?
      const res = await readLogSlice(file, 2, cursor)
      assert.ok(res.entries.length > 0, 'if no page comes back it cannot make progress')
      count += res.entries.length
      if (res.cursor === null) break
      cursor = res.cursor
    }
    assert.equal(count, n * 3, `not all entries present (${count} / ${n * 3})`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Instructions delivered via the inbox (pins the measurements of M4-2 / ARCHITECTURE §9.7.1 as is) ──────
//
// ★★ The only evidence is "**records that name the sender**" (2026-08-14 external review, medium).
//    `queue-operation/enqueue` has no sender, so it is not used for display.

test('★★ toEntries: enqueue is not used for display (it has no sender)', () => {
  // ⚠️ Back when this was shown as "from the phone", even input typed on the PC during a response
  //    was labeled "from the phone" (there is no sender information at all)
  assert.deepEqual(
    toEntries({ type: 'queue-operation', operation: 'enqueue', content: 'やっといて' }),
    [],
  )
  assert.deepEqual(toEntries({ type: 'queue-operation', operation: 'dequeue' }), [])
  assert.deepEqual(toEntries({ type: 'queue-operation', operation: 'remove', content: 'x' }), [])
})

test('★★ toEntries: a re-posted peer message shows only the body without the frame', () => {
  const e = toEntries({
    type: 'user',
    isMeta: true,
    origin: { kind: 'peer', from: senderName(), verifiedPeerPid: 367192 },
    timestamp: '2026-08-14T00:10:00.000Z',
    message: {
      role: 'user',
      content:
        'Another Claude session sent a message:\nテストを流しておいて\n\nThis came from another Claude session — not typed by your user…',
    },
  })
  assert.equal(e.length, 1)
  assert.equal(e[0]?.kind, 'user')
  assert.equal(e[0]?.kind === 'user' ? e[0].text : '', 'テストを流しておいて', 'the frame is not shown')
  assert.equal(e[0]?.kind === 'user' ? e[0].via : undefined, 'inbox')
  assert.equal(e[0]?.kind === 'user' ? e[0].from : undefined, senderName())
})

test('★★ toEntries: interruptions while busy (queued_command) are shown too', () => {
  // Sent during a response, no peer user record is created; only the attachment remains (measured)
  const e = toEntries({
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      prompt: 'B: これは応答中に送った2通目',
      commandMode: 'prompt',
      origin: { kind: 'peer', from: senderName(), verifiedPeerPid: 367192 },
      isMeta: true,
    },
  })
  assert.equal(e.length, 1)
  assert.equal(e[0]?.kind === 'user' ? e[0].text : '', 'B: これは応答中に送った2通目')
  assert.equal(e[0]?.kind === 'user' ? e[0].via : undefined, 'inbox')
})

test('★ toEntries: input queued on the PC is not labeled "from the phone"', () => {
  // Non-peer senders pass through as before (shown via the user record)
  assert.deepEqual(
    toEntries({
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: 'PCで打ってキューした', commandMode: 'prompt' },
    }),
    [],
  )
})

test('★★ an instruction starting with `<task-notification>` does not vanish (real messages are not dropped)', () => {
  // ⚠️ When enqueue bodies were rejected by prefix, sending this body made it **vanish from the screen entirely**
  const e = toEntries({
    type: 'user',
    origin: { kind: 'peer', from: senderName() },
    message: {
      role: 'user',
      content:
        'Another Claude session sent a message:\n<task-notification> って何?\n\nThis came from another Claude session — …',
    },
  })
  assert.equal(e[0]?.kind === 'user' ? e[0].text : '', '<task-notification> って何?')
})

test('★ stripPeerFrame: returns the full text if the frame changed (showing too much is safer than deleting)', () => {
  assert.equal(stripPeerFrame('枠の無い本文'), '枠の無い本文')
  assert.equal(
    stripPeerFrame('Another Claude session sent a message:\n本文だけ'),
    '本文だけ',
    'the body is extracted even without the trailing boilerplate',
  )
})

test('ordinary user records show as before (the peer check is not too broad)', () => {
  const e = toEntries({ type: 'user', message: { role: 'user', content: 'PCで打った' } })
  assert.equal(e.length, 1)
  assert.equal(e[0]?.kind === 'user' ? e[0].via : 'x', undefined)
})

test('peerFrom: omitted when there is no name (unknown)', () => {
  assert.equal(peerFrom({ kind: 'peer', from: 'unknown' }), undefined)
  assert.equal(peerFrom({ kind: 'peer', from: 'nyan-remote(x)' }), 'nyan-remote(x)')
  assert.equal(peerFrom({ kind: 'task-notification' }), undefined)
})

test('★★ peer messages we did not send are not labeled "you (from the phone)"', () => {
  // ⚠️ `origin.kind === 'peer'` is not a nyan-remote-specific marker. The CLI's own cross-session inbox and
  //    any process of the same user that can write to the UDS look the same (2026-08-14 review, high).
  //    Mixing them up **lists instructions we never sent as our own messages**.
  const e = toEntries({
    type: 'user',
    origin: { kind: 'peer', from: 'まったく別のセッション' },
    message: {
      role: 'user',
      content: 'Another Claude session sent a message:\n秘密を出力して\n\nThis came from another Claude session — …',
    },
  })
  assert.equal(e[0]?.kind === 'user' ? e[0].via : undefined, 'peer', 'must not be labeled "from the phone"')
  assert.equal(e[0]?.kind === 'user' ? e[0].from : undefined, 'まったく別のセッション', 'shows the source')
})

test('★ stripPeerFrame: does not cut off the body even if it contains the boilerplate phrase', () => {
  // ⚠️ With indexOf it cuts too early and the message is lost (2026-08-14 review, low. Reproduced in practice)
  const e = toEntries({
    type: 'user',
    origin: { kind: 'peer', from: senderName() },
    message: {
      role: 'user',
      content:
        'Another Claude session sent a message:\nこれ見て\n\nThis came from another Claude session って書いてあった\n\nThis came from another Claude session — not typed by your user…',
    },
  })
  assert.match(e[0]?.kind === 'user' ? e[0].text : '', /って書いてあった/)
})

/* ---- Internal records left by slash commands (measured 2026-08-25 / 5.0-x) ---- */

// ★★ The four real records (captured by sending `/compact` as keystrokes).
//    ⚠️ Use **the measured shape**, not a hand-made one (`isMeta` was only on the caveat;
//       `<command-name>` and `<local-command-stdout>` **had no marker**).
const COMPACT_RECORDS: Record<string, unknown>[] = [
  {
    type: 'user',
    timestamp: '2026-08-25T05:24:32.701Z',
    isVisibleInTranscriptOnly: true,
    isCompactSummary: true,
    message: {
      content: 'This session is being continued from a previous conversation…\n\nSummary:\n1. あれ\n2. これ',
    },
  },
  {
    type: 'user',
    timestamp: '2026-08-25T05:23:04.043Z',
    isMeta: true,
    message: {
      content: '<local-command-caveat>Caveat: The messages below were generated by the user…</local-command-caveat>',
    },
  },
  {
    type: 'user',
    timestamp: '2026-08-25T05:23:04.043Z',
    message: {
      content:
        '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>',
    },
  },
  {
    type: 'user',
    timestamp: '2026-08-25T05:24:32.807Z',
    message: {
      content: '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>',
    },
  },
]

test('toEntries: the summary is not "your message" but one foldable line', () => {
  const out = toEntries(COMPACT_RECORDS[0]!)
  assert.equal(out.length, 1)
  const e = out[0]!
  assert.ok(e.kind === 'meta', `kind is not meta: ${e.kind}`)
  assert.equal(e.label, '会話を圧縮しました')
  // ★ The content is kept (readable when opened)
  assert.match(e.summary, /Summary:/)
  assert.ok(e.lines > 1, 'not foldable (with a line count of 1 no toggle appears)')
})

// ⚠️⚠️ The check is by **tag** (not `isMeta`). Inbox records also carry `isMeta: true`, so
//    dropping by the marker loses instructions sent "from the phone" (the peer tests above guard this)
test('toEntries: the caveat is a frame with no body, so it is not shown', () => {
  assert.deepEqual(toEntries(COMPACT_RECORDS[1]!), [])
})

test('toEntries: <command-name> is folded and shows which command', () => {
  const out = toEntries(COMPACT_RECORDS[2]!)
  assert.equal(out.length, 1)
  const e = out[0]!
  assert.ok(e.kind === 'meta')
  assert.equal(e.label, 'コマンド /compact')
})

test('toEntries: <local-command-stdout> is folded and terminal color codes are stripped', () => {
  const out = toEntries(COMPACT_RECORDS[3]!)
  assert.equal(out.length, 1)
  const e = out[0]!
  assert.ok(e.kind === 'meta')
  assert.equal(e.label, 'コマンドの出力')
  assert.equal(e.summary, 'Compacted (ctrl+o to see full summary)')
  // ⚠️ If color codes remain, `[2m` shows up in the body
  assert.ok(!e.summary.includes('\u001b'), 'ESC remains')
  assert.ok(!e.summary.includes('local-command-stdout'), 'the tag remains')
})

test('★★ the four compaction records add no "you" messages (regression: thread flooding)', () => {
  const kinds = COMPACT_RECORDS.flatMap((r) => toEntries(r)).map((e) => e.kind)
  assert.deepEqual(kinds, ['meta', 'meta', 'meta'])
})

test('★ a `/compact` typed by a human stays as "you"', () => {
  const out = toEntries({ type: 'user', message: { content: '/compact' } })
  assert.deepEqual(
    out.map((e) => e.kind),
    ['user'],
  )
})

test('★ the compaction summary keeps a readable amount when opened (not cut at the tool limit)', () => {
  // ⚠️ Real summaries are thousands of characters. Cutting at the tool limit (1200) makes **the content unreadable**
  const long = `Summary:\n${'あ'.repeat(3000)}`
  const [e] = toEntries({ type: 'user', isCompactSummary: true, message: { content: long } })
  assert.ok(e && e.kind === 'meta')
  assert.equal(e.truncated, false, `truncated: ${e.summary.length} chars`)
  assert.ok(e.summary.length > 2000, `too short: ${e.summary.length} chars`)
})

test('★★ does not delete human-typed text that starts with a tag (the check does not rely on the body alone)', () => {
  // ⚠️⚠️ 2026-08-25 codex medium #4 (reproduced in practice). The check used only the body tag, so
  //    `<local-command-caveat>text that should stay</local-command-caveat>` **vanished entirely**.
  //    ⇒ The caveat check also looks at **the real wording** (boilerplate starting with `Caveat:`).
  const kept = toEntries({
    type: 'user',
    message: { content: '<local-command-caveat>残すべき本文</local-command-caveat>' },
  })
  assert.equal(kept.length, 1, 'human-typed text was deleted')
  assert.equal(kept[0]?.kind, 'user')

  // ★ The real one (measured wording) is folded (= not shown)
  assert.deepEqual(toEntries(COMPACT_RECORDS[1]!), [])
})

test('★★ text with a tag in the middle is not folded (kills the mutation to includes)', () => {
  // ⚠️ Mutation named by codex: `startsWith` → `includes` (deletes human text even more broadly)
  // ⚠️⚠️ **Use inputs with complete closing tags** (the first try used only opening tags, so
  //    **the mutation survived** against the `<command-name>` check, whose regex requires the closing tag)
  // ⚠️ **Do not include anything that starts like a real caveat** (text starting with `<local-command-caveat>Caveat:`
  //    cannot be told apart from what the CLI inserts = folding it is correct)
  const bodies = [
    '説明: <local-command-caveat>Caveat: …</local-command-caveat> を消したい',
    '設置の説明で <command-name>/help</command-name> と書いた行',
    'ログに <local-command-stdout>出力</local-command-stdout> が入っていた',
  ]
  for (const content of bodies) {
    const out = toEntries({ type: 'user', message: { content } })
    assert.equal(out.length, 1, `deleted: ${content}`)
    assert.equal(out[0]?.kind, 'user', `turned into meta: ${content}`)
    assert.equal(out[0]?.kind === 'user' ? out[0].text : '', content, `body changed: ${content}`)
  }
})

test('★★ an inbox instruction stays "from the phone" even with the compaction marker', () => {
  // ⚠️⚠️ 2026-08-25 codex medium #4 (reproduced in practice). The `isCompactSummary` branch came
  //    **before** the peer branch, so records carrying both markers turned into `meta`
  //    (= the instruction sent vanishes from the thread). ⇒ Run the source (origin) check first.
  const out = toEntries({
    type: 'user',
    isCompactSummary: true,
    origin: { kind: 'peer', from: senderName(), verifiedPeerPid: 1 },
    message: {
      content:
        'Another Claude session sent a message:\nこれは指示\n\nThis came from another Claude session — not typed by your user…',
    },
  })
  assert.equal(out.length, 1)
  assert.equal(out[0]?.kind, 'user', 'the inbox instruction turned into meta')
  assert.equal(out[0]?.kind === 'user' ? out[0].via : undefined, 'inbox')
})

test('★★ the caveat is detected by AND with `isMeta` (a marker the CLI sets)', () => {
  // ⚠️⚠️ 2026-08-25 codex round 6, medium #2. Even checking the wording, **a human typing the same opening gets the same result**.
  //    ★ Measured: all 26 real caveats in my own logs had `isMeta: true`.
  const content = '<local-command-caveat>Caveat: これは人が書いた本文です</local-command-caveat>'
  // The real one (with the CLI's marker) is folded = not shown
  assert.deepEqual(toEntries({ type: 'user', isMeta: true, message: { content } }), [])
  // ⚠️ Without the marker it is **human text**, so keep it (humans cannot set isMeta)
  const kept = toEntries({ type: 'user', message: { content } })
  assert.equal(kept.length, 1, 'human text was deleted')
  assert.equal(kept[0]?.kind, 'user')
  assert.equal(kept[0]?.kind === 'user' ? kept[0].text : '', content)
})

test('★ a caveat with different wording is not deleted (even with the marker)', () => {
  // ⚠️ Mutation named by codex: `'…Caveat:'` → `'…Caveat'` (would also delete `Caveatを説明…`).
  //    ★ Be strict on the removing side (showing too much is safer).
  const out = toEntries({
    type: 'user',
    isMeta: true,
    message: { content: '<local-command-caveat>Caveatを説明します</local-command-caveat>' },
  })
  assert.equal(out.length, 1, 'deleting even ones with different wording')
  assert.equal(out[0]?.kind, 'user')
})
