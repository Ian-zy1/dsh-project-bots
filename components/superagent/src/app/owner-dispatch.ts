import { key, type ChannelRef, type DomainEvent, type OutboundMessage, type Trigger } from '../core/index.ts'
import { awDispatchRequest } from './aw.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

export type OwnerDispatch = {
  eventId: string
  type: 'dispatch.accepted' | 'dispatch.rejected' | 'dispatch.assessment_timeout'
  projectId: string
  taskId: string
  revision: number
  originMessageId: string
  ticketId?: string
  reason?: 'directionUnsettled' | 'noRuleMatched' | 'notActionable'
}

export function ownerDispatches(store: Pick<Store, 'decisions' | 'tickets' | 'triggers'>, effects: Effects, options: {
  destination: string
  projectId: string
  authorized(trigger: Trigger): boolean
  target(channel: ChannelRef): boolean
  belongs(event: OwnerDispatch): Promise<boolean>
  format(event: OwnerDispatch, channel: ChannelRef): OutboundMessage
  send(message: OutboundMessage): void
}) {
  effects.handle('ownerDispatch', async ({ destination, event, origin }) => {
    // The destination is fixed in the recorded channel and must still match the configured route.
    if (options.destination !== destination || !options.target(origin) || options.projectId !== event.projectId)
      throw Error('Restore the original Owner dispatch route')
    if (await options.belongs(event)) options.send(options.format(event, origin))
  })
  return (native: DomainEvent): Set<string> => {
    const recorded = new Set<string>()
    if (native.type !== 'ticket.created' && native.type !== 'decision.recorded') return recorded
    const { decisionId } = native.data
    const decision = store.decisions.get(decisionId)
    if (decision?.strength !== 'explicit') return recorded
    const ticket = native.type === 'ticket.created' ? store.tickets.get(native.data.ticketId) : undefined
    if (native.type === 'ticket.created' && !ticket) return recorded
    for (const triggerId of ticket ? [ticket.origin.triggerId] : decision.triggerIds) {
      const trigger = store.triggers.get(triggerId)
      const origin = trigger?.channel
      if (!trigger?.human || trigger.addressed !== 'mention' || !origin || !options.target(origin) || !options.authorized(trigger)) continue
      const originMessageId = origin.address.messageId
      if (!originMessageId || !/^om_[A-Za-z0-9]+$/.test(originMessageId)) continue
      let request
      try { request = awDispatchRequest(trigger) } catch { continue }
      if (request?.phase !== 'implement') continue
      const reasons = decision.reason.filter(reason => !reason.triggerId || reason.triggerId === triggerId)
      // Native attach and replay housekeeping are recorded as ignore without refusing work.
      if (reasons.some(reason => ['routed', 'startedTicket', 'acceptedBefore'].includes(reason.code))) continue
      const type = ticket ? 'dispatch.accepted' : decision.kind === 'ignore' ? 'dispatch.rejected'
        : decision.kind === 'unavailable' && reasons.some(reason => reason.code === 'timeout') ? 'dispatch.assessment_timeout' : undefined
      if (!type) continue
      const reason = type === 'dispatch.rejected' ? reasons.some(item => item.code === 'directionUnsettled') ? 'directionUnsettled'
        : reasons.some(item => item.code === 'noRuleMatched') ? 'noRuleMatched' : 'notActionable' : undefined
      const event: OwnerDispatch = { eventId: key('owner-dispatch-v1', trigger.id, decisionId, type), type, projectId: options.projectId,
        taskId: request.taskId, revision: request.revision, originMessageId,
        ...(ticket ? { ticketId: ticket.id } : {}), ...(reason ? { reason } : {}) }
      // Preserve native timeout liveness even when AW is down. A timeout carries no authority to bind a Ticket.
      if (type === 'dispatch.assessment_timeout') options.send(options.format(event, origin))
      else effects.enqueue('ownerDispatch', event.eventId, { destination: options.destination, event, origin })
      recorded.add(triggerId)
    }
    return recorded
  }
}
