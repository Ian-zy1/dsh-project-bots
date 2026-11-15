/** GitLab Source plugin: Issue/MR events, subscribed comments and MR lifecycle polling. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GitlabAccountsSchema } from '../deployment.ts'
import { record } from '../kv.ts'
import { gitlabApi, gitlabPages } from '../infra/gitlab.ts'
import { sameName } from '../infra/text.ts'
import { sourceContext, health, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { cursorAt, pause, polled } from './poll.ts'
import { GitlabItem, GitlabNote, gitlabThread, gitlabTrigger, objectPath, parseGitlabThread, type GitlabItemValue, type GitlabObject } from './gitlab-model.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { sendGitlab } from './gitlab-channel.ts'
import { observeMergeRequest } from './gitlab-pull.ts'

export const GitlabConfigSchema = GitlabAccountsSchema.extend({ pollSeconds: z.number().int().min(60).max(3600).default(60),
  observeIssues: z.boolean().default(false), observeMergeRequests: z.boolean().default(false), observeComments: z.boolean().default(false) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const username = '[A-Za-z0-9_.-]+'
const text = (key: string, zh: string, en: string) => ({ key, type: 'text' as const, label: { zh, en } })
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: 'gitlab', title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: 'GitLab仓库的Issue、MR及评论。支持显式HTTP/HTTPS实例和子组路径。', en: 'Issues, merge requests and comments in an explicitly configured HTTP/HTTPS GitLab project with nested groups.' },
  schema: GitlabConfigSchema, health: ['gitlab'],
  fields: [text('protocol', '协议（https或http，默认https）', 'Protocol: https (default) or http'), text('host', 'GitLab主机（可带端口）', 'GitLab host (optional port)'), text('repository', '仓库完整路径', 'Full project path'),
    { key: 'apiEnabled', type: 'switch', label: { zh: '启用GitLab API（Issue/MR）', en: 'Enable GitLab API (Issues/MRs)' } },
    text('credentialFile', '仅Git模式凭据文件（宿主私密路径，可选）', 'Git-only credential file (private host path, optional)'), text('cli', '智能体glab CLI（API模式）', 'Agent glab CLI (API mode)'),
    { key: 'pollSeconds', type: 'number', min: 60, max: 3600, label: { zh: '轮询间隔/秒', en: 'Poll interval / seconds' } },
    ...[['observeIssues', '接收未@的新Issue', 'Receive unaddressed Issues'], ['observeMergeRequests', '接收未@的新MR', 'Receive unaddressed MRs'],
      ['observeComments', '接收未@的评论', 'Receive unaddressed comments']].map(([key, zh, en]) => ({ key: key!, type: 'switch' as const, label: { zh: zh!, en: en! } }))],
  scope: ({ meta }, config) => config.apiEnabled === false ? { listened: false, reason: 'gitlab_api_disabled' } : !(sameName(String(meta.host ?? ''), config.host) && sameName(String(meta.repository ?? ''), config.repository))
    ? { listened: false, reason: 'gitlab_project_not_listened' } : ({ listened: true,
    observed: meta.comment === true ? config.observeComments : meta.kind === 'merge_request' ? config.observeMergeRequests : config.observeIssues,
    row: meta.comment === true ? 'comments' : meta.kind === 'merge_request' ? 'merge_requests' : 'issues' }),
  channel: { allowed: (address, config) => config.apiEnabled !== false && sameName(address.host ?? '', config.host) && sameName(address.repository ?? '', config.repository),
    send: sendGitlab, link: address => ({ url: address.url ?? '', label: { zh: `GitLab ${address.kind === 'merge_request' ? '!' : '#'}${address.iid ?? ''}`, en: `GitLab ${address.kind === 'merge_request' ? '!' : '#'}${address.iid ?? ''}` } }) },
  threadContext: gitlabThreadContext,
  policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(new RegExp(`^${username}$`)) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '允许派活的GitLab账号', en: 'GitLab accounts that may originate work' }, columns: [text('id', '账号', 'Username')] }],
    explicit: { zh: '允许的账号在Issue/MR或评论中@智能体。', en: 'An allowed account mentions the agent in an Issue, MR or comment.' },
    rows: config => [['issues', 'observeIssues'], ['merge_requests', 'observeMergeRequests'], ['comments', 'observeComments']].map(([id, option]) => ({ id: id!, label: id!,
      note: { zh: config[option!] ? '全部' : '仅@', en: config[option!] ? 'All' : '@ only' },
      cells: { listedUnaddressed: !!config[option!], unlistedAddressed: true, unlistedUnaddressed: !!config[option!] } })) },
  environment: {
    variables: [text('DSH_SUPERAGENT_GITLAB_REPOSITORY', '当前GitLab项目完整路径', 'Full GitLab project path'),
      text('DSH_SUPERAGENT_GITLAB_HOST', '当前GitLab主机', 'GitLab host'), text('DSH_SUPERAGENT_GITLAB_ACCOUNT', '智能体账号', 'Agent account'),
      text('DSH_SUPERAGENT_GITLAB_CLONE_URL', 'HTTP(S)克隆地址', 'HTTP(S) clone URL')].map(({ key, label }) => ({ key, description: label })),
    values: ({ deployment }) => ({ DSH_SUPERAGENT_GITLAB_REPOSITORY: deployment.gitlab || deployment.git ? deployment.repository : '', DSH_SUPERAGENT_GITLAB_HOST: (deployment.gitlab ?? deployment.git)?.host ?? '',
      DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab?.login ?? '', DSH_SUPERAGENT_GITLAB_CLONE_URL: (deployment.gitlab ?? deployment.git)?.cloneUrl ?? '' }),
  },
}
/** Polls from a durable overlap cursor; failures leave it unchanged so already-received events are safely replayed. */
export async function pollGitlab(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const config = ctx.config<GitlabConfig>('gitlab'), account = ctx.deployment.gitlab
  if (!config || config.apiEnabled === false || !account || config.host !== account.host || !sameName(config.repository, ctx.deployment.repository)) return
  const checkpoint = record<string>(`gitlab:since:${account.host}:${account.projectId}`)
  const started = new Date().toISOString(), since = ctx.state.get(checkpoint)
  if (!since) { ctx.state.set(checkpoint, cursorAt(started)); return }
  const commands = ctx.commands.withSignal(signal), read = new Set<string>(), failures: unknown[] = []
  const receive = async (kind: GitlabObject, item: GitlabItemValue, opened: boolean) => {
    signal.throwIfAborted()
    const id = gitlabThread(account, kind, item.iid), key = `gitlab:${id}`
    if (read.has(id)) return
    read.add(id)
    if (opened && Date.parse(item.created_at) >= Date.parse(since)) {
      const event = gitlabTrigger(account, ctx.deployment.repository, kind, item)
      if (event && (event.addressed || (kind === 'issue' ? config.observeIssues : config.observeMergeRequests))) await ctx.receive(event)
    }
    const subscribed = !!ctx.threads.get(key)?.subscriptions.length
    const notes = await gitlabPages(commands, GitlabNote, `${objectPath(kind, item.iid)}/notes?sort=asc&order_by=updated_at`)
    for (const note of notes) {
      signal.throwIfAborted()
      if (Date.parse(note.updated_at) < Date.parse(since)) continue
      const event = gitlabTrigger(account, ctx.deployment.repository, kind, item, note)
      if (event && (subscribed || event.addressed || config.observeComments)) await ctx.receive(event)
    }
    ctx.threads.describe(key, { label: `${kind === 'issue' ? '#' : '!'}${item.iid} ${item.title}`, url: item.web_url })
    if (kind === 'merge_request') observeMergeRequest(ctx, item)
  }
  for (const kind of ['issue', 'merge_request'] as const) {
    try {
      const path = `${kind === 'issue' ? 'issues' : 'merge_requests'}?scope=all&state=all&updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc`
      for (const item of await gitlabPages(commands, GitlabItem, path)) {
        try { await receive(kind, item, true) } catch (error) { failures.push(error) }
      }
    } catch (error) { failures.push(error) }
  }
  for (const thread of ctx.threads.subscribed('gitlab')) {
    if (!polled(ctx, thread)) continue
    const target = parseGitlabThread(account, thread.ref.id)
    if (!target || read.has(thread.ref.id)) continue
    try { await receive(target.kind, await gitlabApi(commands, GitlabItem, objectPath(target.kind, target.iid)), false) }
    catch (error) { failures.push(error) }
  }
  signal.throwIfAborted()
  if (failures.length) throw new Error(`GitLab poll incomplete (${failures.length} failed operations); retrying from the same cursor`)
  ctx.state.set(checkpoint, cursorAt(started))
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind), controller = new AbortController()
    const running = (async () => {
      await source.ready
      while (!controller.signal.aborted) {
        const config = source.config<GitlabConfig>('gitlab')
        if (config?.apiEnabled === false) source.report('gitlab', { state: 'paused', detail: 'GitLab API is disabled; Git/AW execution is independent.' })
        else if (!source.configured() || !config || !source.deployment.gitlab) source.report('gitlab', health('paused', config ? 'setupPending' : 'sourceOff'))
        else {
          try { await pollGitlab(source, controller.signal); source.report('gitlab', { state: 'ready', detail: 'GitLab poll complete' }) }
          catch { if (!controller.signal.aborted) source.report('gitlab', { state: 'error', detail: 'GitLab poll failed; verify access and retry' }) }
        }
        await pause((config?.pollSeconds ?? 60) * 1000, controller.signal)
      }
    })().catch(() => { source.report('gitlab', { state: 'error', detail: 'GitLab source stopped unexpectedly' }) })
    return async () => { controller.abort(); await running }
  })
}
