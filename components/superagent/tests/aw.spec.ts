import { afterEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AwClient, awInstructions, awRequest, gitBaseline, prepareAwWorkspace, verifyAwBinding, verifyAwToolchain, verifyAwWorkspace } from '../src/app/aw.ts'
import { Config, machineOf, resolveGitlabDeployment, type Deployment } from '../src/deployment.ts'
import { repositoryEnvironment } from '../src/app/execution-environment.ts'
import { Commands } from '../src/infra/commands.ts'
import { credentialHelper, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { Store } from '../src/app/store.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Ticket } from '../src/core/index.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'
import { feishuTrigger } from '../src/sources/feishu.ts'
import { dingtalkTrigger, RobotMessage } from '../src/sources/dingtalk.ts'
import { DingtalkConfigSchema } from '../src/sources/dingtalk-api.ts'

const exec = promisify(execFile), directories: string[] = [], servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), 'sa-aw-')); directories.push(dir); return dir }
it.each(['http', 'https'] as const)('uses explicitly configured %s for API, clone, worker CLI and git helper', async protocol => {
  const dir = temporary(), host = 'git.example.test:8080', path = 'team/sub/repo'
  const project = { id: 7, path_with_namespace: path, web_url: `${protocol}://${host}/${path}`, http_url_to_repo: `${protocol}://${host}/${path}.git`,
    default_branch: 'main', permissions: { project_access: { access_level: 30 } } }
  const probe = vi.fn(async (argv: string[]) => JSON.stringify(argv.at(-1) === 'user' ? { id: 9, username: 'agent' } : project))
  const deployment = await resolveGitlabDeployment(testMachine({ stateDir: dir }), { protocol, host, repository: path, cli: '/usr/bin/false' }, probe)
  expect(probe.mock.calls[0]![0]).toContain(`API_PROTOCOL=${protocol}`)
  expect(deployment.gitlab!.cloneUrl).toBe(project.http_url_to_repo)
  await writeEnvironment(deployment, [])
  expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain(`[credential "${protocol}://${host}"]`)
  expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain(credentialHelper('/usr/bin/false', { host, protocol }))
  expect(readFileSync(join(dir, 'worker-bin/glab'), 'utf8')).toContain(`GLAB_API_PROTOCOL='${protocol}'`)
})

