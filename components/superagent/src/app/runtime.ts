/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { AwClient, awDispatchRequest, verifyAwBinding } from './aw.ts'
import { awDispatchSink } from './aw-dispatch-results.ts'
import { dispatchResults } from './dispatch-results.ts'
import { directReadyNotice, directWorkScope, loadDirectWork, verifyDirectCandidate, verifyDirectWork } from './im-direct.ts'
import { ownerReports } from './owner-report.ts'
import { ownerDispatches } from './owner-dispatch.ts'
import { feishuOwnerDispatchNotice, feishuOwnerReportRoute } from '../sources/feishu-owner-report.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { dispatchTimeoutNotice, eventNotice, followupNotice } from './notices.ts'
import { mergeEndNotices } from '../sources/gitlab-pull.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart,
        hasLegacyTickets: () => !!store.get(KV.runtime.repository) && store.tickets.list().some(ticket => !ticket.execution?.imDirect && !ticket.execution?.aw?.repository?.provider),
        bindRepository: deployment => {
        const binding = JSON.stringify([deployment.gitlab || deployment.git ? 'gitlab' : 'github', (deployment.gitlab ?? deployment.git)?.host ?? 'github.com', deployment.repository.toLowerCase()])
        const previous = store.get(KV.runtime.repository)
        if (store.tickets.list().length && (previous ? previous !== binding : !!(deployment.gitlab || deployment.git))) throw new SetupError('repositoryChanged')
        store.set(KV.runtime.repository, binding)
      } })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu, () => machine.repositoryProvider ?? 'github', () => !!this.sources?.instance('dingtalk')?.enabled)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const aw = new AwClient(machine)
      const projectId = machine.awProjectId
      const recordDispatch = machine.awDispatchWriteUrl ? dispatchResults(store, effects,
        awDispatchSink(machine.awDispatchWriteUrl, machine.awDispatchAuthorizationFile,
          projectId ? { projectId, contains: (ref, signal) => aw.belongsToProject(ref, projectId, signal) } : undefined),
        trigger => !!allowedSender(store.settings(), trigger.actor), this.lifetime) : undefined
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment, gitOnly: () => setup.configured() && (!!setup.deployment.git || !setup.deployment.repository),
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const ownerBot = machine.ownerReportBotId
      const recordOwnerDispatch = machine.ownerDispatchEvents && projectId && ownerBot ? ownerDispatches(store, effects, {
        destination: key('owner-dispatch', projectId, ownerBot, machine.ownerReportChatId!, machine.awBaseUrl!),
        projectId, authorized: trigger => !!allowedSender(store.settings(), trigger.actor),
        target: channel => channel.source === 'feishu' && channel.address.chatId === machine.ownerReportChatId,
        belongs: event => aw.belongsToProject(event, projectId, this.lifetime),
        format: (event, channel) => feishuOwnerDispatchNotice(ownerBot, event, channel),
        send: message => outbox.send(message),
      }) : undefined
      const ownerReport = ownerReports(feishuOwnerReportRoute(machine.ownerReportChatId, machine.ownerReportBotId),
        ticket => store.triggers.get(ticket.origin.triggerId)?.channel, message => outbox.send(message), id => store.receipts.get(id))
      const directOrigin = (ticket: Ticket) => store.triggers.get(ticket.origin.triggerId)
      const authorizedDirectOrigin = (ticket: Ticket) => {
        const trigger = directOrigin(ticket)
        const config = setup.deployment.imDirect
        return config && directWorkScope(trigger, config.senderId,
          !!trigger && ticket.mandate.strength === 'explicit' && !!allowedSender(store.settings(), trigger.actor))
      }
      const publishReport = (ticket: Ticket) => {
        if (!ticket.execution?.imDirect) return ownerReport.publish(ticket)
        const message = directReadyNotice(ticket, directOrigin(ticket))
        if (message) outbox.send(message)
      }
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, outbox, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger), publishOwnerReport: publishReport,
        verifyRepository: aw => verifyAwBinding(aw, setup.deployment),
        verifyDirectWork: (work, ticket) => {
          if (authorizedDirectOrigin(ticket) !== work.scope) throw new Error('IM direct sender is no longer authorized')
          verifyDirectWork(work, setup.deployment.imDirect)
        },
        externalTask: async ticket => {
          const origin = store.triggers.get(ticket.origin.triggerId)
          const config = setup.deployment.imDirect
          if (config && origin?.meta.directScope) {
            const scope = authorizedDirectOrigin(ticket)
            if (!scope) throw new Error('Feishu direct work is unavailable for this instance or sender')
            return loadDirectWork(scope, config, commands, this.lifetime)
          }
          const request = origin ? awDispatchRequest(origin) : undefined
          if ((setup.deployment.git || !setup.deployment.repository) && !request)
            throw new Error(setup.deployment.imDirect ? 'Send an explicit Feishu “直接做：…” request or an AW fixed task reference.' : 'Git-only development requires an AW taskId, fixed revision and explicit phase/scope.')
          return request ? aw.load(request, setup.deployment, commands, this.lifetime) : undefined
        } })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: async candidate => {
          const card = await candidateCard(links, candidate)
          const trigger = candidate.triggers.at(-1)
          const direct = machine.imDirect && directWorkScope(trigger, machine.imDirect.senderId, !!trigger && !!allowedSender(store.settings(), trigger.actor))
          return direct ? { ...card, next_action: 'This sender explicitly requested Feishu direct work. Use the native Ticket pathway. '
            + 'With a clear request, accept or attach as appropriate. Keep the acknowledgement short and name the scope and expected behavior. '
            + 'If the request is unclear, obtain clarification in the original topic before any changes. Do not broaden the stated scope.' } : card
        } })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, readyReply: ticket => {
          if (!ticket.execution?.imDirect) return ownerReport.readyReply(ticket)
          const message = directReadyNotice(ticket, directOrigin(ticket))
          const receipt = message && store.receipts.get(message.id)
          return message && receipt && receipt.status !== 'dropped' ? { id: message.id, status: receipt.status, reused: true } : undefined
        }, allowsFollowup: (ticket, trigger) => {
          const origin = directOrigin(ticket)
          if (!ticket.execution?.imDirect && !(machine.imDirect && origin?.meta.directScope)) return true
          return !!origin && trigger.human && trigger.source === 'feishu' && trigger.actor.id === origin.actor.id
            && !!authorizedDirectOrigin(ticket) && trigger.threads.some(thread => thread.source === 'feishu' && origin.threads.some(item => item.id === thread.id))
        }, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          recordDispatch?.(event)
          const ownerDispatches = recordOwnerDispatch?.(event)
          if (event.type === 'decision.recorded' && event.data.kind === 'unavailable') {
            const decision = store.decisions.get(event.data.decisionId)
            if (decision?.reason.some(reason => reason.code === 'timeout')) {
              for (const triggerId of decision.triggerIds) {
                if (ownerDispatches?.has(triggerId)) continue
                const message = dispatchTimeoutNotice(decision.id, store.triggers.get(triggerId), !!machine.imDirect)
                if (message) outbox.send(message)
              }
            }
          }
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of [...pullEndNotices(ended, request, setup.deployment.repository), ...mergeEndNotices(ended, setup.deployment.gitlab)]) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        ownerReportEnabled: ownerReport.enabled, publishOwnerReport: publishReport,
        verifyDirectCandidate: (ticket: Ticket, candidate: string, reviewId: string, signal: AbortSignal) =>
          verifyDirectCandidate(ctx, ticket, workerSessionId(ticket.id), candidate, reviewId, signal),
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        get gitlab() { return runtime.context({ kind: 'gitlab', health: ['gitlab'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
