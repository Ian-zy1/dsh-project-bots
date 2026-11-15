/** Owner review facts and their native Outbox handoff. */
import { key, latestAssignment, type ChannelRef, type OutboundMessage, type ReplyStatus, type Ticket } from '../core/index.ts'

type OwnerReportType = 'implementation.ready' | 'execution.blocked' | 'execution.failed'
export type OwnerReportEvent = {
  schemaVersion: 1
  type: OwnerReportType
  eventId: string
  phase: 'implement'
  projectId: string
  taskId: string
  revision: number
  ticketId: string
  assignmentId: string
  reportRef: string
  candidateSha?: string
}

/** Resolve an eligible origin to its outbound address and wire format using trusted configuration. */
export type OwnerReportRoute = (origin: ChannelRef) => {
  channel: ChannelRef
  format(event: OwnerReportEvent, title: string): { text: string; includesReadySummary?: true }
} | undefined

/** Build the fact independently of its channel or the Owner's session. */
export function ownerReportEvent(ticket: Ticket): OwnerReportEvent | undefined {
  const aw = ticket.execution?.aw
  if (aw?.phase !== 'implement') return undefined
  const assignment = latestAssignment(ticket)
  const report = assignment?.report
  if (!assignment || !report || (report.state !== 'ready' && report.state !== 'blocked' && report.state !== 'failed')) return undefined
  if (report.state === 'ready' && !report.candidateSha) return undefined
  const eventId = key('owner-report-v1', ticket.id, assignment.id, report.at, report.state, report.candidateSha ?? '')
  return { schemaVersion: 1, type: report.state === 'ready' ? 'implementation.ready' : `execution.${report.state}`,
    eventId, phase: aw.phase, projectId: aw.project.id, taskId: aw.taskId, revision: aw.revision, ticketId: ticket.id,
    assignmentId: assignment.id, reportRef: `ticket/${ticket.id}/result`, ...(report.candidateSha ? { candidateSha: report.candidateSha } : {}) }
}

export function ownerReportNotice(route: OwnerReportRoute, ticket: Ticket, origin?: ChannelRef): OutboundMessage | undefined {
  return ownerReportDelivery(route, ticket, origin)?.message
}

function ownerReportDelivery(route: OwnerReportRoute, ticket: Ticket, origin?: ChannelRef) {
  const event = ownerReportEvent(ticket)
  const target = event && origin && route(origin)
  if (!event || !target) return undefined
  const { text, includesReadySummary } = target.format(event, ticket.execution?.aw?.task.title ?? '')
  const message: OutboundMessage = { id: event.eventId, kind: 'notice', ticketId: event.ticketId, channel: target.channel, text }
  return { message, replacesReadyReply: includesReadySummary && event.type === 'implementation.ready' }
}

/** Use the same route for ready-report validation and for worker and system report publication. */
export function ownerReports(route: OwnerReportRoute, originOf: (ticket: Ticket) => ChannelRef | undefined,
  enqueue: (message: OutboundMessage) => void, receiptOf: (id: string) => { text: string; status: ReplyStatus } | undefined) {
  return {
    enabled(ticket: Ticket): boolean {
      if (ticket.execution?.aw?.phase !== 'implement') return false
      const origin = originOf(ticket)
      return !!(origin && route(origin))
    },
    publish(ticket: Ticket): void {
      const notice = ownerReportNotice(route, ticket, originOf(ticket))
      if (notice) enqueue(notice)
    },
    readyReply(ticket: Ticket) {
      const delivery = ownerReportDelivery(route, ticket, originOf(ticket))
      if (!delivery?.replacesReadyReply) return undefined
      const { id, text } = delivery.message
      const receipt = receiptOf(id)
      // Older, event-only receipts still need a human result. A dropped receipt is not a replacement.
      if (receipt?.text === text && receipt.status !== 'dropped') return { id, status: receipt.status, reused: true }
    },
  }
}
