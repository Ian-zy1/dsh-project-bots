import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dispatchTimeouts, parseDispatchEvent, reconcileDispatches } from './dispatch.mjs';

export const prefix = 'DSH_OWNER_EVENT_V1 ';
const id = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const key = e => `${e.projectId}:${e.taskId}:${e.revision}`;
export const digest = v => createHash('sha256').update(v).digest('hex');
export function validateProjectPublishers(publishers) {
  if (publishers === undefined) return;
  if (!publishers || Array.isArray(publishers) || typeof publishers !== 'object') throw Error('Invalid project publisher map');
  const entries = Object.entries(publishers);
  if (!entries.length || entries.some(([project, sender]) => !id(project) || typeof sender !== 'string' || !/^ou_[A-Za-z0-9]+$/.test(sender))
      || new Set(entries.map(([, sender]) => sender)).size !== entries.length) throw Error('Project publishers must be distinct Feishu bot IDs');
}
export function parseMessage(m, config) {
  if (m.chat_id !== config.chatId || m.sender_type !== 'bot') return;
  const publishers = config.projectPublishers;
  if (publishers ? !Object.values(publishers).includes(m.sender_id) : m.sender_id !== config.publisherSenderId) return;
  if (!m.mentions?.some(v => v.id === config.botOpenId)) return;
  const at = m.content?.indexOf(prefix) ?? -1;
  if (at < 0 || m.content.length > 12000) return;
  let e; try { e = JSON.parse(m.content.slice(at + prefix.length).trim()); } catch { return; }
  if (!e || typeof e !== 'object' || e.schemaVersion !== 1) return;
  if (publishers && (!Object.hasOwn(publishers, e.projectId) || publishers[e.projectId] !== m.sender_id)) return;
  if (publishers && typeof e.type === 'string' && e.type.startsWith('dispatch.')) return parseDispatchEvent(e, m);
  if (!['implementation.ready', 'execution.failed', 'execution.blocked'].includes(e.type)
      || !['eventId', 'projectId', 'taskId', 'ticketId', 'assignmentId'].every(k => id(e[k]))
      || !Number.isSafeInteger(e.revision) || e.revision < 1 || e.phase !== 'implement'
      || e.reportRef !== `ticket/${e.ticketId}/result`
      || (e.type === 'implementation.ready' && e.candidateSha === undefined)
      || (e.candidateSha !== undefined && (typeof e.candidateSha !== 'string' || !/^[a-f0-9]{40}$/.test(e.candidateSha)))
      || !/^om_[A-Za-z0-9]+$/.test(m.message_id ?? '')) return;
  // Construct an allowlisted payload; never pass arbitrary IM text/instructions to Owner.
  return { schemaVersion: 1, type: e.type, ...Object.fromEntries(
    ['eventId', 'projectId', 'taskId', 'ticketId', 'assignmentId', 'revision', 'phase', 'reportRef', 'candidateSha']
      .filter(k => e[k] !== undefined).map(k => [k, e[k]])), messageId: m.message_id, chatId: m.chat_id };
}

