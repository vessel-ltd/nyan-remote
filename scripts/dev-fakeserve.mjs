// A **check-only** server for verifying the history features in a real browser.
//
// ⚠️ Never touches the real agent (does not use 7777 / does not read state files).
//    Serves web/dist as is and returns fixed fake data for the API only.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, join, normalize } from 'node:path'
// ★ Approval card contents are built with **the real formatter** (passing a hand-written summary
//   makes only the screen look right even when the implementation changes / VERIFY.md "false green")
import { detailOf, summarize } from '../agent/src/permission.ts'
// ★ Questions with choices are also built with **the real conversion** (passing a hand-written interaction
//   makes only the screen look right even if the agent drops the preview. We actually missed that)
import { describeInteraction } from '../agent/src/claude/interaction.ts'
// ★ Preview columns are also counted with **the real logic**. Counting by hand is always wrong (hit twice on 2026-08-19;
//   the fixture was 2 columns off and it looked like "the implementation breaks it")
import { cells } from '../web/src/ui/previewCells.ts'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

// ★ Decide the language before building messages (calling `t()` at top level freezes the default language)
initCliLang()

/** Columns in a terminal */
const cellWidth = (line) =>
  cells(line).reduce((n, c) => n + (c.wide ? 2 : [...c.text].length), 0)

/** Draw a box-drawing frame **by counting columns** (write the contents and the frame fits automatically) */
const boxed = (rows) => {
  const w = Math.max(...rows.map(cellWidth))
  const bar = '─'.repeat(w + 2)
  return [
    `┌${bar}┐`,
    ...rows.map((r) => `│ ${r}${' '.repeat(w - cellWidth(r))} │`),
    `└${bar}┘`,
  ].join('\n')
}

// ⚠️ No absolute paths. When working in parallel with `git worktree`, it would **serve another worktree's dist
//    and make you think "I checked it in a real browser"** (CLAUDE.md §5 recommends worktrees).
//    It would also break on mac. Pointed out in the 2026-08-16 external review.
const DIST = fileURLToPath(new URL('../web/dist', import.meta.url))
// ⚠️ 7788 is the port used for **the real agent** in VERIFY.md's static-serving check.
//    If this server is left running, that check returns a false 200
const PORT = Number(process.argv[2] ?? 7799)

const now = new Date().toISOString()
let firstPermAt = 0
let extraPerm = false
// ★ Context size (2026-08-19). ⚠️ Built in the shape of the real usage (sum of 3)
// ⚠️ **Assign it to sessions that exist** (`CCC` is the approval's sessionId and had no row).
//    Cover every formatting branch: k / M / 0 (hidden) / not fetched (hidden)
const CTX = { AAA: 673965, BBB: 12000, DDD: 1234567, EEE: 0, FFF: undefined, GGG: 999999 }
const session = (id, title, status = 'idle', waitingFor = undefined) => ({
  machine: 'TESTBOX',
  account: '.claude-r',
  sessionId: id,
  cwd: '/home/test/proj',
  project: 'proj',
  title,
  titleSource: 'custom-title',
  status,
  ...(waitingFor ? { waitingFor } : {}),
  // ★ Context size. ⚠️ **Must not go inside the `waitingFor` branch**
  //    (2026-08-19 `/code-review` medium #1. Sessions needing attention got no value, and
  //    **the 1.2M row was never drawn** = the measurement was weaker than claimed)
  ...(CTX[id] === undefined ? {} : { contextTokens: CTX[id] }),
  live: true,
  lastActivity: now,
  transcriptBytes: 100,
})

/** ★ Offset times to see "oldest first (FIFO)" by eye */
const ago = (min) => new Date(Date.parse(now) - min * 60_000).toISOString()

