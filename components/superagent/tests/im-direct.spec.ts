/** Native Feishu Trigger -> Ticket -> Worker -> review -> Outbox, with local host fixtures. */
import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { SettingsSchema } from '../src/policy.ts'
import { awDispatchRequest } from '../src/app/aw.ts'
import { directWorkScope } from '../src/app/im-direct.ts'
import { feishu, MEMBER, startRuntime, type Host } from './fixtures/host.ts'
import type { ImDirectRepository } from '../src/deployment.ts'

const base = 'a'.repeat(40)
const candidate = 'b'.repeat(40)
const origin = 'https://git.example.test/team/widgets.git'
const config: ImDirectRepository = {
  repositoryUrl: origin, provider: 'gitlab', branch: 'main', senderId: MEMBER,
  author: { name: 'Lab Author', email: 'lab@example.test' },
  environmentRef: 'test', environment: { path: ['/usr/bin'], executables: ['git'], variables: {} },
}
const mention = [{ id: 'ou_bot', key: '@_user_1', name: 'Bot' }]
let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

it('requires an actual leading Bot mention in a group and the pinned, authorized human', () => {
  const trigger = feishu('1', '@_user_1 直接做：增加筛选\n显示结果数', { mentions: mention })
  expect(directWorkScope(trigger, MEMBER, true)).toBe('增加筛选\n显示结果数')
  expect(directWorkScope(trigger, 'ou_other', true)).toBeUndefined()
  expect(directWorkScope(trigger, MEMBER, false)).toBeUndefined()
  expect(awDispatchRequest(feishu('2', '@_user_1 直接做：引用 AW taskId=tsk_x revision=1 phase=implement scope=test', { mentions: mention }))).toBeUndefined()
  expect(feishu('3', '@Bot 直接做：增加筛选').meta.directScope).toBeUndefined()
  expect(feishu('4', '转述 @_user_1 直接做：增加筛选', { mentions: mention }).meta.directScope).toBeUndefined()
  expect(feishu('5', '@_user_1 直接做：增加筛选', { mentions: mention, sender_type: 'bot' }).meta.directScope).toBeUndefined()
  expect(feishu('6', '直接做:增加筛选', { chat_type: 'p2p', mentions: [] }).meta.directScope).toBe('增加筛选')
})

it('keeps existing native Feishu execution when direct work is disabled', async () => {
  h = await startRuntime()
  const normal = await h.acceptedTicket(feishu('7', '@_user_1 直接做：增加筛选', { mentions: mention }))
  expect(normal.ticket.execution?.imDirect).toBeUndefined()
  expect(h.agents.has(normal.sessionId)).toBe(true)
})