export class State {
  constructor(file, { readOnly = false } = {}) {
    this.file = file;
    if (readOnly) { this.db = new DatabaseSync(file, { readOnly }); return; }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;'
      + ' CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, payload TEXT NOT NULL, PRIMARY KEY(kind,id));'
      + ' CREATE TABLE IF NOT EXISTS dispatch_records (kind TEXT, id TEXT, payload TEXT NOT NULL, PRIMARY KEY(kind,id));');
  }
  get data() {
    const data = { bindings: Object.create(null), inbox: Object.create(null), meta: Object.create(null),
      dispatches: Object.create(null), dispatchEvents: Object.create(null) };
    for (const r of this.db.prepare('SELECT kind,id,payload FROM records').all()) data[r.kind][r.id] = JSON.parse(r.payload);
    if (this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='dispatch_records'").get())
      for (const r of this.db.prepare('SELECT kind,id,payload FROM dispatch_records').all()) data[r.kind][r.id] = JSON.parse(r.payload);
    return data;
  }
  put(kind, id, value) { this.db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(kind, id, JSON.stringify(value)); }
  putDispatch(id, value) {
    this.db.prepare("INSERT INTO dispatch_records VALUES ('dispatches',?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload")
      .run(id, JSON.stringify(value));
  }
  save(item) { this.put('inbox', item.event.eventId, item); }
  patch(eventId, fields, allowed) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT payload FROM records WHERE kind='inbox' AND id=?").get(eventId);
      const current = row && JSON.parse(row.payload);
      if (!current || (allowed && !allowed.includes(current.status))) { this.db.exec('ROLLBACK'); return; }
      const updated = { ...current, ...fields };
      this.save(updated); this.db.exec('COMMIT'); return updated;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
  bind(b, { deferAssignment = false } = {}) {
    if (!['projectId', 'taskId', 'ticketId'].every(k => id(b[k])) || (!deferAssignment && !id(b.assignmentId)) || !Number.isSafeInteger(b.revision)
        || b.revision < 1 || !/^[a-f0-9-]{36}$/.test(b.threadId ?? '') || !/^[a-f0-9]{64}$/.test(b.snapshotDigest ?? '')
        || !/^om_[A-Za-z0-9]+$/.test(b.originMessageId ?? '')
        || !b.cwd?.startsWith('/') || !b.authorized
        || (b.followTicketAssignments !== undefined && typeof b.followTicketAssignments !== 'boolean'))
      throw Error('Incomplete explicit Owner binding');
    const k = key(b), payload = JSON.stringify(b);
    this.db.prepare("INSERT INTO records VALUES ('bindings', ?, ?) ON CONFLICT(kind,id) DO NOTHING").run(k, payload);
    const previous = this.db.prepare("SELECT payload FROM records WHERE kind='bindings' AND id=?").get(k);
    if (previous?.payload !== payload) throw Error('Binding already registered; explicit migration required');
  }
  receiveDispatch(e) {
    return this.db.prepare("INSERT INTO dispatch_records VALUES ('dispatchEvents', ?, ?) ON CONFLICT(kind,id) DO NOTHING")
      .run(e.eventId, JSON.stringify(e)).changes === 1;
  }
  confirmAssignment(binding, assignmentId) {
    const updated = { ...binding, assignmentId };
    this.db.prepare("UPDATE records SET payload=? WHERE kind='bindings' AND id=? AND payload=?")
      .run(JSON.stringify(updated), key(binding), JSON.stringify(binding));
    return this.data.bindings[key(binding)];
  }
  receive(e) {
    if (this.data.inbox[e.eventId]) {
      const old = this.data.inbox[e.eventId].event;
      const same = { ...old, messageId: e.messageId };
      if (JSON.stringify(same) !== JSON.stringify(e)) throw Error('Event ID reused with different facts');
      return false;
    }
    const semantic = Object.values(this.data.inbox).find(v => key(v.event) === key(e) && v.event.type === e.type
      && v.event.ticketId === e.ticketId && v.event.assignmentId === e.assignmentId && v.event.candidateSha === e.candidateSha);
    this.save({ event: e, status: semantic ? 'duplicate' : 'pending', receivedAt: new Date().toISOString() });
    return !semantic;
  }
  complete(eventId, receipt) {
    const item = this.data.inbox[eventId];
    if (!item || item.status !== 'dispatched' || receipt.taskId !== item.event.taskId || receipt.revision !== item.event.revision
        || receipt.candidateSha !== item.event.candidateSha || !['accept', 'revise', 'pending'].includes(receipt.conclusion)
        || !receipt.artifact?.startsWith('/') || !statSync(receipt.artifact).isFile()) throw Error('Review receipt does not match dispatched candidate');
    const review = { ...receipt, artifact: resolve(receipt.artifact), sha256: digest(readFileSync(receipt.artifact)) };
    if (!this.patch(eventId, { review, status: 'reviewed', reviewedAt: new Date().toISOString() }, ['dispatched']))
      throw Error('Review state changed; inspect the existing receipt');
  }
  started(eventId, threadId, cwd) {
    const item = this.data.inbox[eventId], b = item && this.data.bindings[key(item.event)];
    if (!b || b.threadId !== threadId || b.cwd !== cwd) throw Error('Only the original bound Owner can acknowledge execution');
    if (['dispatched', 'reviewed'].includes(item.status)) return;
    if (!this.patch(eventId, { status: 'dispatched', ownerThreadId: threadId, startedAt: new Date().toISOString() }, ['queued', 'dispatch_unknown']))
      throw Error('No enqueued Owner event to acknowledge');
  }
}

