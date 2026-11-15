import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.mjs';
import { createApp } from './app.mjs';

const sha = char => char.repeat(40);

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workboard-delivery-http-'));
  writeFileSync(join(dir, 'index.html'), '<html>workboard</html>');
  const store = createStore(':memory:');
  const server = createApp(store, { dist: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', value, headers = {}) => fetch(base + path, { method, headers: { ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: value === undefined ? undefined : JSON.stringify(value) });
  const project = await (await request('/api/v1/projects', 'POST', { name: '交付 HTTP 项目', environment: 'Node 24' })).json();
  const requirement = await (await request('/api/v1/requirements', 'POST', { projectId: project.id, title: '交付 HTTP 需求', description: '回报可写可查' })).json();
  const split = await (await request(`/api/v1/requirements/${requirement.id}/tasks`, 'POST', { expectedRevision: requirement.revision, tasks: [{ title: '交付 HTTP 任务', description: '实现回报', acceptance: '回报可查' }] }, { 'idempotency-key': 'http-task' })).json();
  return { request, project, requirement, task: split.items[0] };
}

const candidateBody = {
  executorName: 'HTTP Worker', executorKind: 'superagent', method: 'DSH Ticket', sourceRef: 'issue#6',
  baseSha: sha('a'), branch: 'agent/http-candidate', prUrl: 'https://example.com/pull/9', sha: sha('b'),
};
const reportBody = (kind, overrides = {}) => ({ kind, summary: `${kind} 摘要`, sourceRef: 'https://example.com/evidence/http', submittedBy: 'HTTP Worker', ...overrides });

test('HTTP candidate and report routes enforce idempotency and SHA staleness', async t => {
  const { request, task } = await fixture(t);
  const taskPath = `/api/v1/tasks/${task.id}/candidates`;

  const created = await request(taskPath, 'POST', candidateBody, { 'idempotency-key': 'candidate-http-1' });
  assert.equal(created.status, 201);
  const candidate = await created.json();
  const replay = await request(taskPath, 'POST', candidateBody, { 'idempotency-key': 'candidate-http-1' });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).id, candidate.id);
  assert.equal((await request(taskPath, 'POST', { ...candidateBody, branch: 'agent/other' }, { 'idempotency-key': 'candidate-http-1' })).status, 409);
  assert.equal((await request(taskPath, 'POST', candidateBody)).status, 400);

  const list = await (await request(taskPath)).json();
  assert.equal(list.total, 1);
  assert.deepEqual(list.items[0].latestReports, {});
  assert.equal(list.items[0].lastReportAt, null);

  const progress = reportBody('progress', { summary: '开始实现' });
  const firstReport = await request(`${taskPath}/${candidate.id}/reports`, 'POST', progress, { 'idempotency-key': 'report-http-1' });
  assert.equal(firstReport.status, 201);
  const report = await firstReport.json();
  const reportReplay = await request(`${taskPath}/${candidate.id}/reports`, 'POST', progress, { 'idempotency-key': 'report-http-1' });
  assert.equal(reportReplay.status, 200);
  assert.equal((await reportReplay.json()).id, report.id);

  assert.equal((await request(`${taskPath}/${candidate.id}/reports`, 'POST', reportBody('delivery', { sha: sha('b'), verification: { status: 'passed', summary: '测试通过' } }), { 'idempotency-key': 'report-http-2' })).status, 201);
  assert.equal((await request(`${taskPath}/${candidate.id}/reports`, 'POST', reportBody('review', { reviewedSha: sha('b'), verdict: 'accepted' }), { 'idempotency-key': 'report-http-3' })).status, 201);

  const reports = await (await request(`${taskPath}/${candidate.id}/reports?limit=2`)).json();
  assert.equal(reports.total, 3);
  assert.equal(reports.items.length, 2);
  assert.equal(reports.items[0].kind, 'review');

  const updated = await request(`${taskPath}/${candidate.id}`, 'PUT', { expectedRevision: 1, sha: sha('c') });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).sha, sha('c'));
  const stale = await (await request(taskPath)).json();
  assert.equal(stale.items[0].reviewStale, true);
  assert.equal(stale.items[0].verificationStale, true);
  assert.equal((await request(`${taskPath}/${candidate.id}`, 'PUT', { expectedRevision: 1, sha: sha('d') })).status, 409);

  assert.equal((await request(`${taskPath}/${candidate.id}/reports`, 'POST', reportBody('progress'), { 'idempotency-key': 'report-http-1' })).status, 409);
  assert.equal((await request(`${taskPath}/${candidate.id}/reports`, 'POST', reportBody('progress'))).status, 400);
  assert.equal((await request(`${taskPath}/${candidate.id}/reports`, 'POST', reportBody('review', { verdict: 'accepted' }), { 'idempotency-key': 'report-http-4' })).status, 400);
});

test('HTTP reports reject candidates that belong to another task', async t => {
  const { request, project, task } = await fixture(t);
  const otherRequirement = await (await request('/api/v1/requirements', 'POST', { projectId: project.id, title: '其他 HTTP 需求', description: '其他背景' })).json();
  const otherSplit = await (await request(`/api/v1/requirements/${otherRequirement.id}/tasks`, 'POST', { expectedRevision: 1, tasks: [{ title: '其他任务', description: '其他说明', acceptance: '其他验收' }] }, { 'idempotency-key': 'other-task' })).json();
  const otherTask = otherSplit.items[0];
  const candidate = await (await request(`/api/v1/tasks/${otherTask.id}/candidates`, 'POST', candidateBody, { 'idempotency-key': 'other-candidate' })).json();
  assert.equal((await request(`/api/v1/tasks/${task.id}/candidates/${candidate.id}/reports`, 'POST', reportBody('progress'), { 'idempotency-key': 'cross-task' })).status, 404);
  assert.equal((await request(`/api/v1/tasks/${task.id}/candidates`, 'POST', candidateBody, { 'idempotency-key': 'other-candidate' })).status, 201);
});
