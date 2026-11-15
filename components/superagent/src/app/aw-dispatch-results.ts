import { readFile } from 'node:fs/promises'
import { key } from '../core/index.ts'
import { awDispatchRequest } from './aw.ts'
import type { DispatchResultSink } from './dispatch-results.ts'

export function awDispatchSink(baseUrl: string, authorizationFile?: string,
  scope?: { projectId: string; contains(ref: { taskId: string; revision: number }, signal: AbortSignal): Promise<boolean> }): DispatchResultSink {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/')
  return {
    id: scope ? key('aw-dispatch-results', base.href, scope.projectId) : key('aw-dispatch-results', base.href),
    reference(trigger) {
      try {
        const ref = awDispatchRequest(trigger)
        if (ref) return { taskId: ref.taskId, revision: ref.revision }
      } catch { /* Malformed dispatch text must not interrupt the native transaction. */ }
      return undefined
    },
    async write(result, idempotencyKey, signal) {
      const { taskId, revision: taskRevision, outcome, occurredAt, sourceRef } = result
      if (scope && !await scope.contains(result, signal)) return
      const details = result.outcome === 'accepted' ? {
        summary: 'Superagent created a Ticket', ticketRef: result.ticketId,
      } : {
        summary: 'Superagent assessment timed out', nextAction: 'Check the original request before retrying',
      }
      let response: Response
      try {
        const authorization = authorizationFile ? (await readFile(authorizationFile, 'utf8')).trim() : undefined
        if (authorizationFile && !authorization) throw new Error('Empty authorization')
        response = await fetch(new URL(`api/v1/tasks/${encodeURIComponent(taskId)}/dispatch-records`, base), {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey,
            ...authorization ? { Authorization: authorization } : {} },
          body: JSON.stringify({ taskRevision, outcome, occurredAt, sourceRef, ...details }),
        })
      } catch { throw new Error('AW dispatch write failed; check the configured service and authorization') }
      await response.body?.cancel()
      if (!response.ok) throw new Error(`AW dispatch write failed (HTTP ${response.status})`)
    },
  }
}
