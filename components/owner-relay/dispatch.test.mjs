import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attachDispatchReceipt, reserveDispatch } from './dispatch.mjs';
import { parseMessage, prefix, Relay, State } from './relay.mjs';

const config = { chatId: 'oc_team', botOpenId: 'ou_owner', projectPublishers: { prj_test: 'ou_lab', prj_other: 'ou_other' }, dispatchWaitMs: 1000 };
const originalOwner = { threadId: '12345678-1234-4234-8234-123456789abc', cwd: '/repo' };
const intent = { ...originalOwner, dispatchId: 'approved_dispatch_1', projectId: 'prj_test', taskId: 'tsk_test', revision: 1,
  phase: 'implement', authorized: true, chatId: config.chatId, snapshotDigest: 'a'.repeat(64) };
const originMessageId = 'om_accepted';
const source = { schemaVersion: 1, projectId: 'prj_test', taskId: 'tsk_test', revision: 1, phase: 'implement' };
const accepted = { ...source, type: 'dispatch.accepted', eventId: 'decision1', originMessageId, ticketId: 'ticket1' };
const report = { ...source, type: 'implementation.ready', eventId: 'report1', ticketId: 'ticket1', assignmentId: 'assignment1',
  candidateSha: 'a'.repeat(40), reportRef: 'ticket/ticket1/result' };
const message = (event, fields = {}) => ({ sender_type: 'bot', sender_id: 'ou_lab', chat_id: config.chatId,
  message_id: 'om_' + event.eventId, mentions: [{ id: config.botOpenId }], content: prefix + JSON.stringify(event), ...fields });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-dispatch-'));
  const path = join(dir, 'state.sqlite');
  let state = new State(path);
  const turns = [], notices = [];
  const build = () => new Relay(state, { dispatch: async (binding, e) => { turns.push({ binding, e }); return { queueId: 'queue' }; } },
    async (item, text, stage) => { notices.push({ origin: item.event.messageId, text, stage }); return { messageId: 'om_receipt' }; }, config);
  let relay = build();
  t.after(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get state() { return state; }, get relay() { return relay; }, turns, notices,
    restart() { state.close(); state = new State(path); relay = build(); } };
}

test('binds exactly once after receipt with delivery and acceptance arriving early across a restart', async t => {
  const f = fixture(t);
  reserveDispatch(f.state, intent, config);
  assert.throws(() => reserveDispatch(f.state, { ...intent, dispatchId: 'different' }, config), /already recorded/);
  await f.relay.receive(message(report));
  await f.relay.receive(message(accepted));
  await f.relay.tick();
  assert.equal(f.turns.length, 0);
  assert.equal(f.state.data.bindings['prj_test:tsk_test:1'], undefined);
  f.restart();
  assert.equal(await f.relay.receive(message(accepted, { message_id: 'om_anotherDelivery' })), false);
  assert.throws(() => attachDispatchReceipt(f.state, intent.dispatchId, { chatId: config.chatId, originMessageId },
    { ...originalOwner, cwd: '/wrong' }), /does not match/);
  attachDispatchReceipt(f.state, intent.dispatchId, { chatId: config.chatId, originMessageId }, originalOwner);
  await f.relay.tick(); await f.relay.tick();
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0].binding.threadId, originalOwner.threadId);
  assert.equal(f.turns[0].binding.ticketId, accepted.ticketId);
  assert.equal(f.turns[0].binding.assignmentId, report.assignmentId);
  assert.equal(f.state.data.dispatches[intent.dispatchId].decision, 'dispatch.accepted');
  const legacyKinds = f.state.db.prepare('SELECT DISTINCT kind FROM records ORDER BY kind').all().map(row => row.kind);
  assert.deepEqual(legacyKinds, ['bindings', 'inbox']);
  assert.equal(f.notices.some(v => v.stage === 'dispatch-unconfirmed'), false);
});

test('records native rejection and assessment timeout without a duplicate user notice or Owner turn', async t => {
  const f = fixture(t);
  for (const [index, type] of ['dispatch.rejected', 'dispatch.assessment_timeout'].entries()) {
    const taskId = 'tsk_' + index, dispatchId = 'key_' + index, original = 'om_origin' + index;
    reserveDispatch(f.state, { ...intent, taskId, dispatchId }, config);
    attachDispatchReceipt(f.state, dispatchId, { chatId: config.chatId, originMessageId: original }, originalOwner, 0);
    const event = { ...source, taskId, type, eventId: 'decision' + index, originMessageId: original,
      ...(type === 'dispatch.rejected' ? { reason: 'notActionable' } : {}) };
    await f.relay.receive(message(event));
    await f.relay.tick();
    assert.equal(f.state.data.dispatches[dispatchId].decision, type);
  }
  assert.equal(f.turns.length, 0);
  assert.equal(f.notices.length, 0);
  assert.deepEqual(Object.keys(f.state.data.bindings), []);
});

test('missing decision notifies its original message only once; missing receipt and wrong scope never bind', async t => {
  const f = fixture(t);
  reserveDispatch(f.state, intent, config);
  await f.relay.tick();
  assert.equal(f.notices.length, 0);
  attachDispatchReceipt(f.state, intent.dispatchId, { chatId: config.chatId, originMessageId }, originalOwner, 0);
  await f.relay.receive(message({ ...accepted, originMessageId: 'om_wrong' }));
  const anotherBot = { ...accepted, eventId: 'wrongbot' };
  assert.equal(await f.relay.receive(message(anotherBot, { sender_id: 'ou_other' })), false);
  await f.relay.tick();
  f.restart();
  await f.relay.tick();
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].origin, originMessageId);
  assert.equal(f.notices[0].stage, 'dispatch-unconfirmed');
  assert.equal(f.turns.length, 0);
  assert.deepEqual(Object.keys(f.state.data.bindings), []);
});

test('parses the native DSH Feishu wire fixtures when supplied', { skip: !process.env.OWNER_DISPATCH_TEST_OUT }, () => {
  const samples = JSON.parse(readFileSync(process.env.OWNER_DISPATCH_TEST_OUT, 'utf8'));
  const wire = samples.map((sample, index) => parseMessage(message({}, { message_id: 'om_dsh' + index, content: sample.text }), config));
  assert.deepEqual(wire.map(event => event.type).sort(), ['dispatch.accepted', 'dispatch.assessment_timeout', 'dispatch.rejected']);
  assert.deepEqual(wire.map(event => event.originMessageId).sort(), ['om_accepted', 'om_rejected', 'om_timedout']);
});
