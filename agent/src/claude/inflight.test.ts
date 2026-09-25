import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, rm, utimes, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  alreadyInTranscript,
  inflightDir,
  INFLIGHT_MAX_CHARS,
  isSessionId,
  readInflight,
  sweepInflight,
} from './inflight.ts'

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const HOOK = join(import.meta.dirname, '..', '..', '..', 'hooks', 'message-display.sh')

/**
 * ★ Run the real hook (bash) and read the file the implementation produces.
 *
 * ⚠️ `env.TMPDIR` can be passed in. The hook's **escape hatch** (`$TMPDIR/…off`)
 *    looks at `/tmp` by default, so **it would affect other tests too** (it actually made them flaky).
 */
function fire(payload: Record<string, unknown>, env: Record<string, string> = {}): void {
  execFileSync(HOOK, { input: JSON.stringify(payload), env: { ...process.env, ...env } })
}

async function withState<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-inflight-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  }
}

test('★★ reads exactly what the hook wrote (bash and Node agree on the format)', async () => {
  // ⚠️ If these disagree, "the hook works but nothing shows".
  //    ⇒ **Do not make this a test that reads a hand-made file** (run the real hook)
  await withState(async () => {
    fire({ session_id: SID, index: 0, final: false, delta: '1行目\n' })
    fire({ session_id: SID, index: 1, final: false, delta: '2行目\n' })
    fire({ session_id: SID, index: 2, final: true, delta: '3行目' })
    const got = await readInflight(SID)
    assert.ok(got)
    assert.equal(got.text, '1行目\n2行目\n3行目')
    assert.equal(got.final, true)
    assert.ok(!Number.isNaN(Date.parse(got.at)))
  })
})

test('★★ truncates at index 0 (the previous message does not remain)', async () => {
  await withState(async () => {
    fire({ session_id: SID, index: 0, final: false, delta: '古いメッセージ' })
    fire({ session_id: SID, index: 1, final: true, delta: 'のつづき' })
    fire({ session_id: SID, index: 0, final: false, delta: '新しいメッセージ' })
    const got = await readInflight(SID)
    assert.equal(got?.text, '新しいメッセージ')
    assert.equal(got?.final, false)
  })
})

test('★★ does not touch anything not shaped like a session ID (path traversal)', async () => {
  await withState(async () => {
    fire({ session_id: '../../etc/passwd', index: 0, delta: 'わるいの' })
    // The hook creates no file
    let names: string[] = []
    try {
      names = await readdir(inflightDir())
    } catch {
      names = []
    }
    assert.deepEqual(names, [])
    // The reader rejects it too
    assert.equal(await readInflight('../../etc/passwd'), undefined)
    assert.equal(isSessionId('../../etc/passwd'), false)
    assert.equal(isSessionId(SID), true)
  })
})

test('★★ missing / empty / broken → undefined (no fabricated content / fail-closed)', async () => {
  await withState(async () => {
    assert.equal(await readInflight(SID), undefined)
    await mkdir(inflightDir(), { recursive: true })
    await writeFile(join(inflightDir(), `${SID}.jsonl`), '')
    assert.equal(await readInflight(SID), undefined)
    await writeFile(join(inflightDir(), `${SID}.jsonl`), '{壊れた\n')
    assert.equal(await readInflight(SID), undefined)
  })
})

test('★ clips at the limit (and shows that it clipped)', async () => {
  await withState(async () => {
    fire({ session_id: SID, index: 0, final: false, delta: 'あ'.repeat(INFLIGHT_MAX_CHARS + 500) })
    const got = await readInflight(SID)
    assert.equal(got?.text.length, INFLIGHT_MAX_CHARS)
    assert.equal(got?.clipped, true)
    assert.ok(got?.text.endsWith('…'))
  })
})

test('★★ not shown if already in the transcript (the same body does not appear twice)', () => {
  const text = 'n=100 の測定が完了しました。結果を issue に記録します。あと少し続きます。'
  const entries = [
    { kind: 'tool_result', text: 'なにか' },
    { kind: 'assistant', text: `${text}\nさらに続き` },
  ]
  assert.equal(alreadyInTranscript(text, entries), true)
  // A different body is shown
  assert.equal(alreadyInTranscript('まったく別の長い本文がここにあります', entries), false)
  // ★★ **Short remarks are hidden only on an exact match** (2026-08-21 codex, low #7).
  //    ⚠️ Short ones used to be hidden unconditionally, so `了解` and `続行。` never showed
  assert.equal(alreadyInTranscript('短', entries), false)
  assert.equal(alreadyInTranscript('了解', [{ kind: 'assistant', text: '了解' }]), true)
  assert.equal(alreadyInTranscript('了解', [{ kind: 'assistant', text: '了解しました。続けます' }]), false)
  // Empty is not shown
  assert.equal(alreadyInTranscript('   ', entries), true)
})