export class Relay {
  constructor(state, owner, notify, config) { this.state = state; this.owner = owner; this.notify = notify; this.config = config; }
  stop() { this.stopping = true; }
  async receive(m) {
    const e = parseMessage(m, this.config);
    if (!e) return false;
    if (e.type.startsWith('dispatch.')) return this.state.receiveDispatch(e);
    return this.state.receive(e);
  }
  async tick() {
    if (this.stopping) return;
    if (Object.keys(this.state.data.dispatches).length) {
      reconcileDispatches(this.state);
      await dispatchTimeouts(this.state, this.notify, Date.now(), this.config.dispatchWaitMs ?? 600_000, () => this.stopping);
    }
    // Sequential dispatch. No model calls while there is no pending event.
    for (let item of Object.values(this.state.data.inbox)) {
      if (this.stopping) return;
      const e = item.event;
      const patch = fields => { item = this.state.patch(e.eventId, fields); };
      if (item.status === 'queued' && !item.queueNoticeSent) {
        try { const queueReceipt = await this.notify(item, `已进入原Owner队列：${e.taskId} r${e.revision}。等待原会话实际接手。`, 'queued'); patch({ queueReceipt, queueNoticeSent: true }); }
        catch { patch({ noticeError: 'Queue notification pending' }); }
      }
      if (this.stopping) return;
      if (item.status !== 'duplicate' && !item.receivedAck) {
        try { const receivedReceipt = await this.notify(item, `已收报：${e.taskId} r${e.revision}。原Owner接续状态另行回报。`, 'received'); patch({ receivedReceipt, receivedAck: true }); }
        catch { patch({ noticeError: 'Receive notification pending' }); }
      }
      if (this.stopping) return;
      if (['dispatched', 'reviewed'].includes(item.status) && !item.ackSent) {
        try { const ackReceipt = await this.notify(item, `已接手Owner${item.kind === 'attention' ? '阻塞核对' : '复审'}：${e.taskId} r${e.revision}。`, 'ack'); patch({ ackReceipt, ackSent: true }); }
        catch { patch({ noticeError: 'Acknowledgement pending' }); }
      }
      if (this.stopping) return;
      if (item.status === 'reviewed' && !item.resultSent) {
        try { const resultReceipt = await this.notify(item, `Owner复审：${item.review.conclusion}。任务 ${e.taskId} r${e.revision}${e.candidateSha ? `，候选 ${e.candidateSha}` : ''}。证据：${item.review.artifact}。合入仍需用户确认。`, 'review'); patch({ resultReceipt, resultSent: true, repliedAt: new Date().toISOString() }); }
        catch { patch({ noticeError: 'Result notification pending' }); }
      }
      if (this.stopping) return;
      if (item.status !== 'pending') continue;
      let b = this.state.data.bindings[key(e)];
      if (!b || b.projectId !== e.projectId || b.taskId !== e.taskId || b.revision !== e.revision
          || b.ticketId !== e.ticketId || !b.authorized
          || (b.assignmentId !== e.assignmentId && b.followTicketAssignments !== true)) {
        patch({ reason: 'Explicit Owner/task/assignment binding required' }); continue;
      }
      if (!b.assignmentId) b = this.state.confirmAssignment(b, e.assignmentId);
      if (e.type !== 'implementation.ready') {
        // Inform Owner of failure/blocker, without granting retry or implementation permissions.
        patch({ kind: 'attention' });
      }
      // Persist uncertainty BEFORE side effect: a crash or timeout cannot silently start a second turn.
      patch({ status: 'dispatch_unknown', dispatchAt: new Date().toISOString(), reason: undefined });
      try {
        const result = await this.owner.dispatch(b, e, this.config);
        // Owner can acknowledge before the CLI exits. Never regress an actual started/reviewed state to queued.
        this.state.patch(e.eventId, { status: 'queued', queueId: result.queueId }, ['dispatch_unknown']);
        this.state.patch(e.eventId, { queueId: result.queueId, queuedAt: new Date().toISOString() });
      } catch { patch({ reason: 'Dispatch result unknown; inspect original session before retry' }); continue; }
      // The next tick sends the durable dispatch receipt; a failed IM send never repeats dispatch.
    }
  }
}
