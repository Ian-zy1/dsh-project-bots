/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
const BindingId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const AwRepository = z.object({
  repositoryUrl: z.string().url(),
  provider: z.enum(['github', 'gitlab']).optional(),
  credentialFile: z.string().regex(/^\/[^\r\n\0]*$/).optional(),
  environmentRef: BindingId,
  environment: z.object({
    path: z.array(z.string().regex(/^\/[^:\r\n\0]*$/)).min(1),
    executables: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)).min(1),
    variables: z.partialRecord(z.enum(['JAVA_HOME', 'MAVEN_HOME', 'MAVEN_OPTS', 'NODE_HOME', 'PNPM_HOME', 'GOCACHE', 'GOMODCACHE', 'npm_config_cache']), z.string().min(1)).default({}),
  }).strict(),
}).strict()
export type AwRepository = z.infer<typeof AwRepository>
const ImDirectRepository = AwRepository.extend({
  provider: z.enum(['github', 'gitlab']),
  senderId: z.string().regex(/^ou_[A-Za-z0-9]+$/),
  author: z.object({ name: z.string().trim().min(1).max(120).regex(/^[^<>\r\n\0]+$/), email: z.email() }).strict(),
  branch: z.string().regex(/^(?!-)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
    .refine(value => !value.includes('..'), 'Use a Git branch name'),
})
export type ImDirectRepository = z.infer<typeof ImDirectRepository>
export const cleanRepository = (value: string): string => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('AW repository must be a clean HTTP(S) URL')
  return url.origin + url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')
}
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  expectedFeishuAppId: s.string().pattern(/^cli_[A-Za-z0-9]+$/).description('Expected Feishu publishing and intake application for this instance.'),
  ownerReportBotId: s.string().pattern(/^ou_[A-Za-z0-9]+$/).description('Optional Owner consumer bot ID in the publishing app; requires ownerReportChatId. No Codex endpoint.'),
  ownerReportChatId: s.string().pattern(/^oc_[A-Za-z0-9]+$/).description('Only this Feishu group publishes structured AW implementation reports; optional and disabled when absent.'),
  ownerDispatchEvents: s.boolean().description('Publish Owner dispatch decisions to the configured Feishu group; enable after Relay is upgraded.'),
  imDirect: s.any().description('Opt-in Feishu direct work. One manually configured Git repository, branch and toolchain.'),
  awBaseUrl: s.string().description('Configured Agent Workboard service base URL; optional. Dispatch messages cannot override it.'),
  awProjectId: s.string().description('AW project assigned to this instance.'),
  awRepositories: s.any().description('Allowed AW repositories and their versioned execution environments.'),
  awAccessTokenEnv: s.string().description('Optional host environment variable holding the AW bearer token; never a token value.'),
  awDispatchWriteUrl: s.string().description('Optional trusted AW writer base URL, separate from the worker read endpoint.'),
  awDispatchAuthorizationFile: absolute('Optional file containing the HTTP Authorization header for the AW writer.'),
  publicWebOrigin: s.string().description('Exact HTTP(S) browser origin of an authenticated reverse proxy; optional.'),
  repositoryProvider: s.union(['github', 'gitlab']).default('github').description('Code hosting provider for this deployment; IM Sources are independent.'),
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  expectedFeishuAppId?: string
  ownerReportBotId?: string
  ownerReportChatId?: string
  ownerDispatchEvents?: boolean
  imDirect?: ImDirectRepository
  awBaseUrl?: string
  awProjectId?: string
  awRepositories?: Record<string, AwRepository>
  awAccessTokenEnv?: string
  awDispatchWriteUrl?: string
  awDispatchAuthorizationFile?: string
  publicWebOrigin?: string
  repositoryProvider?: 'github' | 'gitlab'
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  if (!!config.ownerReportBotId !== !!config.ownerReportChatId) throw new Error('Set both ownerReportBotId and ownerReportChatId, or neither')
  if (config.ownerDispatchEvents && (!config.ownerReportBotId || !config.awProjectId || !config.awBaseUrl))
    throw new Error('ownerDispatchEvents requires the Owner report route and AW project binding')
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  for (const [name, value] of Object.entries({ awBaseUrl: config.awBaseUrl, awDispatchWriteUrl: config.awDispatchWriteUrl })) {
    if (!value) continue
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${name} must be an HTTP(S) service URL without credentials or query`)
  }
  if (config.awDispatchAuthorizationFile && !config.awDispatchWriteUrl) throw new Error('awDispatchAuthorizationFile requires awDispatchWriteUrl')
  if (config.awAccessTokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.awAccessTokenEnv)) throw new Error('awAccessTokenEnv must name an environment variable')
  const awRepositories = config.awRepositories === undefined ? undefined : z.record(BindingId, AwRepository).parse(config.awRepositories)
  if (config.awProjectId !== undefined) BindingId.parse(config.awProjectId)
  if (config.awProjectId || awRepositories) {
    if (!config.awProjectId || !awRepositories || !Object.keys(awRepositories).length || !config.awBaseUrl)
      throw new Error('AW project routing requires awProjectId, awRepositories and awBaseUrl')
    const repositories = new Set<string>()
    for (const entry of Object.values(awRepositories)) {
      const url = cleanRepository(entry.repositoryUrl)
      if (!entry.provider && (entry.credentialFile || config.repositoryProvider === 'gitlab' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url)))
        throw new Error('Specify a repository provider for Git transport; legacy entries require github.com')
      if (entry.provider && !/^(?:\/[\w.-]+){2,}$/.test(new URL(url).pathname))
        throw new Error('AW repository path must name at least an owner and repository')
      if (repositories.has(url)) throw new Error('Configure each repository URL only once')
      repositories.add(url)
    }
  }
  const imDirect = config.imDirect === undefined ? undefined : ImDirectRepository.parse(config.imDirect)
  if (imDirect) {
    const url = cleanRepository(imDirect.repositoryUrl)
    if (!/^(?:\/[\w.-]+){2,}$/.test(new URL(url).pathname)) throw new Error('IM direct repository must name an owner and repository')
    for (const entry of Object.values(awRepositories ?? {})) {
      if (cleanRepository(entry.repositoryUrl) === url && entry.credentialFile !== imDirect.credentialFile)
        throw new Error('IM direct and AW must use the same credential file for the same repository')
    }
  }
  if (config.publicWebOrigin) {
    const origin = new URL(config.publicWebOrigin)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== config.publicWebOrigin || origin.username || origin.password) throw new Error('publicWebOrigin must be an exact HTTP(S) origin without path or credentials')
  }
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs,
    ...(config.expectedFeishuAppId ? { expectedFeishuAppId: config.expectedFeishuAppId } : {}),
    ...(config.ownerReportBotId ? { ownerReportBotId: config.ownerReportBotId, ownerReportChatId: config.ownerReportChatId } : {}),
    ...(config.ownerDispatchEvents ? { ownerDispatchEvents: true } : {}),
    ...(config.awBaseUrl ? { awBaseUrl: config.awBaseUrl, ...(config.awAccessTokenEnv ? { awAccessTokenEnv: config.awAccessTokenEnv } : {}) } : {}),
    ...(imDirect ? { imDirect } : {}),
    ...(awRepositories ? { awProjectId: config.awProjectId, awRepositories } : {}),
    ...(config.awDispatchWriteUrl ? { awDispatchWriteUrl: config.awDispatchWriteUrl, awDispatchAuthorizationFile: config.awDispatchAuthorizationFile } : {}),
    ...(config.publicWebOrigin ? { publicWebOrigin: config.publicWebOrigin } : {}), ...(config.repositoryProvider === 'gitlab' ? { repositoryProvider: 'gitlab' as const } : {}) }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const GitlabAccountsSchema = z.object({
  apiEnabled: z.boolean().default(true),
  credentialFile: z.string().trim().default(''),
  protocol: z.enum(['http', 'https']).default('https'),
  host: z.string().trim().regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$/).default('gitlab.com'),
  repository: z.string().trim().regex(/^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/).or(z.literal(''))
    .refine(value => !value.split('/').some(part => part === '.' || part === '..'), 'Repository path cannot contain dot segments').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { dingtalk: ['clientId', 'robotCode', 'corpId', 'clientSecretEnv'], gitlab: Object.keys(GitlabAccountsSchema.shape), github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  /** Git transport without a code-host API identity. Credentials stay in the host's private file. */
  git?: { protocol: 'http' | 'https'; host: string; cloneUrl: string; defaultBranch: string; credentialFile?: string }
  github?: { cli: string; login: string; noreply: string }
  gitlab?: { protocol?: 'http' | 'https'; cli: string; login: string; userId: number; host: string; projectId: number; webUrl: string; cloneUrl: string; defaultBranch: string }
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name && !machine.expectedFeishuAppId) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  if (!name) return fail(new Error('No Feishu CLI is configured for the expected app'))
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (machine.expectedFeishuAppId && status.appId !== machine.expectedFeishuAppId)
    return fail(new Error('Configured Feishu CLI does not match the expected application'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}

/** Requires the GitHub account for a GitHub-only operation. */
export function githubAccount(deployment: Pick<Deployment, 'github'>): NonNullable<Deployment['github']> {
  if (!deployment.github) throw new Error('This deployment uses GitLab, not GitHub')
  return deployment.github
}

/** Checks the configured GitLab identity and Developer-or-higher project membership using its isolated glab CLI. */
export async function resolveGitlabDeployment(machine: Machine, config: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const account = GitlabAccountsSchema.parse(config ?? {})
  if (!account.apiEnabled) {
    if (!account.repository) throw new SetupError('gitlabSetup', { output: 'Set the Git repository path.' })
    const cloneUrl = `${account.protocol}://${account.host}/${account.repository}.git`
    try {
      if (account.credentialFile && (!isAbsolute(account.credentialFile) || !statSync(account.credentialFile).isFile())) throw new Error('Invalid credential file')
      const helper = account.credentialFile ? `store --file='${account.credentialFile.replaceAll("'", "'\\''")}'` : ''
      const refs = await probe(['git', '-c', 'credential.helper=', '-c', `credential.${account.protocol}://${account.host}.helper=`, '-c', `credential.${account.protocol}://${account.host}.helper=${helper}`,
        '-c', 'credential.useHttpPath=true', 'ls-remote', '--symref', '--', cloneUrl, 'HEAD'])
      const branch = /^ref: refs\/heads\/(.+)\s+HEAD$/m.exec(refs)?.[1]
      if (!branch || !/^[a-f0-9]{40}\s+HEAD$/m.test(refs)) throw new Error('No remote HEAD')
      return { ...machine, repository: account.repository, git: { protocol: account.protocol, host: account.host, cloneUrl, defaultBranch: branch,
        ...(account.credentialFile ? { credentialFile: account.credentialFile } : {}) } }
    } catch { throw new SetupError('gitlabSetup', { output: 'Git access failed. Verify the repository, protocol and optional private credentialFile; GitLab API login is not required.' }) }
  }
  if (!account.repository || !account.cli) throw new SetupError('gitlabSetup', { output: 'Set the GitLab repository and agent glab CLI.' })
  try {
    const cli = executable(account.cli, path, workerBin(machine.stateDir))
    const api = async (route: string) => JSON.parse(await probe(['env', `GLAB_API_PROTOCOL=${account.protocol}`, `API_PROTOCOL=${account.protocol}`,
      `GITLAB_HOST=${account.host}`, `GITLAB_API_HOST=${account.host}`, cli, 'api', '--hostname', account.host, route])) as unknown
    const user = z.object({ id: z.number().int().positive(), username: z.string().min(1) }).parse(await api('user'))
    const permission = z.object({ access_level: z.number() }).nullish()
    const project = z.object({ id: z.number().int().positive(), path_with_namespace: z.string(), web_url: z.string().url(),
      http_url_to_repo: z.string().url(), default_branch: z.string().min(1), archived: z.boolean().default(false),
      permissions: z.object({ project_access: permission, group_access: permission }) }).parse(await api(`projects/${encodeURIComponent(account.repository)}`))
    const urls = [new URL(project.web_url), new URL(project.http_url_to_repo)]
    if (urls.some(url => url.protocol !== `${account.protocol}:` || url.host !== account.host || url.username || url.password || url.search || url.hash)) throw new Error('GitLab returned a repository outside the configured origin')
    if (urls[0]!.pathname !== `/${project.path_with_namespace}` || urls[1]!.pathname !== `/${project.path_with_namespace}.git`) throw new Error('GitLab returned a different repository URL')
    if (project.path_with_namespace.toLowerCase() !== account.repository.toLowerCase()) throw new Error('GitLab returned a different project')
    const access = Math.max(project.permissions.project_access?.access_level ?? 0, project.permissions.group_access?.access_level ?? 0)
    if (access < 30 || project.archived) throw new Error('The GitLab agent needs Developer or higher access to a non-archived project')
    return { ...machine, repository: project.path_with_namespace, gitlab: { ...(account.protocol === 'http' ? { protocol: 'http' as const } : {}), cli, login: user.username, userId: user.id, host: account.host,
      projectId: project.id, webUrl: project.web_url, cloneUrl: project.http_url_to_repo, defaultBranch: project.default_branch } }
  } catch { throw new SetupError('gitlabSetup', { output: 'Verify the configured glab executable, protocol, host, signed-in account and project push permission.' }) }
}
