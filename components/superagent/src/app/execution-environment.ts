/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { delimiter, join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_CODE_HOST', description: { zh: '当前代码平台，github或gitlab', en: 'Selected code host: github or gitlab' } },
  { key: 'DSH_SUPERAGENT_REPOSITORY', description: { zh: '当前仓库完整路径，与消息来源是否启用无关', en: 'Full repository path, independent of Source enablement' } },
  { key: 'DSH_SUPERAGENT_CLONE_URL', description: { zh: '当前仓库的HTTP(S)克隆地址', en: 'HTTP(S) clone URL of the selected repository' } },
  { key: 'DSH_SUPERAGENT_BASE_SHA', ticket: true, description: { zh: '任务固定基线的完整SHA', en: 'Resolved full commit SHA of the fixed task baseline' } },
  { key: 'DSH_SUPERAGENT_ENVIRONMENT', ticket: true, description: { zh: '此任务固定的工具链配置', en: 'Pinned toolchain profile for this ticket' } },
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；执行器 Session 在其中工作', en: 'This ticket\'s directory; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const executor: Record<string, string> = { DSH_SUPERAGENT_CODE_HOST: deployment.gitlab || deployment.git ? 'gitlab' : 'github',
    DSH_SUPERAGENT_REPOSITORY: deployment.repository, DSH_SUPERAGENT_CLONE_URL: (deployment.gitlab ?? deployment.git)?.cloneUrl ?? `https://github.com/${deployment.repository}.git`,
    DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  for (const { kind, environment, config } of sources.environments(settings)) {
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '' }
  const variables = environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
  const checkout = ticket.execution?.imDirect ?? ticket.execution?.aw
  const repository = checkout?.repository
  const fixed: Record<string, string> = { DSH_SUPERAGENT_BASE_SHA: checkout?.baseSha ?? '' }
  if (repository) {
    fixed.DSH_SUPERAGENT_REPOSITORY = new URL(repository.cloneUrl).pathname.slice(1, -4)
    fixed.DSH_SUPERAGENT_CLONE_URL = repository.cloneUrl
    fixed.DSH_SUPERAGENT_ENVIRONMENT = repository.environmentRef
    if (repository.provider) fixed.DSH_SUPERAGENT_CODE_HOST = repository.provider
  }
  for (const variable of variables) if (Object.hasOwn(fixed, variable.key)) variable.value = fixed[variable.key]!
  return variables
}
/** Private process arguments for workspace preparation and ticket-scoped shell integrations. */
export function repositoryEnvironment(ticket: Ticket): Record<string, string> {
  const checkout = ticket.execution?.imDirect ?? ticket.execution?.aw
  const repository = checkout?.repository
  if (!repository) return {}
  const author = ticket.execution?.imDirect?.author
  return { ...repository.variables, ...(author ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email } : {}), ...(repository.path.length ? { PATH: [...repository.path, process.env.PATH ?? ''].filter(Boolean).join(delimiter) } : {}),
    ...(repository.provider ? { DSH_SUPERAGENT_CODE_HOST: repository.provider, DSH_SUPERAGENT_GIT_ONLY: '1' } : {}),
    DSH_SUPERAGENT_ENVIRONMENT: repository.environmentRef, DSH_SUPERAGENT_BASE_SHA: checkout!.baseSha,
    DSH_SUPERAGENT_CLONE_URL: repository.cloneUrl, DSH_SUPERAGENT_REPOSITORY: new URL(repository.cloneUrl).pathname.slice(1, -4) }
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
