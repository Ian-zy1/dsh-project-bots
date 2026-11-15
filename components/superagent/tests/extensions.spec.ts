import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Engine, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { Commands } from '../src/infra/commands.ts'
import { gitlabApi, gitlabPages, gitlabPath } from '../src/infra/gitlab.ts'
import { agentVariables, credentialHelper, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { resolveGitlabDeployment, type Deployment } from '../src/deployment.ts'
import { testMachine } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { gitlabKind, GitlabConfigSchema, pollGitlab } from '../src/sources/gitlab.ts'
import { GitlabItem, gitlabChannel, gitlabThread, gitlabTrigger, parseGitlabThread } from '../src/sources/gitlab-model.ts'
import { claimMergeRequest, observeMergeRequest } from '../src/sources/gitlab-pull.ts'
import { readGitlabRepositoryPath, gitlabThreadContext } from '../src/sources/gitlab-read.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { record } from '../src/kv.ts'
import { DingtalkApi, DingtalkConfigSchema } from '../src/sources/dingtalk-api.ts'
import { createDingtalkKind, dingtalkTrigger, receiveDingtalk, RobotMessage } from '../src/sources/dingtalk.ts'
import type { SourceKind } from '../src/sources/kind.ts'

const account = { cli: '/usr/bin/false', login: 'agent', userId: 9, host: 'git.example.test:8443', projectId: 17,
  webUrl: 'https://git.example.test:8443/team/sub/app', cloneUrl: 'https://git.example.test:8443/team/sub/app.git', defaultBranch: 'main' }
const deployment: Deployment = { ...testMachine(), repositoryProvider: 'gitlab', repository: 'team/sub/app', gitlab: account }
const stamp = '2026-11-12T01:00:00.000Z'
const item = (overrides: Record<string, unknown> = {}) => GitlabItem.parse({ id: 111, iid: 12, title: 'Fix sorting', description: '@agent implement sorting',
  author: { id: 1, username: 'alice' }, state: 'opened', created_at: stamp, updated_at: stamp, web_url: `${account.webUrl}/-/issues/12`, ...overrides })
const note = (overrides: Record<string, unknown> = {}) => ({ id: 3, body: '@agent adjust sorting', author: { id: 1, username: 'alice' }, system: false, created_at: stamp, updated_at: stamp, ...overrides })
const config = GitlabConfigSchema.parse({ host: account.host, repository: deployment.repository, cli: account.cli })
const ding = DingtalkConfigSchema.parse({ clientId: 'client', robotCode: 'robot', corpId: 'corp', conversations: [{ id: 'group' }] })
const robot = (overrides: Record<string, unknown> = {}) => RobotMessage.parse({ msgId: 'message-1', conversationId: 'group', conversationType: '2',
  senderStaffId: 'alice', senderCorpId: 'corp', isInAtList: true, createAt: Date.parse(stamp), msgtype: 'text', text: { content: '实现排序' }, ...overrides })
const directories: string[] = [], stores: Store[] = []
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), 'superagent-ext-')); directories.push(dir); return dir }
function fixture() {
  const store = new Store(join(temporary(), 'state.sqlite')); stores.push(store)
  store.saveSettings(SettingsSchema.parse({ sources: { gitlab: { enabled: true, config }, dingtalk: { enabled: true, config: ding } },
    policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] }, dingtalk: { allowed: [{ id: 'alice' }] } } } }))
  const sources = new SourceRegistry(() => store.settings(), new HealthBoard())
  const sent: OutboundMessage[] = []
  const send = vi.fn(async (message: OutboundMessage) => { sent.push(message); return 'sent' as const })
  const dingtalk = createDingtalkKind({ send }); sources.register(gitlabKind); sources.register(dingtalk)
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  vi.spyOn(commands, 'withSignal').mockReturnValue(commands)
  const start = vi.fn(), deliver = vi.fn()
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor: { request: vi.fn() },
    executor: { start, deliver, stop: vi.fn() }, outbox: { send: message => { store.receipts.add(message) }, status: () => undefined, withdraw: () => {} },
    prepareTicket: ticket => { ticket.execution = { directory: '/tmp/candidate', name: `work-${ticket.id.slice(0, 6)}`, assignment: 'fixture' }; return ticket } })
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps = { store, engine, sources, commands, deployment, ready: Promise.resolve(), configured: () => true, receive,
    outbox: { send: (message: OutboundMessage) => { store.receipts.add(message) } } }
  const host = { sources, context: (kind: Pick<SourceKind, 'kind' | 'health'>) => sourceContextOf(deps, kind) }
  const accept = async (trigger: Trigger) => {
    await receive(trigger)
    const decision = engine.decide(trigger.id, { kind: 'accept', title: 'Sort', scope: 'Sorting only', reason: 'Explicit request' })
    if (!decision.ticketId) throw new Error('Fixture request was not accepted')
    return store.tickets.get(decision.ticketId)!
  }
  return { store, engine, sources, commands, host, receive, accept, start, deliver, sent, send,
    gitlab: host.context(gitlabKind), dingtalk: host.context(dingtalk) }
}

