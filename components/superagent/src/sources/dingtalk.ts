/** Optional DingTalk Stream Source: explicit IM requests and task-bound feedback using native Ticket/Policy/Outbox. */
import type { Context } from '@deepseek-ai/cordis'
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { sourceContext, health, type SourceContext, type SourceHost } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'
import { DingtalkApi, DingtalkConfigSchema, type DingtalkConfig } from './dingtalk-api.ts'
export { DingtalkConfigSchema } from './dingtalk-api.ts'

export const RobotMessage = z.looseObject({ msgId: z.string().min(1), conversationId: z.string().min(1), conversationType: z.enum(['1', '2']),
  senderStaffId: z.string().min(1), senderCorpId: z.string().min(1), chatbotCorpId: z.string().optional(), robotCode: z.string().optional(),
  isInAtList: z.boolean().default(false), createAt: z.number().int().positive(), msgtype: z.string(), text: z.object({ content: z.string() }).optional() })
export type RobotMessageValue = z.infer<typeof RobotMessage>
export function dingtalkTrigger(message: RobotMessageValue, config: DingtalkConfig, feedback?: Trigger): Trigger | undefined {
  if (message.senderCorpId !== config.corpId || (message.chatbotCorpId && message.chatbotCorpId !== config.corpId)
    || (message.robotCode && message.robotCode !== config.robotCode) || message.msgtype !== 'text' || !message.text?.content.trim()) return undefined
  const direct = message.conversationType === '1'
  if (direct ? !config.allowDirect : !message.isInAtList || !config.conversations.some(item => item.id === message.conversationId)) return undefined
  const thread = feedback?.threads[0]?.id ?? `${config.corpId}:${message.conversationId}:${message.msgId}`
  return { id: key('dingtalk', config.clientId, config.corpId, message.msgId), source: 'dingtalk', threads: [{ source: 'dingtalk', id: thread }],
    actor: { source: 'dingtalk', id: message.senderStaffId }, human: true, addressed: direct ? 'direct' : 'mention',
    at: new Date(message.createAt).toISOString(), text: message.text.content.trim(),
    channel: { source: 'dingtalk', thread: `dingtalk:${thread}`, address: { corp: config.corpId, robot: config.robotCode,
      conversation: message.conversationId, direct: String(direct), staff: message.senderStaffId } },
    meta: { corp: config.corpId, robot: config.robotCode, conversation: message.conversationId, direct, messageId: message.msgId } }
}
export function createDingtalkKind(api: Pick<DingtalkApi, 'send'>): SourceKind<DingtalkConfig> {
  return {
    kind: 'dingtalk', title: { zh: '钉钉', en: 'DingTalk' },
    description: { zh: 'Stream机器人单聊及白名单群@派活；反馈使用“反馈 TicketID 内容”。', en: 'Stream robot DMs and mentions in allowed groups. Continue a task with: 反馈 TicketID message.' },
    schema: DingtalkConfigSchema, health: ['dingtalk'],
    fields: [ ...[['clientId', '应用Client ID', 'Application client ID'], ['robotCode', '机器人代码', 'Robot code'], ['corpId', '企业ID', 'Corporation ID'],
      ['clientSecretEnv', '密钥环境变量名', 'Secret environment variable name']].map(([key, zh, en]) => ({ key: key!, type: 'text' as const, label: { zh: zh!, en: en! } })),
      { key: 'allowDirect', type: 'switch', label: { zh: '接收单聊', en: 'Receive direct messages' } },
      { key: 'conversations', type: 'rows', label: { zh: '允许的群会话', en: 'Allowed group conversations' }, columns: [{ key: 'id', type: 'text', label: { zh: '会话ID', en: 'Conversation ID' } }] } ],
    scope: ({ meta }, config) => meta.corp === config.corpId && meta.robot === config.robotCode
      && (meta.direct === true ? config.allowDirect : config.conversations.some(item => item.id === meta.conversation))
      ? { listened: true, observed: false } : { listened: false, reason: 'dingtalk_conversation_not_listened' },
    channel: { allowed: (address, config) => address.corp === config.corpId && address.robot === config.robotCode
      && (address.direct === 'true' ? config.allowDirect : config.conversations.some(item => item.id === address.conversation)),
      send: (_host, message) => api.send(message), link: () => ({ url: '', label: { zh: '钉钉会话', en: 'DingTalk conversation' } }) },
    policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1) }).strict()).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '允许派活的钉钉成员', en: 'DingTalk staff allowed to originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '成员Staff ID', en: 'Staff ID' } }] }],
      explicit: { zh: '允许成员向机器人发单聊或在允许群聊中@机器人。', en: 'An allowed staff member sends a DM or mentions the robot in an allowed group.' } },
  }
}
/** Persists reception before ACK. Feedback can only join an existing task in this exact conversation and corporation. */
export async function receiveDingtalk(source: SourceContext, host: SourceHost, message: RobotMessageValue, config: DingtalkConfig): Promise<void> {
  let feedback: Trigger | undefined
  const request = /^反馈\s+([a-f0-9]{32})\s+\S/.exec(message.text?.content.trim() ?? '')
  if (request) {
    const ticket = source.tickets.get(request[1]!), origin = ticket && source.triggers.get(ticket.origin.triggerId)
    const allowed = host.sources.policyPart('dingtalk')?.allowed.some(person => person.id === message.senderStaffId)
    if (!allowed || origin?.source !== 'dingtalk' || origin.meta.corp !== config.corpId || origin.meta.robot !== config.robotCode
      || origin.meta.conversation !== message.conversationId) return
    feedback = origin
  }
  const trigger = dingtalkTrigger(message, config, feedback)
  if (trigger) await source.receive(trigger)
}
export const name = 'dsh-superagent-dingtalk'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  const host = ctx.orchestrator as SourceHost, controller = new AbortController()
  let source: SourceContext, client: DWClient | undefined
  const callbacks = new Set<Promise<void>>()
  const config = () => source.config<DingtalkConfig>('dingtalk')
  const api = new DingtalkApi(config, controller.signal)
  const kind = createDingtalkKind(api)
  ctx.effect(() => host.sources.register(kind), 'dingtalk: source kind')
  source = sourceContext(host, kind)
  ctx.effect(() => {
    const running = (async () => {
      await source.ready
      while (!controller.signal.aborted) {
        const current = config()
        // Stream reception persists triggers even while repository setup keeps native processing paused.
        if (!current) { source.report('dingtalk', health('paused', 'sourceOff')); await pause(1000, controller.signal); continue }
        let connection: DWClient | undefined
        try {
          const options = { ...api.credentials(), autoReconnect: false, keepAlive: true, debug: false, subscriptions: [] }
          connection = client = new DWClient(options)
          const active = connection
          // SDK callbacks return void; handle asynchronous persistence explicitly and ACK only after success.
          active.registerCallbackListener(TOPIC_ROBOT, envelope => {
            if (callbacks.size >= 32) return // Leave excess messages unacknowledged for server redelivery.
            const pending = (async () => {
              if (controller.signal.aborted || client !== active || !config()) return
              const parsed = RobotMessage.safeParse(JSON.parse(envelope.data))
              if (parsed.success) await receiveDingtalk(source, host, parsed.data, config()!)
              if (!controller.signal.aborted && client === active) {
                active.socketCallBackResponse(envelope.headers.messageId, { status: 'SUCCESS' })
                source.report('dingtalk', { state: 'ready', detail: 'DingTalk Stream connected' })
              }
          })().catch(() => { source.report('dingtalk', { state: 'error', detail: 'DingTalk message could not be persisted; awaiting redelivery' }) })
          callbacks.add(pending)
          void pending.then(() => { callbacks.delete(pending) })
        })
        const connecting = active.connect()
        await Promise.race([connecting, pause(30000, controller.signal)])
        if (!active.connected) throw new Error('DingTalk connection unavailable')
        source.report('dingtalk', { state: 'ready', detail: 'DingTalk Stream connected' })
        const snapshot = JSON.stringify(current)
        while (!controller.signal.aborted && active.connected && JSON.stringify(config()) === snapshot) await pause(1000, controller.signal)
      } catch { if (!controller.signal.aborted) source.report('dingtalk', { state: 'error', detail: 'DingTalk Stream unavailable; verify configuration and network' }) }
      finally { connection?.disconnect(); if (client === connection) client = undefined }
      await pause(5000, controller.signal)
    }
    })().catch(() => { source.report('dingtalk', { state: 'error', detail: 'DingTalk source stopped unexpectedly' }) })
    return async () => { controller.abort(); client?.disconnect(); await running; await Promise.allSettled(callbacks) }
  })
}
