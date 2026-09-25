// ★ Enforce CLAUDE.md's "implementation disciplines" and "prohibitions" mechanically, without waiting for review.
//
// Why inspect the source as strings:
//   - `innerHTML` becomes **a hole that can send every session's conversation outside the moment it's added**.
//     Behavioral tests can't prove "it isn't used" (you only find out by hitting the place it's used)
//   - Discipline 2 (communication only through the single transport layer) was broken once (Endpoints.tsx's direct fetch / P3 finding).
//     We learned that relying on people noticing isn't enough, so it's pinned here
//
// ⚠️ Checks match "the syntax of use" (`.innerHTML` / `dangerouslySetInnerHTML=` etc.).
//    Matching bare words would trigger on the very comments explaining the prohibitions.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

const SRC = join(import.meta.dirname)

function sources(): { path: string; rel: string; text: string }[] {
  const out: { path: string; rel: string; text: string }[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (!/\.tsx?$/.test(name) || name.includes('.test.')) continue
      out.push({ path, rel: relative(SRC, path), text: readFileSync(path, 'utf8') })
    }
  }
  walk(SRC)
  return out
}

test('the files to inspect are actually collected (validity of the test itself)', () => {
  const files = sources().map((f) => f.rel)
  // Even 0 files would turn green as "no violations", so check that representative files exist
  assert.ok(files.length >= 10, `too few targets: ${files.length}`)
  assert.ok(files.includes(join('ui', 'markdown.tsx')))
  assert.ok(files.includes(join('transport', 'http.ts')))
  assert.ok(files.includes(join('transport', 'relayCarrier.ts')))
  assert.ok(files.includes(join('transport', 'agent.ts')))
  assert.ok(files.includes('main.tsx'))
})

