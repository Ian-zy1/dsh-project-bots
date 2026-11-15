/** Merge request ownership, binding and terminal lifecycle within a GitLab project. */
import { key, liveTicket, type Ticket, type OutboundMessage } from '../core/index.ts'
import { gitlabApi } from '../infra/gitlab.ts'
import type { SourceContext } from './host.ts'
import { GitlabItem, gitlabThread, parseGitlabThread, type GitlabItemValue, type GitlabAccount } from './gitlab-model.ts'

export const readMergeRequest = (ctx: SourceContext, iid: number, signal?: AbortSignal) =>
  gitlabApi(ctx.commands.withSignal(signal), GitlabItem, `merge_requests/${iid}`)
export function claimMergeRequest(ctx: SourceContext, ticketId: string, mr: GitlabItemValue): string | undefined {
  const account = ctx.deployment.gitlab, ticket = ctx.tickets.get(ticketId)
  if (!account || !ticket || !liveTicket(ticket) || mr.state !== 'opened') return 'No open GitLab ticket/MR to bind'
  if (mr.target_project_id !== account.projectId) return 'MR targets another project'
  const thread = gitlabThread(account, 'merge_request', mr.iid)
  const origin = ctx.triggers.get(ticket.origin.triggerId)
  const started = origin?.source === 'gitlab' && origin.meta.kind === 'merge_request'
    && origin.meta.projectId === account.projectId && origin.meta.host === account.host && origin.meta.iid === mr.iid
  const own = mr.author.id === account.userId && mr.source_project_id === account.projectId
    && !!ticket.execution?.name && mr.source_branch?.split('/').at(-1) === ticket.execution.name
  if (!started && !own) return 'MR must be the source MR or an agent-owned MR on this ticket branch'
  if (ctx.tickets.open().some(other => other.id !== ticketId && other.follows?.some(follow => !follow.closed && follow.thread === `gitlab:${thread}`))) return 'MR belongs to another active ticket'
  ctx.tickets.bindThread(ticketId, { source: 'gitlab', id: thread }, own)
  ctx.threads.patch(`gitlab:${thread}`, { iid: mr.iid, kind: 'merge_request', url: mr.web_url })
  return undefined
}
export function observeMergeRequest(ctx: SourceContext, mr: GitlabItemValue): void {
  const account = ctx.deployment.gitlab
  if (!account || mr.target_project_id !== account.projectId) return
  const thread = gitlabThread(account, 'merge_request', mr.iid)
  if (mr.state === 'opened') {
    const candidates = mr.author.id === account.userId && mr.source_project_id === account.projectId
      ? ctx.tickets.open().filter(ticket => !!ticket.execution?.name && mr.source_branch?.split('/').at(-1) === ticket.execution.name) : []
    if (candidates.length === 1) claimMergeRequest(ctx, candidates[0]!.id, mr)
    return
  }
  if (mr.state !== 'merged' && mr.state !== 'closed') return
  ctx.tickets.threadClosed({ source: 'gitlab', id: thread }, mr.state === 'merged' ? 'merged' : 'closed', mr.merged_at ?? mr.closed_at ?? mr.updated_at)
}

/** Emits terminal notices from the Ticket-ended event, including an MR observed while the Worker was still finishing. */
export function mergeEndNotices(ticket: Ticket, account: GitlabAccount | undefined): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  if (!account || (outcome !== 'merged' && outcome !== 'closed')) return []
  const follows = (ticket.follows ?? []).filter(follow => follow.closed && follow.thread.startsWith('gitlab:')
    && parseGitlabThread(account, follow.thread.slice(7))?.kind === 'merge_request')
  const latest = (items: typeof follows) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at)).at(0)
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if (!follow) return []
  const target = parseGitlabThread(account, follow.thread.slice(7))!
  const url = `${account.webUrl}/-/merge_requests/${target.iid}`
  return ticket.channels.filter(channel => channel.source !== 'gitlab').map(channel => ({
    id: key('gitlab-terminal', follow.thread, ticket.id, channel.source, JSON.stringify(channel.address), outcome), channel,
    text: `[MR !${target.iid}](${url}) ${outcome === 'merged' ? 'merged' : 'closed without merging'}.`, kind: 'notice', ticketId: ticket.id }))
}