test('★★ a finished body is matched in full (not hidden just because it starts the same)', () => {
  // ⚠️ 2026-08-21 codex, medium #4. Only the first 4000 characters were compared, so
  //    in the "same opening, deciding detail afterwards" shape **the new explanation vanished**.
  const common = 'あ'.repeat(4200)
  const older = `${common}（前のメッセージの結論）`
  const newer = `${common}（新しい判断材料：これは危険です）`
  const entries = [{ kind: 'assistant', text: older }]
  // With final=true the whole text is compared, so it shows as different
  assert.equal(alreadyInTranscript(newer, entries, true), false)
  // The same one is hidden
  assert.equal(alreadyInTranscript(older, entries, true), true)
  // ⚠️ While streaming (final=false) the first 120 characters are compared, so the same opening is hidden (= wait until it grows)
  assert.equal(alreadyInTranscript(newer, entries, false), true)
})

test('★★ matching is not limited by distance (with parallel tools the body is 7+ entries back)', () => {
  // ⚠️ 2026-08-21 `/code-review`, medium #2. One assistant message becomes **one element per block**,
  //    so with parallel tool calls the body falls outside the last-6 window.
  //    ⇒ **The same explanation was shown twice throughout tool execution**.
  const text = '検証をスキーマから導出します（ハードコードすると宣言とズレるため）。'
  const entries = [
    { kind: 'assistant', text },
    { kind: 'tool_use', text: 'a' },
    { kind: 'tool_use', text: 'b' },
    { kind: 'tool_use', text: 'c' },
    { kind: 'tool_result', text: 'd' },
    { kind: 'tool_result', text: 'e' },
    { kind: 'tool_result', text: 'f' },
    { kind: 'tool_result', text: 'g' },
  ]
  assert.equal(alreadyInTranscript(text, entries), true)
})

test('★ short remarks are shown too (judged from 4 characters up)', () => {
  // ⚠️ It was 8 characters, so **one-liners right before an approval, like "進めます。", vanished** (same review, low #10)
  const entries = [{ kind: 'assistant', text: '前のメッセージ' }]
  assert.equal(alreadyInTranscript('進めます。', entries), false)
  // Hide it if it is already there
  assert.equal(alreadyInTranscript('前のメッセージ', entries), true)
})

test('★★ cleanup: never deletes files of live sessions (approvals can wait 24 hours)', async () => {
  await withState(async () => {
    fire({ session_id: SID, index: 0, final: false, delta: 'まだ待っている承認の説明' })
    const path = join(inflightDir(), `${SID}.jsonl`)
    // Even 49 hours old, keep it if the session is alive
    const old = new Date(Date.now() - 49 * 60 * 60 * 1000)
    await utimes(path, old, old)
    assert.equal(await sweepInflight(new Set([SID])), 0)
    assert.ok(await readInflight(SID))
    // Not alive & old → delete
    assert.equal(await sweepInflight(new Set()), 1)
    assert.equal(await readInflight(SID), undefined)
  })
})

test('★★ cleanup: keeps 24 hours even for sessions not in the list (the approval wait time)', async () => {
  // ⚠️ 2026-08-21 `/code-review`, low #8. Approvals can wait **24 hours**, but mtime does not
  //    advance while waiting. And "sessions with not a single transcript line" do not appear in the live list.
  //    ⇒ Deleting at 24 hours **deletes the body of an approval that is still waiting**.
  await withState(async () => {
    fire({ session_id: SID, index: 0, final: false, delta: '30時間前に流れた説明' })
    const path = join(inflightDir(), `${SID}.jsonl`)
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000)
    await utimes(path, old, old)
    assert.equal(await sweepInflight(new Set()), 0, 'not deleted at 30 hours')
    assert.ok(await readInflight(SID))
  })
})

