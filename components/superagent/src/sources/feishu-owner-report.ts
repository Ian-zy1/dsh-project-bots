/** Feishu routing and wire format for an Owner review event. */
import type { OwnerReportRoute } from '../app/owner-report.ts'
import type { OwnerDispatch } from '../app/owner-dispatch.ts'
import type { ChannelRef, OutboundMessage } from '../core/index.ts'
import { IM_WORDS, wordCount } from '../infra/text.ts'

const eventMarker = 'DSH_OWNER_EVENT_V1'

export function feishuOwnerDispatchNotice(ownerBot: string, event: OwnerDispatch, channel: ChannelRef): OutboundMessage {
  const summary = event.type === 'dispatch.accepted' ? 'DSH 已接单。'
    : event.type === 'dispatch.assessment_timeout' ? 'DSH 派活评估超时，未创建 Ticket。请核对原消息后再决定是否重试。'
    : event.reason === 'noRuleMatched' ? 'DSH 未接单：没有匹配的接单规则。'
    : event.reason === 'directionUnsettled' ? 'DSH 未接单：改动目标尚不明确。'
    : 'DSH 未接单：路由未识别到可执行的改动，请核对派活范围。'
  const text = `${summary}\n\n<at user_id="${ownerBot}">Owner</at>\n${eventMarker} ${JSON.stringify({ schemaVersion: 1, phase: 'implement', ...event })}`
  return { id: event.eventId, kind: 'notice', channel: { ...channel, address: { ...channel.address, textFormat: 'plain' } }, text }
}

export function feishuOwnerReportRoute(chatId?: string, botId?: string): OwnerReportRoute {
  return origin => {
    if (!chatId || !botId || origin.source !== 'feishu' || origin.address.chatId !== chatId) return undefined
    return {
      channel: { ...origin, address: { ...origin.address, textFormat: 'plain' } },
      format(event, title) {
        const wire = `<at user_id="${botId}">Owner</at>\n${eventMarker} ${JSON.stringify(event)}`
        if (event.type !== 'implementation.ready') return { text: wire }
        // Keep the first protocol marker and the only mention markup in the machine section.
        const label = [...title.replace(/[<>]/g, ' ').replaceAll(eventMarker, ' ').replace(/\s+/g, ' ').trim()].slice(0, 120).join('')
        const heading = `候选 ${event.candidateSha!.slice(0, 7)} 已交付`
        const tail = `。等待 Owner 复审。\n\n${wire}`
        const withTitle = `${heading}${label ? ` · ${label}` : ''}${tail}`
        if (wordCount(withTitle) <= IM_WORDS) return { text: withTitle, includesReadySummary: true }
        const short = heading + tail
        if (wordCount(short) <= IM_WORDS) return { text: short, includesReadySummary: true }
        return { text: wire }
      },
    }
  }
}