describe('GitLab setup and project isolation', () => {
  const project = { id: 17, path_with_namespace: deployment.repository, web_url: account.webUrl, http_url_to_repo: account.cloneUrl,
    default_branch: 'main', archived: false, permissions: { project_access: { access_level: 30 }, group_access: null } }
  it('starts from a nested self-managed project without any GitHub account', async () => {
    const probe = vi.fn(async (argv: string[]) => JSON.stringify(argv.at(-1) === 'user' ? { id: 9, username: 'agent' } : project))
    const resolved = await resolveGitlabDeployment(testMachine({ repositoryProvider: 'gitlab' }), config, probe)
    expect(resolved.gitlab).toEqual(account); expect(resolved.github).toBeUndefined()
    expect(probe.mock.calls[1]![0]).toEqual(['env', 'GLAB_API_PROTOCOL=https', 'API_PROTOCOL=https', `GITLAB_HOST=${account.host}`, `GITLAB_API_HOST=${account.host}`,
      '/usr/bin/false', 'api', '--hostname', account.host, 'projects/team%2Fsub%2Fapp'])
  })
  it.each([{ ...project, archived: true }, { ...project, permissions: { project_access: { access_level: 20 } } },
    { ...project, http_url_to_repo: 'https://other.test/repo.git' }, { ...project, path_with_namespace: 'other/app' }])('rejects unusable or mismatched repository setup', async value => {
    await expect(resolveGitlabDeployment(testMachine(), config, async argv => JSON.stringify(argv.at(-1) === 'user' ? { id: 9, username: 'agent' } : value))).rejects.toThrow('GitLab repository')
  })
  it('writes a host-scoped glab credential helper and removes ambient GitLab tokens', async () => {
    const stateDir = temporary(); await writeEnvironment({ ...deployment, stateDir }, [])
    const git = readFileSync(workerGitConfig(stateDir), 'utf8')
    expect(git).toContain(`[credential "https://${account.host}"]`); expect(git).toContain(credentialHelper(account.cli, account))
    expect(git).not.toContain('github.com'); expect(readFileSync(join(stateDir, 'worker-bin', 'glab'), 'utf8')).toContain(`GITLAB_HOST='${account.host}'`)
    expect(agentVariables(stateDir)).toMatchObject({ GITLAB_TOKEN: undefined, GITLAB_ACCESS_TOKEN: undefined, CI_JOB_TOKEN: undefined })
  })
  it.each(['../projects/other', '/projects/other', 'https://evil.test', '%2e%2e/foo', 'issues/%252e%252e', 'issues/1#other', 'issues\\..\\foo'])('rejects API escape %s', path => {
    expect(() => gitlabPath(new Commands(() => deployment, {}, new AbortController().signal), path)).toThrow()
  })
  it('paginates all pages and fails closed when the last page cannot be obtained', async () => {
    const f = fixture(), run = vi.spyOn(f.commands, 'run').mockResolvedValueOnce(JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id })))).mockResolvedValueOnce('[{"id":100}]')
    expect(await gitlabPages(f.commands, z.object({ id: z.number() }), 'issues')).toHaveLength(101)
    expect(run.mock.calls[1]![1]).toContain('projects/17/issues?per_page=100&page=2')
    run.mockResolvedValueOnce(JSON.stringify(Array(100).fill({ id: 1 })))
    await expect(gitlabPages(f.commands, z.object({ id: z.number() }), 'issues', 1)).rejects.toThrow('pagination limit')
  })
  it('provides repository preparation variables with no code-host Source installed', () => {
    const settings = SettingsSchema.parse({}), sources = new SourceRegistry(() => settings)
    const values = Object.fromEntries(environmentOf({ deployment, settings, sources }).map(variable => [variable.key, variable.value]))
    expect(values).toMatchObject({ DSH_SUPERAGENT_CODE_HOST: 'gitlab', DSH_SUPERAGENT_REPOSITORY: 'team/sub/app', DSH_SUPERAGENT_CLONE_URL: account.cloneUrl })
  })
  it('uses GitLab to read repository context and rejects hidden or traversal paths', async () => {
    const f = fixture(), run = vi.spyOn(f.commands, 'run').mockResolvedValue('{"encoding":"base64","content":"aGVsbG8="}')
    expect(await readGitlabRepositoryPath(f.commands, 'src/main.ts', 'file')).toBe('hello')
    expect(run.mock.calls[0]![1]).toContain('projects/17/repository/files/src%2Fmain.ts?ref=HEAD')
    await expect(readGitlabRepositoryPath(f.commands, '../secret', 'file')).rejects.toThrow('non-hidden')
    await expect(readGitlabRepositoryPath(f.commands, '.env', 'file')).rejects.toThrow('non-hidden')
  })
})