// ★ The fake data below (titles, bodies, approval contents) is **data for checking how Japanese lays out on screen**. Do not translate it.
// i18n-fixture: begin fake data returned to the PWA (the Japanese titles and bodies are there to check Japanese typesetting)
const SESSIONS = [
  // ★ Include a long name too (it should be truncated to one line in the sticky bar)
  session('AAA', 'セッションA — 承認カードの全文とヘッダーの作り直し（長い名前の確認用）', 'working'),
  session('BBB', 'セッションB', 'background'),
  // ★ Does the "needs attention" reason show (the CLI's waitingFor)
  //   ⚠️ Last activity is offset (to check the second line of the bar lists **oldest first** / 2026-08-18)
  { ...session('DDD', 'セッションD', 'waiting', 'permission prompt'), lastActivity: ago(4) },
  // With no reason, just "needs attention"
  // ★ Long name (the second line of the bar should be truncated to one line)
  {
    ...session('EEE', 'セッションE — 長い名前で帯の2行目が1行に収まるかの確認用', 'waiting'),
    lastActivity: ago(12),
  },
  // ★ A dialog other than approvals (a kind that never reaches the approval hook. The warning text changes)
  { ...session('FFF', 'セッションF', 'waiting', 'input needed'), lastActivity: ago(8) },
  // ★★ Needs-attention on **another machine** (does the machine name show on the bar's second line / 2026-08-18 `/code-review` low #4).
  //    ⚠️ With this present, `machines.size > 1`, so list rows show machine names too (same shape as the real thing)
  {
    ...session('GGG', 'セッションG（別マシン）', 'waiting'),
    machine: 'OTHERBOX',
    lastActivity: ago(30),
  },
]

// ★ An approval that cannot be read in one line (a shape that caused trouble on a real device. A heredoc)
const LONG_COMMAND = [
  "python3 - <<'PY'",
  'import pathlib',
  '# media_types: playlist を inert から外す',
  "p = pathlib.Path('lib/media_types.py')",
  "s = p.read_text(encoding='utf-8')",
  's = s.replace(',
  "    'def is_inert_media_type(essence: str) -> bool:',",
  `    '''${'# `video/` `audio/` prefix を通るが**中身が URL のリスト**である型。'.repeat(8)}`,
  "_PLAYLIST_TYPES: frozenset[str] = frozenset({ 'video/mpegurl', 'application/x-mpegurl' })",
  ')',
  "p.write_text(s, encoding='utf-8')",
  'PY',
].join('\n')

const perm = (key, toolName, input, interaction, sessionId = 'AAA') => {
  const d = detailOf(toolName, input)
  return {
    ...(interaction ? { interaction } : {}),
    key,
    machine: 'TESTBOX',
    account: '.claude-r',
    project: 'proj',
    sessionId,
    toolName,
    summary: summarize(toolName, input),
    ...(d ? { detail: d.text, detailClipped: d.clipped } : {}),
    at: now,
  }
}

/** ★ Questions with choices. **The interaction is built by the real `describeInteraction`** */
const ask = (key, questions, sessionId = 'AAA') => {
  const input = { questions }
  return perm(key, 'AskUserQuestion', input, describeInteraction('AskUserQuestion', input), sessionId)
}

// A diagram pasted on a real device (the CLI draws the outer box frame, so the preview holds this part)
const PREVIEW_SCOPE = [
  'finishHeaders():',
  '  TE + CL 同時   -> 400',
  '  TE != chunked  -> 501',
  '  CL 不正/桁溢れ -> 400',
  '  POST で CL/TE 無し -> 411',
  '',
  '  state_ = COMPLETE   // body は読まない',
  '',
  '※ BODY_LENGTH / BODY_CHUNKED は M3-5 / M4-7',
].join('\n')

const PREVIEW_LF = [
  'GET / HTTP/1.1\\nHost: x\\n\\n',
  '  -> 200 OK   (nginx と一致)',
  '',
  'GET / HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n',
  '  -> 200 OK',
].join('\n')

// ★★ A diagram written in markdown (a code fence) as per the contract. The fence lines must not appear on screen.
//    ⚠️ `---`, `|` and `**bold**` **staying as is** is correct (removing them shifts columns and breaks the box)
const PREVIEW_FENCED = [
  '```ts',
  'finishHeaders() {',
  '  if (te && cl) return 400   // **同時**は弾く',
  '}',
  '```',
  '---',
  '| 入力 | 結果 |',
].join('\n')

