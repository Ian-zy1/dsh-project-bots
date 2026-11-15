import { open } from 'node:fs/promises';

const stages = new Set(['received', 'binding_required', 'queue_unknown', 'queued', 'reviewing', 'reply_pending', 'reply_failed', 'replied']);
const types = new Set(['implementation.ready', 'execution.blocked', 'execution.failed']);
const conclusions = new Set(['accept', 'revise', 'pending']);
const identifier = value => typeof value === 'string' && /^[a-z0-9_.:-]{1,160}$/i.test(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const maxBytes = 4 * 1024 * 1024;
const staleAfter = 35000;

function view(event) {
  if (!event || ![event.eventId, event.ticketId, event.assignmentId].every(identifier)
      || !stages.has(event.stage) || !types.has(event.type) || !instant(event.receivedAt)) return;
  const { eventId, ticketId, assignmentId, type, stage, receivedAt } = event;
  const times = Object.fromEntries(['queuedAt', 'startedAt', 'reviewedAt', 'repliedAt']
    .filter(field => instant(event[field])).map(field => [field, event[field]]));
  const candidateSha = typeof event.candidateSha === 'string' && /^[a-f0-9]{40}$/.test(event.candidateSha) ? event.candidateSha : undefined;
  const conclusion = conclusions.has(event.conclusion) ? event.conclusion : undefined;
  const { chatId, threadId } = event.thread ?? {};
  const validThread = /^oc_[a-z0-9]+$/i.test(chatId ?? '') && /^omt_[a-z0-9]+$/i.test(threadId ?? '');
  const replyUrl = validThread && stage === 'replied'
    ? `https://applink.feishu.cn/client/thread/open?open_chat_id=${chatId}&open_thread_id=${threadId}` : undefined;
  return { eventId, ticketId, assignmentId, type, stage, receivedAt, ...times, candidateSha, conclusion, replyUrl };
}

export async function taskRelayQueue(file, task, revision, now = Date.now()) {
  if (!file) return { state: 'disabled', events: [] };
  try {
    const handle = await open(file, 'r');
    let snapshot;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid queue projection');
      snapshot = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
    if (snapshot?.schemaVersion !== 1 || !instant(snapshot.observedAt) || typeof snapshot.live !== 'boolean' || !Array.isArray(snapshot.events))
      throw new Error('Invalid queue projection');
    const age = now - Date.parse(snapshot.observedAt);
    const state = !snapshot.live ? 'snapshot' : age < -staleAfter || age > staleAfter ? 'stale' : 'live';
    const byEvent = new Map();
    for (const event of snapshot.events) {
      if (event?.taskId !== task.id || event.projectId !== task.projectId || event.revision !== revision) continue;
      const item = view(event);
      if (item && !byEvent.has(item.eventId)) byEvent.set(item.eventId, item);
    }
    const events = [...byEvent.values()].reverse().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return { state, observedAt: snapshot.observedAt, events: events.slice(0, 20), total: events.length };
  } catch { return { state: 'unavailable', events: [] }; }
}
