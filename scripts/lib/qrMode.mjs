// ★★ Decide whether to "draw the QR as text" or "open it as an image" (2026-09-23 / user decision).
//
//   mac                              … image only (⚠️ no text QR / unreadable because of terminal line spacing)
//   otherwise, **fits** the terminal … text (readable on Linux)
//   otherwise, **does not fit**      … image (small window, large font)
//   terminal size **unknown**        … text (pipe, log = never open a window on its own. **mac: string only**)
//   `--image` / `--text`             … as requested (⚠️ `--text` has no effect on mac)
//
// ★ "Fits" is judged by **the columns × rows the terminal reports** (`process.stdout.columns` / `rows`,
//   Unix TIOCGWINSZ). ⚠️ Not the monitor size (font size is reflected too).
// ⚠️ It only tells "fits", not "readable" (mac line spacing cannot be judged ⇒ mac always uses an image).
// ⚠️⚠️ With an image **the one-time token lands in a temp file** (an exception to CLAUDE.md "one-time tokens live only in memory").
//    On 2026-09-23 this widened from "only when asked" to "default" (user approved). The guards are the 3 in pair.mjs
//    (0600, always removed on exit, never outlives the token), keeping it to **the same exposure as showing it on screen**.

import { execFileSync } from 'node:child_process'
import { t } from '../../shared/i18n.ts'

/** Visible width and line count without ANSI color codes */
export function artSize(art) {
  const lines = art.replace(/\n+$/, '').split('\n')
  const cols = Math.max(0, ...lines.map((l) => [...l.replace(/\x1b\[[0-9;]*m/g, '')].length))
  return { cols, rows: lines.length }
}

/**
 * ★ Text or image (**pure function**).
 * @param p.term terminal size (undefined if unknown)
 * @param p.need the size a text QR needs (`artSize`)
 */
export function chooseQrMode({ platform, argv, term, need }) {
  const tty = !!term && Number.isInteger(term.columns) && Number.isInteger(term.rows) && term.columns > 0 && term.rows > 0
  // ★★ **mac: image only. No text QR** (2026-09-23 / user decision).
  //   ⚠️ Half blocks break apart with the line spacing and cannot be read; the readable style (background colors) was so large it always needed ⌘−.
  //   ⚠️ Not a terminal (pipe) ⇒ no window either ⇒ only the string to paste (`none`).
  if (platform === 'darwin') {
    if (!tty) return { mode: 'none', reason: 'mac-no-tty' }
    return { mode: 'image', reason: argv.includes('--text') ? 'mac-text' : 'mac' }
  }
  if (argv.includes('--text')) return { mode: 'text', reason: 'asked' }
  if (argv.includes('--image')) return { mode: 'image', reason: 'asked' }
  // ⚠️ Unknown = not a terminal (pipe, log) ⇒ never open a window on its own
  if (!tty) return { mode: 'text', reason: 'no-tty' }
  if (fitsIn(need, term)) return { mode: 'text', reason: 'fits' }
  return { mode: 'image', reason: 'too-small' }
}

/**
 * ★★ Lines allowed **after** the QR ("★ Scan with your phone's camera", a blank line, the waiting line).
 * ⚠️ Exceeding it pushes the top of a QR that should fit off the screen (codex round 15, low #5).
 *    `scripts/pair.test.mjs` checks with **the real output** that this count is not exceeded.
 */
export const QR_TRAILING_LINES = 3

/** ★ Does it fit in the terminal (⚠️ overflowing vertically means the camera cannot capture it at once ⇒ check rows too, **including the trailing lines**) */
export function fitsIn(need, term) {
  return need.cols <= term.columns && need.rows + QR_TRAILING_LINES <= term.rows
}

/** ★ Why an image was chosen (told to the user. ⚠️ never open a window silently) */
export function modeNote(choice, need, term) {
  switch (choice.reason) {
    case 'mac':
      return t('mac の端末では文字の QR が崩れるので、画像で開きます', 'Text QR codes break up in the mac terminal, so it opens as an image')
    case 'mac-text':
      return t(
        'mac では文字の QR は出しません（端末の行間で崩れて読めないため）。画像で開きます',
        'No text QR on mac (line spacing in the terminal makes it unreadable). Opening it as an image',
      )
    case 'mac-no-tty':
      return t(
        'mac では QR を画像で開きます（端末から実行してください）。下の文字列を貼り付けても登録できます',
        'On mac the QR opens as an image (run this from a terminal). You can also register by pasting the text below',
      )
    case 'too-small':
      // ⚠️ The row count includes the trailing guidance (`QR_TRAILING_LINES`) (print the same number the decision uses)
      return t(
        `端末が小さいので画像で開きます（文字の QR は ${need.cols} 桁 × ${need.rows + QR_TRAILING_LINES} 行 要ります / いまは ${term.columns} 桁 × ${term.rows} 行）`,
        `The terminal is too small, so it opens as an image (a text QR needs ${need.cols} × ${need.rows + QR_TRAILING_LINES} columns × rows / now ${term.columns} × ${term.rows})`,
      )
    default:
      return t('画像で開きます', 'Opening it as an image')
  }
}

/** ★ Is this WSL (⚠️ to open with a Windows-side viewer) */
export function isWsl(env) {
  return typeof env.WSL_DISTRO_NAME === 'string' && env.WSL_DISTRO_NAME !== ''
}

/**
 * ★ Steps to open the image (**pure function**. Try from the top, fall through on failure). Empty means "cannot open here".
 * ⚠️ WSL's `explorer.exe` uses a **full path** (some machines have `appendWindowsPath=false` / CLAUDE.md §4).
 * ⚠️ `explorer.exe` can exit 1 even on success ⇒ do not fall through on its failure (make it the last resort).
 */
export function imageOpeners({ platform, env, file, winPath }) {
  if (platform === 'darwin') {
    // ⚠️⚠️ Name the app (do not bet on the default association / the time an SVG opened in Warp)
    return [
      ['open', ['-a', 'Preview', file]],
      ['open', [file]],
    ]
  }
  if (platform === 'linux' && isWsl(env)) {
    return winPath ? [['/mnt/c/Windows/explorer.exe', [winPath]]] : []
  }
  if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) return [['xdg-open', [file]]]
  return []
}

/** Convert a WSL path to a Windows path (⚠️ undefined if it fails = cannot open) */
export function toWinPath(file) {
  try {
    return execFileSync('wslpath', ['-w', file], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch {
    return undefined
  }
}