it.each([false, true])('reads AW and prepares real HTTP Git with git-only=%s', async gitOnly => {
  const dir = temporary(), seed = join(dir, 'seed'), bare = join(dir, 'repo.git'), work = join(dir, 'work')
  mkdirSync(seed); mkdirSync(work)
  // The test uses no user git configuration, identity or credentials.
  const env = { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const git = async (args: string[], cwd = seed) => (await exec('git', args, { cwd, env })).stdout.trim()
  await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid'])
  writeFileSync(join(seed, 'value.txt'), 'baseline\n'); await git(['add', '.']); await git(['commit', '-m', 'fixture baseline'])
  const baseSha = await git(['rev-parse', 'HEAD'])
  await git(['init', '--bare', '-b', 'main', bare]); await git(['remote', 'add', 'origin', bare]); await git(['push', 'origin', 'main'])
  writeFileSync(join(seed, 'value.txt'), 'later\n'); await git(['commit', '-am', 'fixture later']); await git(['push', 'origin', 'main'])
  await git(['update-server-info'], bare)
  const requests: string[] = []
  let cloneUrl = ''
  const task = { id: 'tsk_demo', revision: 3, projectId: 'prj_demo', requirementId: 'req_demo', title: 'Fixture', description: 'Read baseline', acceptance: 'value.txt contains baseline' }
  const project = () => ({ id: 'prj_demo', revision: 2, repositoryUrl: cloneUrl, baseline: gitOnly ? baseSha : 'main', environment: 'git fixture', rules: 'Fixture only' })
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture'); requests.push(req.url!)
    if (url.pathname.startsWith('/api/v1/tasks/')) {
      res.setHeader('Content-Type', 'application/json')
      if (url.pathname.endsWith('/brief')) return res.end(JSON.stringify({ snapshot: { taskId: task.id, revision: 3, projectRevision: 2, requirementRevision: 4, digest: 'd'.repeat(64) }, current: { revision: 99 } }))
      const section = url.searchParams.get('section')
      return res.end(JSON.stringify({ taskId: task.id, revision: 3, section, content: section === 'task' ? task : section === 'project' ? project() : { id: 'req_demo', revision: 4, plan: 'Approved fixture plan' } }))
    }
    if (gitOnly && req.headers.authorization !== 'Basic ' + Buffer.from('fixture:fixture-pass').toString('base64')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git-fixture"' }); return res.end()
    }
    const relative = url.pathname.replace('/team/sub/repo.git/', '')
    if (!url.pathname.startsWith('/team/sub/repo.git/') || relative.includes('..')) { res.writeHead(404); return res.end() }
    try { res.setHeader('Content-Type', 'text/plain'); res.end(readFileSync(join(bare, relative))) }
    catch { res.writeHead(404); res.end() }
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`
  cloneUrl = `http://${host}/team/sub/repo.git`
  const credentialFile = join(dir, 'git-credentials')
  writeFileSync(credentialFile, `http://fixture:fixture-pass@${host}/team/sub/repo.git\n`, { mode: 0o600 })
  const deployment: Deployment = gitOnly ? await resolveGitlabDeployment(testMachine({ stateDir: dir, repositoryProvider: 'gitlab' }),
    { protocol: 'http', host, repository: 'team/sub/repo', apiEnabled: false, credentialFile }, async argv => {
      expect(argv[0]).toBe('git'); return (await exec(argv[0]!, argv.slice(1), { cwd: dir, env })).stdout
    }) : { ...testMachine({ stateDir: dir }), repository: 'team/sub/repo', gitlab: { protocol: 'http', cli: '/bin/false', login: 'fixture', userId: 9,
    host, projectId: 7, webUrl: cloneUrl.slice(0, -4), cloneUrl, defaultBranch: 'main' } }
  await writeEnvironment(deployment, [])
  const workerEnv = { ...env, GIT_CONFIG_GLOBAL: workerGitConfig(dir) }
  const commands = new Commands(() => deployment, workerEnv, new AbortController().signal)
  const run = vi.spyOn(commands, 'run')
  if (!gitOnly) run.mockResolvedValue(JSON.stringify({ id: baseSha }))
  const request = awRequest('AW taskId=tsk_demo revision=3 phase=implement scope=Read baseline')!
  const client = new AwClient({ awBaseUrl: `http://${host}` })
  const context = await client.load(request, deployment, commands)
  expect(context.task.acceptance).toBe(task.acceptance)
  expect(context.baseSha).toBe(baseSha)
  expect(requests.filter(path => path.startsWith('/api/'))).toEqual([
    '/api/v1/tasks/tsk_demo/brief?revision=3', '/api/v1/tasks/tsk_demo/context?revision=3&section=project', '/api/v1/tasks/tsk_demo/context?revision=3&section=task'])
  if (!gitOnly) expect(run.mock.calls[0]![1]).toContain('projects/7/repository/commits/main')
  else {
    expect(deployment.gitlab).toBeUndefined()
    expect(deployment.git?.defaultBranch).toBe('main')
    expect(run.mock.calls.every(([program]) => program === 'git')).toBe(true)
    expect(readFileSync(join(dir, 'worker-bin/glab'), 'utf8')).toContain('GitLab API is not enabled')
    expect(await gitBaseline(commands, cloneUrl, 'main')).toBe(await git(['rev-parse', 'HEAD']))
  }
  // Execute the same preparation function called by the native Executor using actual child git processes.
  const subprocess = { spawn: (spec: { argv: string[]; cwd: string; env?: Record<string, string> }) => {
    let stdout = '', stderr = ''
    const done = exec(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: { ...workerEnv, ...spec.env } })
      .then(value => { stdout = value.stdout; stderr = value.stderr; return { exitCode: 0 } }, error => { stderr = error.stderr; return { exitCode: error.code } })
    return { done, collected: { stdout: { readFrom: () => ({ text: stdout }) }, stderr: { readFrom: () => ({ text: stderr }) } } }
  } } as unknown as SubprocessRuntime
  await prepareAwWorkspace(subprocess, work, 'codex/fixture', context.baseSha, { DSH_SUPERAGENT_CLONE_URL: cloneUrl }, new AbortController().signal)
  expect(await git(['rev-parse', 'HEAD'], work)).toBe(baseSha)
  expect(await git(['branch', '--show-current'], work)).toBe('codex/fixture')
  expect(readFileSync(join(work, 'value.txt'), 'utf8')).toBe('baseline\n')
  expect(await git(['remote', 'get-url', 'origin'], work)).toBe(cloneUrl)
  expect(await client.section(context, 'requirement')).toMatchObject({ id: 'req_demo', revision: 4 })
  const db = join(dir, 'state.sqlite'), store = new Store(db)
  store.tickets.save({ id: 'fixture', execution: { name: 'fixture', directory: work, assignment: awInstructions(context, 'fixture'), aw: { ...context, workspacePrepared: true } },
    title: 'Fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), assignments: [], inputs: [], channels: [], undelivered: [], origin: { triggerId: 'message', triggerIds: ['message'] } } as unknown as Ticket)
  store.close()
  const reopened = new Store(db)
  expect(reopened.tickets.get('fixture')!.execution!.aw).toMatchObject({ revision: 3, baseSha, workspacePrepared: true })
  reopened.close()
})

it('rejects unavailable Git access without falling back to API and rejects ambiguous AW refs', async () => {
  const probe = vi.fn(async () => { throw new Error('fixture transport failure') })
  await expect(resolveGitlabDeployment(testMachine(), { apiEnabled: false, host: 'git.test', repository: 'team/app' }, probe)).rejects.toThrow('Git access failed')
  expect(probe.mock.calls).toHaveLength(1)
  const commands = { run: vi.fn(async () => `${'a'.repeat(40)}\trefs/heads/release\n${'b'.repeat(40)}\trefs/tags/release\n`) } as unknown as Commands
  await expect(gitBaseline(commands, 'http://git.test/team/app.git', 'release')).rejects.toThrow('identify one')
})

it('pins two repositories and toolchains through concurrent native AW checkout and recovery', async () => {
  const dir = temporary()
  const env = { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, env })).stdout.trim()
  let project = { id: 'prj_fixture', revision: 2, environment: '', rules: '' }
  const fixtures = await Promise.all(['api', 'web'].map(async repoId => {
    const source = join(dir, repoId), work = join(dir, `work-${repoId}`), bin = join(dir, `bin-${repoId}`)
    const repositoryUrl = `https://github.com/example/${repoId}.git`, environmentRef = `${repoId}-v1`
    mkdirSync(source); mkdirSync(work); mkdirSync(bin)
    writeFileSync(join(bin, 'fixture-tool'), `#!/bin/sh\nprintf '%s\\n' '${environmentRef}'\n`, { mode: 0o755 })
    await git(source, 'init', '-b', 'main')
    await git(source, 'config', 'user.name', 'Fixture')
    await git(source, 'config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(source, 'fixture.txt'), repoId)
    await git(source, 'add', '.')
    await git(source, 'commit', '-m', 'fixture baseline')
    const baseSha = await git(source, 'rev-parse', 'HEAD')
    writeFileSync(join(source, 'fixture.txt'), 'newer')
    await git(source, 'commit', '-am', 'move fixture branch')
    const task = { id: `tsk_${repoId}`, revision: 1, projectId: project.id, requirementId: 'req_fixture',
      projectRevision: 2, requirementRevision: 1,
      title: repoId, description: 'Check only this repo', acceptance: 'Fixed result', repoId, repositoryUrl, baseSha,
      environmentRef, verifyCommand: 'fixture-tool' }
    return { task, source, work, bin }
  }))
  let server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture')
    const fixture = fixtures.find(f => url.pathname.includes(`/${f.task.id}/`))!
    const section = url.searchParams.get('section')
    const response = section
      ? { taskId: fixture.task.id, revision: 1, section, content: section === 'task' ? fixture.task : project }
      : { snapshot: { taskId: fixture.task.id, revision: 1, projectRevision: 2, requirementRevision: 1, digest: 'd'.repeat(64) } }
    res.end(JSON.stringify(response))
  })
  const awPath = process.env.DSH_LAB_AW_SERVER
  if (awPath) {
    const { createStore } = await import(pathToFileURL(join(awPath, 'store.mjs')).href)
    const { createApp } = await import(pathToFileURL(join(awPath, 'app.mjs')).href)
    const aw = createStore(':memory:')
    const architectureRef = { repoId: 'api', commitSha: fixtures[0]!.task.baseSha, path: 'fixture.txt' }
    project = aw.createProject({ name: 'Two-repository fixture', architectureRef, repositories: fixtures.map(({ task }) => ({
      repoId: task.repoId, name: task.repoId, repositoryUrl: task.repositoryUrl, environmentRef: task.environmentRef,
      baseline: 'main', verifyCommand: task.verifyCommand })) })
    const req = aw.createRequirement({ projectId: project.id, title: 'Shared API contract', description: 'Add one fixture to each repository' })
    await expect(git(fixtures[0]!.source, 'show', `${architectureRef.commitSha}:${architectureRef.path}`)).resolves.toBe('api')
    const { items } = aw.splitTasks(req.id, { expectedRevision: 1, expectedProjectRevision: project.revision,
      tasks: fixtures.map(({ task }) => ({ title: task.title, description: task.description, acceptance: task.acceptance, repoId: task.repoId, baseSha: task.baseSha })) })
    fixtures.forEach((fixture, index) => { fixture.task = items[index] })
    server = createApp(aw)
    server.once('close', () => aw.close())
  }
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const awBaseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const config = { stateDir: dir, awBaseUrl, awProjectId: project.id, awRepositories: Object.fromEntries(fixtures.map(({ task, bin }) =>
    [task.repoId, { repositoryUrl: task.repositoryUrl, environmentRef: task.environmentRef, environment: { path: [bin], executables: ['fixture-tool'] } }])) }
  const machine = machineOf(Config(config))
  expect(() => machineOf(Config({ ...config, awProjectId: '' }))).toThrow()
  const deployment = testDeployment(machine)
  const client = new AwClient(machine)
  const signal = new AbortController().signal
  const commands = new Commands(() => deployment, env, signal)
  const route = (repoId: string, configured = deployment) => client.load(
    awRequest(`AW taskId=${fixtures.find(f => f.task.repoId === repoId)!.task.id} revision=1 phase=implement scope=Fixture`)!, configured, commands, signal)
  await expect(route('api', { ...deployment, awProjectId: 'other' })).rejects.toThrow('AW project')
  await expect(route('web', { ...deployment, awRepositories: { api: machine.awRepositories!.api! } })).rejects.toThrow('allowlist')
  const versions = await Promise.all(fixtures.map(async ({ task, source, work }) => {
    const context = await route(task.repoId)
    if (awPath) expect(context.project).toMatchObject({ repositories: [{ repoId: 'api' }, { repoId: 'web' }], architectureRef: { repoId: 'api' } })
    await verifyAwToolchain(context.repository!)
    await expect(verifyAwToolchain({ ...context.repository!, executables: ['git'] })).rejects.toThrow('missing git')
    const ticket = { execution: { aw: context } } as Ticket
    const scoped = repositoryEnvironment(ticket)
    expect((await exec('fixture-tool', [], { cwd: work, env: { ...env, ...scoped } })).stdout.trim()).toBe(task.environmentRef)
    // Map the allowlisted fixture URL to a real local repo at transport level.
    const configFile = join(dir, `git-${task.repoId}.config`)
    writeFileSync(configFile, `[url "${source}"]\n\tinsteadOf = ${task.repositoryUrl}\n`)
    const subprocess = { spawn: (spec: { argv: string[]; cwd: string; env?: Record<string, string> }) => {
      let stdout = '', stderr = ''
      const done = exec(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: { ...env, ...spec.env, GIT_CONFIG_GLOBAL: configFile } })
        .then(result => { stdout = result.stdout; return { exitCode: 0 } }, error => { stderr = error.stderr; return { exitCode: error.code } })
      return { done, collected: { stdout: { readFrom: () => ({ text: stdout }) }, stderr: { readFrom: () => ({ text: stderr }) } } }
    } } as unknown as SubprocessRuntime
    const branch = `codex/${task.repoId}`
    await prepareAwWorkspace(subprocess, work, branch, context.baseSha, scoped, signal)
    await prepareAwWorkspace(subprocess, work, branch, context.baseSha, scoped, signal)
    await verifyAwWorkspace(subprocess, work, branch, context.baseSha, scoped, signal)
    expect(await git(work, 'rev-parse', 'HEAD')).toBe(task.baseSha)
    expect(readFileSync(join(work, 'fixture.txt'), 'utf8')).toBe(task.repoId)
    return context
  }))
  const store = new Store(join(dir, 'multi.sqlite'))
  for (const context of versions) store.tickets.save({ id: context.taskId, execution: { aw: context } } as Ticket)
  store.close()
  const reopened = new Store(join(dir, 'multi.sqlite'))
  try {
    for (const context of versions) expect(reopened.tickets.get(context.taskId)?.execution?.aw?.repository).toEqual(context.repository)
    const bound = reopened.tickets.get(fixtures[0]!.task.id)!.execution!.aw!
    expect(() => verifyAwBinding(bound, deployment)).not.toThrow()
    expect(() => verifyAwBinding(bound, { ...deployment, awRepositories: {} })).toThrow('no longer available')
  } finally { reopened.close() }
})

