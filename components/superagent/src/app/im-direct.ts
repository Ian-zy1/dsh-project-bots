/** A Feishu user explicitly authorizes one task against the host's single configured Git checkout. */
import type { ImDirectContext, Ticket, Trigger } from '../core/index.ts'
import { latestAssignment, key } from '../core/index.ts'
import { cleanRepository, type ImDirectRepository } from '../deployment.ts'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { runAsWorker, sameDirectory } from '../infra/environment.ts'
import type { Commands } from '../infra/commands.ts'
import { IM_WORDS, wordCount } from '../infra/text.ts'
import { gitBaseline } from './aw.ts'

function binding(config: ImDirectRepository): ImDirectContext['repository'] {
  return { repoId: 'im-direct', cloneUrl: cleanRepository(config.repositoryUrl) + '.git',
    environmentRef: config.environmentRef, provider: config.provider, ...config.environment }
}

export function directWorkScope(trigger: Trigger | undefined, senderId: string, explicitlyAllowed: boolean): string | undefined {
  if (trigger?.source !== 'feishu' || !trigger.human || !trigger.addressed || trigger.actor.id !== senderId || !explicitlyAllowed) return
  const scope = trigger.meta.directScope
  return typeof scope === 'string' && scope.trim() ? scope : undefined
}

export async function loadDirectWork(scope: string, config: ImDirectRepository, commands: Commands, signal: AbortSignal): Promise<ImDirectContext> {
  const repository = binding(config)
  const baseSha = await gitBaseline(commands.withSignal(signal), repository.cloneUrl, 'refs/heads/' + config.branch, 'IM direct')
  return { scope, branch: config.branch, baseSha, repository, author: config.author }
}

export function verifyDirectWork(work: ImDirectContext, config: ImDirectRepository | undefined): void {
  if (!config || work.branch !== config.branch || work.author.name !== config.author.name || work.author.email !== config.author.email
      || JSON.stringify(work.repository) !== JSON.stringify(binding(config)))
    throw new Error('The IM direct repository, branch or environment changed after this Ticket was accepted.')
}

export function directWorkInstructions(work: ImDirectContext): string {
  return 'Feishu Direct Work. The original sender explicitly authorized the scope below. Treat unrelated history as context, not permission. '
    + 'Before edits, acknowledge the scope and observable acceptance in the original topic. If requirements or acceptance are ambiguous, '
    + 'report a concrete human_action and wait for the answer in the same topic. Do not make changes outside this scope or involve another repository. '
    + 'Create only a local candidate commit. Run the appropriate project checks, then get a read-only independent review via the native subagent tool '
    + 'against that exact candidate SHA. Ask the reviewer to finish with a separate line REVIEW_ACCEPT <full SHA> only when it accepts. '
    + 'Ask the reviewer to work in this same directory without making edits and wait for it to finish. '
    + 'If the SHA changes, verify and review the new SHA. Report ready with the full candidate_sha, '
    + 'review_session_id, and a summary naming the branch, checks and review outcome. If the checks or independent review cannot be completed, report blocked. '
    + 'Do not push, open a PR/MR, merge or deploy. A person decides whether to merge separately.\n'
    + `Fixed checkout: ${work.repository.cloneUrl}, baseline ${work.baseSha}, environment ${work.repository.environmentRef}.\n`
    + `Authorized scope (original Feishu text): ${JSON.stringify(work.scope)}`
}

/** Native Outbox idempotency: a single ready notice per candidate on an Assignment. */
export function directReadyNotice(ticket: Ticket, origin: Trigger | undefined) {
  if (!ticket.execution?.imDirect || origin?.channel?.source !== 'feishu') return
  const assignment = latestAssignment(ticket)
  const report = assignment?.report
  if (!assignment || report?.state !== 'ready' || !report.candidateSha || !report.reviewSessionId) return
  const header = `候选已就绪，等你确认是否合入。\nTicket ${ticket.id}\n候选 ${report.candidateSha}\n独立评审通过 ${report.reviewSessionId}`
  const summary = header + '\n' + report.summary
  return { id: key('im-direct-ready', ticket.id, assignment.id, report.candidateSha), ticketId: ticket.id,
    channel: { ...origin.channel, address: { ...origin.channel.address, textFormat: 'plain' } }, kind: 'notice' as const,
    text: wordCount(summary) <= IM_WORDS ? summary : header + '\n完整验证与改动摘要见 DSH Ticket。' }
}

/** Only a distinct native child that ended its review with acceptance of this SHA can authorize a ready report. */
export function reviewedCandidate(events: readonly SessionEvent[], candidate: string): boolean {
  const index = events.findLastIndex(event => event.type === 'assistant/message')
  const last = events[index]
  const end = events.slice(index + 1).find(event => event.type === 'turn/end')
  return end?.type === 'turn/end' && end.data.reason.kind === 'completed' && last?.type === 'assistant/message' && last.data.message.content.some(block =>
    block.type === 'text' && block.text.trimEnd().split(/\r?\n/).at(-1) === `REVIEW_ACCEPT ${candidate}`)
}

export async function verifyDirectCandidate(ctx: Context, ticket: Ticket, worker: string, candidate: string, reviewId: string, signal: AbortSignal): Promise<void> {
  const execution = ticket.execution!
  const id = SessionId(reviewId)
  const fail = () => new Error('Independent native review must accept the exact candidate SHA in this Ticket workspace.')
  if (ctx.agents.get(id)?.status === 'running') throw fail()
  const review = await ctx.sessionController.inspect(id, signal).catch(() => { throw fail() })
  const { parentSession, cwd } = review.meta
  if (parentSession !== worker || !cwd || !sameDirectory(cwd, execution.directory)
      || !reviewedCandidate(review.events.slice(review.inheritedEventCount), candidate)) throw fail()
  const run = (args: string[]) => runAsWorker(ctx.subprocess, ['git', ...args], execution.directory, signal)
  const branch = (await run(['branch', '--show-current'])).trim()
  const head = (await run(['rev-parse', 'HEAD'])).trim()
  if (branch !== `codex/${execution.name}` || head !== candidate || head === execution.imDirect!.baseSha
      || (await run(['status', '--porcelain'])).trim()) throw new Error('The reviewed candidate must be committed on the Ticket branch with a clean checkout.')
  await run(['merge-base', '--is-ancestor', execution.imDirect!.baseSha, candidate])
}
