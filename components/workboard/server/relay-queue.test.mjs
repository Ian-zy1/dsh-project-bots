import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './app.mjs';
import { createStore } from './store.mjs';

test('task UI shows only the requested revision and keeps Relay internals off the browser and Agent APIs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'workboard-relay-queue-'));
  const file = join(dir, 'queue.json');
  const store = createStore(':memory:');
  const project = store.createProject({ name: 'Relay test' });
  const requirement = store.createRequirement({ projectId: project.id, title: 'Requirement', description: 'Test' });
  const task = store.splitTasks(requirement.id, { expectedRevision: 1, tasks: [{ title: 'Task', description: 'Test', acceptance: 'Test' }] }, 'queue-test').items[0];
  const observedAt = new Date().toISOString();
  const record = { projectId: project.id, taskId: task.id, revision: 1, ticketId: 'ticket', assignmentId: 'assn', type: 'implementation.ready', receivedAt: observedAt };
  const snapshot = { schemaVersion: 1, observedAt, live: false, events: [
    { ...record, eventId: 'eligible', stage: 'replied', repliedAt: observedAt, conclusion: 'accept', thread: { chatId: 'oc_test', threadId: 'omt_test' },
      ownerThreadId: 'private-thread', review: { artifact: '/private/example.md' }, rawMessage: 'private message' },
    { ...record, eventId: 'wrong-project', projectId: 'other', stage: 'queued' },
    { ...record, eventId: 'wrong-revision', revision: 2, stage: 'queued' },
    { ...record, eventId: 'malformed', stage: 'queued', receivedAt: 'yesterday' },
  ] };
  writeFileSync(file, JSON.stringify(snapshot));
  const server = createApp(store, { publicUrl: 'http://workboard.test/', agentHost: 'agent-workboard:4180', relayQueueFile: file, readOnly: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `/api/ui/tasks/${task.id}/relay-queue`;
  const response = await fetch(base + endpoint + '?revision=1');
  const content = await response.json();
  assert.equal(content.state, 'snapshot');
  assert.equal(content.total, 1);
  assert.equal(content.events[0].eventId, 'eligible');
  assert.match(content.events[0].replyUrl, /open_thread_id=omt_test$/);
  assert.doesNotMatch(JSON.stringify(content), /private|wrong-project|wrong-revision|malformed/);
  assert.equal((await fetch(base + endpoint + '?revision=2')).status, 404);
  assert.equal((await fetch(base + endpoint + '?revision=0')).status, 400);
  const host = await new Promise((resolve, reject) => {
    request(base + endpoint, { headers: { host: 'agent-workboard:4180' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }).on('error', reject).end();
  });
  assert.equal(host, 403);
  const brief = await (await fetch(base + `/api/v1/tasks/${task.id}/brief`)).json();
  assert.doesNotMatch(JSON.stringify(brief), /relay-queue|eligible/);

  writeFileSync(file, JSON.stringify({ ...snapshot, live: true, observedAt: '2020-01-01T00:00:00.000Z' }));
  assert.equal((await (await fetch(base + endpoint)).json()).state, 'stale');
  writeFileSync(file, '{partial');
  assert.deepEqual(await (await fetch(base + endpoint)).json(), { state: 'unavailable', events: [] });
});
