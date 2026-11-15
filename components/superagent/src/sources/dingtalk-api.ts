/** DingTalk robot HTTPS transport. Secrets are read only by this host-side adapter, never stored in Source settings. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'

export const DingtalkConfigSchema = z.object({
  clientId: z.string().trim().default(''), robotCode: z.string().trim().default(''), corpId: z.string().trim().default(''),
  clientSecretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*(?:SECRET|TOKEN)$/).default('DINGTALK_CLIENT_SECRET'),
  conversations: z.array(z.object({ id: z.string().min(1) }).strict()).default([]),
  allowDirect: z.boolean().default(true),
}).strict()
export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>
export type HttpFetch = typeof globalThis.fetch
/** Access token and credentials stay in memory; failures never include request URLs, tokens or platform response bodies. */
export class DingtalkApi {
  private token?: { value: string; until: number; clientId: string; secret: string }
  constructor(private readonly config: () => DingtalkConfig | undefined, private readonly signal: AbortSignal,
    private readonly request: HttpFetch = globalThis.fetch, private readonly env: NodeJS.ProcessEnv = process.env) {}
  credentials(): { clientId: string; clientSecret: string } {
    const config = this.config(), secret = config && this.env[config.clientSecretEnv]
    if (!config?.clientId || !config.robotCode || !config.corpId || !secret) throw new Error('Configure DingTalk client ID, robot code, corporation and secret environment reference')
    return { clientId: config.clientId, clientSecret: secret }
  }
  private async post(path: string, body: unknown, token?: string): Promise<unknown> {
    const response = await this.request(`https://api.dingtalk.com${path}`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(15000)]), headers: { 'content-type': 'application/json', ...(token ? { 'x-acs-dingtalk-access-token': token } : {}) },
      body: JSON.stringify(body) }).catch(() => { throw new Error('DingTalk request failed or timed out; delivery may be unconfirmed') })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.token = undefined
      throw new Error(`DingTalk request failed (HTTP ${response.status})`)
    }
    try { return await response.json() } catch { throw new Error('DingTalk returned an invalid response') }
  }
  private async accessToken(): Promise<string> {
    const credentials = this.credentials()
    if (this.token && this.token.until > Date.now() && this.token.clientId === credentials.clientId && this.token.secret === credentials.clientSecret) return this.token.value
    const result = z.object({ accessToken: z.string().min(1), expireIn: z.number().positive() }).parse(await this.post('/v1.0/oauth2/accessToken',
      { appKey: credentials.clientId, appSecret: credentials.clientSecret }))
    this.token = { value: result.accessToken, until: Date.now() + Math.max(0, result.expireIn - 60) * 1000, clientId: credentials.clientId, secret: credentials.clientSecret }
    return result.accessToken
  }
  /** Known successes are settled by Outbox; DingTalk robot endpoints do not provide an idempotency key, so ambiguous retries may duplicate. */
  async send(message: OutboundMessage): Promise<'sent'> {
    const config = this.config(), address = message.channel.address
    if (!config || address.corp !== config.corpId || address.robot !== config.robotCode || !address.conversation
      || (address.direct === 'true' ? !config.allowDirect || !address.staff : !config.conversations.some(item => item.id === address.conversation))) throw new Error('DingTalk reply destination is no longer allowed')
    const token = await this.accessToken()
    const text = `${message.text}${message.ticketId ? `\n\n任务：${message.ticketId}\n继续此任务：反馈 ${message.ticketId} 内容` : ''}`
    const payload = { robotCode: config.robotCode, msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 'SuperAgent', text }) }
    const result = await this.post(address.direct === 'true' ? '/v1.0/robot/oToMessages/batchSend' : '/v1.0/robot/groupMessages/send', {
      ...payload, ...(address.direct === 'true' ? { userIds: [address.staff] } : { openConversationId: address.conversation }),
    }, token)
    const response = z.object({ processQueryKey: z.string().min(1), invalidStaffIdList: z.array(z.string()).optional(), flowControlledStaffIdList: z.array(z.string()).optional() }).safeParse(result)
    if (!response.success || response.data.invalidStaffIdList?.length || response.data.flowControlledStaffIdList?.length) throw new Error('DingTalk did not confirm delivery to the destination')
    return 'sent'
  }
}