it('pins a native checkout, rejects stale review or foreign follow-up, and issues one ready in the original topic', async () => {
  h = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings(SettingsSchema.parse({ ...settings, sources: { ...settings.sources, github: { ...settings.sources.github, config: {} } } }))
  }, { imDirect: config })
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected AW call') })
  vi.mocked(Commands.prototype.run).mockResolvedValue(`${base}\trefs/heads/main\n`)
  const spawn = h.subprocess.spawn.getMockImplementation()!
  let checkoutExists = false
  h.subprocess.spawn.mockImplementation(spec => {
    const args = spec.argv.join(' ')
    if (spec.argv.includes('checkout')) checkoutExists = true
    const value = args === 'git rev-parse --show-toplevel' && checkoutExists ? h!.runtime.store.tickets.get(h!.runtime.store.tickets.list()[0]!.id)!.execution!.directory
      : args === 'git config --local --get remote.origin.url' ? origin
      : args === 'git rev-parse HEAD' ? candidate
      : args === 'git branch --show-current' ? [...h!.runtime.store.tickets.list()].map(ticket => 'codex/' + ticket.execution!.name)[0] ?? ''
      : undefined
    return value === undefined ? spawn(spec) : { done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: { stdout: { readFrom: () => ({ text: value + '\n', nextOffset: value.length + 1, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } } }
  })
  const { trigger, ticket, sessionId } = await h.acceptedTicket(feishu('8', '@_user_1 直接做：增加筛选', { mentions: mention }))
  expect(h.agents.has(sessionId)).toBe(true)
  expect(ticket.execution?.imDirect).toMatchObject({ scope: '增加筛选', baseSha: base, branch: 'main', workspacePrepared: true })
  expect(ticket.execution?.aw).toBeUndefined()
  expect(vi.mocked(Commands.prototype.run).mock.calls.some(([, args]) => args.includes('refs/heads/main'))).toBe(true)
  expect(h.subprocess.spawn.mock.calls.some(([spec]) => spec.argv.includes('checkout') && spec.argv.includes(base))).toBe(true)
  expect(h.runtime.receive(trigger)).toBe('duplicate')
  const foreign = feishu('9', '扩展到另一个仓库', { root_id: 'om_8', sender_id: 'ou_other', mentions: [] })
  h.runtime.receive(foreign)
  expect(h.runtime.store.triggers.disposition(foreign.id)?.fanout).toEqual([])
  expect(() => h!.runtime.engine.attach(ticket.id, foreign.id)).toThrow()

  const run = (ref = candidate) => h!.runTool(sessionId, 'orchestrator_report', { state: 'ready', candidate_sha: ref,
    review_session_id: 'reviewer-1', summary: '已验证筛选和结果数。' })
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', candidate_sha: candidate, summary: '缺少评审' })).rejects.toThrow('review_session_id')
  const events = (sha: string) => [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `无阻塞问题\nREVIEW_ACCEPT ${sha}` }] } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const review = (sha: string, parentSession = sessionId) => ({ meta: { parentSession, cwd: ticket.execution!.directory },
    inheritedEventCount: 0, events: events(sha) })
  const inspect = vi.mocked(h.ctx.sessionController.inspect)
  type Inspection = Awaited<ReturnType<typeof h.ctx.sessionController.inspect>>
  inspect.mockResolvedValueOnce(review(base) as unknown as Inspection)
  await expect(run()).rejects.toThrow('exact candidate SHA')
  inspect.mockResolvedValueOnce(review(candidate, 'worker-other') as unknown as Inspection)
  await expect(run()).rejects.toThrow('Independent native review')
  inspect.mockResolvedValueOnce(review(candidate) as unknown as Inspection)
  await run()
  await h.runtime.idle()
  const ready = () => vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args.some(arg => arg.includes('候选已就绪')))
  expect(ready()).toHaveLength(1)
  expect(ready()[0]![0].join(' ')).toContain('om_8')
  expect(ready()[0]![0].join(' ')).toContain(candidate)
  expect(h.runtime.store.tickets.get(ticket.id)?.assignments.at(-1)?.report).toMatchObject({ state: 'ready', candidateSha: candidate, reviewSessionId: 'reviewer-1' })
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { purpose: 'result', ticket_id: ticket.id, text: 'second result' })
  expect(ready()).toHaveLength(1)
  expect(vi.mocked(Commands.prototype.lark).mock.calls.some(([args]) => args.some(arg => arg.includes('second result') || arg.includes('DSH_OWNER_EVENT_V1')))).toBe(false)
  const sameTopic = feishu('10', '请按原范围修订提示', { root_id: 'om_8', mentions: [] })
  expect(h.runtime.receive(sameTopic)).toBe('stored')
  await h.runtime.idle()
  const resumed = h.runtime.store.tickets.get(ticket.id)!
  expect(resumed.assignments).toHaveLength(2)
  expect(resumed.execution?.imDirect?.baseSha).toBe(base)
  expect(vi.mocked(Commands.prototype.run).mock.calls.filter(([, args]) => args.includes('refs/heads/main'))).toHaveLength(1)
  expect(fetch).not.toHaveBeenCalled()
})
