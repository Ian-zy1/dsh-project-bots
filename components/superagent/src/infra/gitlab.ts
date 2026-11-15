/** Project-scoped GitLab API transport using the deployment's authenticated glab executable. */
import { z } from 'zod'
import type { Commands } from './commands.ts'

/** Rejects URL, traversal, query and fragment escapes before building a project-relative GitLab route. */
export function gitlabPath(commands: Commands, path: string): string {
  const account = commands.deployment.gitlab
  if (!account) throw new Error('GitLab API is not enabled; Git/AW development does not require it.')
  const resource = path.split('?')[0]!
  // Decode once for validation, then reject any nested escapes. Query values are constructed by our adapters.
  let decoded: string
  try { decoded = decodeURIComponent(resource) } catch { throw new Error('Invalid GitLab API path') }
  if (/^[\\/]|[:#\\]|%|(^|\/)\.{1,2}(\/|$)/.test(decoded) || /[\r\n#]/.test(path)) throw new Error('GitLab calls are restricted to the configured project')
  return `projects/${account.projectId}${path ? `/${path}` : ''}`
}
/** Calls only the configured project's REST API, validating its response. No credentials are passed in argv. */
export async function gitlabApi<T>(commands: Commands, schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T> {
  const account = commands.deployment.gitlab
  const route = gitlabPath(commands, path)
  const output = await commands.run(account!.cli, ['api', '--hostname', account!.host, route, ...flags])
  return schema.parse(JSON.parse(output))
}
/** Reads a bounded, explicit page sequence; an incomplete list fails rather than advancing an ingestion cursor. */
export async function gitlabPages<T>(commands: Commands, schema: z.ZodType<T>, path: string, maxPages = 100): Promise<T[]> {
  const items: T[] = []
  for (let page = 1; page <= maxPages; page++) {
    const batch = await gitlabApi(commands, z.array(schema), `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    items.push(...batch)
    if (batch.length < 100) return items
  }
  throw new Error('GitLab pagination limit reached; cursor was not advanced')
}