it('keeps the normal static task format and makes a plan-only AW dispatch explicit', () => {
  expect(awRequest('Fix this issue')).toBeUndefined()
  const request = awRequest('AW taskId=tsk_demo revision=1 phase=plan scope=Write a plan')!
  expect(request).toMatchObject({ revision: 1, phase: 'plan', scope: 'Write a plan' })
})

it('recognizes same-line robot mentions after native Feishu and DingTalk message normalization', () => {
  const dispatch = 'AW taskId=tsk_demo revision=3 phase=implement scope=Approved scope only'
  const feishu = feishuTrigger({ message_id: 'om_aw', chat_id: 'oc_fixture', chat_type: 'group', sender_id: 'ou_fixture', sender_type: 'user',
    content: `@_user_1 ${dispatch}`, create_time: String(Date.now()), mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_fixture')!
  expect(feishu.addressed).toBe('mention')
  expect(awRequest(feishu.text)).toMatchObject({ taskId: 'tsk_demo', revision: 3, phase: 'implement', scope: 'Approved scope only' })
  const config = DingtalkConfigSchema.parse({ clientId: 'fixture', robotCode: 'robot', corpId: 'corp', conversations: [{ id: 'group' }] })
  const dingtalk = dingtalkTrigger(RobotMessage.parse({ msgId: 'msg_aw', conversationId: 'group', conversationType: '2', senderStaffId: 'fixture',
    senderCorpId: 'corp', isInAtList: true, createAt: Date.now(), msgtype: 'text', text: { content: `@机器人 ${dispatch}` } }), config)!
  expect(dingtalk.addressed).toBe('mention')
  expect(awRequest(dingtalk.text)).toMatchObject({ taskId: 'tsk_demo', revision: 3, phase: 'implement', scope: 'Approved scope only' })
})
