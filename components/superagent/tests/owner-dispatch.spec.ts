import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Engine, type Candidate, type Trigger, type OutboundMessage, type Policy } from '../src/core/index.ts'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { ownerDispatches } from '../src/app/owner-dispatch.ts'
import { feishuOwnerDispatchNotice } from '../src/sources/feishu-owner-report.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { checkedImText } from '../src/infra/text.ts'

it('persists native dispatch facts across restart and delivers once only for the authorized project and route', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'owner-dispatch-test-'))
  let time = Date.parse('2026-01-01T00:00:00Z')
  const now = () => new Date(time).toISOString()
  const sent: OutboundMessage[] = []
  let failOnce = true
  const open = () => {
    const store = new Store(join(directory, 'runtime.sqlite'))
    const effects = new Effects(store, new HealthBoard(), () => time)
    const emit = ownerDispatches(store, effects, {
      destination: 'lab-route', projectId: 'prj_test', target: origin => origin.address.chatId === 'oc_team',
      authorized: trigger => trigger.actor.id === 'owner', belongs: async event => {
        expect(event.type).not.toBe('dispatch.assessment_timeout')
        return event.taskId !== 'tsk_other'
      },
      format: (event, origin) => feishuOwnerDispatchNotice('ou_owner', event, origin),
      send: message => {
        checkedImText(message.text)
        if (failOnce && !message.text.includes('dispatch.assessment_timeout')) {
          failOnce = false
          throw Error('simulated delivery interruption')
        }
        sent.push(message)
      },
    })
    const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 1000,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
      admitsInferred: () => false, revalidate: () => true }
    let candidate: Candidate
    const engine = new Engine({ repo: store, emit, now, scope: { scope: () => ({ listened: true, observed: false }) },
      policy: () => policy, assessor: { request: value => { candidate = value } },
      executor: { start() {}, deliver() {}, stop() {} }, outbox: { send() {}, status() { return undefined }, withdraw() {} } })
    const receive = (name: string, task = 'tsk_test', actor = 'owner', chat = 'oc_team', addressed: Trigger['addressed'] = 'mention') => {
      const trigger: Trigger = { id: name, text: `AW taskId=${task} revision=1 phase=implement scope=Update the history panel`,
        source: 'feishu', at: now(), actor: { source: 'feishu', id: actor }, human: true, addressed, meta: {},
        threads: [{ source: 'feishu', id: name }], channel: { source: 'feishu', thread: name, address: { chatId: chat, messageId: `om_${name}` } } }
      engine.receive(trigger); engine.evaluateDue(); return trigger
    }
    return { effects, engine, receive, expire: () => { engine.candidateDelivered(candidate.evalId); time += 1001; engine.evaluateDue() },
      close: async () => { await effects.drain(); store.close() } }
  }
  let h = open()
  try {
    const accept = (trigger: Trigger) => h.engine.decide(trigger.id, { kind: 'accept', title: 'Lab', scope: 'test', reason: 'test' })
    const origin = h.receive('accepted')
    const ticket = accept(origin)
    expect(h.engine.receive(origin)).toBe('duplicate')
    h.engine.attach(ticket.ticketId!, h.receive('routed').id)
    h.engine.decide(h.receive('rejected').id, { kind: 'ignore', reason: 'untrusted raw assessment text' })
    accept(h.receive('wrongproject', 'tsk_other'))
    accept(h.receive('notmentioned', 'tsk_test', 'owner', 'oc_team', 'direct'))
    accept(h.receive('wrongchat', 'tsk_test', 'owner', 'oc_other'))
    accept(h.receive('unauthorized', 'tsk_test', 'visitor'))
    h.receive('timedout'); h.expire(); h.expire(); h.expire()
    await h.close()
    h = open(); h.effects.start(); await h.effects.idle()
    time += 2500; h.effects.kick(); await h.effects.idle()
    expect(sent).toHaveLength(3)
    const events = sent.map(message => JSON.parse(message.text.split('DSH_OWNER_EVENT_V1 ')[1]!))
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dispatch.accepted', originMessageId: 'om_accepted', ticketId: ticket.ticketId }),
      expect.objectContaining({ type: 'dispatch.rejected', originMessageId: 'om_rejected', reason: 'notActionable' }),
      expect.objectContaining({ type: 'dispatch.assessment_timeout', originMessageId: 'om_timedout' }),
    ]))
    expect(JSON.stringify(events)).not.toContain('untrusted raw assessment text')
    expect(new Set(events.map(event => event.eventId)).size).toBe(3)
    if (process.env.OWNER_DISPATCH_TEST_OUT) writeFileSync(process.env.OWNER_DISPATCH_TEST_OUT, JSON.stringify(sent))
  } finally { await h.close(); rmSync(directory, { recursive: true, force: true }) }
})
