/** Native report and Outbox path; no model/network. */
import { afterEach, expect, it, vi } from 'vitest'
import { ownerReportEvent, ownerReportNotice } from '../src/app/owner-report.ts'
import { feishuOwnerReportRoute } from '../src/sources/feishu-owner-report.ts'
import { Commands } from '../src/infra/commands.ts'
import { checkedImText } from '../src/infra/text.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import type { AwContext } from '../src/core/index.ts'
import { writeFileSync } from 'node:fs'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const sha = process.env.OWNER_RELAY_TEST_SHA ?? 'a'.repeat(40)
const aw: AwContext = { taskId: 'tsk_owner', revision: 1, phase: 'implement', scope: 'fixture only', service: 'http://aw.test', digest: 'b'.repeat(64),
  requirementRevision: 1, baseSha: 'c'.repeat(40), task: { id: 'tsk_owner', revision: 1, projectId: 'prj_test', requirementId: 'req_test', title: 'Test', description: 'Fixture', acceptance: 'Fixture' },
  project: { id: 'prj_test', revision: 1, repositoryUrl: 'http://git.test/team/repo.git', baseline: 'c'.repeat(40), environment: '', rules: '' } }
const feishuConfig = { ownerReportBotId: 'ou_owner', ownerReportChatId: 'oc_team' }
const feishuRoute = feishuOwnerReportRoute(feishuConfig.ownerReportChatId, feishuConfig.ownerReportBotId)
async function fixture(enabled = true, title = aw.task.title) {
  h = await startRuntime(undefined, enabled ? feishuConfig : undefined)
  const result = await h.acceptedTicket(feishu('owner', '@bot approved test'))
  const ticket = h.runtime.store.tickets.get(result.ticket.id)!
  h.runtime.store.atomic(() => {
    ticket.execution = { ...ticket.execution!, aw: { ...aw, task: { ...aw.task, title } } }
    h!.runtime.store.tickets.save(ticket)
  })
  vi.mocked(Commands.prototype.lark).mockClear()
  return result
}
it('requires structured candidate SHA before saving ready, then atomically publishes one stable native Outbox notice', async () => {
  const { ticket, trigger, sessionId } = await fixture()
  await expect(h!.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'reviewed candidate' })).rejects.toThrow('candidate_sha')
  expect(h!.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report?.state).not.toBe('ready')
  await h!.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'reviewed candidate', candidate_sha: sha })
  await h!.runtime.idle()
  const saved = h!.runtime.store.tickets.get(ticket.id)!, notice = ownerReportNotice(feishuRoute, saved, trigger.channel)!
  expect(saved.assignments.at(-1)!.report?.candidateSha).toBe(sha)
  expect(h!.runtime.outbox.status(notice.id)).toBe('sent')
  const calls = () => vi.mocked(Commands.prototype.lark).mock.calls.filter(([args]) => args.some(v => v.includes('DSH_OWNER_EVENT_V1')))
  expect(calls()).toHaveLength(1); expect(calls()[0]![0]).toContain('--text')
  expect(notice.text).toMatch(/^候选 .{7} 已交付 · Test。等待 Owner 复审。\n\n<at /)
  expect(notice.text).toContain('<at user_id="ou_owner">'); expect(notice.text).toContain('"phase":"implement"')
  expect(notice.text).toContain(`"candidateSha":"${sha}"`)
  expect(notice.text).not.toContain('threadId'); expect(notice.text).not.toContain('codex')
  await expect(h!.runTool(h!.runtime.masterId, 'orchestrator_reply', { purpose: 'result', ticket_id: ticket.id, text: 'Separate ready result' }))
    .resolves.toEqual({ status: 'sent' })
  expect(vi.mocked(Commands.prototype.lark).mock.calls.some(([args]) => args.includes('Separate ready result'))).toBe(false)
  h!.runtime.outbox.send(notice); await h!.runtime.sendReplies(); expect(calls()).toHaveLength(1)
  if (process.env.OWNER_RELAY_EXPORT) writeFileSync(process.env.OWNER_RELAY_EXPORT, JSON.stringify({
    simulation: true, source: 'Native in-memory test Runtime report/Outbox, not a deployed Worker', notice, ticket: saved, candidateSha: sha,
  }, null, 2))
})
it('keeps the combined message under the Feishu limit when the task title is long', async () => {
  const title = '巡检实时状态异常告警联动自动派发单台多台设备显示结果筛选远程桌面连接无人操作版本升级验证修复清单管理'.repeat(3)
  const { ticket, trigger, sessionId } = await fixture(true, title)
  await h!.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'candidate', candidate_sha: sha })
  await h!.runtime.idle()
  const saved = h!.runtime.store.tickets.get(ticket.id)!
  const notice = ownerReportNotice(feishuRoute, saved, trigger.channel)!
  expect(() => checkedImText(notice.text)).not.toThrow()
  expect(notice.text).toContain(`候选 ${sha.slice(0, 7)} 已交付。等待 Owner 复审。`)
  expect(notice.text).toContain(`"candidateSha":"${sha}"`)
  expect(h!.runtime.outbox.status(notice.id)).toBe('sent')
})
it('keeps the ordinary result when the ready report has no configured Relay destination', async () => {
  const { ticket, sessionId } = await fixture(false)
  await h!.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'candidate', candidate_sha: sha })
  await expect(h!.runTool(h!.runtime.masterId, 'orchestrator_reply', { purpose: 'result', ticket_id: ticket.id, text: 'Human delivery' }))
    .resolves.toEqual({ status: 'sent' })
  expect(vi.mocked(Commands.prototype.lark).mock.calls.some(([args]) => args.includes('Human delivery'))).toBe(true)
})
it('is opt-in; phase plan, another chat and progress never publish to Owner', async () => {
  const { ticket, trigger, sessionId } = await fixture(false)
  await h!.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'working' })
  let saved = h!.runtime.store.tickets.get(ticket.id)!
  expect(ownerReportNotice(feishuRoute, saved, trigger.channel)).toBeUndefined()
  await h!.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'waiting' })
  saved = h!.runtime.store.tickets.get(ticket.id)!
  expect(ownerReportNotice(feishuOwnerReportRoute(), saved, trigger.channel)).toBeUndefined()
  const event = ownerReportEvent(saved)!
  const original = ownerReportNotice(feishuRoute, saved, trigger.channel)!
  expect(original.text).toBe(`<at user_id="ou_owner">Owner</at>\nDSH_OWNER_EVENT_V1 ${JSON.stringify(event)}`)
  expect(event.type).toBe('execution.blocked')
  const testChannel = { source: 'test', thread: 'test-thread', address: { room: 'trusted-test-room' } }
  const alternative = ownerReportNotice(channel => ({ channel, format: value => ({ text: JSON.stringify(value) }) }), saved, testChannel)!
  expect(alternative).toEqual({ id: original.id, ticketId: original.ticketId, kind: 'notice', channel: testChannel, text: JSON.stringify(event) })
  expect(ownerReportNotice(feishuOwnerReportRoute('oc_other', 'ou_owner'), saved, trigger.channel)).toBeUndefined()
  saved.execution!.aw = { ...aw, phase: 'plan' }
  expect(ownerReportNotice(feishuRoute, saved, trigger.channel)).toBeUndefined()
})
it('system failures publish through the same Outbox while Router/model delivery is unavailable', async () => {
  const { ticket, sessionId } = await fixture()
  h!.deliveries.mockImplementation(({ sessionId: id }) => { if (id === h!.runtime.masterId) throw Error('Router offline') })
  h!.ctx.emit('agent/error', { agent: h!.agents.get(sessionId), turn: 1, step: 1, error: Error('private upstream error') } as never)
  await h!.runtime.idle()
  const saved = h!.runtime.store.tickets.get(ticket.id)!, notice = ownerReportNotice(feishuRoute, saved, h!.runtime.store.triggers.get(saved.origin.triggerId)?.channel)!
  expect(notice.text).toContain('execution.failed'); expect(notice.text).not.toContain('private upstream error')
  expect(h!.runtime.outbox.status(notice.id)).toBe('sent')
})
