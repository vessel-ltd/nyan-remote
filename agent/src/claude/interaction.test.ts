import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decisionResponse } from '../permission.ts'
import {
  buildUpdatedInput,
  describeInteraction,
  PREVIEW_MAX,
  requiresInteraction,
} from './interaction.ts'

// ★★ What these tests protect (2026-08-14 on a real machine → cause confirmed in the CLI 2.1.232 implementation):
//
//   `AskUserQuestion` / `ExitPlanMode` have `requiresUserInteraction()` true, and
//   **the CLI silently drops an `allow` without `updatedInput`**.
//   On the real machine it showed up as "pressing 'yes' on the phone does nothing on the PC" (`deny` worked).
//
// ⚠️⚠️ And **never accept `updatedInput` from the phone**.
//    Accepting it would let a Bash approval rewrite the command. This is the gate that "passes only presented labels",
//    and **the moment it is loosened it becomes arbitrary command execution**.

const questionInput = {
  questions: [
    {
      question: 'どちらにする？',
      header: '方式',
      options: [
        { label: 'A でいく', description: '安いほう' },
        { label: 'B でいく' },
      ],
      multiSelect: false,
    },
    {
      question: '含めるもの',
      options: [{ label: 'テスト' }, { label: 'ドキュメント' }],
      multiSelect: true,
    },
  ],
  metadata: { source: 'x' },
}

test('requiresInteraction: only the two known tools', () => {
  assert.equal(requiresInteraction('AskUserQuestion'), true)
  assert.equal(requiresInteraction('ExitPlanMode'), true)
  assert.equal(requiresInteraction('Bash'), false)
})

test('★ describeInteraction: turns the options into a shape the screen can use', () => {
  const i = describeInteraction('AskUserQuestion', questionInput)
  assert.equal(i?.kind, 'question')
  if (i?.kind !== 'question') return
  assert.equal(i.questions.length, 2)
  assert.equal(i.questions[0]?.question, 'どちらにする？')
  assert.equal(i.questions[0]?.header, '方式')
  assert.equal(i.questions[0]?.multiSelect, false)
  assert.deepEqual(i.questions[0]?.options.map((o) => o.label), ['A でいく', 'B でいく'])
  assert.equal(i.questions[1]?.multiSelect, true)
})

// ── ★★ Diagrams attached to options (`preview`). Found on a real machine on 2026-08-18 that they "do not show on the phone"
//
// ⚠️ The cause was **the agent, not the screen**. `describeInteraction` only picked up `label` and `description`,
//    and the diagram was thrown away here (= no amount of screen fixes would show it).

const ART = ['┌────────┐', '│ a -> b │', '│   ※ x  │', '└────────┘'].join('\n')

test('★★ describeInteraction: passes the diagram (preview) through as-is without dropping it', () => {
  const i = describeInteraction('AskUserQuestion', {
    questions: [
      {
        question: 'どちらにする？',
        options: [
          { label: 'A', description: '安い', preview: ART },
          { label: 'B' },
        ],
        multiSelect: false,
      },
    ],
  })
  assert.equal(i?.kind, 'question')
  if (i?.kind !== 'question') return
  // ⚠️ Look at **the value the implementation produces** (a test passing a hand-made Interaction is a false green)
  assert.deepEqual(i.questions[0]?.options, [
    { label: 'A', description: '安い', preview: ART },
    { label: 'B' },
  ])
  // ★ Newlines and leading whitespace are meaningful (box-drawing boxes). Do not squeeze or wrap
  assert.ok(i.questions[0]?.options[0]?.preview?.includes('\n│   ※ x  │'), 'the line shape changed')
})

test('★★ a diagram that is too long is clipped and marked as clipped (the lower half is not silently dropped)', () => {
  const long = 'x'.repeat(PREVIEW_MAX + 50)
  const i = describeInteraction('AskUserQuestion', {
    questions: [{ question: 'q', options: [{ label: 'A', preview: long }] }],
  })
  if (i?.kind !== 'question') return assert.fail('did not become a question')
  const o = i.questions[0]?.options[0]
  assert.equal(o?.preview?.length, PREVIEW_MAX)
  assert.equal(o?.previewClipped, true)

  // ★ Exactly at the limit is not clipped (= do not falsely claim it was clipped)
  const j = describeInteraction('AskUserQuestion', {
    questions: [{ question: 'q', options: [{ label: 'A', preview: 'y'.repeat(PREVIEW_MAX) }] }],
  })
  if (j?.kind !== 'question') return assert.fail('did not become a question')
  assert.equal(j.questions[0]?.options[0]?.previewClipped, undefined)
})

