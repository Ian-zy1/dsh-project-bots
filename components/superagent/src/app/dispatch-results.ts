/** Durable dispatch facts from the native domain events. */
import { key, type DomainEvent, type Trigger } from '../core/index.ts'
import type { Effects } from './effects.ts'
import type { Store } from './store.ts'

type TaskRef = { taskId: string; revision: number }
type DispatchOutcome = { outcome: 'accepted'; ticketId: string } | { outcome: 'assessment_timeout' }
export type DispatchResult = TaskRef & DispatchOutcome & { occurredAt: string; sourceRef: string }

export interface DispatchResultSink {
  /** Stable destination identity, independent of credential rotation. */
  id: string
  /** Pure recognition. Return undefined for unsupported or malformed input. */
  reference(trigger: Trigger): TaskRef | undefined
  write(result: DispatchResult, idempotencyKey: string, signal: AbortSignal): Promise<void>
}

export function dispatchResults(store: Pick<Store, 'decisions' | 'tickets' | 'triggers'>, effects: Effects,
  sink: DispatchResultSink, authorized: (trigger: Trigger) => boolean, signal: AbortSignal): (event: DomainEvent) => void {
  effects.handle('dispatchResult', ({ destination, result }, id) => {
    if (destination !== sink.id) throw new Error('Restore the original dispatch-result destination to resume delivery')
    return sink.write(result, id, signal)
  })
  const enqueue = (decisionId: string, triggerId: string, occurredAt: string, outcome: DispatchOutcome) => {
    const trigger = store.triggers.get(triggerId)
    if (!trigger?.human || !trigger.addressed || !authorized(trigger)) return
    const reference = sink.reference(trigger)
    if (!reference) return
    const result: DispatchResult = { ...reference, ...outcome, occurredAt, sourceRef: `${trigger.source}:trigger/${trigger.id}` }
    effects.enqueue('dispatchResult', key('dispatch-result', decisionId, triggerId), { destination: sink.id, result })
  }
  return event => {
    if (event.type === 'ticket.created' && event.data.strength === 'explicit') {
      const ticket = store.tickets.get(event.data.ticketId)
      if (ticket) enqueue(event.data.decisionId, ticket.origin.triggerId, ticket.createdAt, { outcome: 'accepted', ticketId: ticket.id })
    }
    if (event.type === 'decision.recorded' && event.data.kind === 'unavailable') {
      const decision = store.decisions.get(event.data.decisionId)
      if (decision?.strength !== 'explicit') return
      const timeouts = decision.reason.filter(reason => reason.code === 'timeout')
      for (const triggerId of decision.triggerIds) {
        if (timeouts.some(reason => !reason.triggerId || reason.triggerId === triggerId)) {
          enqueue(decision.id, triggerId, decision.at, { outcome: 'assessment_timeout' })
        }
      }
    }
  }
}
