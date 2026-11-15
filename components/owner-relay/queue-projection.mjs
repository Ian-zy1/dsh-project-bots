import { randomUUID } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

function stage(item) {
  if (item.resultSent) return 'replied';
  if (item.status === 'reviewed') return item.noticeError === 'Result notification pending' ? 'reply_failed' : 'reply_pending';
  if (item.status === 'dispatched') return 'reviewing';
  if (item.status === 'queued') return 'queued';
  if (item.status === 'dispatch_unknown') return 'queue_unknown';
  return item.reason === 'Explicit Owner/task/assignment binding required' ? 'binding_required' : 'received';
}

export function queueSnapshot(inbox, live, observedAt = new Date().toISOString()) {
  const events = Object.values(inbox).filter(item => item.status !== 'duplicate').map(item => {
    const { event, receivedAt, queuedAt, startedAt, reviewedAt, repliedAt } = item;
    const { eventId, projectId, taskId, revision, ticketId, assignmentId, type, candidateSha } = event;
    const { chatId, threadId } = item.resultReceipt ?? {};
    const thread = /^oc_[a-z0-9]+$/i.test(chatId ?? '') && /^omt_[a-z0-9]+$/i.test(threadId ?? '') ? { chatId, threadId } : undefined;
    return {
      eventId, projectId, taskId, revision, ticketId, assignmentId, type, candidateSha, stage: stage(item),
      receivedAt, queuedAt, startedAt, reviewedAt, repliedAt, conclusion: item.review?.conclusion, thread,
    };
  });
  return { schemaVersion: 1, observedAt, live, events };
}

export function writeQueueSnapshot(file, inbox, live) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(queueSnapshot(inbox, live)), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