test('★ cutting in the middle of a surrogate pair does not produce "�"', () => {
  // Fill up to just before the limit and put an emoji (2 code units) on the boundary
  const long = 'x'.repeat(PREVIEW_MAX - 1) + '🙂' + 'y'.repeat(10)
  const i = describeInteraction('AskUserQuestion', {
    questions: [{ question: 'q', options: [{ label: 'A', preview: long }] }],
  })
  if (i?.kind !== 'question') return assert.fail('did not become a question')
  const cut = i.questions[0]?.options[0]?.preview ?? ''
  assert.equal(cut.length, PREVIEW_MAX - 1, 'did not back off by one before cutting')
  // ⚠️ No lone half may remain (otherwise the screen ends with "�")
  assert.equal([...cut].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff), true)
  assert.equal(i.questions[0]?.options[0]?.previewClipped, true)
})

test('★★ clipping at the limit cuts at a grapheme boundary (emoji were being broken)', () => {
  // ⚠️ We only avoided surrogates, so `👩‍💻` became `👩‍` (ending in ZWJ), `⚠️` became `⚠`,
  //    and `é` became `e` + a dangling combining mark (2026-08-19 codex review, low #4)
  for (const g of ['👩‍💻', '⚠️', 'é', '🇯🇵', '𠮛']) {
    const i = describeInteraction('AskUserQuestion', {
      questions: [{ question: 'q', options: [{ label: 'A', preview: g.repeat(3000) }] }],
    })
    if (i?.kind !== 'question') return assert.fail('did not become a question')
    const cut = i.questions[0]?.options[0]?.preview ?? ''
    assert.ok(cut.length <= PREVIEW_MAX, 'exceeded the limit')
    assert.equal(cut.slice(-g.length), g, `the tail is cut mid-character: ${g}`)
    assert.equal(cut.length % g.length, 0, 'cut in the middle of a grapheme')
  }
})

test('★★ two identical question texts are refused with a reason (not a silent "does not match")', () => {
  const dup = {
    questions: [
      { question: 'same', options: [{ label: 'A' }] },
      { question: 'same', options: [{ label: 'B' }] },
    ],
  }
  const r = buildUpdatedInput('AskUserQuestion', dup, { same: ['A'] })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.message, /同じ質問文/, 'the message does not explain the cause')
})

test('★★ the answer does not vanish even for a question text of `__proto__`', () => {
  // ⚠️ With a plain object the assignment was swallowed by the special setter, and **answers was empty despite ok:true**
  const input = { questions: [{ question: '__proto__', options: [{ label: 'A' }] }] }
  const r = buildUpdatedInput('AskUserQuestion', input, JSON.parse('{"__proto__":["A"]}'))
  assert.equal(r.ok, true)
  if (!r.ok) return
  const answers = r.updatedInput['answers'] as Record<string, string>
  assert.equal(Object.keys(answers).length, 1, 'the answer vanished')
  assert.equal(answers['__proto__'], 'A')
  // ★ The hook receives JSON, so check that far
  assert.equal(JSON.stringify(r.updatedInput).includes('"__proto__":"A"'), true)
})

test('★ options without a diagram do not get preview / previewClipped keys', () => {
  const i = describeInteraction('AskUserQuestion', {
    questions: [{ question: 'q', options: [{ label: 'A', preview: '' }, { label: 'B', preview: 7 }] }],
  })
  if (i?.kind !== 'question') return assert.fail('did not become a question')
  assert.deepEqual(i.questions[0]?.options, [{ label: 'A' }, { label: 'B' }])
})

test('★★ even with diagrams, only labels come back from the phone (the diagram stays as in the original input)', () => {
  // ⚠️ Pin down that diagrams **do not widen the attack surface**. `updatedInput` is
  //    "the original tool_input + answers", so there is no path for the screen to rewrite a diagram
  const input = {
    questions: [
      { question: 'q', options: [{ label: 'A', preview: ART }, { label: 'B' }], multiSelect: false },
    ],
  }
  const r = buildUpdatedInput('AskUserQuestion', input, { q: ['A'] })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.updatedInput, { ...input, answers: { q: 'A' } })
})

