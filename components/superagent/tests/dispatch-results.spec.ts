import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { awDispatchSink } from '../src/app/aw-dispatch-results.ts'
import { AwClient } from '../src/app/aw.ts'
import { dispatchResults, type DispatchResultSink } from '../src/app/dispatch-results.ts'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { Engine, type Candidate, type Policy, type Trigger } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-results-'))
  const path = join(directory, 'orchestrator.sqlite')
  let time = Date.parse('2026-11-14T00:00:00Z')
  const now = () => new Date(time).toISOString()
  const signal = new AbortController().signal
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 1000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    admitsInferred: () => false, revalidate: () => true,
  }
  function open(sink: DispatchResultSink) {
    const store = new Store(path)
    const effects = new Effects(store, new HealthBoard(), () => time)
    const emit = dispatchResults(store, effects, sink, trigger => trigger.actor.id === 'owner', signal)
    let candidate: Candidate
    const engine = new Engine({ repo: store, emit, now, scope: { scope: () => ({ listened: true, observed: false }) },
      policy: () => policy, assessor: { request: next => { candidate = next } },
      executor: { start() {}, deliver() {}, stop() {} }, outbox: { send() {}, status: () => undefined, withdraw() {} } })
    const receive = (id: string, text: string, source: string, sender = 'owner') => {
      const trigger: Trigger = { id, text, source, at: now(), threads: [{ source, id }], actor: { source, id: sender },
        human: true, addressed: 'direct', meta: {} }
      engine.receive(trigger)
      engine.evaluateDue()
      return trigger
    }
    const accept = (trigger: Trigger) => engine.decide(trigger.id, { kind: 'accept', title: 'Lab', scope: 'fixture', reason: 'requested' })
    const expire = () => {
      engine.candidateDelivered(candidate.evalId)
      time += 1001
      engine.evaluateDue()
    }
    return { store, effects, engine, receive, accept, expire, close: async () => { await effects.drain(); store.close() } }
  }
  return { open, tick: (ms: number) => { time += ms }, now, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

it('sends only native acceptance and terminal timeouts to an interchangeable sink', async () => {
  const f = fixture()
  const write = vi.fn<DispatchResultSink['write']>().mockResolvedValue(undefined)
  const h = f.open({ id: 'test-sink', write, reference: trigger => trigger.text === 'fixture' ? { taskId: 'T1', revision: 2 } : undefined })
  try {
    h.effects.start()
    expect(h.accept(h.receive('other', 'not a dispatch', 'feishu')).ticketId).toBeDefined()
    h.accept(h.receive('third-party', 'fixture', 'github', 'guest'))
    await h.effects.idle()
    expect(write).not.toHaveBeenCalled()

    const trigger = h.receive('msg-accept', 'fixture', 'dingtalk')
    const ticket = h.accept(trigger).ticketId
    expect(h.engine.receive(trigger)).toBe('duplicate')
    await h.effects.idle()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toMatchObject({ outcome: 'accepted', taskId: 'T1', revision: 2, ticketId: ticket, sourceRef: 'dingtalk:trigger/msg-accept' })

    h.receive('msg-timeout', 'fixture', 'feishu')
    h.expire()
    h.expire()
    await h.effects.idle()
    expect(write).toHaveBeenCalledTimes(1)
    h.expire()
    await h.effects.idle()
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]?.[0]).toEqual({ outcome: 'assessment_timeout', taskId: 'T1', revision: 2, occurredAt: f.now(), sourceRef: 'feishu:trigger/msg-timeout' })
    expect(write.mock.calls[1]?.[1]).not.toBe(write.mock.calls[0]?.[1])
  } finally {
    await h.close()
    f.cleanup()
  }
})

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local address')
  return `http://127.0.0.1:${address.port}`
}
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))

