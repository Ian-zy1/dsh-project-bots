const id = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(value);
const messageId = value => /^om_[A-Za-z0-9]+$/.test(value ?? '');
const scope = value => `${value.projectId}:${value.taskId}:${value.revision}`;
const types = ['dispatch.accepted', 'dispatch.rejected', 'dispatch.assessment_timeout'];
const reasons = ['directionUnsettled', 'noRuleMatched', 'notActionable'];
const knownUnaccepted = ['dispatch.rejected', 'dispatch.assessment_timeout'];

export function parseDispatchEvent(e, m) {
  if (!types.includes(e.type) || !['eventId', 'projectId', 'taskId'].every(k => id(e[k]))
      || !Number.isSafeInteger(e.revision) || e.revision < 1 || e.phase !== 'implement'
      || !messageId(e.originMessageId) || !messageId(m.message_id)) return;
  if (e.type === 'dispatch.accepted' ? !id(e.ticketId) || e.reason !== undefined : e.ticketId !== undefined) return;
  if (e.type === 'dispatch.rejected' ? !reasons.includes(e.reason) : e.reason !== undefined) return;
  return { type: e.type, eventId: e.eventId, projectId: e.projectId, taskId: e.taskId, revision: e.revision,
    originMessageId: e.originMessageId, chatId: m.chat_id, ...(e.ticketId ? { ticketId: e.ticketId } : {}),
    ...(e.reason ? { reason: e.reason } : {}) };
}

function transaction(state, fn) {
  state.db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); state.db.exec('COMMIT'); return value; }
  catch (error) { state.db.exec('ROLLBACK'); throw error; }
}

export function reserveDispatch(state, submission, config) {
  const { dispatchId, projectId, taskId, revision, threadId, cwd, snapshotDigest, chatId, authorized, contextRef } = submission;
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(dispatchId ?? '') || ![projectId, taskId].every(id)
      || !Number.isSafeInteger(revision) || revision < 1 || submission.phase !== 'implement'
      || !/^[a-f0-9-]{36}$/.test(threadId ?? '') || !cwd?.startsWith('/')
      || !/^[a-f0-9]{64}$/.test(snapshotDigest ?? '') || chatId !== config.chatId || authorized !== true
      || (contextRef !== undefined && !contextRef.startsWith('/'))
      || !Object.hasOwn(config.projectPublishers ?? {}, projectId)) throw Error('Invalid approved Owner dispatch');
  const intent = { dispatchId, projectId, taskId, revision, threadId, cwd, snapshotDigest, chatId, authorized, ...(contextRef ? { contextRef } : {}) };
  return transaction(state, () => {
    const data = state.data;
    if (data.dispatches[dispatchId] || data.bindings[scope(intent)] || Object.values(data.dispatches).some(
      row => scope(row.intent) === scope(intent) && !knownUnaccepted.includes(row.decision)))
      throw Error('Dispatch already recorded; reconcile the original receipt before doing anything');
    state.putDispatch(dispatchId, { intent });
  });
}

export function attachDispatchReceipt(state, dispatchId, receipt, owner, now = Date.now()) {
  return transaction(state, () => {
    const { dispatches } = state.data;
    const row = dispatches[dispatchId];
    if (!row || row.intent.threadId !== owner.threadId || row.intent.cwd !== owner.cwd
        || receipt.chatId !== row.intent.chatId || !messageId(receipt.originMessageId)
        || (row.originMessageId && row.originMessageId !== receipt.originMessageId)
        || Object.values(dispatches).some(other => other !== row && other.originMessageId === receipt.originMessageId))
      throw Error('The receipt does not match this Owner dispatch');
    if (!row.originMessageId) state.putDispatch(dispatchId, { ...row, originMessageId: receipt.originMessageId, sentAt: now });
  });
}

export function reconcileDispatches(state) {
  transaction(state, () => {
    const data = state.data;
    for (const [dispatchId, row] of Object.entries(data.dispatches)) {
      if (!row.originMessageId || row.decision) continue;
      const decisions = Object.values(data.dispatchEvents).filter(event => event.originMessageId === row.originMessageId
        && event.chatId === row.intent.chatId && scope(event) === scope(row.intent));
      if (!decisions.length) continue;
      const event = decisions[0];
      if (decisions.some(other => other.type !== event.type || other.ticketId !== event.ticketId)) continue;
      if (event.type === 'dispatch.accepted' && !data.bindings[scope(row.intent)]) {
        const { projectId, taskId, revision, threadId, cwd, snapshotDigest, contextRef } = row.intent;
        state.bind({ projectId, taskId, revision, threadId, cwd, snapshotDigest, ...(contextRef ? { contextRef } : {}),
          ticketId: event.ticketId, originMessageId: row.originMessageId, authorized: true, followTicketAssignments: true }, { deferAssignment: true });
      }
      const binding = event.type === 'dispatch.accepted' && state.data.bindings[scope(row.intent)];
      if (binding && (binding.originMessageId !== row.originMessageId || binding.ticketId !== event.ticketId
          || binding.threadId !== row.intent.threadId || binding.cwd !== row.intent.cwd || binding.snapshotDigest !== row.intent.snapshotDigest)) continue;
      state.putDispatch(dispatchId, { ...row, decision: event.type, decidedBy: event.eventId });
    }
  });
}

export async function dispatchTimeouts(state, notify, now, waitMs, stopping) {
  for (const [dispatchId, row] of Object.entries(state.data.dispatches)) {
    if (stopping()) return;
    if (!row.originMessageId || row.decision || row.noticeSent || now - row.sentAt < waitMs) continue;
    const { taskId, revision } = row.intent;
    try {
      await notify({ event: { eventId: dispatchId, messageId: row.originMessageId } },
        `接单未确认：${taskId} r${revision}。尚未收到 DSH 的决定，请核对原消息后再决定下一步。`, 'dispatch-unconfirmed');
      state.putDispatch(dispatchId, { ...row, noticeSent: true });
    } catch { /* The next tick retries with the same Feishu idempotency key. */ }
  }
}
