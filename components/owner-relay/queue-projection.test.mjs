import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeQueueSnapshot } from './queue-projection.mjs';

test('exports the four queue states and only display fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-queue-'));
  try {
    const file = join(dir, 'queue.json');
    const at = new Date().toISOString();
    const states = [
      { status: 'pending', reason: 'Explicit Owner/task/assignment binding required' },
      { status: 'queued', queuedAt: at, queueId: 'private-queue-id' },
      { status: 'reviewed', reviewedAt: at, noticeError: 'Result notification pending' },
      { status: 'reviewed', reviewedAt: at, repliedAt: at, resultSent: true, noticeError: 'Result notification pending',
        resultReceipt: { chatId: 'oc_test', threadId: 'omt_test', messageId: 'om_private' } },
      { status: 'duplicate' },
    ];
    const inbox = states.map((state, index) => ({ ...state, receivedAt: at, ownerThreadId: 'private-thread',
      review: { conclusion: 'accept', artifact: '/private/evidence.md' },
      event: { eventId: 'event-' + index, projectId: 'project', taskId: 'task', revision: 1, ticketId: 'ticket',
        assignmentId: 'assignment', type: 'implementation.ready', messageId: 'om_origin', rawText: 'private message' } }));
    writeQueueSnapshot(file, inbox, true);
    const text = readFileSync(file, 'utf8');
    const snapshot = JSON.parse(text);
    assert.equal(snapshot.live, true);
    assert.deepEqual(snapshot.events.map(event => event.stage), ['binding_required', 'queued', 'reply_failed', 'replied']);
    assert.deepEqual(snapshot.events[3].thread, { chatId: 'oc_test', threadId: 'omt_test' });
    assert.equal(snapshot.events[3].repliedAt, at);
    assert.doesNotMatch(text, /private|om_origin|rawText|noticeError|queueId|artifact/);
    writeQueueSnapshot(file, inbox, false);
    assert.equal(JSON.parse(readFileSync(file)).live, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
