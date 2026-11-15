import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { apply } from '../src/sources/dingtalk.ts'
import { DingtalkConfigSchema } from '../src/sources/dingtalk-api.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { SourceContext, SourceHost } from '../src/sources/host.ts'
import type { Health } from '../src/sources/host.ts'
import { testDeployment } from './fixtures/deployment.ts'

type Envelope = { data: string; headers: { messageId: string } }
type Stream = { connected: boolean; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
  callback?: (message: Envelope) => void; socketCallBackResponse: ReturnType<typeof vi.fn> }
const sdk = vi.hoisted(() => ({ streams: [] as Stream[], fail: false }))
vi.mock('dingtalk-stream', () => ({ TOPIC_ROBOT: 'robot-topic', DWClient: class {
  connected = false
  callback?: (message: Envelope) => void
  constructor(readonly options: unknown) { sdk.streams.push(this) }
  connect = vi.fn(async () => { this.connected = !sdk.fail })
  disconnect = vi.fn(() => { this.connected = false })
  registerCallbackListener(_topic: string, callback: (message: Envelope) => void) { this.callback = callback }
  socketCallBackResponse = vi.fn()
} }))
const config = DingtalkConfigSchema.parse({ clientId: 'synthetic-client', robotCode: 'robot', corpId: 'corp', conversations: [{ id: 'group' }] })
const payload = (id: string): Envelope => ({ headers: { messageId: id }, data: JSON.stringify({ msgId: id, conversationId: 'group', conversationType: '2',
  senderStaffId: 'alice', senderCorpId: 'corp', isInAtList: true, createAt: Date.now(), msgtype: 'text', text: { content: 'Implement sorting' } }) })
const disposers: (() => unknown | Promise<unknown>)[] = []
async function stop() { for (const dispose of disposers.splice(0).reverse()) await dispose() }
afterEach(async () => { await stop(); vi.useRealTimers(); vi.unstubAllEnvs(); sdk.streams.length = 0; sdk.fail = false })
function mount(receive: SourceContext['receive'], configured = true) {
  vi.useFakeTimers(); vi.stubEnv('DINGTALK_CLIENT_SECRET', 'synthetic-secret')
  let enabled = true
  const settings = SettingsSchema.parse({ sources: { dingtalk: { enabled: true, config } }, policy: { sources: { dingtalk: { allowed: [{ id: 'alice' }] } } } })
  const sources = new SourceRegistry(() => settings)
  let health: Health | undefined
  const source = { deployment: testDeployment(), ready: Promise.resolve(), configured: () => configured,
    config: () => enabled ? config : undefined, receive, report: (_entry: string, value: Health) => { health = value } } as unknown as SourceContext
  const host: SourceHost = { sources, context: () => source }
  apply({ orchestrator: host, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
  return { disable: () => { enabled = false }, get health() { return health } }
}
describe('DingTalk Stream lifecycle', () => {
  it('keeps reception connected while repository processing is not configured', async () => {
    const receive = vi.fn(async () => 'stored' as const), mounted = mount(receive, false)
    await vi.advanceTimersByTimeAsync(0)
    expect(mounted.health).toMatchObject({ state: 'ready', detail: 'DingTalk Stream connected' })
    const connection = sdk.streams[0]!
    connection.callback!(payload('waiting-for-repository')); await vi.advanceTimersByTimeAsync(0)
    expect(receive).toHaveBeenCalledTimes(1)
    expect(connection.socketCallBackResponse).toHaveBeenCalledWith('waiting-for-repository', { status: 'SUCCESS' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(connection.connected).toBe(true)
    expect(sdk.streams).toHaveLength(1)
  })
  it('acknowledges only after successful reception; failure remains available for redelivery', async () => {
    const delivery = Promise.withResolvers<'stored'>(), receive = vi.fn<SourceContext['receive']>().mockReturnValueOnce(delivery.promise).mockRejectedValueOnce(new Error('storage failed'))
    mount(receive); await vi.advanceTimersByTimeAsync(0)
    const connection = sdk.streams[0]!
    connection.callback!(payload('first')); await vi.advanceTimersByTimeAsync(0)
    expect(connection.socketCallBackResponse).not.toHaveBeenCalled()
    delivery.resolve('stored'); await vi.advanceTimersByTimeAsync(0)
    expect(connection.socketCallBackResponse).toHaveBeenCalledWith('first', { status: 'SUCCESS' })
    connection.callback!(payload('second')); await vi.advanceTimersByTimeAsync(0)
    expect(connection.socketCallBackResponse).toHaveBeenCalledTimes(1)
  })
  it('bounds unacknowledged work, disconnects on disable, and stops reconnecting after disposal', async () => {
    const pending = Promise.withResolvers<'stored'>(), receive = vi.fn<SourceContext['receive']>().mockReturnValue(pending.promise), mounted = mount(receive)
    await vi.advanceTimersByTimeAsync(0)
    const connection = sdk.streams[0]!
    for (let i = 0; i < 40; i++) connection.callback!(payload(String(i)))
    expect(receive).toHaveBeenCalledTimes(32)
    mounted.disable(); pending.resolve('stored'); await vi.advanceTimersByTimeAsync(1000)
    expect(connection.disconnect).toHaveBeenCalled()
    await stop(); const count = sdk.streams.length; await vi.advanceTimersByTimeAsync(60000)
    expect(sdk.streams).toHaveLength(count)
  })
  it('retries a failed connection and recovers from a dropped socket', async () => {
    sdk.fail = true
    const mounted = mount(vi.fn(async () => 'stored' as const)); await vi.advanceTimersByTimeAsync(0)
    expect(mounted.health?.state).toBe('error')
    sdk.fail = false; await vi.advanceTimersByTimeAsync(5000)
    expect(mounted.health?.state).toBe('ready')
    sdk.streams.at(-1)!.connected = false; await vi.advanceTimersByTimeAsync(6000)
    expect(sdk.streams.length).toBeGreaterThanOrEqual(3)
    expect(mounted.health?.state).toBe('ready')
  })
})
it('patched published SDK cleans up an opening real loopback socket without an uncaught error', async () => {
  // This child imports the real installed SDK; the module mock above applies only to this Vitest process.
  const script = `
    import { createServer } from 'node:http';
    import { DWClient } from 'dingtalk-stream';
    const connection = Promise.withResolvers();
    const server = createServer();
    server.on('connection', socket => { socket.on('error', () => {}); connection.resolve(socket); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new DWClient({ clientId: 'synthetic', clientSecret: 'synthetic', autoReconnect: false });
    Reflect.set(client, 'dw_url', 'ws://127.0.0.1:' + server.address().port);
    void client._connect().catch(() => {});
    const socket = await connection.promise;
    client.disconnect();
    await new Promise(resolve => setTimeout(resolve, 20));
    socket.destroy(); await new Promise(resolve => server.close(resolve));
    process.stdout.write('socket-cleanup-ok');
  `
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 })
  expect(result.stdout).toContain('socket-cleanup-ok'); expect(result.stderr).not.toContain('Unhandled')
})