// ★★ Endurance check for "diagram-like" things (2026-08-19). **Does it fit in the frame, does it not break the page**
const PREVIEW_TREE = [
  'request',
  '  ├── parseRequestLine ────> METHOD SP TARGET SP VERSION CRLF ────> ok',
  '  ├── parseHeaders ───┬───> Content-Length ──> BODY_LENGTH ──> COMPLETE',
  '  │                   └───> Transfer-Encoding: chunked ──> BODY_CHUNKED',
  '  └── error ──────────────> 400 / 411 / 501 ──────────────────> respond',
].join('\n')

const PREVIEW_TALL = Array.from({ length: 60 }, (_, i) => `${String(i + 1).padStart(2, ' ')}: 行が縦に長い図（40vh を超える）`).join('\n')

const PREVIEW_EMOJI = boxed(['✅ 受理する', '⚠️ 保留する', '❌ 断る'])

const PREVIEW_TABLE = boxed(['入力       │ 結果', 'TE + CL    │ 400', 'CL 桁溢れ  │ 400'])

const PREVIEW_TAB = ['col\tA\tB', 'row1\t1\t2', 'row22222\t3\t4'].join('\n')

// ★ Worst case (Japanese filling the limit). Creates the maximum number of column boxes = measures the upper bound of rendering cost
const PREVIEW_MAXJP = Array.from({ length: 40 }, (_, i) =>
  `${String(i + 1).padStart(2, ' ')}: ` + '日本語の行がずっと続く例'.repeat(2),
).join('\n')

// ★ The codex review medium #1 shape (4 backquotes / the closing fence drops at the limit)
const PREVIEW_NESTED_FENCE = ['````', '```', '│ 中の ``` は中身 │', '```', '````'].join('\n')
const PREVIEW_CLIPPED = '```\n' + '長い図の行。'.repeat(400) + '\n```' // ★ 2000 を超えるので閉じフェンスが落ちる
// ★ Grapheme cases (flags, NFD, variation selectors, skin tones)
const PREVIEW_GRAPHEME = boxed([
  '🇯🇵 日本',
  'ガード'.normalize('NFD') + '（NFD）',
  '👍🏽 いいね',
  '葛󠄀（異体字）',
])

const PREVIEW_ONELINE =
  'https://example.test/very/long/single/line/without/spaces?token=' + 'a'.repeat(200)

// ★ Box drawing + a long horizontal line (does it scroll horizontally only inside the frame / no page-level horizontal scroll)
const PREVIEW_WIDE = [
  '┌──────────────────────────────────────────────────────┐',
  '│ 選択肢の図はボタンの外に置く（横に振っても選ばれない） │',
  '│   long_identifier_that_does_not_wrap_at_all(argument) │',
  '└──────────────────────────────────────────────────────┘',
].join('\n')

