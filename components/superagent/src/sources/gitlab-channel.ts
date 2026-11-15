/** GitLab note delivery with author-bound persisted remote markers for retry deduplication. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { gitlabApi, gitlabPages } from '../infra/gitlab.ts'
import type { SourceContext } from './host.ts'
import { objectPath, type GitlabObject } from './gitlab-model.ts'

export async function sendGitlab({ commands }: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const account = commands.deployment.gitlab, address = message.channel.address
  if (!account || address.host !== account.host || address.repository !== commands.deployment.repository
    || !['issue', 'merge_request'].includes(address.kind ?? '') || !/^[1-9][0-9]*$/.test(address.iid ?? '')) throw new Error('Invalid GitLab reply target')
  const path = `${objectPath(address.kind as GitlabObject, Number(address.iid))}/notes`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const notes = await gitlabPages(commands, z.object({ body: z.string(), author: z.object({ id: z.number() }) }), path)
    if (notes.some(note => note.author.id === account.userId && note.body.includes(marker))) return 'sent'
    await gitlabApi(commands, z.unknown(), path, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
