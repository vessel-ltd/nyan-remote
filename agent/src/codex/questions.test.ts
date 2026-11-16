import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CodexApprovals, type QuestionReply } from './approvals.ts'
import { buildCodexAnswers, NONE_OF_THE_ABOVE, NOTE_PREFIX, parseUserInput, questionInteraction, type CodexQuestion } from './questions.ts'
import type { RpcId, RpcResult, ServerRequest } from './rpc.ts'

// ★ Verbatim from codex-cli 0.169.0 (Plan mode, joined with `thread/resume` / 2026-11-16)
const REAL = JSON.parse(readFileSync(new URL('./fixtures/request-user-input-0.169.0.json', import.meta.url), 'utf8')) as ServerRequest
const P = REAL.params as Record<string, unknown>
const T = P.threadId as string
const Q1 = 'ブログを作る主な目的は何ですか？'
const Q2 = 'Web開発の経験はどのくらいありますか？'
const Q3 = '記事はどの方法で書きたいですか？'

function req(over: Record<string, unknown> = {}, id: RpcId = 7): ServerRequest {
  return { id, method: REAL.method, params: { ...P, ...over } }
}
function withQuestion(i: number, over: Record<string, unknown>): ServerRequest {
  const qs = structuredClone(P.questions) as Record<string, unknown>[]
  qs[i] = { ...qs[i]!, ...over }
  return req({ questions: qs })
}

test('parse: the real request becomes a question with its ids, labels and "other"', () => {
  const q = parseUserInput(REAL)!
  assert.equal(q.requestId, 7)
  assert.equal(q.threadId, T)
  assert.equal(q.turnId, P.turnId)
  assert.equal(q.itemId, P.itemId)
  assert.deepEqual(
    q.questions.map((x) => [x.id, x.question, x.header, x.other, x.options.map((o) => o.label)]),
    [
      ['purpose', Q1, '目的', true, ['記事を書くこと（推奨）', '開発の学習', '仕事や作品の発信']],
      ['experience', Q2, '経験', true, ['ほぼ初めて', 'HTML・CSSは使える', 'プログラミング経験あり']],
      ['editing', Q3, '書き方', true, ['ブラウザの編集画面（推奨）', 'MarkdownとGit', 'まだ決まっていない']],
    ],
  )
  assert.equal(q.questions[0]!.options[0]!.description, '執筆と公開の手軽さを優先して技術を絞ります。')
})

test('parse: what we do not understand is left to the PC', () => {
  const not = (r: ServerRequest, why: string): void => assert.equal(parseUserInput(r), undefined, why)
  not({ ...REAL, method: 'item/commandExecution/requestApproval' }, 'another method')
  not({ id: 7, method: REAL.method, params: null }, 'no params')
  for (const k of ['threadId', 'turnId', 'itemId']) {
    not(req({ [k]: undefined }), `missing ${k}`)
    not(req({ [k]: 3 }), `non-string ${k}`)
  }
  not(req({ isBlocking: false }), 'does not block')
  not(req({ isBlocking: 'yes' }), 'blocking of the wrong type')
  not(req({ questions: [] }), 'no questions')
  not(req({ questions: 'x' }), 'questions not a list')
  not(withQuestion(1, { isSecret: true }), 'a secret question')
  not(withQuestion(1, { isSecret: 'no' }), 'secret of the wrong type')
  not(withQuestion(1, { options: null }), 'no options (free text only)')
  not(withQuestion(1, { options: [] }), 'empty options')
  not(withQuestion(1, { options: [{ label: '' }] }), 'an empty label')
  not(withQuestion(1, { options: [{ label: 'a' }, { label: 'a' }] }), 'two equal labels')
  not(withQuestion(1, { id: '' }), 'an empty id')
  not(withQuestion(1, { id: 'purpose' }), 'a duplicate id')
  not(withQuestion(1, { question: Q1 }), 'a duplicate question text (the phone keys by text)')
  not(withQuestion(1, { isOther: 'true' }), 'isOther of the wrong type')
  assert.ok(parseUserInput(req({ isBlocking: undefined })), 'missing blocking = blocking')
})

test('the card shows texts and labels, never the ids', () => {
  const i = questionInteraction(parseUserInput(withQuestion(2, { isOther: false }))!)
  assert.equal(i.kind, 'question')
  if (i.kind !== 'question') return
  assert.deepEqual(i.questions.map((x) => [x.question, x.multiSelect, x.note]), [
    [Q1, false, 'answer'],
    [Q2, false, 'answer'],
    [Q3, false, 'add'],
  ])
  assert.ok(!JSON.stringify(i).includes('purpose'), 'no id on the card')
})

const Q = parseUserInput(withQuestion(2, { isOther: false }))!