const PERMISSIONS = [
  perm('perm-long', 'Bash', { command: LONG_COMMAND }),
  // when it is still cut off after opening (does the screen say "up to here")
  perm('perm-huge', 'Bash', { command: `echo start\n${'x'.repeat(9000)}` }),
  // something that fits in one line (no open button should appear)
  perm('perm-short', 'Read', { file_path: '/home/test/proj/a.ts' }),
  // ★ When an MCP tool has `command` (other fields must not disappear)
  perm('perm-mcp', 'mcp__ops__deploy', {
    command: 'echo harmless',
    target: 'production',
    force: true,
  }),
  // ★ The most common approvals on real machines (in this machine's journal: ExitPlanMode 36 / AskUserQuestion 6)
  perm(
    'perm-plan',
    'ExitPlanMode',
    { plan: `## やること\n\n${['- 直す', '- 確かめる', '- 記録する'].join('\n')}\n\n${'説明の行。'.repeat(60)}` },
    { kind: 'plan' },
  ),
  ask('perm-ask', [
    {
      question: 'どちらで進めますか',
      header: '方針',
      multiSelect: false,
      options: [
        { label: 'A案', description: '小さく直す' },
        { label: 'B案', description: '作り直す' },
      ],
    },
  ]),
  // ★★ Questions with a preview (2026-08-18). ⚠️ Uses the real shape pasted on a real device as is.
  //    On the PC it appears in the right-hand frame for the currently selected option. The phone stacks them vertically
  ask('perm-ask-preview', [
    {
      question:
        'M2-6 で Content-Length を認識した後、ボディ読み取りをどこまで実装しますか？（webserv_http.md §5 は BODY_LENGTH まで設計済みですが、milestones では body 受信は M3-5 の割り当てです）',
      header: 'スコープ',
      multiSelect: false,
      options: [
        {
          label: '1. ヘッダまで（推奨）',
          preview: PREVIEW_SCOPE,
        },
        { label: '2. BODY_LENGTH まで', description: 'M3-5 を前倒しする', preview: PREVIEW_FENCED },
      ],
    },
    {
      question: 'bare LF（`\n` だけの行末）の扱いをどうしますか？',
      header: 'bare LF',
      multiSelect: false,
      options: [
        { label: '1. 行終端として受理（推奨）', preview: PREVIEW_LF },
        { label: '2. 検出したら 400', preview: '400 Bad Request\n  -> nginx とは一致しない' },
      ],
    },
  ]),
  // ★★ For endurance checks of "diagram-like" shapes (long horizontally / long vertically / emoji / full-width table / tabs / one line)
  ask('perm-ask-stress', [
    {
      question: '図の形をいろいろ入れたときの見え方',
      header: '耐久',
      multiSelect: false,
      options: [
        { label: '横に長い木', preview: PREVIEW_TREE },
        { label: '縦に長い', preview: PREVIEW_TALL },
        { label: '絵文字', preview: PREVIEW_EMOJI },
        { label: '全角の表', preview: PREVIEW_TABLE },
        { label: 'タブ', preview: PREVIEW_TAB },
        { label: '長い1行', preview: PREVIEW_ONELINE },
        { label: '上限いっぱいの日本語', preview: PREVIEW_MAXJP },
        { label: '4バッククォート', preview: PREVIEW_NESTED_FENCE },
        { label: '閉じフェンスが切れる', preview: PREVIEW_CLIPPED },
        { label: '旗・NFD・肌の色', preview: PREVIEW_GRAPHEME },
      ],
    },
  ], 'BBB'),
  // ★★ **Even a single single-choice question is not answered immediately when it has a preview** (2026-08-18 user decision).
  //    The preview makes the card tall, so a mis-tap while scrolling would become an irrevocable answer.
  //    ⇒ With this card, showing "answer with this" is correct
  ask('perm-ask-preview1', [
    {
      question: 'この形で入りますか',
      header: '確認',
      multiSelect: false,
      options: [
        { label: 'はい', preview: PREVIEW_WIDE },
        { label: 'いいえ' },
      ],
    },
  ]),
  // ★ A session with no transcript yet (a synthesized row in the list. Does the thread show the same name and state)
  perm('perm-orphan', 'Bash', { command: 'npm test' }, undefined, 'CCC'),
  // ★★ An approval in **another thread** (the bar's second line. Check the count and the FIFO head / 2026-08-18).
  //    ⚠️ The oldest is DDD from 20 minutes ago, so opening AAA's thread
  //       should show "承認 3 · セッションD・Bash" (older than CCC and EEE)
  { ...perm('perm-ddd', 'Bash', { command: 'git push origin main' }, undefined, 'DDD'), at: ago(20) },
  { ...perm('perm-eee', 'Write', { file_path: '/home/test/proj/b.ts', content: 'x' }, undefined, 'EEE'), at: ago(6) },
  // An unknown tool (one-line JSON). When opened it should be **readable**
  perm('perm-json', 'Task', {
    description: 'レビューする',
    subagent_type: 'code-reviewer',
    prompt: `いまの修正をレビューして。\n${'なるべく詳しく。'.repeat(80)}`,
  }),
]