describe('GitLab task lifecycle and recovery', () => {
  it('keeps same-number Issues and MRs, projects and instances separate', () => {
    const issue = gitlabTrigger(account, deployment.repository, 'issue', item())!, mr = gitlabTrigger(account, deployment.repository, 'merge_request', item())!
    expect(issue.id).not.toBe(mr.id); expect(issue.threads).not.toEqual(mr.threads)
    expect(parseGitlabThread({ ...account, projectId: 18 }, issue.threads[0]!.id)).toBeUndefined()
    expect(parseGitlabThread({ ...account, host: 'other.test' }, issue.threads[0]!.id)).toBeUndefined()
  })
  it('preserves own-account and system-event exclusion', () => {
    expect(gitlabTrigger(account, deployment.repository, 'issue', item({ author: { id: 9, username: 'agent' } }))).toBeUndefined()
    expect(gitlabTrigger(account, deployment.repository, 'issue', item(), note({ system: true }))).toBeUndefined()
  })
  it('deduplicates replay through real Engine and Store and resumes the subscribed task on a comment', async () => {
    const f = fixture(), trigger = gitlabTrigger(account, deployment.repository, 'issue', item())!, ticket = await f.accept(trigger)
    expect((await f.receive(trigger))).toBe('duplicate')
    expect(f.store.tickets.list()).toHaveLength(1); expect(f.start).toHaveBeenCalledTimes(1)
    const comment = gitlabTrigger(account, deployment.repository, 'issue', item(), note())!
    await f.receive(comment)
    expect(f.store.tickets.get(ticket.id)?.inputs.some(input => 'triggerId' in input && input.triggerId === comment.id)).toBe(true)
  })
  it('binds only the source or ticket-owned MR and observes terminal lifecycle once', async () => {
    const f = fixture(), ticket = await f.accept(gitlabTrigger(account, deployment.repository, 'issue', item())!)
    const mr = item({ author: { id: 9, username: 'agent' }, source_branch: `agent/${ticket.execution!.name}`, source_project_id: 17, target_project_id: 17 })
    expect(claimMergeRequest(f.gitlab, ticket.id, { ...mr, source_project_id: 18 })).toContain('must be')
    expect(claimMergeRequest(f.gitlab, ticket.id, mr)).toBeUndefined()
    expect(f.store.tickets.get(ticket.id)?.follows).toEqual(expect.arrayContaining([expect.objectContaining({ thread: `gitlab:${gitlabThread(account, 'merge_request', 12)}`, own: true })]))
    observeMergeRequest(f.gitlab, { ...mr, state: 'merged', merged_at: stamp })
    observeMergeRequest(f.gitlab, { ...mr, state: 'merged', merged_at: stamp })
    expect(f.store.tickets.get(ticket.id)?.follows?.filter(follow => follow.closed)).toHaveLength(1)
  })
  it('retains a poll cursor after partial failure and replays successfully with no duplicate trigger', async () => {
    const f = fixture(), checkpoint = record<string>(`gitlab:since:${account.host}:17`), since = '2026-11-12T00:59:55.000Z'
    f.store.set(checkpoint, since)
    let failed = true
    vi.spyOn(f.commands, 'run').mockImplementation(async (_program, args) => {
      const route = args[3]!
      if (route.includes('/notes?')) { if (failed) throw new Error('network'); return '[]' }
      return route.includes('/merge_requests?') ? '[]' : JSON.stringify([item()])
    })
    await expect(pollGitlab(f.gitlab, new AbortController().signal)).rejects.toThrow('incomplete')
    expect(f.store.get(checkpoint)).toBe(since); expect(f.store.triggers.get(gitlabTrigger(account, deployment.repository, 'issue', item())!.id)).toBeDefined()
    failed = false; await pollGitlab(f.gitlab, new AbortController().signal)
    expect(f.store.get(checkpoint)).not.toBe(since)
    expect(f.store.read.threadTriggers(`gitlab:${gitlabThread(account, 'issue', 12)}`, 10)).toHaveLength(1)
  })
  it('reads subscribed Issue comments even when list endpoints report no updated issue', async () => {
    const f = fixture(), ticket = await f.accept(gitlabTrigger(account, deployment.repository, 'issue', item())!)
    f.store.set(record<string>(`gitlab:since:${account.host}:17`), '2026-11-12T00:59:55.000Z')
    vi.spyOn(f.commands, 'run').mockImplementation(async (_program, args) => args[3]!.includes('/notes?') ? JSON.stringify([note()]) : args[3] === 'projects/17/issues/12' ? JSON.stringify(item()) : '[]')
    await pollGitlab(f.gitlab, new AbortController().signal)
    expect(f.store.tickets.get(ticket.id)?.inputs.length).toBeGreaterThan(0)
  })
  it('reconciles an uncertain send with an agent-owned marker, but not a marker copied by another user', async () => {
    const f = fixture(), message: OutboundMessage = { id: 'send-1', kind: 'reply', text: 'done', channel: gitlabChannel(account, deployment.repository, 'issue', 12) }
    const run = vi.spyOn(f.commands, 'run').mockResolvedValue('[{"body":"<!-- dsh-superagent:send-1 -->","author":{"id":9}}]')
    expect(await sendGitlab(f.gitlab, message)).toBe('sent'); expect(run).toHaveBeenCalledTimes(1)
    run.mockResolvedValueOnce('[{"body":"<!-- dsh-superagent:send-1 -->","author":{"id":1}}]').mockResolvedValueOnce('{}')
    await sendGitlab(f.gitlab, message); expect(run.mock.calls.at(-1)![1]).toContain('POST')
    await expect(sendGitlab(f.gitlab, { ...message, channel: { ...message.channel, address: { ...message.channel.address, host: 'other.test' } } })).rejects.toThrow('reply target')
  })
  it('provides bounded context and rejects another project context', async () => {
    const f = fixture(), trigger = gitlabTrigger(account, deployment.repository, 'issue', item())!
    vi.spyOn(f.commands, 'run').mockImplementation(async (_program, args) => JSON.stringify(args[3]!.includes('/notes?') ? [note()] : item()))
    expect((await gitlabThreadContext.read(f.commands, trigger, 'thread', undefined, {})).messages.map(message => message.id)).toEqual(['description', 'note:3'])
    await expect(gitlabThreadContext.read(f.commands, { ...trigger, meta: { ...trigger.meta, projectId: 18 } }, 'root', undefined, {})).rejects.toThrow('another project')
  })
})

