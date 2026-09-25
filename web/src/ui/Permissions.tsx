import { useMemo, useState } from 'preact/hooks'
import type { VNode } from 'preact'
import type { PermissionRequest } from '../../../shared/types.ts'
import { closePermissionNotification } from '../notifications.ts'
import { hhmm } from '../time.ts'
import { needsSubmit, previewText, tapAnswers } from './interaction.ts'
import { cells } from './previewCells.ts'
import { t } from '../../../shared/i18n.ts'
import { accountLabel, agentTypeLabel, suggestionTexts } from './agentText.ts'

/**
 * Pending approvals (M4-1). This is where "noticing" turns into "acting".
 *
 * ★ Shown at the top of the list. A pending approval means "work is stopped until you answer",
 *   so it must not be something you scroll to find.
 *
 * ⚠️ If it could not be answered (timeout / already handled on the PC), the agent returns ok:false.
 *   **Never make it look like a silent success.** Pressing and having nothing happen is the worst experience.
 *
 * ⚠️ No innerHTML (CLAUDE.md). tool_input, like tool results, may be a third-party
 *   string, so always pass it as a JSX child and let Preact escape it.
 */
/**
 * ★★ The diagram attached to an option. **Drawn with columns matching the terminal** (full-width is 2 columns / `previewCells.ts`).
 *
 * ⚠️ Always pass strings as JSX children (no `innerHTML` / CLAUDE.md).
 *
 * ★ **Reuse the element array** (2026-08-19 `/code-review`, low #6. **Added after measuring**).
 *    With the test card (7 diagrams) at **1760 column boxes**, rebuilding on every option tap made
 *    a single tap (Preact flush + layout) take
 *    **2.3ms (max 7.9ms) → 0.4ms (max 1.3ms) when reused** (Chromium / this dev machine).
 *    ⚠️ 1760 is **the measured value for that card**, not an upper bound (a diagram of only full-width characters
 *    can reach `PREVIEW_MAX` = 2000 per option).
 *    ⚠️ Both fit in one frame (16.7ms). **Phone values were not measured**
 *    (headroom was taken on the assumption that phones are generally slower than the dev machine / codex review, low #6).
 *    If the string does not change, neither does the diagram.
 *
 * ⚠️⚠️ **The first measurement of "31–34ms" was my measuring mistake**
 *    (waiting two `requestAnimationFrame`s always yields two frames = 33ms no matter what;
 *    it was 33ms even with the diagram set to `display: none`). Recorded in VERIFY.md.
 */
function PreviewArt({ art }: { art: string }): VNode {
  const children = useMemo(
    () =>
      art.split('\n').flatMap((line, li) => [
        ...(li === 0 ? [] : ['\n']),
        ...cells(line).map((c, ci) =>
          c.wide === undefined ? (
            c.text
          ) : (
            <span class="pcw2" key={`${li}:${ci}`}>
              {c.text}
            </span>
          ),
        ),
      ]),
    [art],
  )
  return <pre class="permoptpre">{children}</pre>
}

