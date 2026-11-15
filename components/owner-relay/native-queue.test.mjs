import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeQueue } from './native-queue.mjs';
const b = { threadId: '12345678-1234-4234-8234-123456789abc', snapshotDigest: 'fixed' };
const e = { eventId: 'event-1', type: 'implementation.ready' };
test('only the native queue command targets the exact original UUID; no resume or alternate model/runtime', async () => {
  const q = new NativeQueue({ codexCli: '/native/codex' }, async (cli, args) => {
    assert.equal(cli, '/native/codex'); assert.deepEqual(args.slice(0, 4), ['queue', '--thread', b.threadId, '--message']);
    assert.equal(args.length, 5); assert.match(args[4], /started event-1/); assert.match(args[4], /fixed/);
    return { stdout: `Queued message abc-def for thread ${b.threadId}.\n`, stderr: '' };
  });
  assert.equal((await q.dispatch(b, e, { cliPath: '/relay/cli.mjs' })).queueId, 'abc-def');
});
test('queue acknowledgement for another thread or warnings cannot be reported as success', async () => {
  for (const r of [{ stdout: 'Queued message abc for thread wrong.', stderr: '' }, { stdout: `Queued message abc for thread ${b.threadId}.`, stderr: 'could not resume' }]) {
    const q = new NativeQueue({ codexCli: '/native/codex' }, async () => r);
    await assert.rejects(() => q.dispatch(b, e, { cliPath: '/relay/cli.mjs' }));
  }
});
test('an isolated relay uses its own config when the Owner records both receipts', async () => {
  const q = new NativeQueue({ codexCli: '/native/codex' }, async (_cli, args) => {
    const expected = "OWNER_RELAY_CONFIG='/relay configs/isolated.json' node '/relay/cli.mjs'";
    assert.ok(args[4].includes(`${expected} started event-1`));
    assert.ok(args[4].includes(`${expected} complete event-1`));
    return { stdout: `Queued message abc-def for thread ${b.threadId}.\n`, stderr: '' };
  });
  await q.dispatch(b, e, { cliPath: '/relay/cli.mjs', configPath: '/relay configs/isolated.json' });
});
test('stop cancels an in-flight native CLI operation', async () => {
  let entered;
  const ready = new Promise(r => { entered = r; });
  const q = new NativeQueue({ codexCli: '/native/codex' }, async (_bin, _args, { signal }) => {
    entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
  });
  const work = q.dispatch(b, e, { cliPath: '/relay/cli.mjs' }); await ready; q.close(); await assert.rejects(() => work);
});
