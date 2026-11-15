import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createApp } from './app.mjs';
import { createStore } from './store.mjs';
import { startupConfig } from './config.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

async function fixture(t, readOnly = false, agentHost, dispatchAuthorization) {
  const store = createStore(':memory:');
  const project = store.createProject({ name: '项目', repositoryUrl: 'http://git.test/team/app.git' });
  const req = store.createRequirement({ projectId: project.id, title: '需求', description: '固定背景' });
  const task = store.splitTasks(req.id, { expectedRevision: 1, tasks: [{ title: '任务', description: '背景', acceptance: '完整验收' }] }, 'split').items[0];
  const server = createApp(store, { publicUrl: 'https://workboard.test/aw/', readOnly, agentHost, dispatchAuthorization });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const call = (path, headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method,
      headers: { host: 'workboard.test', ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.on('data', x => { text += x; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  return { call, task, store };
}

test('configured proxy accepts its exact host/origin and returns prefixed brief links', async t => {
  const { call, task } = await fixture(t);
  const response = await call(`/api/v1/tasks/${task.id}/brief?revision=1`, { origin: 'https://workboard.test' });
  assert.equal(response.status, 200);
  assert.ok(Object.values(response.body.links).every(link => link.startsWith('/aw/api/v1/')));
  assert.equal((await call(`/api/v1/tasks/${task.id}/context?revision=1&section=task`)).body.content.acceptance, '完整验收');
  assert.equal((await call('/api/health', { host: '127.0.0.1' })).status, 200);
});

test('forwarded headers cannot authorize an unknown host or cross-origin writes', async t => {
  const { call, store } = await fixture(t);
  const before = store.listProjects().length;
  assert.equal((await call('/api/v1/projects', { host: 'outside.test', 'x-forwarded-host': 'workboard.test' }, 'POST')).status, 403);
  assert.equal((await call('/api/v1/projects', { origin: 'https://outside.test' }, 'POST')).status, 403);
  assert.equal((await call('/api/v1/projects', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(store.listProjects().length, before);
});

test('explicit private Agent host accepts only non-browser GET API reads', async t => {
  const { call, task } = await fixture(t, false, 'agent-workboard:4180');
  const headers = { host: 'agent-workboard:4180' };
  assert.equal((await call(`/api/v1/tasks/${task.id}/context?revision=1&section=task`, headers)).body.content.acceptance, '完整验收');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await call('/api/v1/projects', headers, method)).status, 403);
  assert.equal((await call('/api/v1/projects', { ...headers, origin: 'https://workboard.test' })).status, 403);
  assert.equal((await call('/api/v1/projects', { ...headers, 'sec-fetch-site': 'same-origin' })).status, 403);
  assert.equal((await call('/', headers)).status, 403);
  assert.equal((await call('/api/v1/../../', headers)).status, 403);
  assert.equal((await call('/api/v1/projects', { host: 'other-agent:4180' })).status, 403);
  const { call: unconfigured } = await fixture(t);
  assert.equal((await unconfigured('/api/v1/projects', headers)).status, 403);
});

test('private Agent host configuration is explicit and cannot contain URL credentials or paths', () => {
  const base = { WORKBOARD_PUBLIC_URL: 'http://public.test/aw/' };
  assert.equal(startupConfig({ ...base, WORKBOARD_AGENT_HOST: 'agent-workboard:4180' }).agentHost, 'agent-workboard:4180');
  assert.throws(() => startupConfig({ WORKBOARD_AGENT_HOST: 'agent-workboard:4180' }));
  for (const value of ['http://agent:4180', 'user:pass@agent:4180', 'agent:4180/path', 'agent:0', 'agent:65536']) assert.throws(() => startupConfig({ ...base, WORKBOARD_AGENT_HOST: value }));
});

test('only an authenticated private dispatch writer can post dispatch records', async t => {
  const authorization = 'Bearer ' + 'a'.repeat(64);
  const host = 'agent-workboard:4180';
  const { call, task, store } = await fixture(t, false, host, authorization);
  const path = `/api/v1/tasks/${task.id}/dispatch-records`;
  const base = { host, 'idempotency-key': 'dispatch-008' };
  const trusted = { ...base, authorization };
  const body = {
    taskRevision: 1, outcome: 'accepted', summary: 'Ticket created',
    ticketRef: 'ticket-example', sourceRef: 'feishu:message/example', occurredAt: '2026-11-15T00:00:00Z',
  };
  assert.equal((await call(path, base, 'POST', body)).status, 403);
  assert.equal((await call(path, { ...base, authorization: 'Bearer ' + 'b'.repeat(64) }, 'POST', body)).status, 403);
  assert.equal((await call(path, { ...trusted, origin: 'http://' + host }, 'POST', body)).status, 403);
  assert.equal((await call('/api/v1/projects', trusted, 'POST', { name: 'Unexpected' })).status, 403);
  assert.equal((await call(path, trusted, 'POST', body)).status, 201);
  assert.equal((await call(path, trusted, 'POST', body)).status, 200);
  assert.equal(store.listDispatchRecords(task.id, 1).length, 1);
});

test('migration mirror allows reads and rejects writes without changing the store', async t => {
  const { call, store } = await fixture(t, true);
  assert.equal((await call('/api/v1/projects')).status, 200);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await call('/api/v1/projects', {}, method)).status, 503);
  assert.equal((await call('/api/health')).body.readOnly, true);
  assert.equal(store.listProjects().length, 1);
});

test('public listening is explicit; malformed public URLs fail before opening the database', () => {
  assert.equal(startupConfig({}).host, '127.0.0.1');
  assert.throws(() => startupConfig({ WORKBOARD_HOST: '0.0.0.0' }), /requires/);
  for (const value of ['http://example.test/aw', 'http://user:pass@example.test/aw/', 'http://example.test/aw/?x=1', 'http://example.test/a/../aw/']) {
    assert.throws(() => startupConfig({ WORKBOARD_PUBLIC_URL: value }));
  }
  assert.equal(startupConfig({ WORKBOARD_HOST: '0.0.0.0', WORKBOARD_PUBLIC_URL: 'http://example.test/aw/' }).host, '0.0.0.0');
});

test('consistent backup preserves live WAL records and fixed task IDs without closing the source', t => {
  const dir = mkdtempSync(join(tmpdir(), 'workboard-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = createStore(join(dir, 'source.sqlite'));
  try {
    const project = source.createProject({ name: '迁移项目' });
    const req = source.createRequirement({ projectId: project.id, title: '迁移需求', description: '背景' });
    const task = source.splitTasks(req.id, { expectedRevision: 1, tasks: [{ title: '迁移任务', description: '固定内容', acceptance: '不丢快照' }] }, 'backup').items[0];
    const expected = source.getContext(task.id, 1);
    execFileSync(process.execPath, ['deployment/backup-database.mjs', join(dir, 'source.sqlite'), join(dir, 'backup.sqlite')]);
    const copy = createStore(join(dir, 'backup.sqlite'));
    try { assert.deepEqual(copy.getContext(task.id, 1), expected); }
    finally { copy.close(); }
    assert.equal(source.getProject(project.id).name, '迁移项目');
  } finally { source.close(); }
});