export function Permissions({
  items,
  onAnswer,
  inThread = false,
}: {
  items: (PermissionRequest & { endpointId: string })[]
  onAnswer: (
    endpointId: string,
    key: string,
    behavior: 'allow' | 'deny',
    /** ★ Labels selected in an approval with options (`AskUserQuestion`). question text → labels */
    answers?: Record<string, string[]>,
    /** ★ "Please change it like this" attached to a denial */
    feedback?: string,
  ) => Promise<{ ok: boolean; reason?: string }>
  /** Whether it is shown at the bottom of the thread (the same placement as Claude's Android app) */
  inThread?: boolean
}) {
  const [busy, setBusy] = useState<string>()
  const [msg, setMsg] = useState<Record<string, string>>({})
  /**
   * ★ What was selected in approvals with options. `approval key → question text → labels[]`.
   *
   * ⚠️ No need to keep it across drafts (approvals exist only while waiting).
   *    Not put in IndexedDB either (same reason as keeping no state on the server).
   */
  const [picked, setPicked] = useState<Record<string, Record<string, string[]>>>({})
  /**
   * ★ "Please change it like this" (the PC's `3. Tell Claude what to change`).
   * ⚠️ Approvals exist only while waiting, so the draft is not saved (send it or discard it)
   */
  const [note, setNote] = useState<Record<string, string>>({})
  /**
   * ★ Cards whose full text is open (`approval key` → open or not).
   *
   * `summary` is flattened to one line and cut at 400 characters, so long commands like heredocs
   * cannot be read past the "…". This toggle exists **so nobody presses Allow without being able to read it**.
   */
  const [open, setOpen] = useState<Record<string, boolean>>({})

  if (items.length === 0) return null

  const pick = (key: string, question: string, label: string, multi: boolean): void => {
    setPicked((prev) => {
      const forKey = prev[key] ?? {}
      const cur = forKey[question] ?? []
      const next = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : // single choice replaces (pressing again cancels)
          cur[0] === label
          ? []
          : [label]
      return { ...prev, [key]: { ...forKey, [question]: next } }
    })
  }

  const answer = async (
    item: PermissionRequest & { endpointId: string },
    behavior: 'allow' | 'deny',
    answers?: Record<string, string[]>,
    feedback?: string,
  ) => {
    setBusy(item.key)
    try {
      const res = await onAnswer(item.endpointId, item.key, behavior, answers, feedback)
      if (!res.ok) {
        setMsg((m) => ({ ...m, [item.key]: res.reason ?? t('もう有効ではありません', 'No longer valid') }))
        // ⚠️⚠️ **Do not dismiss the notification when it did not go through** (2026-08-20 codex high #1).
        //    `permissionTag` strips the generation (`#…`), so it has **the same tag as a different generation
        //    of the approval currently waiting**. Closing it when refused (= it was a stale mark)
        //    would **erase the only signal of a live approval**.
        return
      }
      // ★ Once answered, dismiss the notification. Leaving it reads as "pressed but still waiting".
      //   Moreover an old notification holds **the URL from when it was created**, so leaving it invites accidents
      //   (2026-08-13: after a fix, tapping an old notification showed sw.js's source)
      void closePermissionNotification(item.machine, item.key)
    } catch (err) {
      setMsg((m) => ({ ...m, [item.key]: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <section class={inThread ? 'group perms inthread' : 'group perms'}>
      <h2>{inThread ? t('承認が必要です', 'Approval needed') : t(`承認待ち ${items.length}`, `Approval needed ${items.length}`)}</h2>
      <ul class="sessions">
        {items.map((p) => (
          <li key={`${p.endpointId}:${p.key}`}>
            <div class="permrow">
              <span class="body">
                <span class="title">
                  {t(`${p.toolName} を実行してよいですか`, `Allow ${p.toolName} to run?`)}
                </span>
                {/* A third-party string. Passed as a JSX child (no innerHTML) */}
                {p.detail ? (
                  <>
                    {/* ★ Make the collapsed line itself pressable (some commands cannot be read in one line).
                        ⚠️ The opened full text goes **outside this button**. Inside, a finger trying
                           to scroll the long text is judged a press and closes it */}
                    <button
                      class="permmore"
                      aria-expanded={open[p.key] ? 'true' : 'false'}
                      onClick={() => setOpen((m) => ({ ...m, [p.key]: !m[p.key] }))}
                    >
                      {open[p.key] ? null : <span class="sub mono">{p.summary}</span>}
                      <span class="permmorehint">{open[p.key] ? t('▲ 全文を閉じる', '▲ Hide full text') : t('▼ 全文を見る', '▼ Show full text')}</span>
                    </button>
                    {open[p.key] ? (
                      <>
                        <div class="permfull mono">{p.detail}</div>
                        {/* ★ If still partial after opening, say so. Cutting silently makes you
                            press Allow believing "I saw it all" */}
                        {p.detailClipped ? (
                          <span class="permmsg">
                            {t(
                              '⚠️ 長すぎるので、ここまでしか表示していません（この先はPCの画面で確認してください）',
                              '⚠️ Too long, showing only this much (check the rest on the PC screen)',
                            )}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </>
                ) : (
                  <span class="sub mono">{p.summary}</span>
                )}
                <span class="chips">
                  {inThread ? null : (
                    <>
                      <span class="chip">{p.machine}</span>
                      <span class="chip">{accountLabel(p)}</span>
                      <span class="chip">{p.project}</span>
                    </>
                  )}
                  {/* ★ Make it clear when the request comes from a subagent (launched by Task).
                      If it cannot be told apart from the main one, "what is this approval for" is unreadable (2026-08-14) */}
                  {p.agentType || p.subagent ? <span class="chip mode">{agentTypeLabel(p)}</span> : null}
                  <span class="chip">{hhmm(p.at)}</span>
                </span>
                {suggestionTexts(p).length > 0 ? (
                  <span class="sub">
                    {t('PCなら選べる: ', 'More choices on the PC: ')}{suggestionTexts(p).join(' / ')}
                  </span>
                ) : null}
                {msg[p.key] ? <span class="permmsg">{msg[p.key]}</span> : null}
              </span>
            </div>

            {/* ★★ Approvals that cannot be answered with "yes/no" (§9.11).
                Show the options and **send what was chosen**. Sending only "Allow" makes
                the CLI discard an allow without updatedInput, and the PC keeps waiting */}
            {p.interaction?.kind === 'question'
              ? p.interaction.questions.map((q) => {
                  const chosen = picked[p.key]?.[q.question] ?? []
                  // ★ Whether a tap may answer immediately is decided by `tapAnswers` (do not copy the condition).
                  //   ⚠️ If the condition here and in "Submit answer" below drift, **a card that cannot be answered** results
                  const single = tapAnswers(p.interaction)
                  return (
                    <div class="permq" key={q.question}>
                      <span class="permqhead">
                        {q.header ? <span class="chip">{q.header}</span> : null}
                        <span class="permqtext">{q.question}</span>
                      </span>
                      <div class="permopts">
                        {q.options.map((o) => {
                          // ★ Check after shaping it for display (through the same function as `tapAnswers`)
                          const art = previewText(o.preview)
                          return (
                          <div class="permoptwrap" key={o.label}>
                            <button
                              class={chosen.includes(o.label) ? 'permopt on' : 'permopt'}
                              disabled={busy === p.key}
                              onClick={() =>
                                single
                                  ? void answer(p, 'allow', { [q.question]: [o.label] })
                                  : pick(p.key, q.question, o.label, q.multiSelect)
                              }
                            >
                              <span class="permoptlabel">{o.label}</span>
                              {o.description ? (
                                <span class="permoptdesc">{o.description}</span>
                              ) : null}
                            </button>
                            {/* ★★ The diagram attached to an option (`preview`).
                                ⚠️ **Placed outside the button.** Inside, every horizontal swipe of the diagram
                                   would select that option (separate the surface you press from the surface you drag).
                                ⚠️ Not passed through markdown. Leading spaces and box-drawing lines carry
                                   meaning, so the string is passed as a `<pre>` child and
                                   Preact escapes it (no `innerHTML` / CLAUDE.md) */}
                            {art ? <PreviewArt art={art} /> : null}
                            {/* ⚠️ **Shown even if `art` is empty** (2026-08-19 codex review, medium #1).
                                If the cap cuts down to the closing fence, no box appears, so
                                unless we at least say "it is cut", **it looks like nothing is there** */}
                            {o.previewClipped ? (
                              <span class="permmorehint">
                                {art
                                  ? t('図が長いので途中まで出しています', 'The diagram is long, showing part of it')
                                  : t('図が長すぎるため出せません（PCで見てください）', 'The diagram is too long to show (view it on the PC)')}
                              </span>
                            ) : null}
                          </div>
                          )
                        })}
                      </div>
                      {q.multiSelect ? (
                        <span class="sub">{t('いくつでも選べます', 'Select any number')}</span>
                      ) : null}
                    </div>
                  )
                })
              : null}

            {/* ★ Deny with "please change it like this" (same effect as option 3 on the PC).
                The CLI **passes the hook's deny message to the model as the denial reason**, so
                it becomes the instruction as-is. ⚠️ Shown only for plan approvals (the most used case) */}
            {p.interaction?.kind === 'plan' ? (
              <div class="permnote">
                <textarea
                  rows={2}
                  placeholder={t('直してほしい点（書いて送ると、この内容で作り直します）', 'What to change (send it and the plan is redone with this)')}
                  value={note[p.key] ?? ''}
                  disabled={busy === p.key}
                  onInput={(e) =>
                    setNote((m) => ({ ...m, [p.key]: (e.target as HTMLTextAreaElement).value }))
                  }
                />
                <button
                  class="permng"
                  disabled={busy === p.key || (note[p.key] ?? '').trim().length === 0}
                  onClick={() => void answer(p, 'deny', undefined, note[p.key])}
                >
                  {t('これを直して', 'Change this')}
                </button>
              </div>
            ) : null}

            <div class="permbtns">
              {p.interaction?.kind === 'question' ? (
                // ★ Shown only for questions not answered on tap (multiple questions / multi-select / with diagram).
                //   ⚠️ The condition is `needsSubmit` in one place (always the inverse of `tapAnswers` above)
                needsSubmit(p.interaction) ? (
                  <button
                    class="permok"
                    disabled={
                      busy === p.key ||
                      !p.interaction.questions.every(
                        (q) => (picked[p.key]?.[q.question] ?? []).length > 0,
                      )
                    }
                    onClick={() => void answer(p, 'allow', picked[p.key] ?? {})}
                  >
                    {t('これで答える', 'Submit answer')}
                  </button>
                ) : null
              ) : (
                <button
                  class="permok"
                  disabled={busy === p.key}
                  onClick={() => void answer(p, 'allow')}
                >
                  {p.interaction?.kind === 'plan' ? t('このプランで進める', 'Go with this plan') : t('許可', 'Allow')}
                </button>
              )}
              <button
                class="permng"
                disabled={busy === p.key}
                onClick={() => void answer(p, 'deny')}
              >
                {t('拒否', 'Deny')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {/* ★ Separate wording. **Background teammate approvals do not appear on the PC's main screen**
          (measured 2026-08-16: running `@code-review` in the background, its approval
          only stops at the `◯ code-review` line and never shows in the main REPL).
          Writing "it is also shown on the PC" there would **be a lie and misdirect where to answer**. */}
      <p class="notice small">
        {items.some((p) => p.agentType || p.subagent)
          ? t(
              'バックグラウンドのエージェントからの要求は、PCの画面に出ないことがあります（ここで答えるのが確実です）。',
              'Requests from background agents may not appear on the PC screen (answering here is the sure way).',
            )
          : t(
              'PCの画面にも同じ確認が出ています。どちらで答えても構いません。',
              'The same prompt is also shown on the PC screen. You can answer in either place.',
            )}
      </p>
    </section>
  )
}