test('describeInteraction: ExitPlanMode has nothing to choose / broken input is undefined', () => {
  assert.deepEqual(describeInteraction('ExitPlanMode', { plan: 'やること' }), { kind: 'plan' })
  assert.equal(describeInteraction('AskUserQuestion', { questions: 'こわれている' }), undefined)
  assert.equal(describeInteraction('AskUserQuestion', { questions: [{ question: 'q' }] }), undefined, 'no options')
  assert.equal(describeInteraction('Bash', { command: 'ls' }), undefined)
})

test('★★ buildUpdatedInput: puts the chosen labels in answers (the CLI reads this shape)', () => {
  const r = buildUpdatedInput('AskUserQuestion', questionInput, {
    'どちらにする？': ['A でいく'],
    含めるもの: ['テスト', 'ドキュメント'],
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  // ★ The original input is kept; answers is just added
  assert.deepEqual(r.updatedInput['questions'], questionInput.questions)
  assert.deepEqual(r.updatedInput['metadata'], { source: 'x' })
  assert.deepEqual(r.updatedInput['answers'], {
    'どちらにする？': 'A でいく',
    // Multi-select is comma-separated
    含めるもの: 'テスト, ドキュメント',
  })
})

test('★★ buildUpdatedInput: labels that were not presented do not pass (this is the gate)', () => {
  const r = buildUpdatedInput('AskUserQuestion', questionInput, {
    'どちらにする？': ['C という勝手な答え'],
    含めるもの: ['テスト'],
  })
  assert.equal(r.ok, false)
})

test('★ buildUpdatedInput: refuses missing answers, multiple picks on single-select, and unknown questions', () => {
  // The second question is missing
  assert.equal(buildUpdatedInput('AskUserQuestion', questionInput, { 'どちらにする？': ['A でいく'] }).ok, false)
  // Two picks on a single-select
  assert.equal(
    buildUpdatedInput('AskUserQuestion', questionInput, {
      'どちらにする？': ['A でいく', 'B でいく'],
      含めるもの: ['テスト'],
    }).ok,
    false,
  )
  // An unknown question is mixed in (version mismatch between screen and agent)
  assert.equal(
    buildUpdatedInput('AskUserQuestion', questionInput, {
      'どちらにする？': ['A でいく'],
      含めるもの: ['テスト'],
      'よその質問': ['なにか'],
    }).ok,
    false,
  )
  // Nothing chosen
  assert.equal(buildUpdatedInput('AskUserQuestion', questionInput, undefined).ok, false)
})

test('★★ buildUpdatedInput: ExitPlanMode passes only plan (no extra keys carried in)', () => {
  const r = buildUpdatedInput(
    'ExitPlanMode',
    { plan: '## やること', planFilePath: '/tmp/plan.md', よそのキー: '無視される' },
    undefined,
  )
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.updatedInput, { plan: '## やること', planFilePath: '/tmp/plan.md' })
  // If the plan cannot be read, do not allow (refusing beats sending an allow that gets dropped)
  assert.equal(buildUpdatedInput('ExitPlanMode', {}, undefined).ok, false)
})

test('★★ decisionResponse: attaches updatedInput only on allow (without it the CLI drops it)', () => {
  const json = JSON.stringify(
    decisionResponse({ behavior: 'allow', updatedInput: { plan: 'p' } }),
  )
  assert.equal(
    json,
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"plan":"p"}}}}',
  )
  // Not attached on deny (the CLI only reads it on allow)
  assert.ok(
    !JSON.stringify(decisionResponse({ behavior: 'deny', updatedInput: { plan: 'p' } })).includes(
      'updatedInput',
    ),
  )
})

test('★ summarize: questions with options are not rendered as "one-line JSON" (seen on a real machine)', async () => {
  const { summarize } = await import('../permission.ts')
  const s = summarize('AskUserQuestion', questionInput)
  assert.equal(s, 'どちらにする？ / 含めるもの')
  assert.ok(!s.includes('{'), `must not output JSON: ${s}`)
})
