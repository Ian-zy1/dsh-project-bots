import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './store.mjs';
import { createApp } from './app.mjs';

function fixture(t) {
  const store = createStore(':memory:'); t.after(() => store.close());
  const project = store.createProject({ name: 'Snapshot project', repositoryUrl: 'https://gitlab.example/team/repo', environment: 'JDK 8; Maven', rules: 'Existing project rules' });
  const requirement = store.createRequirement({ projectId: project.id, title: '需求', description: '长背景'.repeat(3000) });
  const task = store.splitTasks(requirement.id, { expectedRevision: 1, tasks: [{ title: '任务一', description: '任务正文'.repeat(100), acceptance: '验证字段', sourceRef: '.project/requirements/001.md' }] }).items[0];
  return { store, project, requirement, task };
}

test('snapshot history and digests are immutable across source and status revisions', t => {
  const { store, project, requirement, task } = fixture(t);
  const original = store.getContext(task.id, 1), first = store.listSnapshots(task.id)[0];
  store.updateProject(project.id, { expectedRevision: 1, environment: 'Node 24' });
  store.updateRequirement(requirement.id, { expectedRevision: 1, description: '新背景' });
  store.updateTask(task.id, { expectedRevision: 1, title: '任务二', refreshContext: true });
  store.setStatus(task.id, { expectedRevision: 2, expectedStatusRevision: 2, status: 'ready' });
  assert.deepEqual(store.getContext(task.id, 1), original);
  assert.deepEqual(store.listSnapshots(task.id)[1], first);
  const brief = store.getBrief(task.id, 1);
  assert.equal(brief.snapshot.digest, first.digest);
  assert.equal(brief.task.title, '任务一');
  assert.equal(brief.current.revision, 2);
  assert.equal(brief.current.status, 'ready');
  assert.ok(!JSON.stringify(brief).includes('长背景'));
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) < 2500);
  assert.equal(brief.task.previewTruncated, true);
  assert.match(brief.links.task, /revision=1&section=task/);
  assert.equal(store.getContext(task.id, 2).project.environment, 'Node 24');
  assert.equal(first.sourceRef, '.project/requirements/001.md');
  assert.throws(() => store.getBrief(task.id, 999), { status: 404 });
});

test('candidate association stays pinned; replays and report metadata remain idempotent', t => {
  const { store, task } = fixture(t);
  const candidate = store.createCandidate(task.id, { executorName: 'Agent A' }, 'candidate').candidate;
  assert.equal(candidate.taskRevision, 1);
  store.updateTask(task.id, { expectedRevision: 1, description: '第二版任务' });
  assert.equal(store.createCandidate(task.id, { executorName: 'Agent A' }, 'candidate').candidate.taskRevision, 1);
  assert.equal(store.createCandidate(task.id, { executorName: 'Agent B' }, 'other').candidate.taskRevision, 2);
  assert.throws(() => store.updateCandidate(task.id, candidate.id, { expectedRevision: 1, taskRevision: 2 }), { status: 409 });
  assert.throws(() => store.createCandidate(task.id, { executorName: 'X', taskRevision: 0 }, 'bad'), { status: 400 });
  const body = { kind: 'progress', summary: '第一版结果', sourceRef: 'execution:1', submittedBy: 'Agent A', taskRevision: 1, occurredAt: '2026-11-12T01:00:00Z' };
  const first = store.createReport(task.id, candidate.id, body, 'report');
  assert.equal(first.report.taskRevision, 1);
  assert.equal(first.report.occurredAt, body.occurredAt);
  assert.equal(store.createReport(task.id, candidate.id, body, 'report').report.id, first.report.id);
  assert.throws(() => store.createReport(task.id, candidate.id, { ...body, occurredAt: '2026-11-12T02:00:00Z' }, 'report'), { status: 409 });
  assert.throws(() => store.createReport(task.id, candidate.id, { ...body, taskRevision: 2 }, 'wrong-revision'), { status: 409 });
  assert.throws(() => store.createReport(task.id, candidate.id, { ...body, occurredAt: 'yesterday' }, 'bad-date'), { status: 400 });
});

