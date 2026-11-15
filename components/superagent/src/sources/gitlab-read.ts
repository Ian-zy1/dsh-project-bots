/** GitLab repository and Issue/MR context readers scoped to the configured project. */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import { gitlabApi, gitlabPages } from '../infra/gitlab.ts'
import { GitlabItem, GitlabNote, objectPath, type GitlabObject } from './gitlab-model.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

export async function readGitlabRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const normalized = parts.join('/')
  if (kind === 'file') {
    const file = await gitlabApi(commands, z.object({ content: z.string(), encoding: z.literal('base64') }), `repository/files/${encodeURIComponent(normalized)}?ref=HEAD`)
    return Buffer.from(file.content, 'base64').toString('utf8')
  }
  const entries = await gitlabPages(commands, z.object({ name: z.string() }), `repository/tree?path=${encodeURIComponent(normalized)}&ref=HEAD`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}
export const gitlabThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => trigger.meta.noteId ? `note:${trigger.meta.noteId}` : 'description',
  read: async (commands, trigger, part, cursor) => {
    const kind = trigger.meta.kind as GitlabObject, iid = Number(trigger.meta.iid)
    if (!['issue', 'merge_request'].includes(kind) || !Number.isSafeInteger(iid) || iid <= 0) throw new Error('Invalid GitLab context target')
    const account = commands.deployment.gitlab
    if (!account || trigger.meta.host !== account.host || trigger.meta.projectId !== account.projectId) throw new Error('GitLab context belongs to another project')
    const path = objectPath(kind, iid)
    const item = await gitlabApi(commands, GitlabItem, path)
    const root: ContextMessage = { id: 'description', from: item.author.username, at: item.created_at,
      text: `${item.title}\n\n${item.description ?? ''}`, ...(item.author.bot ? { bot: true } : {}), url: item.web_url }
    if (part === 'root' || part === 'parent') return { messages: [root], body: { messages: [root] } }
    const page = cursor === undefined ? 1 : Number(cursor)
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid GitLab context cursor')
    const notes = await gitlabApi(commands, z.array(GitlabNote), `${path}/notes?sort=asc&order_by=created_at&per_page=50&page=${page}`)
    const messages = [...page === 1 ? [root] : [], ...notes.filter(note => !note.system).map(note => ({ id: `note:${note.id}`, from: note.author.username,
      at: note.created_at, text: note.body, ...(note.author.bot || note.author.id === account.userId ? { bot: true as const } : {}) }))]
    return { messages, ...(notes.length === 50 ? { next: String(page + 1) } : {}), body: { messages } }
  },
}

/** Reads only documented GitLab resources; arbitrary API paths and writes are unavailable through this entry. */
export async function readGitlabResource(commands: Commands, resource: string): Promise<unknown> {
  const path = /^(file|directory)\/(.*)$/.exec(resource)
  if (path) return readGitlabRepositoryPath(commands, path[2]!, path[1] as 'file' | 'directory')
  const object = /^(issues|merge_requests)\/([1-9][0-9]*)(\/notes)?$/.exec(resource)
  if (!object) throw new Error('Unknown GitLab resource; use issues/<iid>, merge_requests/<iid>, file/<path> or directory/<path>')
  return object[3] ? gitlabPages(commands, GitlabNote, resource) : gitlabApi(commands, GitlabItem, resource)
}
