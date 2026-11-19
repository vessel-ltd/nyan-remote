// ★ An agy conversation's transcript as thread entries (2026-11-19 / docs/AGY.md §3).
//
// `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl` is appended one step at a time,
// one JSON object per line, so it is read with Claude's byte-cursor reader (`claude/log.ts`); only the record →
// entries mapping differs. Record types seen in agy 1.5.12:
//   USER_INPUT        { source: 'USER_EXPLICIT', content: '<USER_REQUEST>\n…\n</USER_REQUEST>\n<ADDITIONAL_METADATA>…' }
//   PLANNER_RESPONSE  { content?, thinking?, tool_calls?: [{ name, args }] }
//   GENERIC           a tool's result: { content: 'Created At: …\nCompleted At: …\n<result>', error?, status }
//   ERROR_MESSAGE     { content?, error? }
// ⚠️ Anything else is skipped (shown as nothing rather than guessed). Tool calls carry no id, so results are not linked.

import type { LogEntry } from '../../../shared/types.ts'
import { readableInput } from '../claude/log.ts'
import { userRequestText } from './sessions.ts'

const TOOL_MAX = 1200
const TEXT_MAX = 8000

type Rec = Record<string, unknown>

function clip(s: string, max = TEXT_MAX): string {
  const t = s.trimEnd()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function foldable(raw: string, max = TOOL_MAX): { summary: string; lines: number; truncated: boolean } {
  const t = raw.replace(/\s+$/, '')
  if (!t) return { summary: '', lines: 0, truncated: false }
  const truncated = t.length > max
  const summary = truncated ? `${t.slice(0, max - 1)}…` : t
  return { summary, lines: summary.split('\n').length, truncated }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** The time agy stamped on the step (ISO, UTC) */
function atOf(rec: Rec): { at?: string } {
  const at = str(rec.created_at)
  return at && !Number.isNaN(Date.parse(at)) ? { at } : {}
}

/**
 * ★ The gist of a tool call: the command, else the path (as Claude's rows show a Write or an Edit: the file, never
 * what is written into it / codex review), else every argument except contents (agy's own one-line summary dropped).
 */
export function toolGist(_name: string, args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  // ⚠️ Keys in any case: agy's own tools write `Path`, MCP tools `path` (codex review)
  const a: Rec = {}
  for (const [k, v] of Object.entries(args as Rec)) a[k.toLowerCase()] = v
  if (typeof a.commandline === 'string') return a.commandline
  if (typeof a.command === 'string') return a.command
  // ⚠️ Only names of places; a `query` can carry what is written (an INSERT) and goes through the scalar rule below
  for (const k of ['path', 'absolutepath', 'targetfile', 'file', 'file_path', 'filepath', 'url']) if (typeof a[k] === 'string') return a[k] as string
  // ⚠️ Any other tool: only short one-line scalars; nested values and long text are named, never shown (they can be
  //    what is written somewhere: `files: [{ path, content }]` / codex review)
  const shown: Rec = {}
  for (const [k, v] of Object.entries(a)) {
    if (['toolsummary', 'waitmsbeforeasync'].includes(k)) continue
    const scalar = typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 120 && !v.includes('\n'))
    shown[k] = scalar && !['content', 'codecontent', 'contents', 'replacement', 'target', 'replacementcontent', 'targetcontent', 'new_string', 'old_string'].includes(k) ? v : '…'
  }
  return readableInput(shown)
}

/** A tool result without agy's timing header (`Created At:` / `Completed At:` lines it repeats) */
export function resultText(content: string): string {
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length && /^(Created At|Completed At): /.test(lines[i]!)) i++
  return lines.slice(i).join('\n').replace(/\r\n/g, '\n')
}

export function agyEntries(rec: Rec): LogEntry[] {
  const at = atOf(rec)
  switch (rec.type) {
    case 'USER_INPUT': {
      const content = str(rec.content)
      if (!content) return []
      const text = clip(userRequestText(content))
      if (!text) return []
      return rec.source === 'USER_EXPLICIT' ? [{ kind: 'user', ...at, text }] : [{ kind: 'system', ...at, text }]
    }
    case 'PLANNER_RESPONSE': {
      const out: LogEntry[] = []
      const thinking = str(rec.thinking)?.trim()
      if (thinking) out.push({ kind: 'thinking', ...at, text: clip(thinking) })
      const content = str(rec.content)?.trim()
      if (content) out.push({ kind: 'assistant', ...at, text: clip(content) })
      if (Array.isArray(rec.tool_calls)) {
        for (const c of rec.tool_calls) {
          if (!c || typeof c !== 'object') continue
          const name = str((c as Rec).name)
          if (!name) continue
          out.push({ kind: 'tool_use', ...at, name, ...foldable(toolGist(name, (c as Rec).args)) })
        }
      }
      return out
    }
    case 'GENERIC': {
      const content = str(rec.content) ?? ''
      const error = str(rec.error)
      const ok = !error && (rec.status === undefined || rec.status === 'DONE')
      return [{ kind: 'tool_result', ...at, ok, ...foldable(resultText(content) || error || '') }]
    }
    case 'ERROR_MESSAGE': {
      const text = (str(rec.error) || str(rec.content) || '').trim()
      return text ? [{ kind: 'system', ...at, text: clip(text) }] : []
    }
    default:
      return []
  }
}