test('★★ recounts when the message changes (the previous message does not mix in)', async () => {
  // ⚠️ 2026-08-21 `/code-review`, medium #4. Truncation relies on the `index: 0` write, so
  //    losing that one write means **the new body piles up as a continuation of the old one**. ⇒ Separate by `message_id`.
  await withState(async () => {
    fire({ session_id: SID, message_id: 'm1', index: 0, final: false, delta: '古いメッセージ' })
    fire({ session_id: SID, message_id: 'm1', index: 1, final: true, delta: 'のつづき' })
    fire({ session_id: SID, message_id: 'm2', index: 0, final: false, delta: '新しい説明' })
    fire({ session_id: SID, message_id: 'm2', index: 1, final: true, delta: 'のつづき' })
    const got = await readInflight(SID)
    assert.equal(got?.text, '新しい説明のつづき')
    assert.equal(got?.final, true)
  })
})

test('★★ a body with a missing head or skipped index is not shown (better nothing than a lie)', async () => {
  // ⚠️⚠️ 2026-08-21 codex, high #3. An explanation with a gap is not "read" but **a lie**.
  //    It would show, above the approval card, an explanation missing just the sentence "do not run this".
  //    ⚠️ `/code-review` medium #4 proposed "show the last message even if the head is lost", but
  //      **this took priority** (if nothing is shown, the person looks at the PC; a lie leads to a wrong decision).
  await withState(async () => {
    // Head missing (starts at index 1 = the hook was installed midway)
    fire({ session_id: SID, message_id: 'm1', index: 1, final: true, delta: '頭が無い説明' })
    assert.equal(await readInflight(SID), undefined)
  })
  await withState(async () => {
    // Gap in between (the index 1 write was lost)
    fire({ session_id: SID, message_id: 'm1', index: 0, final: false, delta: '前半' })
    fire({ session_id: SID, message_id: 'm1', index: 2, final: true, delta: '後半' })
    assert.equal(await readInflight(SID), undefined)
  })
})

test('★★ not shown if a middle line is broken (do not skip and carry on)', async () => {
  await withState(async () => {
    fire({ session_id: SID, message_id: 'm1', index: 0, final: false, delta: '前半' })
    // Put a broken line in the middle
    await writeFile(join(inflightDir(), `${SID}.jsonl`), '{壊れた\n', { flag: 'a' })
    fire({ session_id: SID, message_id: 'm1', index: 1, final: true, delta: '後半' })
    assert.equal(await readInflight(SID), undefined)
  })
})

test('★★ not shown if lines from another session are mixed in', async () => {
  // ⚠️ Same review, medium #6. Even if the hook's regex someday picks up a "nested session_id", it is rejected here
  await withState(async () => {
    fire({ session_id: SID, message_id: 'm1', index: 0, final: false, delta: '前半' })
    const other = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeFile(
      join(inflightDir(), `${SID}.jsonl`),
      `${JSON.stringify({ session_id: other, message_id: 'm1', index: 1, final: true, delta: 'よそのもの' })}\n`,
      { flag: 'a' },
    )
    assert.equal(await readInflight(SID), undefined)
  })
})

test('★★ hook: does not break on pretty-printed (multi-line) JSON', async () => {
  // ⚠️ 2026-08-21 `/code-review`, low #6. Writing it as-is **breaks the JSONL and makes it unreadable**.
  await withState(async () => {
    execFileSync(HOOK, {
      input: `{\n  "session_id": "${SID}",\n  "index": 0,\n  "delta": "整形でも動く"\n}`,
      env: { ...process.env },
    })
    assert.equal((await readInflight(SID))?.text, '整形でも動く')
  })
})

