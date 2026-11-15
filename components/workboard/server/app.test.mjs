import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createStore } from './store.mjs';
import { createApp } from './app.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workboard-http-'));
  writeFileSync(join(dir, 'index.html'), '<html>workboard</html>');
  const store = createStore(':memory:');
  const server = createApp(store, { dist: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', value, headers = {}) => fetch(base + path, { method, headers: { ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { base, request };
}
test('HTTP creates real work and provides one-task JSON and Markdown context', async t => {
  const { request } = await fixture(t);
  const p = await (await request('/api/v1/projects', 'POST', { name: 'HTTP 项目', environment: 'JDK 8' })).json();
  const r = await (await request('/api/v1/requirements', 'POST', { projectId: p.id, title: '接口需求', description: '需求上下文' })).json();
  const response = await request(`/api/v1/requirements/${r.id}/tasks`, 'POST', { expectedRevision: 1, tasks: [{ title: '接口实现', description: '增加字段', acceptance: '返回字段值' }] }, { 'idempotency-key': 'http-first' });
  assert.equal(response.status, 201);
  const split = await response.json(), key = split.items[0].id;
  const result = await request(`/api/v1/tasks/${key}/context?revision=1`);
  const context = await result.json(); assert.equal(context.project.environment, 'JDK 8'); assert.equal(context.requirement.description, '需求上下文');
  const markdown = await request(`/api/v1/tasks/${key}/context?revision=1&format=markdown`);
  assert.match(markdown.headers.get('content-type'), /text\/plain/); assert.match(await markdown.text(), /返回字段值/);
  const listing = await (await request(`/api/v1/tasks?projectId=${p.id}&limit=1`)).json();
  assert.equal(listing.total, 1); assert.equal(listing.items[0].id, key);
  assert.equal((await request(`/api/v1/tasks/${key}/context?revision=2`)).status, 404);
  assert.equal((await request(`/api/v1/tasks/${key}/context?revision=1.5`)).status, 400);
});
test('local boundary rejects cross-origin requests and invalid Host without changing data', async t => {
  const { request, base } = await fixture(t);
  for (const headers of [{ origin: 'https://example.com' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await request('/api/v1/projects', 'POST', { name: '不应保存' }, headers)).status, 403, JSON.stringify(headers));
  }
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(base + '/api/v1/projects', { headers: { host: 'outside.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await request('/', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 200);
  assert.equal((await (await request('/api/v1/projects')).json()).total, 0);
});
test('malformed inputs give bounded client errors and static assets are served', async t => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/api/v1/requirements', 'POST', { title: '无项目', description: '无项目' })).status, 400);
  assert.equal((await request('/api/v1/projects', 'POST', { name: '' })).status, 400);
  assert.equal((await fetch(base + '/api/v1/projects', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/api/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await request('/api/v1/projects?limit=0')).status, 400);
  assert.equal((await request('/api/v1/projects?limit=201')).status, 400);
  assert.equal((await request('/api/v1/missing')).status, 404);
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/missing.js')).status, 404);
  const huge = await request('/api/v1/projects', 'POST', { name: 'oversize', rules: 'x'.repeat(530000) });
  assert.equal(huge.status, 413);
});
