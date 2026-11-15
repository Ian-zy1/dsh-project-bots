import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catchup, historyMessage } from './history.mjs';
test('history app_id and event sender_id normalize to the same receiving-app bot identity', () => {
  const m = historyMessage({ sender: { id: 'cli_dsh', sender_type: 'app', open_bot_id: 'ou_dsh' } });
  assert.equal(m.sender_type, 'bot'); assert.equal(m.sender_id, 'ou_dsh');
});
test('offline catch-up reads replies on bound old threads even without new group roots', async () => {
  const messages = [], calls = [], writes = [];
  await catchup(async args => { calls.push(args); return { data: { messages: args.includes('+threads-messages-list') ? [{ sender: { sender_type: 'app', open_bot_id: 'ou_dsh' }, content: 'report' }] : [], has_more: false } }; },
    { data: { meta: { historySince: '2026-01-01T00:00:00Z' }, bindings: { task: { originMessageId: 'om_old' } } }, put: (...args) => writes.push(args) },
    { receive: async m => messages.push(m) }, { chatId: 'oc_group' });
  assert.equal(messages[0].content, 'report'); assert.equal(calls[1][3], 'om_old'); assert.equal(writes.length, 1);
});
test('partial history or a failed reply lookup cannot advance the recovery cursor', async () => {
  for (const mode of ['partial', 'error']) {
    const writes = [];
    await assert.rejects(() => catchup(async () => { if (mode === 'error') throw Error('offline'); return { data: { has_more: true, messages: [] } }; },
      { data: { meta: {}, bindings: {} }, put: (...a) => writes.push(a) }, { receive: async () => {} }, { historySince: '2026-01-01', chatId: 'oc_group' }));
    assert.equal(writes.length, 0);
  }
});