test('★★ hook: does nothing if the escape hatch (.off) exists', async () => {
  // ⚠️ It can be stopped without hand-editing settings (emergency measure when writes get stuck / same review, medium #3).
  //    ⚠️ It lives on tmpfs (on a stuck $HOME filesystem, stat itself would hang)
  await withState(async () => {
    // ⚠️ Put it in **a TMPDIR just for this test** (putting it in /tmp stops the hook for other tests too)
    const tmp = await mkdtemp(join(tmpdir(), 'nyan-remote-off-'))
    try {
      await writeFile(join(tmp, 'nyan-remote-inflight.off'), '')
      fire({ session_id: SID, index: 0, delta: '止まっているべき' }, { TMPDIR: tmp })
      assert.equal(await readInflight(SID), undefined)
    // Works again once removed
      await rm(join(tmp, 'nyan-remote-inflight.off'))
      fire({ session_id: SID, index: 0, delta: '動く' }, { TMPDIR: tmp })
      assert.equal((await readInflight(SID))?.text, '動く')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

test('★★★ hook: reads stdin to the end even with the escape hatch present (no EPIPE)', async () => {
  // ⚠️⚠️ 2026-08-23. With `.off` present it **exited without reading stdin**, so
  //    the writer (the CLI / this test) hit **a broken pipe**.
  //    ⚠️ It only failed under load (= flaky), reproduced 3 times out of 8.
  //    ⇒ With **a body larger than the pipe capacity (64KB)**, the write always blocks, so
  //      "exit without reading" **always** gives EPIPE. ⇒ The test becomes deterministic.
  //    ★ In production it is called every 0.7 seconds, so every use of the escape hatch would raise an error.
  await withState(async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'nyan-remote-off-big-'))
    try {
      await writeFile(join(tmp, 'nyan-remote-inflight.off'), '')
      const big = { session_id: SID, index: 0, delta: 'あ'.repeat(120_000) }
      // ⚠️ A throw here means EPIPE (= not read to the end)
      fire(big, { TMPDIR: tmp })
      assert.equal(await readInflight(SID), undefined, 'the escape hatch did not work (it wrote)')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

test('★ does not discard when the same index comes twice (duplicates lose nothing)', async () => {
  // ⚠️ 2026-08-21 `/code-review`, low #3. Unlike gaps, duplicates lose no information, so
  //    do not turn "slight overlap" into "nothing shown".
  await withState(async () => {
    fire({ session_id: SID, message_id: 'm', index: 0, final: false, delta: '前半' })
    fire({ session_id: SID, message_id: 'm', index: 1, final: true, delta: '後半' })
    // ⚠️ The hook **truncates** at `index: 0`, so firing the same index twice leaves no duplicate.
    //    ⇒ Write **directly to the file** to test the reader's tolerance (do not create a state where the test bypasses the implementation)
    await writeFile(
      join(inflightDir(), `${SID}.jsonl`),
      `${JSON.stringify({ session_id: SID, message_id: 'm', index: 1, final: true, delta: '後半' })}\n`,
      { flag: 'a' },
    )
    assert.equal((await readInflight(SID))?.text, '前半後半')
  })
})

test('★★ does not give up beyond 1MB (shows the head and says it clipped)', async () => {
  // ⚠️⚠️ 2026-08-21, both reviews. It used to fall back to `undefined`, so
  //    **the moment a long line came, the whole body vanished with no signal at all**
  //    (= the "silently stops showing" shape, compounded by the accident of the old body remaining).
  await withState(async () => {
    fire({ session_id: SID, message_id: 'm', index: 0, final: false, delta: 'あ'.repeat(30) })
    // Pile up past 1MB
    for (let i = 1; i <= 40; i++) {
      fire({ session_id: SID, message_id: 'm', index: i, final: i === 40, delta: 'い'.repeat(15000) })
    }
    const got = await readInflight(SID)
    assert.ok(got, 'did not give up')
    assert.ok(got.text.startsWith('あ'), 'has the head')
    assert.equal(got.clipped, true, 'says it clipped')
    assert.equal(got.final, false, 'does not claim "complete" when only partly read')
  })
})

test('★ does not split emoji when clipping at the limit', async () => {
  // ⚠️ 2026-08-21 `/code-review`, low #9. A naive cut puts a lone surrogate into the JSON,
  //    and U+FFFD appears on screen.
  await withState(async () => {
    const head = 'あ'.repeat(INFLIGHT_MAX_CHARS - 2)
    fire({ session_id: SID, index: 0, delta: `${head}🇯🇵🇯🇵` })
    const got = await readInflight(SID)
    assert.ok(got?.clipped)
    assert.ok(!/�/.test(got.text), 'broken characters appear')
    assert.ok(got.text.endsWith('…'))
  })
})

test('★ cleanup: keeps recent files even if not alive (not deleted right after exit)', async () => {
  await withState(async () => {
    fire({ session_id: SID, index: 0, final: true, delta: 'さっき終わったばかり' })
    assert.equal(await sweepInflight(new Set()), 0)
    assert.ok(await readInflight(SID))
  })
})
