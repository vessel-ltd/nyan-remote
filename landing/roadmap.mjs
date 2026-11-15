// ★ The roadmap, in one place (2026-11-15). The landing page is built from it, and `scripts/landing.test.mjs` checks
//   that the README's "## Roadmap" says exactly these items (they had drifted: an item twice, a shipped one still listed).
// ⚠️ English only (the site is English only / landing/build.mjs). `text` is plain words (no HTML, no Markdown).

/** @type {ReadonlyArray<{ title: string, text: string }>} */
export const ROADMAP = [
  { title: 'Codex, more of it', text: 'closed Codex sessions as history, and the other kinds of Codex approval (file changes, network access, questions).' },
  { title: 'Phone apps', text: 'native apps for iPhone and Android.' },
  { title: 'Desktop', text: 'a desktop layout, installable on Windows, macOS and Linux.' },
  { title: 'Windows without WSL', text: 'run the agent on Windows directly.' },
  { title: 'Homebrew', text: 'install and update with Homebrew on macOS.' },
  { title: 'Voice', text: 'talk to a session and hear its replies read aloud, hands-free.' },
  { title: 'Images and files', text: 'send images and files from your phone to a session: screenshots, photos, logs.' },
]

/** The README's roadmap lines, as they must read */
export function readmeRoadmap() {
  return ROADMAP.map((r) => `- **${r.title}** — ${r.text}`)
}
