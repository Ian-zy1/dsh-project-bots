/** Stable GitLab identifiers and event normalization; Issue and MR IIDs belong to separate namespaces. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { mentions } from './github-trigger.ts'

export type GitlabAccount = NonNullable<Deployment['gitlab']>
export type GitlabObject = 'issue' | 'merge_request'
export const GitlabUser = z.object({ id: z.number().int().positive(), username: z.string(), bot: z.boolean().optional() })
export const GitlabItem = z.looseObject({ id: z.number().int().positive(), iid: z.number().int().positive(), title: z.string(), description: z.string().nullish(),
  author: GitlabUser, state: z.string(), created_at: z.string(), updated_at: z.string(), web_url: z.string().url(),
  source_branch: z.string().optional(), source_project_id: z.number().optional(), target_project_id: z.number().optional(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish() })
export const GitlabNote = z.looseObject({ id: z.number().int().positive(), body: z.string(), author: GitlabUser, system: z.boolean(), created_at: z.string(), updated_at: z.string() })
export type GitlabItemValue = z.infer<typeof GitlabItem>
export const objectPath = (kind: GitlabObject, iid: number) => `${kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}`
export const gitlabThread = (account: GitlabAccount, kind: GitlabObject, iid: number) => `${account.host}:${account.projectId}:${kind}:${iid}`
export function parseGitlabThread(account: GitlabAccount, id: string): { kind: GitlabObject; iid: number } | undefined {
  const prefix = `${account.host}:${account.projectId}:`
  if (!id.startsWith(prefix)) return undefined
  const match = /^(issue|merge_request):([1-9][0-9]*)$/.exec(id.slice(prefix.length))
  return match && Number.isSafeInteger(Number(match[2])) ? { kind: match[1] as GitlabObject, iid: Number(match[2]) } : undefined
}
export const gitlabChannel = (account: GitlabAccount, repository: string, kind: GitlabObject, iid: number, url?: string): ChannelRef => ({
  source: 'gitlab', thread: `gitlab:${gitlabThread(account, kind, iid)}`, address: { host: account.host, repository,
    kind, iid: String(iid), ...(url ? { url } : {}) },
})
export function gitlabTrigger(account: GitlabAccount, repository: string, kind: GitlabObject, item: GitlabItemValue, note?: z.infer<typeof GitlabNote>): Trigger | undefined {
  const user = (note ?? item).author
  // Preserve upstream self-account exclusion; shared human/agent accounts are outside this extension.
  if (user.id === account.userId || note?.system) return undefined
  const body = note?.body ?? item.description ?? ''
  const thread = gitlabThread(account, kind, item.iid)
  const url = note ? `${item.web_url}#note_${note.id}` : item.web_url
  return { id: key('gitlab', thread, note ? `note:${note.id}:${note.updated_at}` : 'opened'), source: 'gitlab',
    threads: [{ source: 'gitlab', id: thread }], actor: { source: 'gitlab', id: user.username }, human: !user.bot,
    at: note?.updated_at ?? item.created_at, text: note ? body : `${item.title}\n\n${body}`,
    ...(mentions(body, account.login) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(account, repository, kind, item.iid, url), url,
    meta: { host: account.host, repository, projectId: account.projectId, kind, iid: item.iid,
      ...(note ? { noteId: note.id, comment: true } : {}) } }
}