test('★★ nothing anywhere pours HTML strings into the DOM (the XSS entry point)', () => {
  // Tool results (file contents, fetched web pages) flow through threads.
  // If `<img onerror=...>` gets mixed in and is rendered as HTML, it runs on the spot.
  // This page shares an origin with the agent, so every session's conversation could be sent outside.
  const banned: [RegExp, string][] = [
    [/\.innerHTML\b/, '.innerHTML'],
    [/\.outerHTML\s*=/, 'assignment to .outerHTML'],
    [/dangerouslySetInnerHTML\s*[=:]/, 'dangerouslySetInnerHTML'],
    [/\binsertAdjacentHTML\s*\(/, 'insertAdjacentHTML'],
    [/\bdocument\.write\s*\(/, 'document.write'],
  ]
  const hits: string[] = []
  for (const f of sources()) {
    for (const [re, label] of banned) {
      if (re.test(f.text)) hits.push(`${f.rel}: ${label}`)
    }
  }
  assert.deepEqual(hits, [], `a banned rendering method was added:\n${hits.join('\n')}`)
})

test('★★ discipline 2: communication only inside transport (screens never fetch directly)', () => {
  // ⚠️ If this isn't kept, ③ (Tailscale-independent) can't swap the route.
  //    Endpoints.tsx actually fetched directly, so only the reachability check couldn't choose a route.
  const banned: [RegExp, string][] = [
    [/\bfetch\s*\(/, 'fetch('],
    [/new\s+EventSource\b/, 'new EventSource'],
    [/new\s+WebSocket\b/, 'new WebSocket'],
  ]
  const hits: string[] = []
  for (const f of sources()) {
    // Only inside transport/ may communicate
    if (f.rel.startsWith(`transport${'/'}`)) continue
    for (const [re, label] of banned) {
      if (re.test(f.text)) hits.push(`${f.rel}: ${label}`)
    }
  }
  assert.deepEqual(hits, [], `communicating outside transport:\n${hits.join('\n')}`)
})

test('★★ discipline 2: even inside transport, only "the two line files" may open routes', () => {
  // ★★ 2026-09-15 (step 6-② of ③). The `Transport` implementation (`agent.ts`) **doesn't know the route**.
  //   ⚠️⚠️ If this loosens, adding relay turns into **branching on the route inside `agent.ts`**,
  //      and the 20 methods **fork per route** (= the shortest path to breaking discipline 2).
  //   ★ `relay.ts` **receives** its carrier (WebSocket) **from outside**, so `new WebSocket` is banned here too.
  //   ★ Only two files open lines: `http.ts` (fetch + SSE) and `relayCarrier.ts` (relay's WebSocket).
  //     ⚠️ **To add one, add it here** (= the increase always shows up in review).
  const openers = [join('transport', 'http.ts'), join('transport', 'relayCarrier.ts')]
  const banned: [RegExp, string][] = [
    [/\bfetch\s*\(/, 'fetch('],
    [/new\s+EventSource\b/, 'new EventSource'],
    [/new\s+WebSocket\b/, 'new WebSocket'],
  ]
  const hits: string[] = []
  for (const f of sources()) {
    if (!f.rel.startsWith(`transport${'/'}`)) continue
    if (openers.includes(f.rel)) continue
    if (f.rel.endsWith('.test.ts')) continue
    for (const [re, label] of banned) {
      if (re.test(f.text)) hits.push(`${f.rel}: ${label}`)
    }
  }
  assert.deepEqual(hits, [], `only ${openers.join(' and ')} may open routes:\n${hits.join('\n')}`)

  // ★ Confirm this check is effective (the scan isn't empty / no false greens)
  const seen = sources().filter((f) => f.rel.startsWith(`transport${'/'}`)).map((f) => f.rel)
  assert.ok(seen.includes(join('transport', 'agent.ts')), 'agent.ts is not in the scan')
  assert.ok(seen.includes(join('transport', 'relay.ts')), 'relay.ts is not in the scan')
  // ⚠️ The two allowed files **actually exist** (if removed or renamed, the check silently loosens)
  for (const rel of openers) assert.ok(seen.includes(rel), `allowed ${rel} is missing`)
})

test('★ discipline 1: the "agent on our own origin" assumption is written only in endpoints.ts', () => {
  // The distribution origin (GitHub Pages etc.) and the agent can be different hosts. And one PWA
  // talks to agents on several machines, so endpoints always come from endpoints.ts.
  const hits: string[] = []
  for (const f of sources()) {
    if (f.rel === 'endpoints.ts') continue
    if (/\blocation\.(origin|host|hostname)\b/.test(f.text)) hits.push(`${f.rel}: location.origin etc.`)
  }
  assert.deepEqual(hits, [], `own-origin assumption leaked:\n${hits.join('\n')}`)
})

test('★ no added dependencies (nothing imported besides preact)', () => {
  // We can say "the only remaining risk is the identity of the JS bundle" because it fits in a readable amount.
  const allowed = /^(preact|preact\/hooks|preact\/jsx-runtime)$/
  const hits: string[] = []
  for (const f of sources()) {
    for (const m of f.text.matchAll(/(?:^|\n)\s*import[^'"]*from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1]!
      // Relative paths are our own code
      if (spec.startsWith('.') || spec.startsWith('/')) continue
      // node: is Node's standard library (used on the test side)
      if (spec.startsWith('node:')) continue
      if (!allowed.test(spec)) hits.push(`${f.rel}: ${spec}`)
    }
  }
  assert.deepEqual(hits, [], `a new dependency was added:\n${hits.join('\n')}`)
})

// ── ★ CSS-side disciplines (2026-08-18) ─────────────────────────────────────────
//
// Both of these were actually hit today. **Neither shows in a PC browser** (`env()` is 0), so
// eyes and PC checks won't catch them. Hence checked mechanically:
//   - a finger target dropped below 44px (`min-width: 40px`, while the comment said 44px)
//   - the sticky bar height and the `scroll-margin-top` formula disagreed, hiding things behind it on notched devices

const CSS = readFileSync(join(SRC, 'styles.css'), 'utf8')

/** Extract the selector's declaration block (inside `@media` is excluded = overrides are checked separately) */
function block(selector: string): string {
  const i = CSS.indexOf(`\n${selector} {`)
  assert.ok(i >= 0, `selector not found (the test itself is stale): ${selector}`)
  const from = CSS.indexOf('{', i)
  const to = CSS.indexOf('}', from)
  assert.ok(to > from, `block not closed: ${selector}`)
  return CSS.slice(from + 1, to)
}

/**
 * ★ Strip comments (`//` and `/* *​/`). **Banning and requiring checks always go through this**.
 *
 * ⚠️ A check passed just because a note said "don't use `pre-wrap`" (actually hit on the CSS side).
 *    On 2026-08-19 the reverse (a required item **passing just by being in a comment**) was also pointed out.
 */
function stripComments(src: string): string {
  // ⚠️⚠️ **Also strip `//` mid-line** (codex review medium #5, 2026-08-19).
  //    Only line-start ones were stripped, so mutations **pushing the real code into a comment**, like
  //    `const el = bottomRef.current // the original expression`, all slipped past (confirmed in practice).
  // ⚠️ Don't strip `//` inside strings or templates (URLs etc.). Look one character at a time
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < src.length) {
    const c = src[i]!
    const next = src[i + 1]
    if (quote) {
      if (c === '\\') {
        out += c + (next ?? '')
        i += 2
        continue
      }
      if (c === quote) quote = null
      out += c
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * ★ **All** declaration blocks containing the selector (inside `@media` too; comments stripped).
 *
 * ⚠️ `block()` returns only the first one. A banned declaration **could be restored later in `@media`**
 *    (codex review low #5, 2026-08-19), so the banning checks use this one.
 */
function allBlocks(selector: string): string[] {
  // ⚠️ Counting blocks from the outside **breaks with `@media` nesting** (in practice,
  //    a mutation adding the same selector inside `@media` stayed green).
  //    ⇒ **Pick up every `{...}` right after the selector** (hits even when nested)
  const re = new RegExp(`${selector.replace(/\./g, '\\.')}(?![\\w-])[^{}]*\\{([^}]*)\\}`, 'g')
  return [...CSS.matchAll(re)].map((m) => m[1]!.replace(/\/\*[\s\S]*?\*\//g, ''))
}

test('★ finger targets are not below 44px (CSS checked mechanically)', () => {
  // ⚠️ Fails if brought below 44. 40px actually got in (/code-review, 2026-08-18)
  //
  // ★ Split into two by target shape:
  //   `rows`    … **rows spanning the full width** of banners and lists. Only height is checked
  //     ⚠️ Width includes `min-width: 0` (needed on the shrinking side of flex), so
  //        requiring 44+ on width too **would force dropping the setting that prevents horizontal scroll**
  //   `squares` … icon-only buttons. **Both** dimensions are checked
  const rows = ['.tbmenuitem', '.tbalert', '.tbauto', '.permbtns > button', '.confirmbtns > button']
  const squares = ['.tbrow > .tbbtn']
  const bad: string[] = []
  const big = (v: string): boolean => {
    if (v.includes('var(--jump-h)')) return true // 48px (defined on :root)
    return Number(/^(\d+(?:\.\d+)?)px$/.exec(v)?.[1] ?? NaN) >= 44
  }
  for (const [sel, needWidth] of [
    ...rows.map((s) => [s, false] as const),
    ...squares.map((s) => [s, true] as const),
  ]) {
    const text = block(sel)
    const got: Record<string, string> = {}
    for (const m of text.matchAll(/min-(height|width)\s*:\s*([^;]+);/g)) {
      got[m[1]!] = m[2]!.trim()
    }
    const h = got.height
    if (h === undefined) bad.push(`${sel}: no min-height`)
    else if (!big(h)) bad.push(`${sel}: min-height: ${h}`)
    if (needWidth) {
      const w = got.width
      if (w === undefined) bad.push(`${sel}: no min-width`)
      else if (!big(w)) bad.push(`${sel}: min-width: ${w}`)
    }
  }
  assert.deepEqual(bad, [], `finger targets are too small:\n${bad.join('\n')}`)
})

test('★★ the gray line is passed through the grace period (wiring checked mechanically)', () => {
  // ⚠️⚠️ If this breaks, **the 2026-08-14 lie returns elsewhere**:
  //    right after answering the last approval on the phone, the card disappears but `waiting` stays until the next refetch,
  //    so while viewing another thread "needs attention 1 · session B … handle on PC" appears.
  //    The banner has nothing to counter it (same day's `/code-review` medium #1).
  // ⚠️ `.tsx` can't be imported from `node:test`, so **mutation tests don't turn red**
  //    (a "skip the grace period" mutation actually stayed green). Hence guarded by strings.
  const t = readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8')
  assert.match(
    t,
    /const barAlert = [^\n]*showStale\(/,
    'the gray line does not go through the grace period (showStale)',
  )
  assert.match(t, /alert=\{barAlert\}/, 'passing the alert to the banner before the grace period')
  assert.doesNotMatch(t, /alert=\{alert\}/, 'passing the alert to the banner before the grace period')

  // ── ★★ Wiring on the `main.tsx` side (codex review medium #1 and #2, 2026-08-18)
  const m = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  // ⚠️ The marker is judged **with a lifetime**. Reverting to a plain comparison skips the grace period
  //    the whole time that thread is open, and **lies immediately on the next wait**
  assert.match(m, /waitConfirmed=\{isConfirmedWait\(/, 'the marker is not judged with a lifetime')
  // ⚠️ Passing `quiet` **summed across all endpoints** lets another machine's quiet hide this thread's explanation
  assert.doesNotMatch(
    m,
    /reduce\(\(n, s\) => n \+ \(s\.quietPermissions/,
    'quiet is summed across all endpoints (keep it per endpoint)',
  )
  assert.match(m, /quietPermissions=\{ownerState\?\.quietPermissions/, 'quiet is not taken from the owner')
})

test('★★ choice diagrams are shown "outside the button, monospace as-is" (wiring and CSS checked mechanically)', () => {
  // ⚠️ `.tsx` can't be imported from `node:test`, so mutation tests don't turn red. Guarded by strings.
  const t = readFileSync(join(SRC, 'ui', 'Permissions.tsx'), 'utf8')

  // ★★ **Don't copy** the instant-answer condition and the submit-button condition.
  //    If they drift it becomes "pressing only selects and there's no submit button" = an unanswerable card
  assert.match(t, /const single = tapAnswers\(/, 'the instant-answer condition is copied')
  // ⚠️⚠️ **Check down to `single` being used in the press branch** (codex review low #5,
  //    2026-08-19). Even if `single` is computed but `onClick` is always `pick(...)`,
  //    the string checks and pure-function tests pass, and **a single diagram-less question becomes "select only, no submit button"**
  assert.match(t, /single\s*\?\s*void answer\(/, 'the instant-answer decision is not used when pressing')
  // ⚠️⚠️ **The clipped-diagram warning shows even when `art` is empty** (codex review medium #1, 2026-08-19).
  //    When the limit drops even the closing fence, no box shows, so adding `art &&` means
  //    **nothing shows on screen even though there's unseen content**
  assert.match(t, /\{o\.previewClipped \?/, 'the clipped warning is hidden depending on whether there is a diagram')
  assert.doesNotMatch(t, /art && o\.previewClipped/, 'the clipped warning is hidden depending on whether there is a diagram')
  assert.match(t, /needsSubmit\(p\.interaction\) \?/, 'the submit-button condition is copied')
  assert.doesNotMatch(t, /questions\.length > 1/, 'the submit-button condition is copied')

  // ★★ Diagrams go through `previewText` (fence lines aren't shown / 2026-08-19 medium #1).
  //    ⚠️ Drawing the raw `o.preview` shows the ``` lines as-is, and
  //       disagrees with the "answer instantly?" decision
  assert.match(t, /const art = previewText\(o\.preview\)/, 'drawn without first converting the diagram to display form')
  // ★★ Columns match the terminal (leaving full-width to the font breaks box drawings / measured 8px on 2026-08-19)
  assert.match(t, /cells\(line\)/, 'diagram columns are not matched to the terminal')
  const pcw2 = block('.pcw2')
  assert.match(pcw2, /width:\s*2ch;/, 'full-width columns are not 2ch')
  assert.match(pcw2, /display:\s*inline-block/, 'not a column box')
  // ⚠️ Boxing box-drawing characters too cuts glyphs so **they look dotted** (found in a real browser and removed)
  assert.doesNotMatch(CSS, /\.pcw1\b/, 'box-drawing characters are put in column boxes (they look dotted)')
  assert.doesNotMatch(t, /\{o\.preview\}/, 'drawing the raw preview')

  // ★★ Diagrams are **outside the button**. Inside, every horizontal swipe selects that choice
  const wrap = t.indexOf('class="permoptwrap"')
  assert.ok(wrap > 0, 'no choice container (the test itself is stale)')
  const close = t.indexOf('</button>', wrap)
  // ⚠️ The diagram is drawn by another component (`PreviewArt`). **The call must come after the button**
  const pre = t.indexOf('<PreviewArt', wrap)
  assert.ok(pre > 0, 'the diagram is not shown')
  assert.ok(close > 0 && close < pre, 'the diagram is inside the button (separate the tap surface from the swipe surface)')
  assert.match(t, /function PreviewArt[\s\S]*?class="permoptpre"/, 'no diagram box')

  // ★★ Don't break box drawings. ⚠️ Fails if reverted to `pre-wrap`
  // ⚠️ **Look after stripping comments**. It once failed just because a note mentioned `pre-wrap`
  const css = block('.permoptpre').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(css, /white-space:\s*pre;/, 'the diagram wraps (box lines shift)')
  assert.doesNotMatch(css, /pre-wrap/, 'the diagram wraps (box lines shift)')
  // ⚠️ Overflow scrolls only inside the box (the whole page never scrolls horizontally)
  assert.match(css, /overflow-x:\s*auto;/, 'horizontal overflow of the diagram is not contained in the box')
  // ⚠️⚠️ **Don't trap vertical scrolling** (`/code-review` low #1 and medium #1, 2026-08-19). A finger starting on the box
  //    couldn't move the page or get down to the buttons. Check **every box in the card that scrolls vertically**
  //    (`.permfull` had the same trap left = missed because "it's only one card")
  //
  // ⚠️⚠️ ★ **Look at "all" declarations of the selector** (same day's codex review low #5).
  //    `block()` only returns the first one, so reverting later inside `@media` to
  //    `overscroll-behavior-y: contain` or `white-space: pre-wrap` passed
  for (const [sel, forbidden] of [
    ['.permoptpre', /overscroll-behavior(-y)?:\s*contain|white-space:\s*pre-wrap/],
    ['.permfull', /overscroll-behavior(-y)?:\s*contain/],
  ] as const) {
    const bodies = allBlocks(sel)
    assert.ok(bodies.length > 0, `selector not found (the test itself is stale): ${sel}`)
    for (const body of bodies) {
      assert.doesNotMatch(body, forbidden, `${sel} has a declaration that must not come back`)
    }
  }
  assert.match(css, /min-width:\s*0;/, 'flex child lacks min-width: 0 (body scrolls horizontally)')
})

test('★ what the screen means is written on the screen (`title` can\'t be read with a finger)', () => {
  // ⚠️ The context amount was shown as just `673k`, and **nobody knew what the number was**
  //    (`/code-review` low #2, 2026-08-19). With the explanation only in the `title` attribute,
  //    **it can't be read on phones, the main battlefield**
  const t = stripComments(readFileSync(join(SRC, 'ui', 'SessionList.tsx'), 'utf8'))
  assert.match(t, /ctx \{ctx\}/, 'the context amount has no on-screen explanation')
  // ⚠️ When unknown, don't show the chip at all (don't write `0`)
  assert.match(t, /\{ctx \?/, 'showing the chip when unknown')
})

test('★★ with an approval card, the landing point is "the boundary between record and card" (wiring checked mechanically)', () => {
  // ⚠️⚠️ Jumping to the very bottom lands on **the bottom of the card**. With 3 questions + diagrams a card spans 2–3 screens,
  //    so **the text right before the questions is off screen** and it looks like "the text isn't shown" (reported 2026-08-19).
  //    ⚠️ `.tsx` can't be imported from `node:test`, so guarded by strings.
  // ⚠️⚠️ **Look after stripping comments** (`/code-review` low #4, 2026-08-19).
  //    It looked at the raw file, so **it passed just because a note said `block: 'center'`**
  //    (we hit and fixed the same trap on the CSS side, but left it here)
  const t = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  assert.match(t, /const settleView = /, 'no single place decides the landing point')
  assert.match(t, /block: 'center'/, 'the boundary is not centered on screen')
  // **Both** the first load and card appearance go through settleView (two or more calls)
  const calls = (t.match(/settleView\((?!behavior)/g) ?? []).length
  assert.equal(calls >= 2, true, `a path doesn't go through the landing point (${calls} calls)`)

  // ★ Don't create paths that pull back to the bottom while a card is shown (same review, medium #2).
  //   Jumping straight to the bottom is allowed only in the 2 places **a human explicitly pressed/sent**.
  //   ⚠️ The 3rd (live following) remains with the condition **only when there's no card**
  const direct = (t.match(/bottomRef\.current\?\.scrollIntoView/g) ?? []).length
  assert.equal(direct, 3, `the number of direct jumps to the bottom changed: ${direct} (allowed is 3: ↓ button, right after sending, live following)`)
  assert.match(
    t,
    /nearBottom && permissionsRef\.current\.length === 0/,
    'live following ignores the card and jumps to the bottom',
  )
  // ★ Card appearance is judged by position (`atBottomRef` becomes false by our own scroll / same review, medium #1)
  assert.match(t, /if \(!boundaryOnScreen\(\)\) return/, 'card appearance is not judged by position')
  // ★ Only pull when added (don't pull back when answering reduces it / codex medium #1)
  assert.match(t, /if \(added === 0\) return/, 'no "only when added" condition')
  // ★ The signal shows on "card not visible" (`!atBottom` makes it disappear after sending / codex medium #2)
  assert.match(t, /const permBelow = needsPermSignal\(area, permissions\.length\)/, 'the signal condition is not delegated to a pure function')
  // ★★ The decision measures **the card itself** (not the end of the page / codex round 3, medium #2)
  assert.match(t, /ref=\{permsRef\}/, 'no box to measure the approval card')
  assert.match(t, /permArea\(permBox\?\.top, permBox\?\.bottom, usable\.top, usable\.bottom\)/, 'the signal decision doesn\'t use measured values')
  // ★★ Measure after commit (values during render are from the previous layout / same review, medium #4)
  assert.match(t, /useLayoutEffect\(measure\)/, 'not measured after commit')
  assert.match(t, /new ResizeObserver\(/, 'the card growing/shrinking is not observed')
  assert.match(t, /box: 'border-box'/, 'ResizeObserver is not border-box')
  // ★★ Pressing the signal **actually moves** (same review, medium #3; a regression I introduced)
  // ⚠️ The same string appears in the label's `?:`, so look **inside `if (`** (with a loose check
  //    a mutation replacing it with `if (false)` slipped past / 2026-08-19)
  assert.match(t, /if \(signalTarget\(area\) === 'down'\)/, 'the direction is not checked when the signal is pressed')
  assert.match(t, /signalTarget\(area\) === 'down' \? '↓' : '↑'/, 'the signal arrow does not show the direction')
  // ★ Don't pull while the log is loading (pulling on an empty record and again after loading makes it jump / codex round 3, low #6)
  assert.match(t, /if \(loading\) return/, 'pulling while the log loads (double scroll)')
  assert.match(t, /block: 'end'/, 'does not move to the end of the card when its bottom is cut off')
  // ⚠️ Give the destination a margin so it doesn't stop behind the input box (the formula lives in one place, `--pad-h`)
  assert.match(block('.permswrap'), /scroll-margin-bottom:\s*var\(--pad-h\)/, 'the end of the card stops behind the input box')
  assert.match(block('.composerpad'), /height:\s*var\(--pad-h\)/, 'the input box height is not in one place')
  // ★★ **Floating buttons also sit on the same measurement** (2026-09-21 / "↓ Latest" got hidden in practice).
  //   ⚠️⚠️ `.jump.up` used to **recount the input box height with a formula**,
  //      `calc(max(18px, env(…)) + 54px)`, so it went underneath by however much the input box grew.
  //   ⚠️ The positioning modifier (`.up`) was **removed** = "always add it" is a convention, not an invariant.
  //   ⚠️⚠️ **Always go through `stripComments`** (2026-09-21; **hit on the spot**).
  //      The check picked up **the very note** "don't add `env(safe-area-inset-bottom)`" and failed
  //      = a repeat of CLAUDE.md's "the most common form is hitting a comment".
  const jump = stripComments(block('button.jump'))
  assert.match(jump, /bottom:\s*calc\(var\(--pad-h\)/, 'floating buttons don\'t use the input box\'s actual size')
  // ⚠️⚠️ **Don't add the notch again** (`--pad-h` is `.composer`'s border-box = already included)
  assert.doesNotMatch(jump, /safe-area-inset-bottom/, 'the notch is counted twice')
  // ⚠️ The positioning modifier **hasn't come back** (if it did, "forgetting to add it" would happen again)
  assert.doesNotMatch(stripComments(CSS), /\.jump\.up\b/, 'the positioning modifier came back (back to a convention)')
  // ★ The pure-function call **returns its result** (rejects mutations that `void` it and return a fixed value / same review, medium #7)
  assert.match(
    t,
    /const boundaryOnScreen = \(\): boolean =>\s*boundaryVisible\(/,
    'the boundary decision doesn\'t return the pure function\'s result as-is',
  )
  // ★★ Don't assert that a `quiet` notice **will appear in this thread** (codex review medium #3, 2026-08-19).
  //    `quiet` is a count per endpoint and carries no session identifier
  assert.doesNotMatch(t, /まもなく承認が表示されます/, 'the quiet notice asserts it will appear in this thread')
  assert.match(t, /このPCで確認中の承認が \$?\{quietPermissions\} 件あります/, 'no quiet notice / count not shown')

  // ★★ **Decisions live in pure functions (`scroll.ts`)** (same day's codex medium #5).
  //    Conditions written inside `.tsx` don't turn red under mutation tests (boundary mutations actually slipped past)
  assert.match(t, /from '\.\/scroll\.ts'/, 'scroll decisions are not moved to pure functions')
  for (const fn of ['boundaryVisible(', 'permArea(', 'addedKeys(', 'needsPermSignal(', 'signalTarget(']) {
    assert.ok(t.includes(fn), `pure function not used: ${fn}`)
  }
  // ⚠️ What the screen passes is **measured values** (don't copy conditions)
  assert.match(t, /window\.innerHeight,?\s*\)/, 'the screen height is not passed')
  assert.doesNotMatch(t, /if \(!atBottomRef\.current\) return/, 'uses a check that becomes false by our own scroll')
  // ★ Instead of showing the 2nd+ cards by scrolling, make them noticeable by count (same review, medium #1)
  assert.match(t, /permissions\.length > 1 \? (?:t\()?`（\$\{permissions\.length\}件）`/, 'the approval count is not shown')

  // ⚠️⚠️ ★ **Only names and counts were checked, so 4 slip-past mutations remained**
  //    (codex review medium #1, 2026-08-19). Pin the destination, dependencies and ref **concretely**.
  //    ⚠️ "a settleView name exists" and "block: 'center' exists" are weak conditions
  assert.match(
    t,
    /permissionsRef\.current\.length > 0 \? permTopRef\.current : bottomRef\.current/,
    'the landing destinations (boundary / bottom) are swapped',
  )
  // ⚠️ Removing the ref makes `permTopRef.current` null and it **silently falls back to the bottom**
  assert.match(t, /ref=\{permTopRef\}/, 'the boundary marker has no ref')
  // ⚠️ Adding `permissions` to the first-load dependencies means **refetch + scroll on every parent re-render**
  //    (`main.tsx` passes a new array every time, stealing the position when reading above)
  const firstLoad = /const page = await transport\.getLog\(sessionId, \{ limit: PAGE \}\)[\s\S]*?\}, \[([^\]]*)\]\)/.exec(t)
  assert.ok(firstLoad, 'first-load effect not found (the test itself is stale)')
  assert.equal(firstLoad![1]!.trim(), 'sessionId, endpointId', 'first-load dependencies grew')
  // ⚠️ The card-appearance effect goes through `settleView('smooth')`
  assert.match(t, /permKeys\]\)/, 'no card-appearance effect')
  assert.match(t, /settleView\('smooth'\)/, 'card appearance does not go through the landing point')
})

test('★★ the sticky banner height is "distributed from one measurement" (formula not duplicated)', () => {
  // ⚠️⚠️ The same bug was made **3 times**: writing only `--jump-h` fell short by the notch (medium #2) /
  //    double counting with `#app`'s padding (medium #1) / the formula became a lie the moment it had two rows (banner row 2, 2026-08-18).
  //    The root cause was **duplicating the banner height as a CSS formula**. It now distributes the measurement, so
  //    here we check that "the duplication hasn't come back".
  const bar = block('.threadbar')

  // The banner "adds the notch inside" + "cancels #app's top padding with a negative margin"
  assert.match(bar, /position:\s*sticky/)
  assert.match(bar, /padding:[^;]*env\(safe-area-inset-top/, 'the banner doesn\'t avoid the notch')
  assert.match(
    bar,
    /margin:\s*calc\(-1 \* max\(12px, env\(safe-area-inset-top[^;]*\)\)\)/,
    '#app\'s top padding is not cancelled (the notch is counted twice)',
  )

  // The destination looks **only at the measurement (--bar-h)**
  const smt = /scroll-margin-top:\s*([^;]+);/.exec(block('.threadhead'))?.[1] ?? ''
  assert.ok(smt.includes('var(--bar-h)'), `the destination doesn't use the banner measurement: ${smt}`)
  assert.ok(
    !smt.includes('--jump-h') && !smt.includes('env('),
    `the destination duplicates the banner height as a formula (always off with two rows): ${smt}`,
  )

  // ★ There's **exactly one place** writing the measurement.
  //   ⚠️ Without it `--bar-h` is frozen at the :root fallback (one row) and breaks on row 2
  const writers = sources().filter((f) => /setProperty\(\s*'--bar-h'/.test(f.text))
  assert.deepEqual(
    writers.map((f) => f.rel),
    [join('ui', 'ThreadBar.tsx')],
    '--bar-h is written only in the banner implementation',
  )
  const w = writers[0]!.text
  assert.match(w, /getBoundingClientRect\(\)\.height/, 'written with a formula instead of a measurement')
  assert.match(w, /new ResizeObserver\(/, 'height changes are not followed (a stale value remains when row 2 comes and goes)')
  // ⚠️ The default (content-box) **doesn't fire on padding changes** = when the notch changes
  //    (device rotation) a stale height remains. Confirmed by measurement that it doesn't fire (2026-08-18)
  assert.match(
    w,
    /box:\s*'border-box'/,
    'ResizeObserver is not border-box (can\'t catch padding changes from the notch)',
  )
})

// ★★ Live following's "not loaded yet" marker **must not be 0** (`/code-review` medium, 2026-08-20).
//    `tail` is "the end of the last complete line", so **it can be 0 even for a file with content**
//    (when the first record is over 4KB and mid-write). With 0 as a sentinel
//    **following never starts for that mount** (the thread stops updating).
test('★★ Thread: the tail sentinel is a negative value, not 0', () => {
  const t = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  assert.match(t, /const tailRef = useRef\(-1\)/)
  assert.match(t, /if \(tailRef\.current < 0\)/)
  // ⚠️ No comparison with 0 remains (`page.tail === tailRef.current` is different, so excluded)
  assert.ok(!/tailRef\.current === 0/.test(t), 'using 0 as the tail sentinel')
  assert.ok(!/tailRef\.current = 0\b/.test(t), 'resetting tail to 0 (the not-loaded marker is -1)')
})

// ★★ Live following "doesn't run concurrently, doesn't rewind, checks the generation" (codex medium #3/#4, 2026-08-20).
//    The decision itself is covered by `follow.ts` unit tests. Here we pin **that the screen uses it** and
//    that the locks stopping concurrency and rapid repeats remain.
test('★★ Thread: following goes through followAction and stops concurrency and rapid repeats', () => {
  const t = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  // Not reverted to a raw comparison (the `page.tail === tailRef.current` decision lives in followAction)
  assert.match(t, /const action = followAction\(\{/)
  assert.ok(!/page\.tail === tailRef\.current/.test(t), 'the follow decision is back in the screen')
  // The lock stopping concurrency (no next call while running). ★ Moved to `coalesce` on 2026-09-23
  //   (following is driven by notifications, so signals during a run aren't dropped but run once afterwards / `followPlan.ts`)
  assert.match(t, /const pull = coalesce\(async \(\) => \{/)
  // Rapid repeats of reading backwards
  assert.match(t, /if \(olderRef\.current\) return/)
  // Generation check (looked at when the response arrives)
  assert.match(t, /gen !== genRef\.current/)
  // ★ If the file was recreated, reread from the latest (don't append to old contents)
  assert.match(t, /if \(action === 'reset'\) \{/)
})

// ★★ Following retries even if the first load fails (codex medium #4, 2026-08-20).
//    ⚠️ Without this, opening from a notification a session whose transcript doesn't exist yet
//    stays **empty forever until reopened**.
test('★★ Thread: if tail isn\'t loaded, refetch the latest page', () => {
  const t = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  assert.match(t, /if \(tailRef\.current < 0\) \{\s*await loadFirst\(gen\)/)
})

// ★★ The list passed to notification cleanup is the **superset** (the agent's `pendingTags`) (`/code-review` low #5, 2026-08-20).
//    ⚠️ Building it from `permissions` **closes live notifications** of quietly waiting approvals.
test('★★ main: notification cleanup uses pendingTags (superset)', () => {
  const t = stripComments(readFileSync(join(SRC, 'main.tsx'), 'utf8'))
  // ⚠️ The same shape appears in the dependency line (joining `p.key`), so look **only at the expression passed to cleanup**
  //    (a loose regex was written here once and a mutation survived)
  assert.match(t, /closeStalePermissionNotifications/)
  assert.match(
    t,
    /const active = new Set\(\s*known\.flatMap\(\(s\) => s\.pendingTags \?\? s\.permissions\.map\(\(p\) => permissionTag/,
  )
  assert.match(t, /pendingTags: perms\.pendingTags/)
})

// ★★ When an answer **didn't go through**, don't remove the notification (codex high #1, 2026-08-20).
//    `permissionTag` drops the generation (`#…`), so closing with a refused old card
//    **removes the only signal of an approval of another generation waiting now**.
test('★★ Permissions: remove the notification only when the answer went through', () => {
  const t = stripComments(readFileSync(join(SRC, 'ui', 'Permissions.tsx'), 'utf8'))
  assert.match(
    t,
    /if \(!res\.ok\) \{[\s\S]{0,400}?return\s*\}\s*void closePermissionNotification\(/,
    'no return when it didn\'t go through (the notification gets removed)',
  )
})

// ★★ No undefined CSS variables are used (hit on 2026-08-21 by writing `var(--muted)`).
//    ⚠️ Invalid values are **silently ignored**, so you don't notice until the look breaks.
test('★★ styles.css: no undefined variables are used', () => {
  const css = readFileSync(join(SRC, 'styles.css'), 'utf8')
  const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]))
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
  const missing = [...used].filter((v) => !defined.has(v))
  assert.deepEqual(missing, [], `undefined variables: ${missing.join(', ')}`)
})

// ★★ How "text not yet recorded" is shown (2026-08-21).
//    ⚠️ If this breaks, **the explanation right before an approval doesn't show** (this feature's reason to exist) or
//      **the same text appears twice**. Both were nearly hit during design.
test('★★ Thread: unrecorded text is shown after matching, and replaced on every follow', () => {
  const t = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  // Shown only when "it isn't in after matching" (the decision is shared with shared/)
  // ⚠️ Pass `final` (finished text is matched **in full** / codex medium #8)
  assert.match(t, /\{inflight && !alreadyInTranscript\(inflight\.text, entries, inflight\.final\) \? \(/)
  // ⚠️ The decision uses **all elements the screen holds** (deciding by `page.entries` duplicates on follow)
  assert.ok(!/alreadyInTranscript\(\s*[a-z]*page\./.test(t), 'matching only against the page\'s elements')
  // The text goes through the markdown element tree (`innerHTML` banned / CLAUDE.md)
  assert.match(t, /class="md">\{renderMarkdown\(inflight\.text\)\}/)
  // ★★ On follow, replace it **before followAction's decision** (`/code-review` high #1, 2026-08-21).
  //    ⚠️ While waiting for a human, tail doesn't grow, so `followAction` returns `ignore` every time.
  //      Placed after it, **this feature itself doesn't work** (the text doesn't update until reopening).
  //    ★ The previous canary only checked "before `reset`" and let this through.
  const poll = t.slice(t.indexOf('{ since: tailRef.current }'))
  const setAt = poll.indexOf('setInflight(page.inflight)')
  const actionAt = poll.indexOf('const action = followAction')
  const ignoreAt = poll.indexOf("action === 'ignore'")
  assert.ok(setAt > 0, 'setInflight not called on follow')
  assert.ok(actionAt > 0, 'followAction not found')
  assert.ok(setAt < actionAt, `setInflight comes after followAction (${setAt} > ${actionAt})`)
  assert.ok(setAt < ignoreAt, 'setInflight comes after the early return on ignore')
  // ★ The generation check comes before setInflight (don't show another thread's text)
  assert.ok(poll.indexOf('gen !== genRef.current') < setAt, 'setInflight before checking the generation')
  // ★ Discarding on switch is no longer needed (rebuilt by `<Thread key=…>` in `main.tsx`).
  //   ⇒ Instead **the presence of key** is pinned by the test below (fails if removed).
  assert.ok(!/setInflight\(undefined\)/.test(t) || true)
})

test('★★ Thread.tsx passes the send result\'s `route` to the optimistic row (needed to match keystrokes)', () => {
  // ⚠️ `.tsx` can't be run from node:test, so **the wiring is pinned as strings**.
  //    If this is missing it goes back to "delivered by keystrokes, but 'can't confirm delivery' never clears"
  //    (appeared on a real device on 2026-08-23; `pending.ts` tests can't detect it).
  const thread = sources().find((f) => f.rel === join('ui', 'Thread.tsx'))
  assert.ok(thread, 'Thread.tsx not found')
  assert.match(
    thread.text,
    /\b\w+\s*=\s*await\s+transport\.sendMessage\(/,
    'not receiving the send result (route unavailable)',
  )
  // ★ Matching what arrived while sending (2026-08-23; without it "can't confirm" lingers)
  // ★★ Queue at the moment of sending and settle on the reply (2026-09-24 / codex round 25 / pending.ts)
  assert.match(thread.text, /setPending\(\(prev\) => beginSend\(prev, id, text, Date\.now\(\)\)\)/, 'not queued at the moment of sending')
  assert.match(thread.text, /finishSend\(prev, id, res\.route\)/, 'not settled on the reply')
  assert.match(thread.text, /finishSend\(prev, id, null\)/, 'not removed when sending failed')
  assert.match(thread.text, /noteArrivals\(prev, page\.entries, usedRef\.current\)/, 'not matched against arrivals')
  assert.doesNotMatch(thread.text, /registerPending\(|arrivalsRef/, '⚠️⚠️ back to queuing after the reply')
})

test('★★ the thread view draws every LogEntry kind (no kind left undrawn)', () => {
  // ⚠️ "Drawn ≠ visible" (2026-08-24). The `switch` has no `default`, so
  //    adding a kind makes TypeScript say nothing and **only that element silently vanishes**.
  const types = readFileSync(join(SRC, '..', '..', 'shared', 'types.ts'), 'utf8')
  const union = /export type LogEntry =([\s\S]*?)\n\n/.exec(types)?.[1] ?? ''
  const kinds = [...union.matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]!)
  assert.ok(kinds.length >= 7, `LogEntry kinds not obtained: ${kinds.join(',')}`)
  const thread = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  for (const kind of kinds) {
    assert.ok(thread.includes(`case '${kind}':`), `Thread.tsx doesn't draw ${kind}`)
  }
})

test('★★ table commands run "after going through confirmation" (never at the moment of pressing)', () => {
  // ⚠️⚠️ `/exit` is irreversible (the session disappears = **pending approvals disappear too**).
  //    Fails if it goes back to calling `transport.runCommand` directly from the menu's `onClick`.
  const src = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  const calls = [...src.matchAll(/transport\.runCommand\(/g)].length
  assert.equal(calls, 1, `transport.runCommand is called in ${calls} places (keep it to one)`)
  // ★ The menu only "opens the confirmation"
  assert.match(
    src,
    /onClick: \(\) => \{[\s\S]{0,120}?if \(!v\.disabled\) setConfirm\(\{ id, \.\.\.here \}\)/,
    'the menu does not open the confirmation',
  )
  // ★ Execution comes from the dialog's `onOk`
  assert.match(src, /onOk=\{\(\) => void runCommand\(confirm\)\}/, 'not executed from the confirmation OK')
  // ★★ Don't write whether to show it on the screen (one place, `commands.ts`)
  assert.match(src, /commandView\(\s*session,\s*id,/, 'not going through commandView')
  assert.ok(!/session\?\.live && .*runCommand/.test(src), 'the show condition is written inside the screen')
})

test('★★ the /exit confirmation includes "irreversible" wording (wording also in one place)', () => {
  // ⚠️ Writing the wording directly in Thread.tsx makes it disagree with `commands.ts`
  const src = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  assert.match(src, /COMMAND_UI\[confirm\.id\]\.body/, 'the confirmation body is not taken from the table')
  assert.ok(!/承認待ちも消え/.test(src), 'the wording is written directly in Thread.tsx')
  const ui = readFileSync(join(SRC, 'ui', 'commands.ts'), 'utf8')
  assert.match(ui, /取り返しがつきません|取り返しがつかない/, 'commands.ts has no warning')
})

test('★★ async send targets come from "the destination at the moment of pressing" (never reread the current value)', () => {
  // ⚠️ Isolation on switching is handled by `<Thread key=…>` (the test below). What's pinned here is
  //    **where the send target comes from** (so destinations don't swap if `key` is removed).
  // ⚠️⚠️ **Matching against "the current `sessionId`" after completion is meaningless** (a closure value, so it always matches /
  //    measured in codex round 7, medium #2, 2026-08-25). So pin **the origin**, not a match.
  const src = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  assert.match(src, /const here = \{ sessionId, endpointId \}/, 'the destination is not built in one place')
  assert.match(src, /setConfirm\(\{ id, \.\.\.here \}\)/, 'the confirmation does not carry the destination')
  assert.match(src, /transport\.runCommand\(target\.sessionId, target\.id\)/, 'the send target is not from the target')
  assert.match(src, /transport\.clearInput\(target\.sessionId\)/, 'the clear send target is not from the target')
  assert.ok(
    !/transport\.(runCommand|clearInput)\(sessionId/.test(src),
    '⚠️⚠️ sending to the current sessionId (rereading it)',
  )
  // ★ The running marker is released by **token** (an old run doesn't clear a newer marker for the same destination)
  const run = src.slice(src.indexOf('const runCommand'), src.indexOf('const area ='))
  assert.match(run, /const token = \+\+runToken\.current/, 'no per-run token')
  assert.match(run, /setRunning\(\{ \.\.\.target, token \}\)/, 'the running marker is not set')
  assert.match(run, /setRunning\(\(prev\) => releaseRunning\(prev, token\)\)/, 'not released by token')
})

test('★★ the thread is rebuilt per destination (async work before switching doesn\'t break the screen after)', () => {
  // ★★ codex round 8, high #1, 2026-08-25. **This is the root fix**.
  //   ⚠️⚠️ Without `key` the same component is reused, so async work started **before** switching
  //      breaks the screen **after** switching (notice, optimistic rows, input box, saved draft, running marker).
  //      Rounds 6–7 patched these **individually** (= plugging holes one by one).
  //   ⇒ Rebuilding with `key` means no one sees `setState` from the unmounted side = **it disappears structurally**.
  const main = stripComments(readFileSync(join(SRC, 'main.tsx'), 'utf8'))
  const src = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  // ★ The destination is **both the endpoint and the session** (the same sessionId can exist on two machines)
  assert.match(
    main,
    /<Thread[\s\S]{0,200}?key=\{`\$\{transport\.endpoint\.id\}:\$\{openSessionId\}`\}/,
    'Thread has no per-destination key (the component is reused on switching)',
  )
  // ★★ With `key`, the switching effect **doesn't need** "discard things one by one" logic.
  //   ⚠️⚠️ Going back to it leaves **one frame** since `useEffect` runs after paint (round 6, high #1).
  //      = a shape where a missed discard becomes an accident. ⇒ Pin here that it **doesn't grow**.
  // ⚠️⚠️ **Bracket with code markers** (`src` has comments stripped, so using a comment as a marker
  //    makes `indexOf` -1 and **the slice an empty string = a false green that checks nothing**.
  //    Hit by my own mutation test on 2026-08-25)
  const from = src.indexOf('let cancelled = false')
  const to = src.indexOf('}, [sessionId, endpointId])', from)
  assert.ok(from > 0 && to > from, 'loading effect not found (validity of the test itself)')
  const effect = src.slice(from, to)
  assert.match(effect, /setLoading\(true\)/, 'effect contents not obtained (validity of the test itself)')
  for (const dead of ['setConfirm(undefined)', 'setRunning(undefined)', 'setNote(undefined)']) {
    assert.ok(
      !effect.includes(dead),
      `${dead} came back into the switching effect (breaks the key-based shape)`,
    )
  }
  // ★ Show the target's name in the heading (for noticeability. ⚠️ Not a guard in itself)
  assert.match(src, /title=\{confirmTitle\(confirm\.id, session\)\}/, 'the confirmation heading doesn\'t show the target')
})

test('★★ pin the table-command wiring (send target and notes)', () => {
  // ⚠️ Mutations named by codex: `runCommand(sessionId, id)` → `runCommand('wrong-session', id)` /
  //    `note={DRAFT_WARNING}` → `note={undefined}` (neither has behavioral TSX tests)
  const src = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  // ★ Notes are **per operation** ("the draft will be sent too" is irrelevant to `clear` / held in the table)
  assert.match(src, /note=\{confirmNote\(confirm\.id\)\}/, 'the confirmation note is not taken from the table')
  // ⚠️ Mutation named by codex: fixing the menu's `sending` wiring to `'ready'`
  assert.match(
    src,
    /commandView\(session, id, running\?\.id === id \? 'sending' : 'ready', features\)/,
    'the running marker or feature markers are not passed to the menu',
  )
  // ★ What turns red. ⚠️ `auto-approve` is "reversible", but **arbitrary commands run after pressing**
  //   (added 2026-09-07. ⚠️ Kills mutations removing it from red)
  assert.match(
    src,
    /danger=\{confirm\.id === 'exit' \|\| confirm\.id === 'auto-approve'\}/,
    '/exit or auto-approve is not red',
  )
  // ⚠️ Mutations named by codex: not closing the confirmation while running / not clearing "running" when done
  const run = src.slice(src.indexOf('const runCommand'), src.indexOf('const area ='))
  assert.match(run, /setRunning\(\{ \.\.\.target, token \}\)/, 'the running marker is not set')
  assert.match(run, /releaseRunning\(prev, token\)/, '"running" is not cleared after execution')
  assert.equal(
    [...run.matchAll(/setConfirm\(undefined\)/g)].length,
    1,
    'the confirmation is not closed on execution (can be pressed again)',
  )
  // ★ The loading effect's dependencies include endpointId (catches switches where only the machine changes)
  // ⚠️ Comments are stripped before looking, so bracket with **code markers**
  assert.match(src, /setLoading\(true\)[\s\S]{0,1200}?\}, \[sessionId, endpointId\]\)/, 'missing dependencies')
})

test('★★ auto-approve visibility is derived from "the markers" (pins `main.tsx` wiring)', () => {
  // ⚠️⚠️ codex round 2, high #1, #2 and medium #3, 2026-09-07. **The same hole was made 4 times here**, so
  //    even in `.tsx` (can't be hit by mutations) **only the dangerous wiring** is checked mechanically. Mutations killed here:
  //      ① stop overlaying markers with `applyAutoApprove` (make it depend on where the row came from)
  //      ② drop `machine` / `endpointId` from markers (markers land on another machine's row, off goes elsewhere)
  //      ③ put markers back in `synthesizeRows` (two mechanisms again, back to fixing only one)
  //      ④ remove the send-target fallback (endpoints with only a marker) (off can't be sent)
  const m = stripComments(readFileSync(join(SRC, 'main.tsx'), 'utf8'))

  // ② A marker carries four things: **sessionId + until + machine + endpointId**
  const marks = m.slice(m.indexOf('const autoApproveMarks'), m.indexOf('const merged'))
  assert.ok(marks.length > 0, 'no marker construction')
  for (const need of ['sessionId: a.id', 'until: a.until', 'machine: s.machine', 'endpointId: s.endpoint.id']) {
    assert.ok(marks.includes(need), `⚠️ marker lacks ${need} (marks another machine's row / off goes to another machine)`)
  }

  // ① **Overlay** onto list rows (once, when building `merged`)
  assert.match(
    m,
    /const merged = applyAutoApprove\(all\.flatMap\(\(s\) => combineRows\(s\)\), autoApproveMarks\)/,
    '⚠️ markers are not overlaid onto list rows (cached history rows get no marker)',
  )
  // ① Overlay onto thread rows too (**a row is created if absent** is what guarantees the off button)
  assert.match(
    m,
    /const session = applyAutoApprove\(\s*base \? \[base\] : \[\],/,
    '⚠️ markers are not overlaid onto the thread row (the banner vanishes the moment an approval is answered)',
  )
  // ③ One mechanism (`synthesizeRows` has no markers)
  assert.match(m, /synthesizeRows\(pendingPerms, merged\)/, '⚠️ markers put back into synthetic rows (two mechanisms)')
  // ④ Send-target fallback: owner → pending approvals → marker, in that order
  assert.match(
    m,
    /owner\?\.endpoint\.id \?\? permEndpoint \?\? autoEndpoint/,
    '⚠️ no fallback to "endpoints with only a marker" (off can\'t be sent)',
  )
  assert.match(m, /const autoEndpoint = autoApproveMarks\.find/, 'the endpoint is not looked up from markers')
})

test('★★ pin auto-approve wiring (shown in the banner, off without confirmation)', () => {
  // ⚠️⚠️ `.tsx` can't be hit by mutations, so **only the dangerous wiring** is checked mechanically (2026-09-07).
  //    Mutations killed here:
  //      ① not shown in the banner (only inside `⋯` = unknown unless opened = keeps running unnoticed)
  //      ② a confirmation dialog before off (two taps from the banner, unreachable when panicking)
  //      ③ decide visibility with `commandView` (**can't be turned off** on sessions without keystrokes)
  //      ④ not passing the running / feature markers
  const src = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  // ① Passed to the banner (`ThreadBar`)
  assert.match(src, /auto=\{/, '⚠️ the auto-approve warning is not passed to the banner (hidden in the menu)')
  assert.match(src, /autoApproveBanner\(session, Date\.now\(\)\)/, 'the banner text is not taken from one place')
  // ③④ Visibility is `autoApproveView` (⚠️ not `commandView`)
  assert.match(
    src,
    /autoApproveView\(\s*session,\s*running\?\.id === 'auto-approve' \? 'sending' : 'ready',\s*features,\s*\)/,
    'the running marker or feature markers are not passed to auto-approve',
  )
  // ② On needs confirmation, off is immediate (branching on `autoView.on`)
  assert.match(
    src,
    /if \(autoView\.on\) void autoApproveOff\(\)\s*else setConfirm\(\{ id: 'auto-approve', \.\.\.here \}\)/,
    '⚠️ the on/off branch changed (confirming off makes it two taps from the banner)',
  )
  // ★ No confirmation dialog mixed into the off path
  const off = src.slice(src.indexOf('const autoApproveOff'), src.indexOf('const runCommand'))
  assert.ok(off.length > 0, 'no off path')
  assert.ok(!/setConfirm/.test(off), '⚠️ off goes through a confirmation')
  // ★ The send target is the destination at the moment of pressing (`here`). The current value isn't reread
  assert.match(off, /\.\.\.here/, 'the off destination is not taken from the value at the moment of pressing')
})

test('★★ new feature buttons are shown by the agent\'s "feature markers" (don\'t reuse `sendRoute`)', () => {
  // ⚠️⚠️ codex round 7, medium #3, 2026-08-25: machines update one by one, so
  //    buttons appear on **agents without the endpoint yet** and 404. `sendRoute` can't be used as a marker
  //    (it predates `/command` `/clear`).
  const main = stripComments(readFileSync(join(SRC, 'main.tsx'), 'utf8'))
  // ⚠️ codex round 8 mutation ②: `health.features?.filter(() => false)` matches the first half and passes
  assert.match(main, /features: health\.features,/, 'health markers are not stored as-is')
  assert.ok(!/features: health\.features[^,\n]/.test(main), 'the markers are modified (buttons disappear)')
  assert.match(main, /features=\{ownerState\?\.features\}/, 'markers are not passed to Thread')
  const ui = stripComments(readFileSync(join(SRC, 'ui', 'commands.ts'), 'utf8'))
  // ★ fail-closed (not shown without the marker)
  assert.match(ui, /if \(!features\?\.includes\(NEEDS_FEATURE\[id\]\)\)/, 'markers are not checked')
})

// ── Display, stopping and asset integrity of the original cats ────────────────────────

test('★★ no sound is used (picture and sound have different rights holders / codex low #9)', () => {
  // ⚠️⚠️ "No sound is used" was **written in a comment, but no test checked it**
  //    (adding audio playback to `Composer` stayed green). = Relying on my own comment.
  //    ⇒ Once written, check it mechanically.
  // ⚠️ On the other hand **"the repository is private" is not checked mechanically** (querying
  //    the remote's visibility from a test is flaky, so we decided not to).
  //    ⇒ That is only written in CLAUDE.md as "reread before going public".
  //      **Don't write that it's guarded.**
  // ⚠️ Sequence and extension alone aren't enough (codex round 2, low #5, 2026-08-28).
  //    `new window.Audio('data:audio/wav;base64,…')` matches neither `new Audio(` nor `.wav`
  const banned: [RegExp, string][] = [
    [/<audio[\s/>]/i, '<audio>'],
    // ★ Catch all of `new Audio(` / `new window.Audio(` / `new globalThis.Audio(`
    [/new\s+(?:[\w$.]+\.)?Audio\s*\(/, 'new Audio('],
    [/AudioContext\b/, 'AudioContext'],
    [/\.(mp3|ogg|wav|m4a)\b/i, 'audio file'],
    // ★ Forms embedded via data URL / MIME
    [/audio\/(wav|mpeg|mp3|ogg|webm|aac|x-m4a)/i, 'audio MIME'],
  ]
  const hits: string[] = []
  for (const f of sources()) {
    const text = stripComments(f.text)
    for (const [re, label] of banned) {
      if (re.test(text)) hits.push(`${f.rel}: ${label}`)
    }
  }
  assert.deepEqual(hits, [], `sound is used (a different rights holder's matter):\n${hits.join('\n')}`)
})

test('★★ cat assets are kept in-house (never fetched from nyan.cat directly)', () => {
  // ⚠️⚠️ An external reference **disappears offline** and hits someone else's server every time it opens.
  //    ⚠️ A separate matter from discipline 1 (no own-origin assumption): these are **our own assets** served by the PWA.
  const css = stripComments(CSS)
  assert.match(css, /--nyan-sheet:\s*url\('\/cats\/mochi-cat\.png'\)/, 'asset reference is not in one place')
  assert.doesNotMatch(css, /nyan\.cat|https?:\/\//, 'CSS references an external URL')

  // ⚠️⚠️ **Looking only at CSS isn't enough** (codex round 2, medium #3, 2026-08-28).
  //    A mutation adding `style={{ backgroundImage: "url('https://nyan.cat/…')" }}` to JSX stayed green.
  //    At runtime **inline styles win**, so it disappears offline, and if it's a GIF
  //    it doesn't stop even with `prefers-reduced-motion`. ⇒ Look at the screen sources too.
  const outside: string[] = []
  for (const f of sources()) {
    const text = stripComments(f.text)
    if (/nyan\.cat/i.test(text)) outside.push(`${f.rel}: nyan.cat`)
    // ★ Forms pulling images from outside (`url(http…)` / an external URL in `backgroundImage`)
    if (/url\(\s*['"]?https?:/i.test(text)) outside.push(`${f.rel}: url(http…)`)
  }
  assert.deepEqual(outside, [], `the screen pulls external assets:\n${outside.join('\n')}`)
  // ★ The real file exists (so the test isn't "green while missing")
  const png = join(SRC, '..', 'public', 'cats/mochi-cat.png')
  assert.ok(statSync(png).size > 500, 'asset missing / too small')
})

test('★★ sprite dimensions match between CSS and the real file (prevents half-frame shifts)', () => {
  // Display PNGs are 2x resolution. Match the frame boundaries between the sheet and CSS.
  const png = readFileSync(join(SRC, '..', 'public', 'cats/mochi-cat.png'))
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG')
  const sheetW = png.readUInt32BE(16) / 2
  const sheetH = png.readUInt32BE(20) / 2

  const num = (name: string): number => {
    const m = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)`).exec(stripComments(CSS))
    assert.ok(m, `${name} missing (the test itself is stale)`)
    return Number(m![1])
  }
  const w = num('--nyan-w')
  const h = num('--nyan-h')
  const frames = num('--nyan-frames')

  assert.equal(sheetH, h, `sheet height differs from --nyan-h: ${sheetH} vs ${h}`)
  assert.equal(sheetW, w * frames, `sheet width differs from frame width × frame count: ${sheetW} vs ${w * frames}`)
  // ★ Used at 1x (non-integer scaling fattens dots unevenly)
  assert.equal(sheetW % frames, 0, 'frame width is not an integer')
})

test('★★ the picture shows / isn\'t blurred / the animation ends at "one full sheet"', () => {
  // ⚠️⚠️ **Don't just check that "the declaration exists"** (codex medium #3, 2026-08-28).
  //    A mutation to `background-image: none` stayed green (the asset variable, PNG and dimensions all remain, yet
  //    **the cat vanishes completely**). ⇒ Check down to it actually pointing at the asset.
  // ⚠️⚠️ **Don't use `block()`** (codex round 2, medium #2, 2026-08-28). It only returns the first one, so
  //    a mutation appending `@media (max-width: 9999px) { .nyan { background-image: none } }`
  //    **could erase the cat on phones while staying green**. This repo hit the same hole on 2026-08-19 and
  //    built `allBlocks()`, yet I wrote it with `block()` again.
  const blocks = allBlocks('.nyan')
  assert.ok(blocks.length > 0, 'no .nyan declaration (the test itself is stale)')
  const nyan = blocks.join('\n')
  assert.match(nyan, /background-image:\s*var\(--nyan-sheet\);/, 'not pointing at the asset (no picture)')
  // ⚠️ **Fails if even one later declaration cancels it** (including inside `@media`)
  for (const b of blocks) {
    assert.doesNotMatch(b, /background-image:\s*none/, 'the asset is erased')
    assert.doesNotMatch(b, /image-rendering:\s*(auto|smooth|crisp-edges)/, 'pixel art gets blurred')
  }
  // ⚠️ With the default smooth scaling, outlines melt into something else
  assert.match(nyan, /image-rendering:\s*var\(--nyan-rendering\);/, 'the per-asset rendering mode is not used')
  // ⚠️ Stretch so one frame equals the element size
  assert.match(
    nyan,
    /background-size:\s*calc\(var\(--nyan-w\) \* var\(--nyan-frames\)\) var\(--nyan-h\);/,
    'frame slicing is broken',
  )
  // ⚠️⚠️ The end point is **one full sheet** (`steps()` lands exactly on frame boundaries).
  //    Writing it as a percentage (%) misses the boundaries and **shifts by half a frame**
  const clean = stripComments(CSS)
  const play = clean.slice(clean.indexOf('@keyframes nyan-play'))
  assert.match(
    play.slice(0, 300),
    /calc\(var\(--nyan-w\) \* var\(--nyan-frames\) \* -1\)/,
    'the animation end point is not on a frame boundary',
  )
  assert.doesNotMatch(play.slice(0, 300), /%/, 'the animation end point is written as a percentage (half-frame shift)')
})

test('★★ the run declaration "really runs" (codex medium #3)', () => {
  // ⚠️⚠️ Only the presence of `animation:` on `.nyanrun` was checked, so all of these stayed green:
  //    - changing to `animation: none` (stops even while responding)
  //    - changing `steps(...)` to `linear` (**half-cut frames** flow by)
  //    ⇒ Check **the contents**: animation name, frame stepping, and period.
  const clean = stripComments(CSS)
  const m = /\.nyanrun\s*\{([^}]*)\}/.exec(clean)
  assert.ok(m, '.nyanrun declaration not found (the test itself is stale)')
  const run = m![1]!
  assert.match(run, /animation:\s*nyan-play\b/, 'wrong animation name / set to none')
  assert.match(run, /steps\(var\(--nyan-frames\)\)/, 'not frame-stepped (steps)')
  assert.match(run, /var\(--nyan-cycle\)/, 'the period does not come from a token')
  assert.match(run, /infinite/, 'stops after one cycle')
})

test('★★ **reliably** stops with the "reduce motion" setting (closes the comma loophole)', () => {
  // ⚠️⚠️ Only the presence of `animation:\s*none` was checked, so
  //    a mutation **adding a second one with a comma**, `animation: none, nyan-play ... infinite`, stayed green
  //    (keeps moving on screens of people who enabled the setting / codex medium #3).
  // ⚠️⚠️ **Don't look only at "the first" `@media (prefers-reduced-motion)`** (codex round 2, medium #2).
  //    A mutation **appending a later `@media` with the same condition that restarts it** passed green
  //    by looking only at the first block's `animation: none`. ⇒ **Look at every block.**
  const clean = stripComments(CSS)
  const bodies: string[] = []
  for (let at = clean.indexOf('@media (prefers-reduced-motion: reduce)'); at >= 0; ) {
    let depth = 0
    let end = -1
    for (let i = clean.indexOf('{', at); i < clean.length; i++) {
      if (clean[i] === '{') depth++
      else if (clean[i] === '}' && --depth === 0) {
        end = i
        break
      }
    }
    assert.ok(end > 0, 'the reduced-motion block is not closed')
    bodies.push(clean.slice(at, end))
    at = clean.indexOf('@media (prefers-reduced-motion: reduce)', end)
  }
  assert.ok(bodies.length > 0, 'no reduced-motion declaration')

  // ★ At least one block stops the cat, and **no block restarts it**
  let stopped = false
  for (const body of bodies) {
    for (const m of body.matchAll(/\.nyanrun\s*\{([^}]*)\}/g)) {
      const anim = m[1]!
        .split(';')
        .map((d) => d.trim())
        .filter((d) => /^animation\s*:/.test(d))
      if (anim.length === 0) continue
      // ⚠️ Also close the loophole of adding a second with a comma (`animation: none, nyan-play …`)
      assert.deepEqual(anim, ['animation: none'], `the stop is not a single "animation: none": ${anim}`)
      stopped = true
    }
  }
  assert.ok(stopped, 'the cat\'s motion is not stopped under reduced-motion')
})

test('★★ the run class is derived from `running` (fixing it gives "a picture that misrepresents state")', () => {
  // ⚠️⚠️ **This survived** (mutation 7 on 2026-08-28). We checked that the caller (`Composer`)
  //    passes `running={busy.running}`, yet a mutation where **`Nyan` discards the value and
  //    always adds `nyanrun`** stayed green.
  //    = The cat keeps running on stopped sessions (misrepresents state).
  // ⇒ Check that **the expression deciding `nyanrun` references `running`**.
  const n = stripComments(readFileSync(join(SRC, 'ui', 'Nyan.tsx'), 'utf8'))
  // ⚠️⚠️ **Check the direction too** (codex medium #2, 2026-08-28). Only "`running` and `nyanrun` appear in the expression"
  //    was checked, so **an inverting mutation `running ? 'nyan' : 'nyan nyanrun'` stayed green**
  //    (stops only while responding and runs in every other state = a picture that misrepresents state).
  //    ⇒ Check that **the true branch has `nyanrun` and the false branch doesn't**.
  const t = /\brunning\s*\?\s*'([^']*)'\s*:\s*'([^']*)'/.exec(n)
  assert.ok(t, `the run ternary not found (hardcoded / shape changed): ${n.slice(0, 200)}`)
  const [, whenRunning, whenStopped] = t!
  assert.match(whenRunning!, /\bnyanrun\b/, `nyanrun not added when running: ${whenRunning}`)
  assert.doesNotMatch(whenStopped!, /\bnyanrun\b/, `nyanrun added when stopped: ${whenStopped}`)
  // ★ Both branches need the base `nyan` (without it neither dimensions nor image apply)
  assert.match(whenRunning!, /(^|\s)nyan(\s|$)/, 'no .nyan when running')
  assert.match(whenStopped!, /(^|\s)nyan(\s|$)/, 'no .nyan when stopped')
  // ★ `nyanrun` only inside this expression (no path adding it unconditionally elsewhere)
  assert.equal(
    (n.match(/nyanrun/g) ?? []).length,
    1,
    'nyanrun appears in multiple places (a path to add it unconditionally)',
  )
})

test('★★ the cat is stopped by default (runs only when `.nyanrun` is present)', () => {
  // ⚠️⚠️ Doing the reverse (run by default and write the stop separately) puts the stop in
  //    **two places, for `.nyanrun` and for reduced-motion**, and fixing only one shows
  //    "running while stopped" = **a picture that misrepresents state**.
  const nyan = stripComments(block('.nyan'))
  assert.doesNotMatch(nyan, /animation:/, 'the stopped side has an animation')
  for (const body of allBlocks('.nyanrun')) {
    // `.nyanrun` has two: the "run" side and reduced-motion's "stop" side
    assert.match(body, /animation:/, '.nyanrun has no animation declaration')
  }
})

test('★ things that move stop under the "reduce motion" setting', () => {
  // ⚠️ Built so stopping leaves frame 0 (= the stopped cat)
  const at = CSS.indexOf('@media (prefers-reduced-motion: reduce)')
  assert.ok(at >= 0, 'no reduced-motion declaration')
  let depth = 0
  let end = -1
  for (let i = CSS.indexOf('{', at); i < CSS.length; i++) {
    if (CSS[i] === '{') depth++
    else if (CSS[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  assert.ok(end > 0, 'the reduced-motion block is not closed')
  const body = CSS.slice(at, end)
  assert.match(body, /\.nyanrun\b/, 'the cat\'s motion is not stopped')
  assert.match(body, /animation:\s*none/, 'how to stop is not written')
})

test('★★ the line above the input box shows "after reserving its seat" (`--pad-h` wiring)', () => {
  // ⚠️⚠️ `--pad-h` was **a hardcoded 58px** for the input box height. Adding a line made
  //    both `.composerpad` and `.permswrap`'s `scroll-margin-bottom` **lies**,
  //    hiding the last message and approval buttons behind the input box (the same shape hit 3 times with `--bar-h`).
  //    ⇒ **Reserve the seat even when it isn't shown** (erring larger is safe = only more space).
  // ⚠️ `block(':root')` **can't be used** (it's `indexOf('\n:root {')`, so it misses the `:root {`
  //    on line 1 of the file and returns the second `:root` later). Look at all with `allBlocks`
  const roots = allBlocks(':root').join('\n')
  assert.ok(allBlocks(':root').length >= 2, ':root not found (the test itself is stale)')
  assert.match(roots, /--nyan-h:\s*\d/, 'the cat height is not a token')
  assert.match(roots, /--busy-h:\s*calc\(var\(--nyan-h\)/, 'the line height is not derived from the cat height')

  // ★ `--pad-h` is "base + one line + notch". ⚠️ Also fails mutations restoring it inside `@media`
  const padDecls = [...CSS.matchAll(/--pad-h:\s*([^;]+);/g)].map((m) => m[1]!)
  assert.ok(padDecls.length > 0, 'no --pad-h (the test itself is stale)')
  for (const d of padDecls) {
    assert.match(d, /var\(--busy-h\)/, `--pad-h doesn't include the one-line seat: ${d}`)
    assert.match(d, /var\(--composer-h\)/, `--pad-h doesn't include the input box base: ${d}`)
  }

  // ★★ **Protect the base obtained by measurement** (codex medium #5, 2026-08-28).
  //    ⚠️⚠️ Originally only "contains `var(--busy-h)`" was checked, so
  //       a mutation to `calc(0px + var(--busy-h) + …)` stayed green (27px of space against
  //       an 87px input box = **the last 60px goes underneath**). The measured number itself was a false green.
  //    ⚠️ Measured 60.13px (Chrome 390px wide, one line). Checked as **a lower bound** (increasing is the safe side).
  const base = /--composer-h:\s*(\d+(?:\.\d+)?)px/.exec(roots)
  assert.ok(base, 'no --composer-h (the test itself is stale)')
  assert.ok(
    Number(base![1]) >= 61,
    `the input box base is smaller than the measurement (60.13px): ${base![1]}px`,
  )

  // ★★ The real value is **measured and distributed** (not relying on the fallback number / codex medium #7).
  //    ⚠️ Paths like the textarea growing 42→120px with multiple lines can't all be counted in a formula
  const c = stripComments(readFileSync(join(SRC, 'ui', 'Composer.tsx'), 'utf8'))
  // ⚠️⚠️ **Don't just look at API names** (codex round 2, medium #1, 2026-08-28).
  //    A mutation to `setProperty('--pad-h', '0px')` stayed green (= the end and approval buttons hide underneath).
  //    ⇒ Check down to **distributing the actual size (`getBoundingClientRect().height`)**.
  //    ⚠️ **Don't look line by line** (arguments can be broken over lines). Look at a **window around** where it's written
  const at = c.indexOf("setProperty(")
  assert.ok(at >= 0, 'the input box height is not distributed to `--pad-h`')
  const window_ = c.slice(at, at + 240)
  assert.match(window_, /'--pad-h'/, '`--pad-h` is not distributed')
  assert.match(
    window_,
    /getBoundingClientRect\(\)\.height/,
    `distributing a value that isn't the actual size: ${window_.slice(0, 120)}`,
  )
  assert.match(c, /new ResizeObserver\(/, 'height changes are not followed')
  assert.match(c, /box: 'border-box'/, 'ResizeObserver is not border-box (doesn\'t fire on padding changes)')
  // ★★ **Measuring is two-layered** (codex round 2, low #4, 2026-08-28).
  //    ⚠️⚠️ It relied on observation only, so **following stopped in environments without `ResizeObserver`**
  //       (open with one line and type 8: measured 164px while `--pad-h` stayed 87px = about 77px underneath).
  //    ⇒ **Also measure on every render** (situations that change height almost always involve a render).
  //    ⚠️ It must have no dependency list (`useLayoutEffect(writePad)`). Adding `[]` makes it run only once
  assert.match(
    c,
    /useLayoutEffect\(writePad\)/,
    'no re-measure on every render (following stops where it can\'t be observed)',
  )
  assert.match(c, /useLayoutEffect\(/, 'measuring after paint (a one-frame-stale space appears)')
  // ⚠️⚠️ The actual size already includes `.composer`'s `padding-bottom: calc(8px + env(...))`, so
  //    adding `env()` when writing is **double counting** (the shape actually hit with `--bar-h`)
  assert.doesNotMatch(
    /setProperty\('--pad-h'[^\n]*/.exec(c)?.[0] ?? '',
    /env\(/,
    'env() added to the measured value (double counting)',
  )

  // ★★ The line's height is exactly `--busy-h` (if it grows it overflows the seat and hides underneath)
  const busy = stripComments(block('.composerbusy'))
  assert.match(busy, /height:\s*var\(--busy-h\);/, 'the line height is not --busy-h')
  assert.match(busy, /box-sizing:\s*border-box;/, 'padding falls outside the height')
  // ⚠️ `margin` falls **outside** `--busy-h`, so it stays 0 (the space below comes from padding).
  //    ⚠️⚠️ Writing it negatively is a lie (`/margin:\s*(?!0)/` also matches `margin: 0;`:
  //       `\s*` can pick zero characters, so the lookahead succeeds at the whitespace position). **Check the intended shape**
  assert.match(busy, /margin:\s*0;/, 'space is held by margin (overflows the seat)')
  assert.doesNotMatch(busy, /margin-(bottom|block-end):/, 'the space below is a margin')
  assert.match(busy, /min-width:\s*0;/, 'flex child lacks min-width: 0 (horizontal scroll)')
})

test('★★ the input box line\'s decision goes through the single `composerBusy` (conditions not copied)', () => {
  // ⚠️⚠️ Writing the same state decision in two places **disagreed in 65 of 96 cases**, this repo's
  //    most expensive lesson. ⇒ The list, banner and input box all go through `showNyan`.
  //    ⚠️ `.tsx` can't be imported from `node:test`, so guarded by strings (the pure-function side is
  //       matched across all states by `ui/status.test.ts`).
  const t = stripComments(readFileSync(join(SRC, 'ui', 'Thread.tsx'), 'utf8'))
  assert.match(t, /busy=\{composerBusy\(session\)\}/, 'materials are not passed to the input box')

  const c = stripComments(readFileSync(join(SRC, 'ui', 'Composer.tsx'), 'utf8'))
  // ★ The input box side doesn't look at state (it only receives materials)
  assert.doesNotMatch(c, /'working'/, 'Composer judges state itself')
  assert.doesNotMatch(c, /statusView|showNyan/, 'Composer steps into the decision')
  // ★ Don't make it optional with `?` (if types still pass without it, it silently vanishes from the screen)
  assert.match(
    c,
    /\n  busy: \{ label: string; cls: string; running: boolean \} \| null\n/,
    'busy is optional / materials are missing',
  )
  // ★★ Run/stop is **passed** (forgetting it fails the types, but fixed values are banned too)
  assert.match(c, /<Nyan running=\{busy\.running\} \/>/, 'the run decision is not passed')
  // ★ Meaning is carried by text (not just the picture). Color is state-derived too
  assert.match(c, /class=\{`state \$\{busy\.cls\}`\}>\{busy\.label\}</, 'text/color are not state-derived')
})

test('★★ the cat appears only in one place, the input box (not in list rows or the banner)', () => {
  // ⚠️⚠️ The user decided on 2026-08-28: **not in the list or header**.
  //    ⇒ Adding more breaks "where to look", and the list **adds rects per row**
  //      (98 rects per cat; 1960 with 20 rows).
  // ⚠️ `.tsx` can't be imported from node:test, so guarded by strings.
  // ⚠️⚠️ **Don't check by component name** (codex round 2, low #6, 2026-08-28).
  //    A mutation using `import { Nyan as Cat }` with `<Cat running />` hit neither the `<Nyan>` check
  //    nor the lowercase class check, and could add cats to the list.
  //    ⇒ Check **the files importing `Nyan.tsx`** (an alias can't remove the import).
  const users = sources()
    .filter((f) => f.rel !== join('ui', 'Nyan.tsx'))
    .filter((f) => /from\s*'\.{1,2}\/(?:ui\/)?Nyan\.tsx'/.test(stripComments(f.text)))
    .map((f) => f.rel)
  assert.deepEqual(users, [join('ui', 'Composer.tsx')], `more places show the cat: ${users}`)

  // ⚠️⚠️ **The component name alone isn't enough** (codex medium #4, 2026-08-28).
  //    A mutation adding one **raw** `<span class="nyan nyanrun" />` line to the list or banner stayed green
  //    (`<Nyan>` doesn't increase, so it passes the check above).
  //    ⇒ The cat's class strings are confined **to `Nyan.tsx` only**.
  //    ⚠️ Case **is distinguished**. Classes are lowercase (`nyan` / `nyanrun`), while
  //       uppercase `Nyan` is the component name and import path; ignoring case would flag `Composer.tsx` falsely.
  //    ⚠️ **Look only inside `class` attributes** (codex round 2, low #6). Searching the whole source for `nyan`
  //       **flags unrelated things** like `data-testid="nyan"` (false positives).
  const raw: string[] = []
  for (const f of sources()) {
    if (f.rel === join('ui', 'Nyan.tsx')) continue
    for (const m of stripComments(f.text).matchAll(/class=(?:"([^"]*)"|\{`([^`]*)`\}|'([^']*)')/g)) {
      const value = m[1] ?? m[2] ?? m[3] ?? ''
      if (/\bnyan(run)?\b/.test(value)) raw.push(`${f.rel}: class="${value}"`)
    }
  }
  assert.deepEqual(raw, [], `places write the cat's class directly:\n${raw.join('\n')}`)
})

test('★★ finding a session\'s owner is only `pickOwner` (not hand-written in `.tsx`)', () => {
  // ⚠️⚠️ Mutation ⑥ from codex round 3, 2026-09-01. Reverting `pickOwner(all, id)` to
  //    `all.find((s) => combineRows(s).some((x) => x.sessionId === id))`
  //    **picks A if A's old history comes before B's live** (= keeps reading old logs), yet
  //    the pure-function tests in `history.test.ts` stay green. ⇒ **`.tsx` can't be hit by mutations, so check mechanically.**
  const src = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  const inline = src.match(/\.some\(\s*\(\s*x\s*\)\s*=>\s*x\.sessionId\s*===/g) ?? []
  assert.deepEqual(inline, [], `owner lookup is written inside .tsx (use pickOwner)`)
  assert.ok(src.includes('pickOwner('), 'pickOwner is not used')
})

/** ⚠️ `sources()` covers only web/src, so a small scan to look at other trees too */
function allSources(...roots: string[]): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = []
  const walk = (dir: string, base: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === 'dist') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        walk(path, base)
        continue
      }
      if (!/\.(tsx?|mjs)$/.test(name) || name.includes('.test.')) continue
      out.push({ rel: relative(base, path), text: readFileSync(path, 'utf8') })
    }
  }
  const root = new URL('../../', import.meta.url).pathname
  for (const r of roots) walk(join(root, r), root)
  return out
}

test('★★ test-only hooks are not used from production code (the injection points in `shared/crypto.ts`)', () => {
  // ⚠️⚠️ `__forTest` (swapping ephemeral keys and randomness) and `__unsafeSessionForTest`
  //    (creating a Session without a handshake) **break the crypto entirely if called from production**.
  //    ⇒ Named so it's obvious, and **also checked mechanically** (not a prose promise / codex round 4).
  const all = allSources('web/src', 'agent/src', 'shared')
  assert.ok(all.length >= 30, `too few targets (the scan is broken): ${all.length}`)
  const bad = all
    .filter((f) => f.rel !== join('shared', 'crypto.ts'))
    .filter((f) => /__forTest|__unsafeSessionForTest/.test(f.text))
    .map((f) => f.rel)
  assert.deepEqual(bad, [], 'production code references test-only hooks')
})

test('★★ the PWA doesn\'t import agent-only key modules (XSS can\'t exfiltrate keys)', () => {
  // ⚠️⚠️ `agent/src/agentKey.ts` has `exportPrivateKey` and generates `extractable: true` keys.
  //    If the PWA imported it, **it would ship an API letting XSS exfiltrate the private key**
  //    (codex round 4, high #2, 2026-09-01; the very reason it was moved out of `shared/crypto.ts`).
  // ⚠️ `deviceKey.ts` (writes the private key to a file) and `peers.ts` (registration/revocation) are agent-only too.
  //    ★ To add more, add them here (**everything that touches the agent's state files**).
  const bad = sources()
    .filter((f) => /agentKey|deviceKey|from '.*\/peers\.ts'/.test(f.text))
    .map((f) => f.rel)
  assert.deepEqual(bad, [], 'the PWA references agent-only modules')
})

test('★★ the one-time token is sent only to "the one matched endpoint" (never leaked)', () => {
  // ⚠️⚠️ The QR names the agent by **public key**, while the PWA holds endpoints by **URL**.
  //    A shape that "POSTs to every endpoint without matching and takes whichever succeeds"
  //    **leaks the one-time token to other machines** (ARCHITECTURE §14.1.2.16).
  //
  // ★★ **The main test is `ui/pairRun.test.ts`** (stubs the transport and
  //    confirms "sent to only one machine" = checks the link between return value and side effect).
  //    ⚠️ Here we guard that **the procedure doesn't come back into `.tsx`** (then no one would check it).
  const all = allSources('web/src')
  const run = all.find((f) => f.rel === join('web', 'src', 'ui', 'pairRun.ts'))
  assert.ok(run, 'pairRun.ts not read (the scan is broken)')

  // ★ Extract **only the body** of the registration procedure (★ and assert it was obtained = don't check empty)
  const body = /export async function runPairing\([\s\S]*?\n\}/.exec(run.text)?.[0] ?? ''
  assert.ok(body.length > 200, 'could not get the body of runPairing')
  assert.match(body, /pickPairTarget\(/, 'sending without matching')
  assert.ok(
    body.indexOf('pickPairTarget(') < body.indexOf('sendPairing('),
    '⚠️⚠️ sending before matching',
  )
  // ⚠️⚠️ **Don't create a shape that loops over endpoints to send** (narrow to one, then send)
  assert.equal(/transports\.map|for \(const/.test(body), false, '⚠️⚠️ looping over endpoints to send')
  // ⚠️ Count only **calls** (`.pairDevice(`). Counting declarations (interface) always gives 2
  //   ★ 2026-09-16: there are now two ways to choose the destination (existing endpoint / the QR's `u`), so
  //     **sending was gathered into one place, `sendPairing`**. This counts that one.
  assert.equal(run.text.split('.pairDevice(').length - 1, 1, 'pairDevice is not called from exactly one place')

  // ★★ The path connecting via the QR's `u` also **matches before sending** (2026-09-16 / Y).
  //   ⚠️⚠️ Skipping it would mean "hand the one-time token to wherever the QR points".
  const viaQr = /async function pairViaQr\([\s\S]*?\n\}/.exec(run.text)?.[0] ?? ''
  assert.ok(viaQr.length > 200, 'could not get the body of pairViaQr')
  assert.match(viaQr, /found\.agentPublicKey !== payload\.agentPublicKey/, '⚠️⚠️ keys are not matched')
  assert.ok(
    viaQr.indexOf('agentPublicKey !== payload.agentPublicKey') < viaQr.indexOf('sendPairing('),
    '⚠️⚠️ sending before matching (the QR `u` path)',
  )
  // ⚠️ Adding as an endpoint happens **after registration succeeds** (don't leave refused peers in the list)
  assert.ok(
    viaQr.indexOf('sendPairing(') < viaQr.indexOf('addEndpoint?.('),
    '⚠️ added to endpoints before registration',
  )

  // ⚠️⚠️ **`.tsx` doesn't hold the procedure** (if it did, it would be back where there are no behavioral tests)
  const bad = all
    .filter((f) => f.rel.endsWith('.tsx'))
    .filter((f) => /\.pairDevice\(|\.revokeDevice\(|\.listDevices\(/.test(f.text))
    .map((f) => f.rel)
  assert.deepEqual(bad, [], '.tsx calls register/revoke/list directly (move it to pairRun.ts)')
})

test('★★ revocation is sent only to "the machine of the pressed row" (never removes another machine)', () => {
  // ⚠️⚠️ It used to try all endpoints in order and stop at the first success, so with the same device key
  //    registered on A and B, **pressing B's row removed A** (codex medium #5, 2026-09-08).
  const run = allSources('web/src').find((f) => f.rel === join('web', 'src', 'ui', 'pairRun.ts'))
  assert.ok(run, 'pairRun.ts not read')
  const body = /export async function runRevoke\([\s\S]*?\n\}/.exec(run.text)?.[0] ?? ''
  assert.ok(body.length > 120, 'could not get the body of runRevoke')
  // ★ Use the destination held by the row (`row.at`)
  assert.match(body, /transports\[row\.at\]/, 'the row\'s destination is not used')
  assert.equal(/transports\.map|for \(const/.test(body), false, '⚠️⚠️ looping over endpoints')
  // ⚠️ Treat `saved === false` separately (dropping it means "removed yet it comes back")
  assert.match(body, /saved === false/, 'saved:false is dropped')
})

test('★★ the handshake procedure lives in ui/pairing.ts (not reassembled in .tsx)', () => {
  // ⚠️ `.tsx` has no behavioral tests, so **the procedure (first message → reply → confirm → encryption)**
  //    lives in a testable `.ts` (2026-09-08 / `verifyHandshake`).
  const tsx = allSources('web/src').filter((f) => f.rel.endsWith('.tsx'))
  assert.ok(tsx.length >= 5, `too few targets: ${tsx.length}`)
  const bad = tsx
    .filter((f) => /startHandshake\(|finishHandshake\(/.test(f.text))
    .map((f) => f.rel)
  assert.deepEqual(bad, [], '.tsx assembles the handshake itself')

  const src = tsx.find((f) => f.rel === join('web', 'src', 'ui', 'Pairing.tsx'))
  assert.ok(src, 'Pairing.tsx not read')
  assert.match(src.text, /verifyHandshake\(/, 'the connectivity check doesn\'t go through `verifyHandshake`')
})

test('★★ the camera lifecycle is owned by scan.ts (.tsx doesn\'t run the loop)', () => {
  // ⚠️⚠️ codex round 7, medium #6, 2026-09-16. `.tsx` has no behavioral tests, so
  //    writing "open, loop, close" for the camera in the screen breaks **unmounting, double taps and
  //    failures mid-open** without anyone seeing (measured: removing `track.stop()` left
  //    all 7 tests green / docs/VERIFY.md "a lax fake gives a false green — 3rd time").
  const tsx = allSources('web/src').filter((f) => f.rel.endsWith('.tsx'))
  assert.ok(tsx.length >= 5, `too few targets: ${tsx.length}`)
  // ★ Only `.ts` may run the loop
  const bad = tsx.filter((f) => /scanForPairing\(/.test(f.text)).map((f) => f.rel)
  assert.deepEqual(bad, [], '.tsx runs the scan loop itself (move it to `createScanController`)')

  const src = tsx.find((f) => f.rel === join('web', 'src', 'ui', 'Pairing.tsx'))
  assert.ok(src, 'Pairing.tsx not read')
  assert.match(src.text, /createScanController\(/, 'no one owns the camera lifecycle')
  // ⚠️⚠️ **Stop when the screen goes away** (otherwise the lamp stays on even after moving to another screen)
  assert.match(
    src.text,
    /useEffect\(\(\) => \(\) => scanRef\.current\?\.stop\(\), \[\]\)/,
    'the camera is not stopped on unmount',
  )
})

test('★★ pairing-only connections allow "only the single pairing endpoint" (step 7 of ③ / §14.1.4)', () => {
  // ⚠️⚠️ If this loosens, **unregistered peers get full power**. The session key is real, so
  //    the only thing stopping them is `authenticate`'s default deny.
  const auth = allSources('agent/src').find((f) => f.rel === join('agent', 'src', 'auth.ts'))
  assert.ok(auth, 'auth.ts not read')
  // ★ Exactly **one** endpoint is allowed (not a table = adding more fails here)
  const gate = /function isPairingPath\([\s\S]*?\n\}/.exec(auth.text)?.[0] ?? ''
  assert.ok(gate.length > 20, 'could not get the body of isPairingPath')
  assert.deepEqual(
    [...gate.matchAll(/route\?\.pattern === '([^']+)'/g)].map((m) => m[1]),
    ['/pair'],
    'the pairing-only connection does not allow exactly one endpoint, "/pair"',
  )
  // ⚠️⚠️ Refuse **before `NYAN_REMOTE_DEV=1`'s `via:'dev'`** (falling through lets everything pass).
  //   ⇒ The pairing decision is inside the `marks.get(req)` branch = before the dev branch.
  const at = {
    marked: auth.text.indexOf('const marked = marks.get(req)'),
    pairing: auth.text.indexOf("marked.minted.kind === 'pairing'"),
    dev: auth.text.indexOf("via: 'dev'"),
  }
  assert.ok(at.marked >= 0 && at.pairing >= 0 && at.dev >= 0, 'markers not found')
  assert.ok(at.marked < at.pairing, 'the pairing decision comes before "the handshake mark"')
  assert.ok(at.pairing < at.dev, "⚠️⚠️ the pairing decision comes after `via:'dev'` (everything passes)")
  // ★ "Only once" is in the tunnel layer (a guard on **count**, not on endpoints; different things, both needed)
  const tunnel = allSources('agent/src').find((f) => f.rel === join('agent', 'src', 'tunnel.ts'))
  assert.ok(tunnel, 'tunnel.ts not read')
  assert.match(tunnel.text, /isPairingConnection\(o\.connection\)/, 'the pairing connection is not closed')
})

test('★★ the pairing button is hidden without the marker (fail-closed)', () => {
  // ⚠️⚠️ Machines update one by one, so **there's always a period with agents lacking the endpoint**.
  //    Showing the button without checking the marker gives **a button that 404s** (CLAUDE.md §2).
  const src = allSources('web/src').find((f) => f.rel === join('web', 'src', 'ui', 'Pairing.tsx'))
  assert.ok(src, 'Pairing.tsx not read')
  // ★ The decision is only `pairAbility` (don't hand-roll `features.includes` in the screen)
  assert.match(src.text, /pairAbility\(/, 'markers are not checked')
  assert.equal(
    /features\?\.includes|features\.includes/.test(src.text),
    false,
    'the screen hand-rolls the marker decision (move it to `pairAbility`)',
  )
  // ★ "Verify" uses the verify marker
  assert.match(src.text, /pairAbility\(h\?\.features\)\.verify/, 'verify doesn\'t check the verify marker')
  // ★★ Whether to show the section is `showPairing` (⚠️ not shown before health is known / codex low #1)
  assert.match(src.text, /if \(!showPairing\(healths\)\) return null/, 'section visibility is not showPairing')
  // ★ The `pair` marker for registration and listing is on the `pairRun.ts` side (the procedure moved there, so that's the one place)
  const run = allSources('web/src').find((f) => f.rel === join('web', 'src', 'ui', 'pairRun.ts'))
  assert.ok(run, 'pairRun.ts not read')
  assert.match(run.text, /pairAbility\(h\?\.features\)\.pair/, 'the list doesn\'t check the pair marker')
})

test('★★ only Endpoints.tsx uses the pairing screen (no extra entry points)', () => {
  const users = allSources('web/src')
    .filter((f) => f.rel !== join('web', 'src', 'ui', 'Pairing.tsx'))
    .filter((f) => /<Pairing\b/.test(f.text))
    .map((f) => f.rel)
  assert.deepEqual(users, [join('web', 'src', 'ui', 'Endpoints.tsx')])
})

test('★★ device identity is built only from "the mark of passing the handshake" (never from headers)', () => {
  // ⚠️⚠️ A shape like `x-nyan-device: <public key>` lets **browsers or curl claim it**
  //    (relying on `tailscale serve` stripping same-named headers from outside
  //    is "opening a hole before authentication" / CLAUDE.md §1).
  // ★ Two things are checked mechanically:
  //    ① only one place, `auth.ts`, creates `via: 'device'`
  //    ② that branch's material is `marks` (a WeakMap keyed by the request itself)
  const all = allSources('web/src', 'agent/src', 'shared')
  const makers = all
    .filter((f) => /via: 'device'/.test(f.text))
    .map((f) => f.rel)
  assert.deepEqual(makers, [join('agent', 'src', 'auth.ts')], "via:'device' is not created in exactly one place")

  const auth = all.find((f) => f.rel === join('agent', 'src', 'auth.ts'))
  assert.ok(auth, 'auth.ts not read (the scan is broken)')
  assert.match(
    auth.text,
    /const marked = marks\.get\(req\)/,
    'device identity is built from something other than `marks` (a WeakMap keyed by the request)',
  )
  assert.match(auth.text, /const marks = new WeakMap</, 'the marker container is not a WeakMap')
  // ★★ In step 7 of ③ the value became a union (`device` = registration generation / `pairing` = unregistered).
  //   ⚠️⚠️ **Don't make it a public value** (if public, the tunnel layer could promote itself to `device`
  //      = unregistered peers get full power). ⇒ The type is fixed here.
  assert.match(
    auth.text,
    /const minted = new WeakMap<DeviceConnection, Minted>/,
    'no WeakMap holding the connection\'s origin (registration generation / pairing)',
  )
  // ★ The `device` side keeps holding **the registration itself** (the basis for revocation working)
  assert.match(
    auth.text,
    /kind: 'device'; readonly registration: Device/,
    'the registration generation passed at the handshake is not bound to the connection (revocation stops working)',
  )
  // ★★ ③ Revocation applies to **connections that already handshook** (codex round 2, medium #8).
  //   ⚠️ The effect is checked behaviorally by `agent/src/deviceAuth.test.ts`. Here only **the wiring**
  //      (the generation check exists inside authentication = noticeable if removed).
  assert.match(
    auth.text,
    /isLiveRegistration\(marked\.minted\.registration\)/,
    '⚠️⚠️ authentication doesn\'t check the registration generation (revocation doesn\'t apply to existing connections / codex medium #8)',
  )
})
