import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from './store.mjs';

const sha = char => char.repeat(40);
function fixture(t, path = ':memory:') {
  const store = createStore(path); t.after(() => store.close());
  const project = store.createProject({ name: '交付项目', repositoryUrl: 'https://example.com/repo', baseline: '617dd99', environment: 'Node 24', rules: '本地验证' });
  const requirement = store.createRequirement({ projectId: project.id, title: '交付需求', description: '记录候选回报', plan: '加法实现', acceptance: '回报可查' });
  return { store, project, requirement };
}
const taskItem = (key, dependsOn = []) => ({ key, title: `${key} 实施`, description: `${key} 说明`, acceptance: `${key} 验收`, dependsOn });
function split(store, requirement, key = 'T1') {
  return store.splitTasks(requirement.id, { expectedRevision: requirement.revision, tasks: [taskItem(key)] }).items[0];
}
function candidateBody(overrides = {}) {
  return { executorName: 'Worker A', executorKind: 'superagent', method: 'DSH Ticket', sourceRef: 'issue#6', baseSha: sha('a'), branch: 'agent/candidate', prUrl: 'https://example.com/pull/7', sha: sha('b'), ...overrides };
}
function reportBody(kind, overrides = {}) {
  return { kind, summary: `${kind} 摘要`, sourceRef: 'https://example.com/evidence/1', submittedBy: 'Worker A', ...overrides };
}

test('candidate creation is idempotent per task and candidates stay independent', t => {
  const { store, requirement } = fixture(t);
  const task = split(store, requirement);
  const first = store.createCandidate(task.id, candidateBody(), 'candidate-a');
  const replay = store.createCandidate(task.id, candidateBody(), 'candidate-a');
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.candidate.id, first.candidate.id);
  assert.throws(() => store.createCandidate(task.id, candidateBody({ branch: 'agent/other' }), 'candidate-a'), { status: 409 });

  const second = store.createCandidate(task.id, candidateBody({ executorName: 'Worker B', sha: null }), 'candidate-b');
  assert.equal(second.replayed, false);
  const minimal = store.createCandidate(task.id, { executorName: 'Minimal Worker' }, 'candidate-c').candidate;
  assert.equal(minimal.method, null);
  assert.equal(minimal.baseSha, null);
  assert.equal(minimal.sha, null);
  assert.equal(store.listCandidates(task.id).length, 3);

  assert.throws(() => store.createCandidate(task.id, candidateBody(), undefined), { status: 400 });
  assert.throws(() => store.createCandidate(task.id, candidateBody({ sha: 'abc' }), 'candidate-d'), { status: 400 });
  assert.throws(() => store.createCandidate(task.id, candidateBody({ executorKind: 'unknown-kind' }), 'candidate-e'), { status: 400 });
  assert.throws(() => store.createCandidate(task.id, candidateBody({ prUrl: 'ftp://example.com/pull' }), 'candidate-f'), { status: 400 });
});

test('reports append once per idempotency key and insist on task ownership', t => {
  const { store, project, requirement } = fixture(t);
  const task = split(store, requirement);
  const other = store.createRequirement({ projectId: project.id, title: '其他需求', description: '其他背景' });
  const otherTask = split(store, other);
  const candidate = store.createCandidate(task.id, candidateBody(), 'candidate-a').candidate;
  const otherCandidate = store.createCandidate(otherTask.id, candidateBody(), 'candidate-b').candidate;

  const progress = reportBody('progress', { summary: '开始执行' });
  const first = store.createReport(task.id, candidate.id, progress, 'report-1');
  const replay = store.createReport(task.id, candidate.id, progress, 'report-1');
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.report.id, first.report.id);
  assert.throws(() => store.createReport(task.id, candidate.id, { ...progress, summary: '不同内容' }, 'report-1'), { status: 409 });

  store.createReport(task.id, candidate.id, reportBody('blocked', { summary: '等待环境' }), 'report-2');
  store.createReport(task.id, candidate.id, reportBody('delivery', {
    summary: '候选已提交', prUrl: 'https://example.com/pull/7', sha: sha('b'),
    verification: { status: 'passed', summary: 'npm test / npm run build', evidenceRef: 'run-1' },
  }), 'report-3');
  store.createReport(task.id, candidate.id, reportBody('review', {
    summary: '独立评审通过', reviewedSha: sha('b'), verdict: 'accepted',
  }), 'report-4');

  const reports = store.listReports(task.id, candidate.id);
  assert.equal(reports.length, 4);
  assert.equal(reports[0].kind, 'review');
  assert.equal(reports[1].kind, 'delivery');
  const view = store.listCandidates(task.id)[0];
  assert.equal(view.reportCount, 4);
  assert.equal(view.latestReports.progress.summary, '开始执行');
  assert.equal(view.latestReports.blocked.summary, '等待环境');
  assert.equal(view.latestReports.review.verdict, 'accepted');
  assert.equal(view.reviewStale, false);
  assert.equal(view.verificationStale, false);

  assert.throws(() => store.createReport(task.id, otherCandidate.id, progress, 'report-5'), { status: 404 });
  assert.throws(() => store.listReports(otherTask.id, candidate.id), { status: 404 });
  assert.throws(() => store.createReport(task.id, candidate.id, reportBody('review', { verdict: 'accepted' }), 'report-6'), { status: 400 });
  assert.throws(() => store.createReport(task.id, candidate.id, reportBody('delivery', { sha: sha('c'), verification: { status: 'passed' } }), 'report-7'), { status: 409 });
  assert.throws(() => store.createReport(task.id, candidate.id, reportBody('delivery', { verification: { status: 'passed' } }), 'report-8'), { status: 400 });
});