test('build: labels, a label with a note, and a note alone as the TUI sends them', () => {
  const b = buildCodexAnswers(Q, { [Q1]: ['開発の学習'], [Q3]: ['MarkdownとGit'] }, { [Q2]: '  Rust を少し  ', [Q3]: '画像も' })
  assert.deepEqual(b, {
    ok: true,
    result: {
      answers: {
        purpose: { answers: ['開発の学習'] },
        experience: { answers: [NONE_OF_THE_ABOVE, `${NOTE_PREFIX}Rust を少し`] },
        editing: { answers: ['MarkdownとGit', `${NOTE_PREFIX}画像も`] },
      },
    },
  })
  assert.equal(NONE_OF_THE_ABOVE, 'None of the above')
  assert.equal(NOTE_PREFIX, 'user_note: ')
})

test('build: anything off is refused, and nothing is built', () => {
  const all = { [Q1]: ['開発の学習'], [Q2]: ['ほぼ初めて'], [Q3]: ['MarkdownとGit'] }
  assert.equal(buildCodexAnswers(Q, all, undefined).ok, true)
  const no = (answers: unknown, notes: unknown, why: string): void => assert.equal(buildCodexAnswers(Q, answers, notes).ok, false, why)
  no({ ...all, [Q2]: [] }, undefined, 'a question left unanswered')
  no({ ...all, [Q2]: ['ほぼ初めて', 'HTML・CSSは使える'] }, undefined, 'two labels (no multi-select)')
  no({ ...all, [Q2]: ['something else'] }, undefined, 'a label that was not shown')
  no({ ...all, [Q2]: [5] }, undefined, 'a label of the wrong type')
  no({ ...all, [Q2]: 'ほぼ初めて' }, undefined, 'not a list')
  no({ ...all, other: ['x'] }, undefined, 'an unknown question')
  no(all, { other: 'x' }, 'a note for an unknown question')
  no({ [Q1]: ['開発の学習'], [Q2]: ['ほぼ初めて'] }, { [Q3]: 'これで' }, 'a note alone where no other answer is allowed')
  no(all, { [Q1]: 5 }, 'a note of the wrong type')
  no(all, { [Q1]: 'あ'.repeat(2000) }, 'a note past the limit')
  no(all, 'x', 'notes not a record')
  no(['x'], undefined, 'answers not a record')
  no(Object.assign(Object.create({ [Q2]: ['ほぼ初めて'] }), { [Q1]: ['開発の学習'], [Q3]: ['MarkdownとGit'] }), undefined, 'an answer on the prototype is not an answer')
  assert.equal(buildCodexAnswers(undefined, all, undefined).ok, false, 'no request kept with the card')
  assert.equal(buildCodexAnswers(Q, { ...all, [Q2]: [] }, { [Q2]: '   ' }).ok, false, 'a blank note is no answer')
})

test('build: a question id of __proto__ is still defined, not swallowed', () => {
  const q: CodexQuestion = { ...Q, questions: [{ id: '__proto__', question: 'x?', options: [{ label: 'a' }], other: false }] }
  const b = buildCodexAnswers(q, { 'x?': ['a'] }, undefined)
  assert.ok(b.ok)
  if (b.ok) assert.deepEqual(Object.getOwnPropertyDescriptor(b.result.answers, '__proto__')?.value, { answers: ['a'] })
})

// --- the question path in `approvals.ts` ---

interface Asked {
  question: CodexQuestion
  reply: (r: QuestionReply | undefined) => void
  withdrawn: boolean
}

function setup(opts: { ask?: boolean } = {}) {
  const calls: Array<{ method: string; params: unknown }> = []
  const responses: Array<{ id: RpcId; result: unknown }> = []
  const asked: Asked[] = []
  /** thread → what it waits on */
  const waiting = new Map<string, Set<'approval' | 'answer'>>([[T, new Set(['answer'])]])
  /** ★ Like the real line: writes wait their turn, and `guard` is asked only then */
  const state = { gate: Promise.resolve() as Promise<void> }
  const a = new CodexApprovals({
    call: async (method, params, guard): Promise<RpcResult> => {
      await state.gate
      if (guard && !guard()) return { ok: false, failure: { type: 'cancelled' } }
      calls.push({ method, params })
      return { ok: true, result: {} }
    },
    respond: async (id, result, guard) => {
      await state.gate
      if (!guard()) return false
      responses.push({ id, result })
      return true
    },
    isWaiting: (id, on) => {
      const w = waiting.get(id)
      return w !== undefined && (on ? w.has(on) : w.size > 0)
    },
    sleep: () => new Promise<void>(() => undefined),
    offer: () => new Promise(() => undefined),
    ...(opts.ask === false
      ? {}
      : {
          ask: (question: CodexQuestion, onWithdraw: (w: () => void) => void) =>
            new Promise<QuestionReply | undefined>((resolve) => {
              const o: Asked = { question, reply: resolve, withdrawn: false }
              onWithdraw(() => {
                o.withdrawn = true
                resolve(undefined)
              })
              asked.push(o)
            }),
        }),
  })
  return { a, calls, responses, asked, waiting, state }
}