describe('DingTalk authorization, routing and robot transport', () => {
  it('retains only text and identifiers, excluding the temporary webhook credential', () => {
    const trigger = dingtalkTrigger(robot({ sessionWebhook: 'https://secret.invalid/access-bearing' }), ding)!
    expect(trigger.addressed).toBe('mention'); expect(JSON.stringify(trigger)).not.toContain('secret.invalid')
    expect(dingtalkTrigger(robot({ conversationType: '1', isInAtList: false }), ding)?.addressed).toBe('direct')
  })
  it.each([{ senderCorpId: 'other' }, { robotCode: 'other' }, { chatbotCorpId: 'other' }, { conversationId: 'unlisted' }, { isInAtList: false }, { msgtype: 'image' }])('ignores out-of-scope input %j', overrides => {
    expect(dingtalkTrigger(robot(overrides), ding)).toBeUndefined()
  })
  it('gates unknown senders, deduplicates delivery, and keeps unrelated messages in separate threads', async () => {
    const f = fixture(), first = dingtalkTrigger(robot(), ding)!, ticket = await f.accept(first)
    await receiveDingtalk(f.dingtalk, f.host, robot(), ding)
    expect(f.store.tickets.list()).toHaveLength(1)
    const other = dingtalkTrigger(robot({ msgId: 'other', senderStaffId: 'stranger' }), ding)!
    await f.receive(other); expect(f.engine.candidate(other.id)).toBeUndefined()
    expect(dingtalkTrigger(robot({ msgId: 'new-task' }), ding)?.threads).not.toEqual(first.threads)
    await receiveDingtalk(f.dingtalk, f.host, robot({ msgId: 'feedback', text: { content: `反馈 ${ticket.id} 修改排序方向` } }), ding)
    expect(f.store.tickets.get(ticket.id)?.inputs).toHaveLength(1)
  })
  it('rejects cross-conversation and unauthorized feedback without starting another task', async () => {
    const f = fixture(), ticket = await f.accept(dingtalkTrigger(robot(), ding)!)
    const before = f.receive.mock.calls.length
    await receiveDingtalk(f.dingtalk, f.host, robot({ msgId: 'bad', conversationId: 'other', text: { content: `反馈 ${ticket.id} 改一下` } }), ding)
    await receiveDingtalk(f.dingtalk, f.host, robot({ msgId: 'bad2', senderStaffId: 'stranger', text: { content: `反馈 ${ticket.id} 改一下` } }), ding)
    expect(f.receive).toHaveBeenCalledTimes(before)
  })
  const reply = (direct = false): OutboundMessage => ({ id: 'robot-send', kind: 'reply', text: 'done', channel: { source: 'dingtalk', thread: 'test',
    address: { corp: ding.corpId, robot: ding.robotCode, conversation: 'group', direct: String(direct), staff: 'alice' } } })
  it.each([false, true])('uses fixed robot API and private OAuth cache for direct=%s', async direct => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ accessToken: 'private-token', expireIn: 7200 })).mockImplementation(async () => Response.json({ processQueryKey: 'sent' }))
    const api = new DingtalkApi(() => ding, new AbortController().signal, request, { DINGTALK_CLIENT_SECRET: 'private-secret' })
    await api.send(reply(direct)); await api.send(reply(direct))
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[1]![0]).toBe(`https://api.dingtalk.com/v1.0/robot/${direct ? 'oToMessages/batchSend' : 'groupMessages/send'}`)
    expect(request.mock.calls[1]![1]?.headers).toMatchObject({ 'x-acs-dingtalk-access-token': 'private-token' })
    expect(request.mock.calls[1]![1]?.body).not.toContain('private-secret')
  })
  it('rejects revoked destinations before fetching a token and hides transport error details', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-secret https://secret.invalid'))
    const api = new DingtalkApi(() => ({ ...ding, conversations: [] }), new AbortController().signal, request, { DINGTALK_CLIENT_SECRET: 'private-secret' })
    await expect(api.send(reply())).rejects.toThrow('no longer allowed'); expect(request).not.toHaveBeenCalled()
    const valid = new DingtalkApi(() => ding, new AbortController().signal, request, { DINGTALK_CLIENT_SECRET: 'private-secret' })
    await expect(valid.send(reply())).rejects.toThrow('delivery may be unconfirmed')
    await expect(valid.send(reply())).rejects.not.toThrow('private-secret')
  })
})
