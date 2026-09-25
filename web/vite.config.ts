import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vite'

/**
 * ★★ Marker of the build being served (2026-09-16).
 *
 * ⚠️⚠️ Without this we lost half a day: **old JS was running only when launched offline**,
 *    but the screen didn't show it, so we suspected the implementation ("saving doesn't work") for several rounds.
 * ⇒ **Which build is running must always be readable from the screen.**
 * ⚠️ Not a secret (we also ship source maps / §14.4).
 */
function buildId(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
    return `${sha}${dirty ? '+' : ''} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  } catch {
    return new Date().toISOString().slice(0, 16).replace('T', ' ')
  }
}

/**
 * ★ Material for checking whether the screen is "older than the distribution origin" (2026-09-24 / `shared/release.ts`).
 *   ⚠️ Compares the **commit date** (not build time = the same commit is the same version whenever built).
 */
function buildInfo(): { commit: string; committedAt: string } | null {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%h%n%cI'], { encoding: 'utf8' }).trim().split('\n')
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
    return { commit: `${out[0]}${dirty ? '+' : ''}`, committedAt: out[1] ?? '' }
  } catch {
    return null
  }
}

// Do not add @preact/preset-vite (no new dependencies / CLAUDE.md §2).
// Preact works with esbuild's JSX settings alone.
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId()), __BUILD_INFO__: JSON.stringify(buildInfo()) },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // ★ Include source maps in production too.
    //   So users can verify that "the served JS matches the source" (§14.4).
    sourcemap: true,
    target: 'es2022',
  },
})
