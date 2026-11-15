/** System failures use the native Outbox even when the Router cannot accept a relay. No network or model calls. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { workerFailureNotice } from '../src/app/notices.ts'
import { Commands } from '../src/infra/commands.ts'
import { checkedImText } from '../src/infra/text.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function fail(sessionId: string, error = 'Invalid tool schema: secret-value') {
  h.ctx.emit('agent/error', { agent: h.agents.get(sessionId), turn: 1, step: 1, error: new Error(error) } as never)
  await h.runtime.idle()
}

it('sends a fixed failure notice to the origin while the Router relay fails, without exposing the exception', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修复接口'))
  h.deliveries.mockImplementation(({ sessionId }) => { if (sessionId === h.runtime.masterId) throw new Error('503 Router unavailable') })
  const lark = vi.mocked(Commands.prototype.lark).mockClear()
  await fail(sessionId)
  const saved = h.runtime.store.tickets.get(ticket.id)!
  const notice = workerFailureNotice(saved, trigger)!
  expect(saved.assignments.at(-1)!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('secret-value') })
  expect(h.runtime.effects.pending('relay')).toBe(true)
  expect(h.runtime.outbox.status(notice.id)).toBe('sent')
  expect(notice.channel).toEqual(trigger.channel)
  expect(notice.text).toContain(ticket.id)
  expect(notice.text).not.toContain('secret-value')
  expect(checkedImText(notice.text)).toBe(notice.text)
  const sends = () => lark.mock.calls.filter(([args]) => args.includes('+messages-reply'))
  expect(sends()).toHaveLength(1)
  expect(sends()[0]![0]).toContain(trigger.channel!.address.messageId)
  // Replaying the persisted report generates the same native receipt ID, even after successful delivery.
  h.runtime.outbox.send(workerFailureNotice(saved, trigger)!)
  await h.runtime.sendReplies()
  expect(sends()).toHaveLength(1)
})

it('keeps a failed send pending and sends once when the source recovers', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('2', '@bot 修复接口'))
  const lark = vi.mocked(Commands.prototype.lark).mockRejectedValue(new Error('IM unavailable'))
  await fail(sessionId)
  const notice = workerFailureNotice(h.runtime.store.tickets.get(ticket.id)!, trigger)!
  expect(h.runtime.outbox.status(notice.id)).toBe('pending')
  lark.mockResolvedValue({}).mockClear()
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h.runtime.sendReplies() } finally { vi.useRealTimers() }
  expect(h.runtime.outbox.status(notice.id)).toBe('sent')
  expect(lark.mock.calls.filter(([args]) => args.includes('+messages-reply'))).toHaveLength(1)
})

it('uses only the origin channel, supports DingTalk and channel-less origins, and distinguishes later reports', async () => {
  const { ticket, trigger, sessionId } = await h.acceptedTicket(feishu('3', '@bot fix the endpoint'))
  await fail(sessionId)
  const saved = h.runtime.store.tickets.get(ticket.id)!
  const first = workerFailureNotice(saved, trigger)!
  expect(first.text).toContain('Worker execution failed')
  expect(checkedImText(first.text)).toBe(first.text)
  expect(workerFailureNotice(saved, { ...trigger, channel: undefined })).toBeUndefined()
  expect(workerFailureNotice(saved, undefined)).toBeUndefined()
  const channel = { source: 'dingtalk', thread: 'single-chat', address: { conversationId: 'single-chat' } }
  expect(workerFailureNotice(saved, { ...trigger, channel })!.channel).toEqual(channel)
  const later = structuredClone(saved)
  later.assignments.at(-1)!.report!.at = '2026-12-01T00:00:00.000Z'
  expect(workerFailureNotice(later, trigger)!.id).not.toBe(first.id)
  later.assignments.at(-1)!.report!.state = 'ready'
  expect(workerFailureNotice(later, trigger)).toBeUndefined()
})

it('does not add system notices for ordinary Worker reports', async () => {
  const { sessionId } = await h.acceptedTicket(feishu('4', '@bot 修复接口'))
  const lark = vi.mocked(Commands.prototype.lark).mockClear()
  for (const state of ['progress', 'blocked', 'failed'] as const) {
    await h.runTool(sessionId, 'orchestrator_report', { state, summary: `${state} report` })
    await h.runtime.idle()
  }
  expect(lark.mock.calls.filter(([args]) => args.includes('+messages-reply'))).toHaveLength(0)
})

it('notifies only after native launch retries are exhausted', async () => {
  h.controller.resolveAgent.mockImplementation(async (id: string) => {
    if (id.startsWith('worker-')) throw Object.assign(new Error('Service Unavailable'), { status: 503 })
    return h.resolveDefault(id)
  })
  const { ticket } = await h.acceptedTicket(feishu('5', '@bot 修复接口'))
  const lark = vi.mocked(Commands.prototype.lark).mockClear()
  let now = Date.now()
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toBeUndefined()
    expect(lark.mock.calls.filter(([args]) => args.includes('+messages-reply'))).toHaveLength(0)
    now += 5000 * 2 ** attempt + 1000
    vi.useFakeTimers({ toFake: ['Date'], now })
    try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  }
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report?.state).toBe('failed')
  expect(lark.mock.calls.filter(([args]) => args.includes('+messages-reply'))).toHaveLength(1)
})

it('replies to the original AW dispatch only after assessment times out with no Ticket', async () => {
  const trigger = feishu('6', '@bot AW taskId=tsk_example revision=1 phase=implement scope=实施范围')
  const lark = vi.mocked(Commands.prototype.lark).mockClear()
  const replies = () => lark.mock.calls.filter(([args]) => args.includes('+messages-reply'))
  const timeout = h.runtime.store.settings().eval.timeoutSeconds * 1000 + 1000
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    h.runtime.receive(trigger)
    await h.runtime.idle()
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(replies()).toHaveLength(0)
      vi.setSystemTime(Date.now() + timeout)
      await h.runtime.pump()
      await h.runtime.idle()
    }
    expect(h.runtime.store.tickets.list()).toHaveLength(0)
    expect(h.runtime.store.decisions.get(h.runtime.store.triggers.disposition(trigger.id)!.decisionId!))
      .toMatchObject({ kind: 'unavailable', reason: [{ code: 'timeout' }] })
    expect(replies()).toHaveLength(1)
    expect(replies()[0]![0]).toContain(trigger.channel!.address.messageId)
    expect(replies()[0]![0].join(' ')).toContain('AW 任务 tsk_example（版本 1）派活评估超时')
    h.runtime.receive(trigger)
    await h.runtime.idle()
    expect(replies()).toHaveLength(1)
  } finally { vi.useRealTimers() }
})