/** An approval that appears later (`FAKE_MANUAL_PERM` / `FAKE_SECOND_PERM_MS`) */
const LATE_PERM = () => perm('perm-late', 'Bash', { command: 'echo あとから出た承認' }, undefined, 'BBB')
/** A shape where the card state is unknown (`FAKE_PERM_FAIL`) */
const PERM_FAIL_BODY = 'permissions failed (確認用)'
const PEERS_REASON = '確認用'
/** Thread contents (★ checking the sticky bar needs **a scrollable length**) */
const logEntries = (id) => [
  { kind: 'user', at: now, text: `${id} の中身` },
  // ★ For checking that "thinking N" appears in the bar's "…"
  { kind: 'thinking', at: now, text: '' },
  ...Array.from({ length: 40 }, (_, i) => ({
    kind: i % 2 === 0 ? 'assistant' : 'user',
    at: now,
    text: `${i + 1} 行目。${'ここは会話の本文です。'.repeat(3)}`,
  })),
]
// i18n-fixture: end

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  // ★ Serve PNGs with the correct MIME type too.
  //   ⚠️ Browsers sniff, so it **works anyway**, but a wrong type on the check server
  //      is no basis for "it works in production"
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
}

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * The page `/check` returns. ⚠️ **Written as plain strings to avoid nested templates**
 * (using `${}` or backquotes inside would clash with the outer literal and break it. We actually broke it).
 * ⚠️ The `<script>` inside is written with string concatenation only (no template literals).
 */