/** Hold every write until `release` */
function hold(s: { state: { gate: Promise<void> } }): () => void {
  let release: () => void = () => undefined
  s.state.gate = new Promise<void>((r) => (release = r))
  return release
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

test('a question becomes a card, and the built answer is sent as the result', async () => {
  const s = setup()
  assert.equal(s.a.onServerRequest(REAL), true)
  assert.equal(s.asked.length, 1)
  const result = { answers: { purpose: { answers: ['開発の学習'] } } }
  s.asked[0]!.reply({ type: 'answers', result })
  await tick()
  assert.deepEqual(s.responses, [{ id: 7, result }])
  assert.equal(s.a.cards, 0)
})

test('"stop" interrupts the turn that asks, and answers nothing', async () => {
  const s = setup()
  s.a.onServerRequest(REAL)
  s.asked[0]!.reply({ type: 'stop' })
  await tick()
  assert.deepEqual(s.responses, [], 'never an empty answer (it would resolve the question)')
  assert.deepEqual(s.calls.filter((c) => c.method === 'turn/interrupt'), [
    { method: 'turn/interrupt', params: { threadId: T, turnId: P.turnId } },
  ])
})

test('no question hook ⇒ a question is not taken (left to the PC)', () => {
  const s = setup({ ask: false })
  assert.equal(s.a.onServerRequest(REAL), false)
})

test('a question for a thread that does not wait is not taken', () => {
  const s = setup()
  s.waiting.clear()
  assert.equal(s.a.onServerRequest(REAL), false)
  assert.equal(s.asked.length, 0)
})

test('resolved elsewhere (the PC answered) ⇒ the card goes, and a late reply is not sent', async () => {
  const s = setup()
  s.a.onServerRequest(REAL)
  s.a.onResolved({ threadId: T, requestId: 7 })
  assert.equal(s.asked[0]!.withdrawn, true)
  s.asked[0]!.reply({ type: 'answers', result: { answers: {} } })
  s.asked[0]!.reply({ type: 'stop' })
  await tick()
  assert.deepEqual(s.responses, [])
  assert.deepEqual(s.calls.filter((c) => c.method === 'turn/interrupt'), [])
})

test('the line ends ⇒ the card goes, nothing is sent', async () => {
  const s = setup()
  s.a.onServerRequest(REAL)
  s.a.dispose()
  assert.equal(s.asked[0]!.withdrawn, true)
  await tick()
  assert.deepEqual(s.responses, [])
})

// ── ★ Decisions already made whose write is still queued (codex review, 2026-11-16, low #3) ──

const ANSWER = { type: 'answers' as const, result: { answers: { purpose: { answers: ['開発の学習'] } } } }

test('race: an answer queued behind the line, then resolved on the PC ⇒ not sent', async () => {
  const s = setup()
  s.a.onServerRequest(REAL)
  const release = hold(s)
  s.asked[0]!.reply(ANSWER)
  await tick()
  s.a.onResolved({ threadId: T, requestId: 7 })
  release()
  await tick()
  assert.deepEqual(s.responses, [])
})

test('race: a Stop queued, then the thread stops waiting on the answer but still waits on an approval ⇒ no interrupt (codex medium)', async () => {
  const s = setup()
  s.a.onServerRequest(REAL)
  const release = hold(s)
  s.asked[0]!.reply({ type: 'stop' })
  await tick()
  s.waiting.set(T, new Set(['approval']))
  s.a.sync(T)
  release()
  await tick()
  assert.deepEqual(s.calls.filter((c) => c.method === 'turn/interrupt'), [])
  assert.equal(s.a.cards, 0, 'the question card went with its wait')
})

test('race: the status moved but no sync has run yet ⇒ the write is still refused (checked right before it goes out)', async () => {
  const s = setup()
  s.a.onServerRequest(REAL)
  const release = hold(s)
  s.asked[0]!.reply(ANSWER)
  await tick()
  s.waiting.set(T, new Set(['approval']))
  release()
  await tick()
  assert.deepEqual(s.responses, [])
})

test('the question card goes when the answer wait ends, even while an approval still waits', () => {
  const s = setup()
  s.a.onServerRequest(REAL)
  s.waiting.set(T, new Set(['approval']))
  s.a.sync(T)
  assert.equal(s.asked[0]!.withdrawn, true)
})

test('race: an answer queued, then the line ends ⇒ not sent', async () => {
  const s = setup()
  s.a.onServerRequest(REAL)
  const release = hold(s)
  s.asked[0]!.reply(ANSWER)
  await tick()
  s.a.dispose()
  release()
  await tick()
  assert.deepEqual(s.responses, [])
})

test('race: an answer queued, then the same request is replayed (a new card) ⇒ the old answer is not sent; the new card answers', async () => {
  const s = setup()
  s.a.onServerRequest(REAL)
  const release = hold(s)
  s.asked[0]!.reply(ANSWER)
  await tick()
  s.a.onServerRequest(REAL)
  release()
  await tick()
  assert.deepEqual(s.responses, [], 'the old card was replaced before its write went out')
  assert.equal(s.asked.length, 2)
  s.asked[1]!.reply(ANSWER)
  await tick()
  assert.deepEqual(s.responses, [{ id: 7, result: ANSWER.result }])
})
