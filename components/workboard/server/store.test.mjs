import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.mjs';

function fixture(t, path = ':memory:') {
  const store = createStore(path); t.after(() => store.close());
  const project = store.createProject({ name: 'API 项目', repositoryUrl: 'https://example.com/repo', baseline: 'main', environment: 'Node 24', rules: '先确认计划，再实现' });
  const requirement = store.createRequirement({ projectId: project.id, title: '增加时间筛选', description: '接受起止毫秒时间', plan: '接口参数透传', acceptance: '只改变趋势查询' });
  return { store, project, requirement };
}
const task = (key, dependsOn = []) => ({ key, title: `${key} 实施`, description: `${key} 具体实现范围`, acceptance: `${key} 验收标准`, dependsOn });

test('empty store, real records and context survive a database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workboard-db-'));
  let store;
  try {
    const path = join(dir, 'tasks.sqlite');
    store = createStore(path); assert.deepEqual(store.listProjects(), []);
    const p = store.createProject({ name: '持久化项目', environment: 'JDK 8' });
    const r = store.createRequirement({ projectId: p.id, title: '真实需求', description: '真实描述' });
    const { items } = store.splitTasks(r.id, { expectedRevision: 1, tasks: [task('T1')] }, 'batch-1');
    store.close(); store = createStore(path);
    assert.equal(store.getContext(items[0].id).project.environment, 'JDK 8');
    assert.equal(store.listTasks({ projectId: p.id }).length, 1);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('split maps aliases, binds one requirement revision and replays atomically', t => {
  const { store, requirement } = fixture(t);
  const body = { expectedRevision: 1, tasks: [task('T1'), task('T2', ['T1'])] };
  const first = store.splitTasks(requirement.id, body, 'same-request');
  const replay = store.splitTasks(requirement.id, body, 'same-request');
  assert.deepEqual(replay, first);
  assert.equal(store.listTasks().length, 2);
  assert.deepEqual(first.items[1].dependsOn, [first.items[0].id]);
  assert.equal(store.getContext(first.items[1].id).requirement.revision, 1);
  assert.throws(() => store.splitTasks(requirement.id, { ...body, tasks: [task('T3')] }, 'same-request'), { status: 409 });
});

test('cycles, unknown dependencies, duplicate aliases and invalid items roll back entire split', t => {
  const { store, requirement } = fixture(t);
  for (const tasks of [[task('T1', ['T2']), task('T2', ['T1'])], [task('T1'), task('T2', ['missing'])], [task('T1'), task('T1')], [task('T1'), { ...task('T2'), acceptance: '' }]]) {
    assert.throws(() => store.splitTasks(requirement.id, { expectedRevision: 1, tasks }), { status: 400 });
    assert.equal(store.listTasks().length, 0);
  }
});

test('dependencies cannot cross project or requirement boundaries', t => {
  const { store, requirement } = fixture(t);
  const first = store.splitTasks(requirement.id, { expectedRevision: 1, tasks: [task('T1')] }).items[0];
  const project = store.createProject({ name: '独立项目' });
  const other = store.createRequirement({ projectId: project.id, title: '独立需求', description: '单独背景' });
  assert.throws(() => store.splitTasks(other.id, { expectedRevision: 1, tasks: [task('T2', [first.id])] }), { status: 400 });
  assert.equal(store.listTasks({ projectId: project.id }).length, 0);
  assert.equal(store.listRequirements(project.id).length, 1);
});

test('editing a requirement or project preserves old task context; explicit refresh versions it', t => {
  const { store, requirement, project } = fixture(t);
  const first = store.splitTasks(requirement.id, { expectedRevision: 1, tasks: [task('T1')] }).items[0];
  const old = store.getContext(first.id);
  store.updateRequirement(requirement.id, { expectedRevision: 1, description: '新需求描述' });
  store.updateProject(project.id, { expectedRevision: 1, environment: 'Node 26' });
  assert.deepEqual(store.getContext(first.id, 1), old);
  assert.equal(store.getTask(first.id).contextOutdated, true);
  assert.throws(() => store.setStatus(first.id, { expectedRevision: 1, expectedStatusRevision: 1, status: 'ready' }), { status: 409 });
  const revised = store.updateTask(first.id, { expectedRevision: 1, refreshContext: true });
  assert.equal(revised.revision, 2); assert.equal(revised.status, 'draft');
  assert.equal(store.getContext(first.id).requirement.description, '新需求描述');
  assert.equal(store.getContext(first.id).project.environment, 'Node 26');
  assert.deepEqual(store.getContext(first.id, 1), old);
  assert.equal(store.getRequirement(requirement.id, 1).description, requirement.description);
});

test('stale edits and stale splits cannot overwrite new work', t => {
  const { store, requirement, project } = fixture(t);
  store.updateProject(project.id, { expectedRevision: 1, name: '新标题' });
  assert.throws(() => store.updateProject(project.id, { expectedRevision: 1, name: '旧请求' }), { status: 409 });
  store.updateRequirement(requirement.id, { expectedRevision: 1, description: '新描述' });
  assert.throws(() => store.updateRequirement(requirement.id, { expectedRevision: 1, description: '旧请求' }), { status: 409 });
  assert.throws(() => store.splitTasks(requirement.id, { expectedRevision: 1, tasks: [task('T1')] }), { status: 409 });
  assert.equal(store.listTasks().length, 0);
});

test('status changes respect dependencies and do not mutate versioned task specs', t => {
  const { store, requirement } = fixture(t);
  const [a, b] = store.splitTasks(requirement.id, { expectedRevision: 1, tasks: [task('T1'), task('T2', ['T1'])] }).items;
  const before = store.getContext(b.id);
  assert.throws(() => store.setStatus(b.id, { expectedRevision: 1, expectedStatusRevision: 1, status: 'ready' }), { status: 409 });
  store.setStatus(a.id, { expectedRevision: 1, expectedStatusRevision: 1, status: 'done' });
  assert.equal(store.setStatus(b.id, { expectedRevision: 1, expectedStatusRevision: 1, status: 'ready' }).status, 'ready');
  assert.deepEqual(store.getContext(b.id), before);
  assert.throws(() => store.updateTask(a.id, { expectedRevision: 1, dependsOn: [b.id] }), { status: 400 });
});

test('project-only changes expose an explicit refresh and preserve the old snapshot', t => {
  const { store, project, requirement } = fixture(t);
  const first = store.splitTasks(requirement.id, { expectedRevision: 1, tasks: [task('T1')] }).items[0];
  store.updateProject(project.id, { expectedRevision: 1, environment: '新环境' });
  assert.equal(store.getTask(first.id).contextOutdated, true);
  assert.equal(store.getTask(first.id).currentProjectRevision, 2);
  const next = store.updateTask(first.id, { expectedRevision: 1, refreshContext: true });
  assert.equal(next.contextOutdated, false);
  assert.equal(store.getContext(first.id).project.environment, '新环境');
  assert.equal(store.getContext(first.id, 1).project.environment, 'Node 24');
});

test('stale status writes are rejected without changing task context revision', t => {
  const { store, requirement } = fixture(t);
  const first = store.splitTasks(requirement.id, { expectedRevision: 1, tasks: [task('T1')] }).items[0];
  const next = store.setStatus(first.id, { expectedRevision: 1, expectedStatusRevision: 1, status: 'ready' });
  assert.equal(next.revision, 1); assert.equal(next.statusRevision, 2);
  assert.throws(() => store.setStatus(first.id, { expectedRevision: 1, expectedStatusRevision: 1, status: 'blocked' }), { status: 409 });
  assert.equal(store.getTask(first.id).status, 'ready');
});

test('task edits preserve frozen backgrounds, add history, and reject stale task writes', t => {
  const { store, requirement } = fixture(t);
  const first = store.splitTasks(requirement.id, { expectedRevision: 1, tasks: [task('T1')] }).items[0];
  const old = store.getContext(first.id);
  const edited = store.updateTask(first.id, { expectedRevision: 1, title: '新的实施标题' });
  assert.equal(edited.revision, 2);
  assert.equal(store.getContext(first.id).task.title, '新的实施标题');
  assert.deepEqual(store.getContext(first.id, 1), old);
  assert.throws(() => store.updateTask(first.id, { expectedRevision: 1, title: '过时内容' }), { status: 409 });
});