const checkPage = () => [
  t('<!doctype html><meta charset="utf-8" /><title>切り分け</title>', '<!doctype html><meta charset="utf-8" /><title>Triage</title>'),
  '<style>',
  ' body{background:#12161c;color:#e6e8eb;font:14px/1.7 system-ui;padding:20px}',
  ' .box{border:1px solid #232a33;border-radius:8px;padding:12px;margin:0 0 14px}',
  // ★ Dimensions match the display asset (`--nyan-w` / `--nyan-h` in `styles.css` / 12 frames)
  " .sprite{width:72px;height:48px;background:url('/cats/mochi-cat.png') no-repeat;",
  '   background-size:864px 48px;image-rendering:auto;display:inline-block;',
  '   vertical-align:-.35em;outline:1px solid #ff7a7a}',
  ' .run{animation:play 1.2s steps(12) infinite}',
  ' @keyframes play{from{background-position-x:0}to{background-position-x:-864px}}',
  ' #out{white-space:pre;font-family:ui-monospace,monospace}',
  ' a{color:#7ab8ff}',
  '</style>',
  t('<h2>切り分け（画面が古いのか / 素材が出ていないのか）</h2>', '<h2>Triage (is the page stale, or are the assets missing?)</h2>'),
  t('<div class="box">① 素材そのまま（16倍）<br />', '<div class="box">(1) The asset as is (16x)<br />'),
  ' <img src="/cats/mochi-cat.png" style="width:13824px;image-rendering:pixelated;max-width:100%" /></div>',
  t('<div class="box">② 止まったねこ（赤枠は 72×48 の場所）: <span class="sprite"></span></div>', '<div class="box">(2) Still cat (the red box is the 72x48 area): <span class="sprite"></span></div>'),
  t('<div class="box">③ 走るねこ: <span class="sprite run"></span></div>', '<div class="box">(3) Running cat: <span class="sprite run"></span></div>'),
  t('<div class="box" id="out">調べ中…</div>', '<div class="box" id="out">Checking...</div>'),
  t('<div class="box">④ が出たら → <a href="/?v=fresh">アプリを開く</a>', '<div class="box">Once (4) shows up -> <a href="/?v=fresh">open the app</a>'),
  t(' <br />⚠️ <b>?v= を付けて開く</b>（ハッシュだけの移動ではバンドルが読み直されない）</div>', ' <br />⚠️ <b>Open it with ?v=</b> (changing only the hash does not reload the bundle)</div>'),
  '<script>',
  ' var lines = [], out = document.getElementById("out")',
  ' function show(){ out.textContent = lines.join("\\n") }',
  ' async function step(name, fn){',
  '   try { lines.push(name + ": " + (await fn())) } catch (e) { lines.push(name + ": ✖ " + e) }',
  '   show()',
  ' }',
  ' ;(async function(){',
  t('   await step("いま配られている JS", async function(){', '   await step("JS being served now", async function(){'),
  '     var html = await (await fetch("/index.html", { cache: "no-store" })).text()',
  '     var m = html.match(/index-[A-Za-z0-9_-]+\\.js/)',
  t('     return m ? m[0] : "分からない"', '     return m ? m[0] : "unknown"'),
  '   })',
  '   await step("service worker", async function(){',
  t('     if (!("serviceWorker" in navigator)) return "この環境には無い"', '     if (!("serviceWorker" in navigator)) return "not available here"'),
  '     var rs = await navigator.serviceWorker.getRegistrations()',
  t('     if (rs.length === 0) return "登録なし（きれい）"', '     if (rs.length === 0) return "none registered (clean)"'),
  '     for (var i = 0; i < rs.length; i++) await rs[i].unregister()',
  t('     return "登録が " + rs.length + " 件あった ← これが原因。消した"', '     return "found " + rs.length + " registration(s) <- this was the cause. Removed"'),
  '   })',
  t('   await step("キャッシュ", async function(){', '   await step("cache", async function(){'),
  t('     if (!("caches" in window)) return "この環境には無い"', '     if (!("caches" in window)) return "not available here"'),
  '     var keys = await caches.keys()',
  '     for (var i = 0; i < keys.length; i++) await caches.delete(keys[i])',
  t('     return keys.length === 0 ? "なし" : "捨てた: " + keys.join(", ")', '     return keys.length === 0 ? "none" : "dropped: " + keys.join(", ")'),
  '   })',
  '   await step("/cats/mochi-cat.png", async function(){',
  '     var r = await fetch("/cats/mochi-cat.png", { cache: "no-store" })',
  '     var b = await r.blob()',
  '     return "HTTP " + r.status + " / " + r.headers.get("content-type") + " / " + b.size + " bytes"',
  '   })',
  t('   await step("②の背景", async function(){', '   await step("(2) background", async function(){'),
  '     return getComputedStyle(document.querySelector(".sprite")).backgroundImage',
  '   })',
  t('   await step("②の大きさ", async function(){', '   await step("(2) size", async function(){'),
  '     var cs = getComputedStyle(document.querySelector(".sprite"))',
  '     return cs.width + " × " + cs.height',
  '   })',
  t('   await step("アニメ本数(③)", async function(){', '   await step("animations (3)", async function(){'),
  '     return document.querySelector(".run").getAnimations().length',
  '   })',
  t('   await step("ブラウザ", async function(){ return navigator.userAgent })', '   await step("browser", async function(){ return navigator.userAgent })'),
  '   lines.push("")',
  t('   lines.push("⇒ ここが全部OKなら、原因はアプリのコード側")', '   lines.push("=> If all of these are OK, the cause is in the app code")'),
  '   show()',
  ' })()',
  '</script>',
  '',
].join('\n')

createServer(async (req, res) => {
  try {
    await handle(req, res)
  } catch (err) {
    // ⚠️ Without catching here, an unhandledRejection takes the whole server down.
    //    e.g. `/sessions/%E0/log` makes decodeURIComponent throw URIError
    console.error(t('[確認用] 要求の処理に失敗:', '[dev-fakeserve] failed to handle the request:'), err?.message ?? err)
    if (!res.headersSent) res.writeHead(500)
    res.end('error')
  }
// ⚠️⚠️ **bind is fixed to `127.0.0.1`** (never `0.0.0.0` / see the `/sw.js` explanation above).
//    This server returns "a SW that removes itself", so **exposed on the production origin it kills subscriptions**.
}).listen(PORT, '127.0.0.1', () => console.log(t(`確認用サーバー http://127.0.0.1:${PORT}`, `Dev fake server http://127.0.0.1:${PORT}`)))