test('candidate SHA updates keep evidence but mark old verification and review stale', t => {
  const { store, requirement } = fixture(t);
  const task = split(store, requirement);
  const candidate = store.createCandidate(task.id, candidateBody({ sha: sha('a') }), 'candidate-a').candidate;
  store.createReport(task.id, candidate.id, reportBody('delivery', {
    sha: sha('a'), verification: { status: 'passed', summary: '旧版本验证', evidenceRef: 'run-old' },
  }), 'report-delivery');
  store.createReport(task.id, candidate.id, reportBody('review', {
    reviewedSha: sha('a'), verdict: 'accepted', summary: '旧版本评审通过',
  }), 'report-review');

  const updated = store.updateCandidate(task.id, candidate.id, { expectedRevision: 1, sha: sha('b') });
  assert.equal(updated.revision, 2);
  assert.equal(updated.sha, sha('b'));
  assert.equal(store.listReports(task.id, candidate.id).length, 2);
  const view = store.listCandidates(task.id)[0];
  assert.equal(view.latestReports.review.reviewedSha, sha('a'));
  assert.equal(view.reviewStale, true);
  assert.equal(view.verificationStale, true);
  assert.throws(() => store.updateCandidate(task.id, candidate.id, { expectedRevision: 1, sha: sha('c') }), { status: 409 });

  const branchOnly = store.updateCandidate(task.id, candidate.id, { expectedRevision: 2, branch: 'agent/updated' });
  assert.equal(branchOnly.sha, sha('b'));
  assert.equal(branchOnly.revision, 3);
  assert.equal(store.listCandidates(task.id)[0].reviewStale, true);
});