test('HTTP supports paged history, compact brief and isolated context sections', async t => {
  const { store, task } = fixture(t); const app = createApp(store);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}/api/v1/tasks/${task.id}`;
  const read = async path => { const response = await fetch(base + path); return { status: response.status, body: await response.json() }; };
  const history = await read('/snapshots?limit=1');
  assert.equal(history.body.total, 1); assert.equal(history.body.items[0].digest.length, 64);
  const section = await read('/context?revision=1&section=task');
  assert.equal(section.body.content.id, task.id); assert.equal(section.body.project, undefined);
  assert.equal((await read('/brief?revision=1')).body.snapshot.revision, 1);
  assert.equal((await read('/context?section=secrets')).status, 400);
  assert.equal((await read('/brief?revision=0')).status, 400);
  assert.equal((await read('/brief?revision=999')).status, 404);
  const markdown = await fetch(base + '/context?section=project&format=markdown');
  assert.match(await markdown.text(), /JDK 8/);
});

test('multi-repository task HTTP reads keep checked repository, base and environment frozen by revision', async t => {
  const { store, project: old, requirement, task: legacy } = fixture(t);
  const legacyContext = store.getContext(legacy.id, 1);
  const legacyDigest = store.getBrief(legacy.id, 1).snapshot.digest;
  const apiSha = 'a'.repeat(40), webSha = 'b'.repeat(40);
  const repositories = [
    { repoId: 'api', name: 'API', responsibility: '后端', repositoryUrl: 'https://example.com/team/api.git', baseline: 'main', environmentRef: 'java8-v1', verifyCommand: './mvnw test' },
    { repoId: 'web', name: 'Web', repositoryUrl: 'https://example.com/team/web.git', baseline: 'main', environmentRef: 'node24-v1', verifyCommand: 'npm test' },
  ];
  const architectureRef = { repoId: 'api', commitSha: apiSha, path: 'docs/architecture.md' };
  const project = store.updateProject(old.id, { expectedRevision: 1, repositories, architectureRef });
  const baseTask = { title: '任务', description: '按接口契约修改', acceptance: '执行定向验证' };
  const split = [
    { ...baseTask, key: 'API', repoId: 'api', baseSha: apiSha },
    { ...baseTask, key: 'WEB', repoId: 'web', baseSha: webSha, dependsOn: ['API'], verifyCommand: 'ignored' },
  ];
  assert.throws(() => store.splitTasks(requirement.id, { expectedRevision: 1, tasks: [split[0], baseTask] }), /选择.*仓库/);
  assert.equal(store.listTasks({ requirementId: requirement.id }).length, 1);
  assert.throws(() => store.splitTasks(requirement.id, { expectedRevision: 1, expectedProjectRevision: 1, tasks: split }), { status: 409 });
  for (const invalid of [{ ...split[1], repoId: 'other' }, { ...split[1], baseSha: 'main' }]) {
    assert.throws(() => store.splitTasks(requirement.id, { expectedRevision: 1, tasks: [split[0], invalid] }), { status: 400 });
  }
  assert.throws(() => store.updateProject(project.id, { expectedRevision: 2, repositories: [...repositories, repositories[0]] }), /重复/);
  assert.throws(() => store.updateProject(project.id, { expectedRevision: 2, architectureRef: { ...architectureRef, path: '../secret' } }), /相对路径|相对文件路径/);
  const [apiTask, webTask] = store.splitTasks(requirement.id, { expectedRevision: 1, expectedProjectRevision: 2, tasks: split }).items;
  assert.deepEqual(webTask.dependsOn, [apiTask.id]);
  const app = createApp(store);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}/api/v1`;
  const read = async path => {
    const r = await fetch(base + path);
    assert.ok(r.ok, path);
    return r.headers.get('content-type').startsWith('text/plain') ? r.text() : r.json();
  };
  const first = await read(`/tasks/${webTask.id}/context?revision=1&section=task`);
  assert.deepEqual(
    Object.fromEntries(['repoId', 'repositoryUrl', 'baseSha', 'environmentRef', 'verifyCommand'].map(key => [key, first.content[key]])),
    { repoId: 'web', repositoryUrl: repositories[1].repositoryUrl, baseSha: webSha, environmentRef: 'node24-v1', verifyCommand: 'npm test' },
  );
  assert.equal((await read(`/tasks/${apiTask.id}/context?revision=1`)).schemaVersion, 2);
  const oldBrief = await read(`/tasks/${webTask.id}/brief?revision=1`);
  assert.match(await read(`/tasks/${webTask.id}/context?revision=1&format=markdown`), /任务仓库[\s\S]*验证命令：npm test/);
  assert.deepEqual((await read(`/projects/${project.id}`)).architectureRef, architectureRef);

  const updated = { ...repositories[1], repositoryUrl: 'https://example.com/team/new-web.git', environmentRef: 'node26-v1' };
  store.updateProject(project.id, { expectedRevision: 2, repositories: [repositories[0], updated] });
  store.updateTask(webTask.id, { expectedRevision: 1, title: '标题修订' });
  assert.equal((await read(`/tasks/${webTask.id}/context?revision=2&section=task`)).content.environmentRef, 'node24-v1');
  assert.throws(() => store.updateTask(webTask.id, { expectedRevision: 2, refreshContext: true }), /任务基线 SHA/);
  store.updateTask(webTask.id, { expectedRevision: 2, refreshContext: true, expectedProjectRevision: 3, baseSha: 'c'.repeat(40) });
  const refreshed = await read(`/tasks/${webTask.id}/context?revision=3&section=task`);
  assert.equal(refreshed.content.baseSha, 'c'.repeat(40));
  assert.equal(refreshed.content.repositoryUrl, updated.repositoryUrl);
  assert.equal(refreshed.content.environmentRef, 'node26-v1');
  assert.deepEqual(await read(`/tasks/${webTask.id}/context?revision=1&section=task`), first);
  assert.equal((await read(`/tasks/${webTask.id}/brief?revision=1`)).snapshot.digest, oldBrief.snapshot.digest);
  assert.deepEqual(await read(`/tasks/${legacy.id}/context?revision=1`), legacyContext);
  assert.equal((await read(`/tasks/${legacy.id}/brief?revision=1`)).snapshot.digest, legacyDigest);
});