async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  if (p === '/sessions') {
    // ★ A hook for slow responses. ⚠️⚠️ **Must not be 10 seconds or more** (`TIMEOUT_MS = 10_000` in `transport/http.ts`
    //    aborts it and **the machine is treated as down**.
    //    Putting 15000 made us think "the data never comes" / 2026-08-18)
    const delay = Number(process.env.FAKE_SESSIONS_DELAY_MS ?? 0)
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    return json(res, { sessions: SESSIONS })
  }
  // ★ Show the second card **on our signal** (leaving it to time cannot measure the 1→2 transition /
  //   2026-08-19 codex review low #8). An entry point only on the check server
  if (p === '/fake/add-perm') {
    extraPerm = true
    return json(res, { ok: true })
  }
  if (p === '/fake/del-perm') {
    extraPerm = false
    return json(res, { ok: true })
  }
  if (p === '/permissions') {
    if (process.env.FAKE_MANUAL_PERM === '1') {
      const base = PERMISSIONS.filter((x) => x.key === 'perm-ask-stress')
      const extra = extraPerm
        ? [LATE_PERM()]
        : []
      return json(res, { permissions: [...base, ...extra], quiet: 0 })
    }
    // ★ Make the shape where the second card appears **later** (for checking 2026-08-19 `/code-review` medium #1).
    //   With FAKE_SECOND_PERM_MS=3000, one more appears 3 seconds after start
    const after = Number(process.env.FAKE_SECOND_PERM_MS ?? 0)
    if (after > 0) {
      // ⚠️ The baseline is **the first request** (using the start time means that merely opening the browser late
      //    returns 2 from the start, and **we would be satisfied with "2 showed" without checking the crucial 1→2 transition**
      //    / 2026-08-19 codex review low #8)
      if (firstPermAt === 0) firstPermAt = Date.now()
      const elapsed = Date.now() - firstPermAt
      const base = PERMISSIONS.filter((x) => x.key === 'perm-ask-stress')
      const extra = elapsed >= after ? [LATE_PERM()] : []
      return json(res, { permissions: [...base, ...extra], quiet: 0 })
    }
    // ★ Allow emptying the cards (to see the **gray** in the bar's second line = needs attention that cannot be answered)
    if (process.env.FAKE_NO_PERMS === '1') return json(res, { permissions: [], quiet: 0 })
    // ★ A state with only "an approval that appears in a few seconds" (gray must not be shown)
    if (process.env.FAKE_QUIET_ONLY === '1') return json(res, { permissions: [], quiet: 1 })
    // ★ Allow creating "card state unknown" (for checking fail-open / 2026-08-18)
    if (process.env.FAKE_PERM_FAIL === '1') {
      res.writeHead(500)
      return res.end(PERM_FAIL_BODY)
    }
    return json(res, { permissions: PERMISSIONS, quiet: 0 })
  }
  // ★ Check the update notice (the origin has a future version, this agent an old one ⇒ both show in the bar)
  if (p === '/RELEASE') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('fffffff\n2099-01-01T00:00:00.000Z\n2099-01-01T00:00:00Z\n')
  }
  if (p === '/health') return json(res, { machine: 'TESTBOX', accounts: [], build: { commit: 'aaaaaaa', committedAt: '2026-01-01T00:00:00Z' }, account: { signedIn: true, plan: 'free', maxMachines: 1, maxDevices: 2, login: 'nyan', relay: 'machine-limit' } })
  if (p === '/peers') return json(res, { available: false, reason: PEERS_REASON })
  if (p === '/push/status') return json(res, { supported: false, subscribed: false, deviceCount: 0 })
  if (p.startsWith('/sessions/') && p.endsWith('/log')) {
    const id = decodeURIComponent(p.split('/')[2])
    return json(res, {
      sessionId: id,
      account: '.claude-r',
      entries: logEntries(id),
      cursor: null,
      tail: 100,
      bytes: 100,
    })
  }
  if (p === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write('retry: 3000\n\n')
    return
  }

  /**
   * ★★★ **A Service Worker that removes itself** (2026-08-28).
   *
   * ⚠️⚠️ Even with `no-store`, **the Service Worker's cache is not cleared**.
   *    `web/public/sw.js` holds `/assets/*` **cache-first**, so once registered
   *    old bundles keep being served even after rebuilding.
   * ★ On 2026-08-28 we **got lost here for an hour** (misdiagnosed "the cat does not show" as the SW;
   *   it was actually **a tab left open on an old version** = changing only the hash does not reload it).
   *   ⇒ **On the check server, never let a SW establish in the first place** (one less thing to suspect).
   * ⚠️ The real `sw.js` is not served. What this returns only **unregisters and drops the caches**.
   *
   * ⚠️⚠️ **Never expose this server on "the production hostname"** (added 2026-08-28).
   *    Service Workers are **per origin**, so it is safe while confined to `127.0.0.1`, but
   *    exposing it on the same hostname via `tailscale serve` **unregisters that origin's real SW and
   *    kills the Push subscriptions** (the symptom is "notifications silently stop" = the sender looks successful).
   *    ⇒ That is why bind is fixed to `127.0.0.1` (the `listen` below). **Do not change it.**
   */
  if (p === '/sw.js') {
    res.writeHead(200, {
      'content-type': TYPES['.js'],
      'cache-control': 'no-store, must-revalidate',
    })
    // ★ Contents: check server only. Removes registered Service Workers and drops the caches too.
    return res.end(
      [
        "self.addEventListener('install', () => self.skipWaiting())",
        "self.addEventListener('activate', (e) => {",
        '  e.waitUntil((async () => {',
        '    for (const k of await caches.keys()) await caches.delete(k)',
        '    await self.registration.unregister()',
        '    for (const c of await self.clients.matchAll()) c.navigate(c.url)',
        '  })())',
        '})',
        '',
      ].join('\n'),
    )
  }

  /**
   * ★★ Triage page (2026-08-28). **Separates "is the page stale, or are the assets missing".**
   *
   * ⚠️ When chasing a UI bug, this is where we get stuck first every time:
   *      - the open tab is an old version (**changing only the hash does not reload it**)
   *      - Service Worker / browser cache
   *      - assets (`cats/mochi-cat.png` etc.) are not arriving
   *    ⇒ **Separate these 3 first**. If all are OK here, the cause is in the app code.
   * ⚠️ try/catch per step (one throw stops everything and it freezes on "Checking…". We actually hit this).
   */
  if (p === '/check') {
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' })
    return res.end(checkPage())
  }
  // Static serving (never outside dist)
  const rel = normalize(p === '/' ? '/index.html' : p).replace(/^(\.\.[/\\])+/, '')
  const file = join(DIST, rel)
  if (!file.startsWith(DIST)) {
    res.writeHead(403)
    return res.end('no')
  }
  try {
    const buf = await readFile(file)
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // ⚠️⚠️ **No caching** (fooled twice on 2026-08-18).
      //    If `index.html` comes from the cache after rebuilding, **you see an old bundle and
      //    wrongly conclude "not fixed"**. It is a check server, so always serve the latest.
      //    ⚠️ This does not clear the Service Worker cache. If something looks wrong,
      //       run `navigator.serviceWorker.getRegistrations()` → `unregister()`
      'cache-control': 'no-store, must-revalidate',
    })
    res.end(buf)
  } catch {
    // SPA, so unknown paths get index.html
    try {
      const buf = await readFile(join(DIST, 'index.html'))
      res.writeHead(200, { 'content-type': TYPES['.html'] })
      res.end(buf)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  }
}
