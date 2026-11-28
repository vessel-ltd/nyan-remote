// ★★ A Codex lead's team is confirmed by the human on the phone (2026-11-27 / user decision / docs/TEAM.md §10.5).
//
// A Codex lead runs `nyan team …` outside its sandbox through an allow rule (`scripts/install-skill.mjs`). Codex can
// approve its own escalations ("Approve for me"), so neither the rule nor Codex's approval is the human's yes. ⇒ The
// agent raises one card on the phone and makes the team only when a person presses "Allow" there.
// ⚠️ Human-only: never answered by a team's leader (`cardFromMember` refuses `TEAM_CREATE_TOOL`), never by auto-approve
//    (this never calls `shouldAutoApprove`). The card's key is ours (random), so no session can name it beforehand.
// ⚠️ It waits while the CLI waits: the CLI going away (Codex interrupted) withdraws the card; no answer in
//    `TEAM_CONFIRM_MS` withdraws it too.

import { randomBytes } from 'node:crypto'
import { t } from '../../shared/i18n.ts'
import { hasHidden, hasBidi } from '../../shared/reveal.ts'
import { TEAM_CREATE_TOOL, type PermissionRequest } from '../../shared/types.ts'
import { waitForDecision, withGeneration, type Decision } from './permission.ts'
import type { TeamTool } from './team.ts'

/** How long the card waits for the human (the CLI waits a little longer: `scripts/team.mjs` `CREATE_WAIT_MS`) */
export const TEAM_CONFIRM_MS = 5 * 60 * 1000

/** At most this much of a session's title or project on the card (third-party text) */
const FIELD_MAX = 120

function field(s: string | undefined): string {
  const one = String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ')
  return one.length <= FIELD_MAX ? one : `${one.slice(0, FIELD_MAX - 1)}…`
}

function toolLabel(tool: TeamTool): string {
  return tool === 'codex' ? 'Codex' : tool === 'agy' ? 'agy' : 'Claude'
}

export interface ConfirmSession {
  sessionId: string
  account: string
  project: string
  title: string
}

export interface ConfirmMember extends ConfirmSession {
  ref: string
  tool: TeamTool
}

/** The card (pure: tests read what the phone shows) */
export function teamCreateCard(o: { machine: string; lead: ConfirmSession; members: ConfirmMember[]; approvals?: string; at: string }): PermissionRequest {
  const refs = o.members.map((m) => m.ref).join(', ')
  const summary = o.approvals
    ? t(`この Codex がチームを作り、メンバーの承認を ${o.approvals} 任されます: ${refs}`, `This Codex makes a team and answers its members’ approvals for ${o.approvals}: ${refs}`)
    : t(`この Codex がチームを作ります: ${refs}`, `This Codex makes a team: ${refs}`)
  const lines = [
    t('Codex のセッションが、ほかのセッションをメンバーにしてチームを作ろうとしています。', 'A Codex session wants to make a team with other sessions as its members.'),
    '',
    `${t('リーダー', 'Lead')}: Codex · ${field(o.lead.account)} · ${field(o.lead.project)}`,
    `  ${field(o.lead.title)}`,
    '',
    t('メンバー:', 'Members:'),
    ...o.members.flatMap((m) => [`${m.ref}  ${toolLabel(m.tool)} · ${field(m.account)} · ${field(m.project)}`, `  ${field(m.title)}`]),
    '',
    o.approvals
      ? t(
          `⚠️ メンバーの承認（Bash を含む）を、この Codex が ${o.approvals} のあいだ答えられるようになります。プランの承認は人に残ります。`,
          `⚠️ This Codex will answer the members’ approvals (Bash included) for ${o.approvals}. Plan approvals stay with you.`,
        )
      : t('メンバーの承認は、今までどおり人が答えます。', 'The members’ approvals stay with you.'),
    t(
      'リーダーはメンバーに指示を送り、メンバーの発言を読めるようになります。この確認はスマホでだけ答えられます。',
      'The lead will send instructions to the members and read what they say. This confirmation is answered on the phone only.',
    ),
  ]
  const detail = lines.join('\n')
  return {
    key: withGeneration(`team-create:${randomBytes(8).toString('hex')}`),
    machine: o.machine,
    account: o.lead.account,
    project: o.lead.project,
    sessionId: o.lead.sessionId,
    toolName: TEAM_CREATE_TOOL,
    tool: 'codex',
    summary,
    detail,
    ...(hasHidden(detail) || hasBidi(detail) ? { hidden: true as const } : {}),
    at: o.at,
  }
}

export type ConfirmResult = 'allow' | 'deny' | 'no-answer'

export interface ConfirmDeps {
  /** The card is up (ring the phone, refresh its list) */
  shown(info: PermissionRequest): void
  /** The card is gone (refresh the list) */
  over(): void
  timeoutMs?: number
}

/**
 * Raise the card and wait for the human.
 * @param registerGone called once with the function that withdraws the card (the caller wires the CLI going away)
 */
export async function confirmOnPhone(info: PermissionRequest, registerGone: (withdraw: () => void) => void, deps: ConfirmDeps): Promise<ConfirmResult> {
  let withdraw: (() => void) | undefined
  const waiting = waitForDecision(info, (w) => {
    withdraw = w
    registerGone(w)
  })
  const timer = setTimeout(() => withdraw?.(), deps.timeoutMs ?? TEAM_CONFIRM_MS)
  timer.unref?.()
  deps.shown(info)
  let decision: Decision | undefined
  try {
    decision = await waiting
  } finally {
    clearTimeout(timer)
    deps.over()
  }
  if (!decision) return 'no-answer'
  return decision.behavior === 'allow' ? 'allow' : 'deny'
}