test('candidates and reports survive a database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workboard-delivery-'));
  let store;
  try {
    const path = join(dir, 'delivery.sqlite');
    store = createStore(path);
    const project = store.createProject({ name: '持久化项目' });
    const requirement = store.createRequirement({ projectId: project.id, title: '持久化需求', description: '重启后仍可读' });
    const task = split(store, requirement);
    const candidate = store.createCandidate(task.id, candidateBody(), 'candidate-a').candidate;
    store.createReport(task.id, candidate.id, reportBody('progress', { summary: '重启前写入' }), 'report-1');
    store.close();
    store = createStore(path);
    assert.equal(store.listCandidates(task.id).length, 1);
    assert.equal(store.listCandidates(task.id)[0].latestReports.progress.summary, '重启前写入');
    assert.equal(store.listReports(task.id, candidate.id).length, 1);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function createV1Database(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE requirements (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
    CREATE TABLE requirement_versions (id TEXT NOT NULL REFERENCES requirements(id), revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,revision));
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), requirement_id TEXT NOT NULL REFERENCES requirements(id), data TEXT NOT NULL);
    CREATE TABLE task_versions (id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,revision));
    CREATE TABLE batches (key TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL);
    PRAGMA user_version=1;
  `);
  const createdAt = '2026-11-11T06:00:00.000Z';
  const project = { id: 'prj_legacy', name: '旧项目', repositoryUrl: 'https://example.com/legacy', baseline: 'e24d04d', environment: 'Node 24', rules: '旧规则', revision: 1, createdAt, updatedAt: createdAt };
  const requirement = { id: 'req_legacy', projectId: project.id, title: '旧需求', description: '旧需求描述', plan: '旧计划', acceptance: '旧验收', revision: 1, createdAt, updatedAt: createdAt };
  const task = { id: 'tsk_legacy', projectId: project.id, projectRevision: 1, requirementId: requirement.id, requirementRevision: 1, revision: 1, statusRevision: 1, title: '旧任务', description: '旧任务说明', acceptance: '旧任务验收', priority: 'normal', dependsOn: [], status: 'draft', createdAt, updatedAt: createdAt };
  const context = {
    schemaVersion: 1,
    task: { id: task.id, projectId: task.projectId, projectRevision: 1, requirementId: task.requirementId, requirementRevision: 1, revision: 1, title: task.title, description: task.description, acceptance: task.acceptance, priority: task.priority, dependsOn: [], createdAt, updatedAt: createdAt },
    project,
    requirement,
    authorization: 'legacy authorization',
  };
  db.prepare('INSERT INTO projects VALUES (?,?)').run(project.id, JSON.stringify(project));
  db.prepare('INSERT INTO requirements VALUES (?,?,?)').run(requirement.id, project.id, JSON.stringify(requirement));
  db.prepare('INSERT INTO requirement_versions VALUES (?,?,?)').run(requirement.id, 1, JSON.stringify(requirement));
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?)').run(task.id, project.id, requirement.id, JSON.stringify(task));
  db.prepare('INSERT INTO task_versions VALUES (?,?,?)').run(task.id, 1, JSON.stringify(context));
  db.close();
  return { project, requirement, task, context };
}

test('v1 database upgrades in place with a backup and unchanged fixed contexts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workboard-migrate-'));
  let store;
  try {
    const path = join(dir, 'legacy.sqlite');
    const legacy = createV1Database(path);
    store = createStore(path);
    assert.deepEqual(store.getProject(legacy.project.id), legacy.project);
    assert.deepEqual(store.getRequirement(legacy.requirement.id), legacy.requirement);
    assert.deepEqual(store.getContext(legacy.task.id), legacy.context);
    assert.equal(store.listTasks().length, 1);
    assert.equal(store.listCandidates(legacy.task.id).length, 0);
    store.close();
    store = createStore(path);
    assert.deepEqual(store.getContext(legacy.task.id), legacy.context);
    store.close();
    store = null;

    const db = new DatabaseSync(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    db.close();
    assert.ok(tables.includes('candidates'));
    assert.ok(tables.includes('candidate_reports'));
    assert.equal(readdirSync(dir).filter(name => name.startsWith('legacy.sqlite.pre-v3.')).length, 1);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a database newer than this app is refused without touching it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workboard-newer-'));
  try {
    const path = join(dir, 'newer.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version=4;');
    db.close();
    assert.throws(() => createStore(path), { status: 500 });
    const check = new DatabaseSync(path);
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 4);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatch records survive without a candidate and stay on their fixed snapshot', t => {
  const { store, requirement } = fixture(t);
  const task = split(store, requirement);
  const body = { taskRevision: 1, outcome: 'assessment_timeout', occurredAt: '2026-11-13T15:24:00+08:00',
    summary: '派活超时，Worker 未启动', sourceRef: 'https://example.com/messages/1' };
  const first = store.createDispatchRecord(task.id, body, 'dispatch-1');
  assert.equal(store.createDispatchRecord(task.id, body, 'dispatch-1').record.id, first.record.id);
  assert.throws(() => store.createDispatchRecord(task.id, { ...body, summary: '不同' }, 'dispatch-1'), { status: 409 });
  assert.throws(() => store.createDispatchRecord(task.id, { ...body, taskRevision: 999 }, 'wrong-version'), { status: 404 });
  store.createDispatchRecord(task.id, { ...body, outcome: 'received', occurredAt: '2026-11-13T15:18:00+08:00' }, 'dispatch-2');
  assert.deepEqual(store.listDispatchRecords(task.id, 1).map(record => record.outcome), ['assessment_timeout', 'received']);
  store.updateTask(task.id, { expectedRevision: 1, title: '新版本' });
  assert.deepEqual(store.listDispatchRecords(task.id), []);
  assert.equal(store.listDispatchRecords(task.id, 1).length, 2);
  assert.deepEqual(store.listCandidates(task.id), []);
});

test('independent and Owner review evidence is scoped to the current candidate SHA', t => {
  const { store, requirement } = fixture(t);
  const task = split(store, requirement);
  const { candidate } = store.createCandidate(task.id, candidateBody(), 'candidate-1');
  for (const role of ['independent', 'owner']) {
    store.createReport(task.id, candidate.id, reportBody('review', {
      reviewRole: role, reviewedSha: sha('b'), verdict: 'accepted',
    }), role);
  }
  assert.deepEqual(Object.keys(store.listCandidates(task.id)[0].currentReviews).sort(), ['independent', 'owner']);
  store.updateCandidate(task.id, candidate.id, { expectedRevision: 1, sha: sha('c') });
  assert.deepEqual(store.listCandidates(task.id)[0].currentReviews, {});
  assert.equal(store.listReports(task.id, candidate.id).length, 2);
});