it.skipIf(!process.env.DSH_LAB_AW_SERVER)('recovers a lost AW response after restart with exactly one record per native result', async () => {
  const awPath = process.env.DSH_LAB_AW_SERVER!
  const { createStore } = await import(pathToFileURL(join(awPath, 'store.mjs')).href)
  const { createApp } = await import(pathToFileURL(join(awPath, 'app.mjs')).href)
  const aw = createStore(':memory:')
  const project = aw.createProject({ name: 'Lab' })
  const requirement = aw.createRequirement({ projectId: project.id, title: 'Dispatch records', description: 'Recover delivery' })
  const { items: [task] } = aw.splitTasks(requirement.id, { expectedRevision: 1, tasks: [{ title: 'Trace acceptance', description: 'Trace dispatch', acceptance: 'One record' }] })
  const otherProject = aw.createProject({ name: 'Other Lab' })
  const otherRequirement = aw.createRequirement({ projectId: otherProject.id, title: 'Outside this instance', description: 'Verify the project guard' })
  const { items: [otherTask] } = aw.splitTasks(otherRequirement.id, { expectedRevision: 1, tasks: [{ title: 'Other task', description: 'No write to this project', acceptance: 'No dispatch record' }] })
  const awServer: Server = createApp(aw)
  const awUrl = await listen(awServer)
  const keys: string[] = []
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      keys.push(String(req.headers['idempotency-key']))
      const response = await fetch(awUrl + req.url, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keys.at(-1)! },
        body: Buffer.concat(chunks) })
      await response.arrayBuffer()
      if (keys.length === 1) { res.destroy(); return }
      res.writeHead(response.status)
      res.end()
    } catch { res.writeHead(502); res.end() }
  })
  const proxyUrl = await listen(proxy)
  const reader = new AwClient({ awBaseUrl: awUrl })
  const scoped = (target: string, projectId = project.id) => awDispatchSink(target, undefined, { projectId,
    contains: (ref, signal) => reader.belongsToProject(ref, projectId, signal) })
  const f = fixture()
  const text = `AW taskId=${task.id} revision=1 phase=implement scope=fixture`
  let h = f.open(scoped(proxyUrl))
  try {
    h.effects.start()
    h.accept(h.receive('issue', text, 'github'))
    h.accept(h.receive('malformed', 'AW taskId=bad', 'dingtalk'))
    await h.effects.idle('dispatchResult')
    expect(keys).toEqual([])
    const trigger = h.receive('aw-accept', text, 'dingtalk')
    const ticketId = h.accept(trigger).ticketId
    await h.effects.idle('dispatchResult')
    expect(h.effects.pending('dispatchResult')).toBe(true)
    expect(aw.listDispatchRecords(task.id, 1)).toMatchObject([{ outcome: 'accepted', ticketRef: ticketId, taskRevision: 1 }])
    await h.close()

    h = f.open(scoped(proxyUrl, otherProject.id))
    f.tick(2000)
    h.effects.start()
    await h.effects.idle('dispatchResult')
    expect(h.effects.pending('dispatchResult')).toBe(true)
    expect(keys).toHaveLength(1)
    await h.close()

    h = f.open(scoped(proxyUrl))
    f.tick(4000)
    h.effects.start()
    await h.effects.idle('dispatchResult')
    expect(h.effects.pending('dispatchResult')).toBe(false)
    expect(h.engine.receive(trigger)).toBe('duplicate')
    expect(keys).toEqual([keys[0], keys[0]])

    h.receive('aw-timeout', text, 'feishu')
    h.expire()
    h.expire()
    h.expire()
    await h.effects.idle('dispatchResult')
    expect(aw.listDispatchRecords(task.id, 1)).toMatchObject([
      { outcome: 'assessment_timeout', sourceRef: 'feishu:trigger/aw-timeout' },
      { outcome: 'accepted', sourceRef: 'dingtalk:trigger/aw-accept' },
    ])
    expect(keys).toHaveLength(3)
    expect(keys[2]).not.toBe(keys[0])
    const other = `AW taskId=${otherTask.id} revision=1 phase=implement scope=fixture`
    h.accept(h.receive('other-project-accepted', other, 'feishu'))
    h.receive('other-project-timeout', other, 'feishu')
    h.expire(); h.expire(); h.expire()
    await h.effects.idle('dispatchResult')
    expect(aw.listDispatchRecords(otherTask.id, 1)).toEqual([])
    expect(keys).toHaveLength(3)
  } finally {
    await h.close()
    await close(proxy)
    await close(awServer)
    aw.close()
    f.cleanup()
  }
})
