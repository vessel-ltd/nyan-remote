// Turns the parse result (markdown-parse.ts) into a Preact element tree.
//
// ★★ Never use innerHTML / dangerouslySetInnerHTML. ★★
//
// Tool results (= file contents and fetched web pages) flow through the thread. If a string like
// `<img onerror=...>` gets mixed in and is rendered as an HTML string,
// the script runs on the spot. This page shares its origin with the agent, so
// it could send every session's conversation to the outside.
//
// Always pass strings as JSX children (Preact escapes them automatically).
// Because of this policy, no library that emits HTML strings (marked etc.) is used = zero dependencies.

import type { VNode } from 'preact'
import { parseBlocks, parseInline, type Block, type Inline } from './markdown-parse.ts'

function inlineNodes(text: string): (VNode | string)[] {
  return parseInline(text).map((tok, i) => node(tok, i))
}

function node(tok: Inline, key: number): VNode | string {
  switch (tok.t) {
    case 'text':
      return tok.v
    case 'code':
      return <code key={key}>{tok.v}</code>
    case 'bold':
      return <strong key={key}>{tok.v}</strong>
    case 'em':
      return <em key={key}>{tok.v}</em>
    case 'strike':
      return <s key={key}>{tok.v}</s>
    case 'link':
      // If href is null (javascript: etc.), render as text instead of a link
      return tok.href ? (
        <a key={key} href={tok.href} target="_blank" rel="noreferrer noopener">
          {tok.v}
        </a>
      ) : (
        <span key={key}>{tok.v}</span>
      )
  }
}

function block(b: Block, key: number): VNode {
  switch (b.t) {
    case 'p':
      return (
        <p key={key} class="md-p">
          {inlineNodes(b.text)}
        </p>
      )
    case 'h':
      return (
        <div key={key} class={`md-h md-h${b.level}`}>
          {inlineNodes(b.text)}
        </div>
      )
    case 'pre':
      return (
        <pre key={key} class="md-pre">
          {b.lang ? <span class="md-lang">{b.lang}</span> : null}
          <code>{b.code}</code>
        </pre>
      )
    case 'hr':
      return <hr key={key} class="md-hr" />
    case 'quote':
      return (
        <blockquote key={key} class="md-quote">
          {b.blocks.map((child, i) => block(child, i))}
        </blockquote>
      )
    case 'list': {
      const items = b.items.map((it, i) => (
        <li key={i} class={it.depth > 0 ? 'md-sub' : undefined}>
          {inlineNodes(it.text)}
        </li>
      ))
      return b.ordered ? (
        <ol key={key} class="md-list">
          {items}
        </ol>
      ) : (
        <ul key={key} class="md-list">
          {items}
        </ul>
      )
    }
    case 'table':
      return (
        <div key={key} class="md-tablewrap">
          <table class="md-table">
            <thead>
              <tr>
                {b.header.map((c, i) => (
                  <th key={i}>{inlineNodes(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{inlineNodes(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

export function renderMarkdown(src: string): VNode[] {
  return parseBlocks(src).map((b, i) => block(b, i))
}
