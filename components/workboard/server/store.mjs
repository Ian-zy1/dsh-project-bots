import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 3;

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new InputError(message, status); };
const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
export const statuses = ['draft', 'ready', 'in_progress', 'blocked', 'done'];
const priorities = ['low', 'normal', 'high'];
export const reportKinds = ['progress', 'blocked', 'delivery', 'review'];
const verdicts = ['accepted', 'changes_requested', 'pending'];
const verificationStatuses = ['passed', 'failed', 'partial', 'not_run', 'unknown'];
const executorKinds = ['superagent', 'local-agent', 'human'];
const shaPattern = /^[0-9a-fA-F]{40}$/;
const idempotencyPattern = /^[A-Za-z0-9_.:-]{1,120}$/;
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('请求内容必须是对象');
  return value;
}
function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    fail(`${label}${required ? '不能为空，且' : ''}必须是最多 ${max} 字符的文本`);
  }
  return value.trim();
}
function fields(body, previous, definitions) {
  object(body);
  const result = {};
  for (const [key, [label, max, required]] of Object.entries(definitions)) {
    result[key] = text(body[key] ?? previous?.[key] ?? '', label, max, required);
  }
  return result;
}
const projectFields = { name: ['项目名', 120, true], repositoryUrl: ['仓库地址', 1000], baseline: ['基线', 200], environment: ['环境说明', 12000], rules: ['项目规则', 12000] };
const repositoryFields = {
  repoId: ['仓库标识', 80, true], name: ['仓库名称', 120, true], responsibility: ['仓库职责', 2000],
  repositoryUrl: ['仓库地址', 1000, true], baseline: ['默认基线', 200, true],
  environmentRef: ['环境标识', 100, true], verifyCommand: ['验证命令', 4000, true],
};
const requirementFields = { title: ['需求标题', 200, true], description: ['需求描述', 30000, true], plan: ['实施计划', 30000], acceptance: ['验收条件', 12000] };
const taskFields = { title: ['任务标题', 200, true], description: ['任务说明', 16000, true], acceptance: ['任务验收条件', 12000, true], sourceRef: ['任务来源', 2000] };
function optional(value, label, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) fail(`${label}必须是最多 ${max} 字符的文本`);
  return value.trim() || null;
}
function fullSha(value, label, required = false) {
  const result = optional(value, label, 40);
  if (!result) {
    if (required) fail(`${label}不能为空`);
    return null;
  }
  if (!shaPattern.test(result)) fail(`${label}必须是完整 40 位 SHA`);
  return result.toLowerCase();
}
function httpUrl(value, label) {
  const result = optional(value, label, 2000);
  if (!result) return null;
  let parsed;
  try { parsed = new URL(result); } catch { fail(`${label}必须是 http(s) 地址`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail(`${label}必须是 http(s) 地址`);
  return result;
}
function projectSpec(body, previous) {
  const spec = fields(body, previous, projectFields);
  const selected = body.repositories === undefined ? previous?.repositories : body.repositories;
  const reference = body.architectureRef === undefined ? previous?.architectureRef : body.architectureRef;
  if (selected === undefined && reference == null) return spec;
  if (!Array.isArray(selected) || selected.length > 100) fail('仓库清单必须是最多 100 项的数组');
  const repositoryIds = new Set();
  const repositories = selected.map(item => {
    const repo = fields(item, null, repositoryFields);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(repo.repoId) || repositoryIds.has(repo.repoId)) fail('仓库标识格式不正确或重复');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(repo.environmentRef)) fail('环境标识格式不正确');
    let parsed;
    try { parsed = new URL(repo.repositoryUrl); } catch { fail('仓库地址必须是有效的 HTTP(S) 地址'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || repo.repositoryUrl.includes('?') || repo.repositoryUrl.includes('#') || parsed.pathname === '/') {
      fail('仓库地址必须是无凭据、查询或片段的 HTTP(S) 仓库地址');
    }
    repositoryIds.add(repo.repoId);
    return { ...repo, repositoryUrl: parsed.href.replace(/\/$/, '') };
  });
  if (reference == null) return { ...spec, repositories };
  object(reference);
  if (!repositoryIds.has(reference.repoId)) fail('架构原件必须属于项目已登记的仓库');
  const commitSha = fullSha(reference.commitSha, '架构原件提交 SHA', true);
  const path = text(reference.path, '架构原件路径', 1000, true);
  if (/[\\\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))
    fail('架构原件路径必须是仓库内的相对文件路径');
  return { ...spec, repositories, architectureRef: { repoId: reference.repoId, commitSha, path } };
}
function taskRepository(body, previous, project) {
  const repoId = body.repoId === undefined ? previous?.repoId : body.repoId;
  if (!project.repositories?.length && repoId === undefined && body.baseSha === undefined) return {};
  const repo = project.repositories?.find(item => item.repoId === repoId);
  if (!repo) fail('任务必须选择项目已登记的仓库');
  const sameRepository = previous?.repoId === repoId && previous.repositoryUrl === repo.repositoryUrl;
  const baseSha = fullSha(body.baseSha === undefined && sameRepository ? previous.baseSha : body.baseSha, '任务基线 SHA', true);
  return { repoId: repo.repoId, repositoryUrl: repo.repositoryUrl, baseSha, environmentRef: repo.environmentRef, verifyCommand: repo.verifyCommand };
}
function oneOf(value, label, values, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`${label}不能为空`);
    return null;
  }
  if (typeof value !== 'string' || !values.includes(value)) fail(`${label}不正确`);
  return value;
}
function idempotencyKey(value) {
  if (typeof value !== 'string' || !idempotencyPattern.test(value)) fail('幂等键格式不正确（1–120 位字母、数字或 _ . : -）');
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
function contentHash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function expected(body, actual) {
  if (body.expectedRevision !== actual) fail('资料已被修改，请刷新后再保存', 409);
}
function dependencies(value) {
  if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string' || !v || v.length > 100)) fail('依赖必须是任务 ID 或拆分编号组成的数组');
  if (new Set(value).size !== value.length) fail('依赖不能重复');
  return value;
}
function validateGraph(tasks) {
  const graph = new Map(tasks.map(t => [t.id, t.dependsOn]));
  const visiting = new Set(), visited = new Set();
  function visit(key) {
    if (!graph.has(key)) fail('依赖必须属于同一需求，且对应任务必须存在');
    if (visiting.has(key)) fail('任务依赖存在循环');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of graph.get(key)) visit(dep);
    visiting.delete(key); visited.add(key);
  }
  for (const key of graph.keys()) visit(key);
}

export function createStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) { db.close(); fail('数据库版本比当前应用新，请使用对应版本的应用', 500); }
  if (version < SCHEMA_VERSION) {
    const hasTables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n > 0;
    if (hasTables && path !== ':memory:') {
      const integrity = db.prepare('PRAGMA integrity_check').get();
      if (integrity.integrity_check !== 'ok') { db.close(); fail('数据库完整性检查失败，请先备份并检查本地数据库', 500); }
      const backup = `${path}.pre-v${SCHEMA_VERSION}.${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.bak`;
      db.prepare('VACUUM INTO ?').run(backup);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requirements (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requirement_versions (id TEXT NOT NULL REFERENCES requirements(id), revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,revision));
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), requirement_id TEXT NOT NULL REFERENCES requirements(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS task_versions (id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,revision));
        CREATE TABLE IF NOT EXISTS batches (key TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), idempotency_key TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(task_id, idempotency_key));
        CREATE TABLE IF NOT EXISTS candidate_reports (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), candidate_id TEXT NOT NULL REFERENCES candidates(id), idempotency_key TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(candidate_id, idempotency_key));
        CREATE INDEX IF NOT EXISTS requirements_project ON requirements(project_id);
        CREATE INDEX IF NOT EXISTS tasks_requirement ON tasks(requirement_id);
        CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS candidates_task ON candidates(task_id);
        CREATE INDEX IF NOT EXISTS candidate_reports_candidate ON candidate_reports(candidate_id);
        CREATE INDEX IF NOT EXISTS candidate_reports_task ON candidate_reports(task_id);
        CREATE TABLE IF NOT EXISTS dispatch_records (
          task_id TEXT NOT NULL, revision INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
          hash TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(task_id, idempotency_key),
          FOREIGN KEY(task_id, revision) REFERENCES task_versions(id, revision)
        );
        CREATE INDEX IF NOT EXISTS dispatch_records_snapshot ON dispatch_records(task_id, revision);
        PRAGMA user_version=3;
      `);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
    if (db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION) { db.close(); fail('数据库升级未完成，请恢复备份后重试', 500); }
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function get(table, key) {
    if (typeof key !== 'string' || !key || key.length > 100) fail('资料 ID 不正确');
    const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(key);
    if (!row) fail('未找到对应资料', 404);
    return JSON.parse(row.data);
  }
  const all = table => db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC`).all().map(r => JSON.parse(r.data));
  const put = (table, value) => db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), value.id);
  function saveRequirement(value, initial = false) {
    if (initial) db.prepare('INSERT INTO requirements VALUES (?,?,?)').run(value.id, value.projectId, JSON.stringify(value));
    else put('requirements', value);
    db.prepare('INSERT INTO requirement_versions VALUES (?,?,?)').run(value.id, value.revision, JSON.stringify(value));
    return value;
  }
  function saveTask(value, context, initial = false) {
    if (initial) db.prepare('INSERT INTO tasks VALUES (?,?,?,?)').run(value.id, value.projectId, value.requirementId, JSON.stringify(value));
    else put('tasks', value);
    db.prepare('INSERT INTO task_versions VALUES (?,?,?)').run(value.id, value.revision, JSON.stringify(context));
    return value;
  }
  function contextFor(task, project, requirement) {
    const { status: _status, statusRevision: _statusRevision, updatedAt: _updated, ...spec } = task;
    return {
      schemaVersion: task.repoId === undefined ? 1 : 2,
      snapshotCreatedAt: now(),
      task: spec,
      project,
      requirement,
      authorization: '本记录提供任务上下文，不自动授权开工、评审、合入或部署；以该次明确派活的授权阶段为准。',
    };
  }
  function context(taskId, revision) {
    const task = get('tasks', taskId);
    const row = db.prepare('SELECT data FROM task_versions WHERE id=? AND revision=?').get(taskId, revision ?? task.revision);
    if (!row) fail('未找到该任务版本', 404);
    return JSON.parse(row.data);
  }
  function snapshotInfo(value) {
    return { taskId: value.task.id, revision: value.task.revision, title: value.task.title,
      projectRevision: value.project.revision, requirementRevision: value.requirement.revision,
      savedAt: value.snapshotCreatedAt ?? null, sourceRef: value.task.sourceRef ?? null,
      digest: contentHash(value), contentBytes: Buffer.byteLength(JSON.stringify(value)) };
  }
  function snapshotRevision(taskId, requested) {
    if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) fail('快照版本必须是正整数');
    const value = context(taskId, requested);
    return value.task.revision;
  }
  function taskDetail(task) {
    const requirement = get('requirements', task.requirementId);
    const project = get('projects', task.projectId);
    const projectRevision = task.projectRevision ?? context(task.id).project.revision;
    return { ...task, requirementTitle: requirement.title, currentRequirementRevision: requirement.revision,
      projectRevision, currentProjectRevision: project.revision, statusRevision: task.statusRevision ?? 1,
      contextOutdated: task.requirementRevision !== requirement.revision || projectRevision !== project.revision,
      dependencies: task.dependsOn.map(key => { const dep = get('tasks', key); return { id: key, title: dep.title, status: dep.status }; }),
    };
  }
  function taskSpec(body, previous) {
    const value = fields(body, previous, taskFields);
    value.priority = body.priority ?? previous?.priority ?? 'normal';
    if (!priorities.includes(value.priority)) fail('任务优先级不正确');
    value.dependsOn = dependencies(body.dependsOn ?? previous?.dependsOn ?? []);
    return value;
  }
  function candidateValues(body, previous) {
    object(body);
    const pick = key => Object.prototype.hasOwnProperty.call(body, key) ? body[key] : previous?.[key];
    return {
      executorName: text(pick('executorName'), '执行者', 200, true),
      executorKind: oneOf(pick('executorKind'), '执行方式', executorKinds),
      method: optional(pick('method'), '执行方式说明', 500),
      sourceRef: optional(pick('sourceRef'), '来源引用', 2000),
      baseSha: fullSha(pick('baseSha'), '基线 SHA'),
      branch: optional(pick('branch'), '分支', 200),
      prUrl: httpUrl(pick('prUrl'), 'PR/MR 地址'),
      sha: fullSha(pick('sha'), '候选 SHA'),
    };
  }
  function candidateRow(taskId, candidateId) {
    if (typeof candidateId !== 'string' || !candidateId || candidateId.length > 100) fail('候选 ID 不正确');
    get('tasks', taskId);
    const row = db.prepare('SELECT data FROM candidates WHERE id=? AND task_id=?').get(candidateId, taskId);
    if (!row) fail('未找到该任务下的候选', 404);
    return JSON.parse(row.data);
  }
  function reportsFor(candidateId) {
    return db.prepare('SELECT data FROM candidate_reports WHERE candidate_id=? ORDER BY rowid DESC').all(candidateId).map(row => JSON.parse(row.data));
  }
  function candidateView(candidate) {
    const reports = reportsFor(candidate.id);
    const latestReports = {};
    const currentReviews = {};
    for (const report of reports) {
      if (report.kind === 'review' && candidate.sha && report.reviewedSha === candidate.sha) {
        currentReviews[report.reviewRole ?? 'unspecified'] ??= report;
      }
    }
    for (const report of reports) if (!latestReports[report.kind]) latestReports[report.kind] = report;
    const review = latestReports.review ?? null;
    const delivery = latestReports.delivery ?? null;
    return {
      ...candidate,
      latestReports, currentReviews,
      lastReportAt: reports[0]?.at ?? null,
      reportCount: reports.length,
      reviewStale: Boolean(review) && (!candidate.sha || review.reviewedSha !== candidate.sha),
      verificationStale: Boolean(delivery?.verification) && (!candidate.sha || delivery.sha !== candidate.sha),
    };
  }
  function reportValues(body) {
    object(body);
    const kind = oneOf(body.kind, '回报类型', reportKinds, true);
    const value = {
      kind,
      summary: text(body.summary, '回报摘要', 8000, true),
      sourceRef: text(body.sourceRef, '来源引用', 2000, true),
      submittedBy: text(body.submittedBy, '提交者', 200, true),
      sha: null, reviewedSha: null, verdict: null, reviewedBy: null, prUrl: null, verification: null,
    };
    if (body.taskRevision !== undefined) {
      if (!Number.isInteger(body.taskRevision) || body.taskRevision < 1) fail('快照版本必须是正整数');
      value.taskRevision = body.taskRevision;
    }
    if (body.occurredAt !== undefined) {
      if (typeof body.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(body.occurredAt) || !Number.isFinite(Date.parse(body.occurredAt))) fail('发生时间需为有效 ISO 时间文本');
      value.occurredAt = body.occurredAt;
    }
    if (kind === 'delivery') {
      value.prUrl = httpUrl(body.prUrl, '交付 PR/MR 地址');
      value.sha = fullSha(body.sha, '交付 SHA');
      if (body.verification !== undefined && body.verification !== null) {
        object(body.verification);
        if (!value.sha) fail('带验证证据的交付回报必须提供完整交付 SHA');
        value.verification = {
          status: oneOf(body.verification.status, '验证状态', verificationStatuses, true),
          summary: optional(body.verification.summary, '验证摘要', 4000),
          evidenceRef: optional(body.verification.evidenceRef, '验证证据引用', 2000),
        };
      }
    } else if (kind === 'review') {
      value.reviewedSha = fullSha(body.reviewedSha, '评审 SHA', true);
      value.verdict = oneOf(body.verdict, '评审结论', verdicts, true);
      value.reviewedBy = optional(body.reviewedBy, '原评审者', 200);
      if (body.reviewRole !== undefined) value.reviewRole = oneOf(body.reviewRole, '评审角色', ['independent', 'owner'], true);
    }
    return value;
  }
  const store = {
    close: () => db.close(),
    listProjects: () => all('projects').map(p => ({ ...p, requirementCount: db.prepare('SELECT count(*) AS n FROM requirements WHERE project_id=?').get(p.id).n, taskCount: db.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(p.id).n })),
    getProject: key => get('projects', key),
    createProject(body) {
      const value = { ...projectSpec(body, null), id: id('prj'), revision: 1, createdAt: now(), updatedAt: now() };
      db.prepare('INSERT INTO projects VALUES (?,?)').run(value.id, JSON.stringify(value));
      return value;
    },
    updateProject(key, body) {
      object(body);
      return transaction(() => {
        const old = get('projects', key);
        expected(body, old.revision);
        const value = { ...projectSpec(body, old), id: old.id, createdAt: old.createdAt, revision: old.revision + 1, updatedAt: now() };
        put('projects', value);
        return value;
      });
    },
    listRequirements(projectId) {
      if (projectId) get('projects', projectId);
      return all('requirements').filter(r => !projectId || r.projectId === projectId).map(r => ({ ...r, taskCount: db.prepare('SELECT count(*) AS n FROM tasks WHERE requirement_id=?').get(r.id).n }));
    },
    getRequirement(key, revision) {
      if (revision === undefined) return get('requirements', key);
      const row = db.prepare('SELECT data FROM requirement_versions WHERE id=? AND revision=?').get(key, revision);
      if (!row) fail('未找到该需求版本', 404);
      return JSON.parse(row.data);
    },
    createRequirement(body) {
      object(body); get('projects', body.projectId);
      const value = { ...fields(body, null, requirementFields), id: id('req'), projectId: body.projectId, revision: 1, createdAt: now(), updatedAt: now() };
      return transaction(() => saveRequirement(value, true));
    },
    updateRequirement(key, body) {
      object(body);
      return transaction(() => { const old = get('requirements', key); expected(body, old.revision); return saveRequirement({ ...old, ...fields(body, old, requirementFields), revision: old.revision + 1, updatedAt: now() }); });
    },
    listTasks({ projectId, requirementId, status } = {}) {
      if (projectId) get('projects', projectId);
      if (requirementId) get('requirements', requirementId);
      if (status && !statuses.includes(status)) fail('任务状态不正确');
      return all('tasks').filter(t => (!projectId || t.projectId === projectId) && (!requirementId || t.requirementId === requirementId) && (!status || t.status === status)).map(taskDetail);
    },
    getTask: key => taskDetail(get('tasks', key)),
    getContext: context,
    listSnapshots(taskId) {
      get('tasks', taskId);
      return db.prepare('SELECT data FROM task_versions WHERE id=? ORDER BY revision DESC').all(taskId).map(row => snapshotInfo(JSON.parse(row.data)));
    },
    getBrief(taskId, revision) {
      const value = context(taskId, revision), current = taskDetail(get('tasks', taskId));
      const info = snapshotInfo(value), base = `/api/v1/tasks/${taskId}/context?revision=${info.revision}`;
      return { snapshot: info, task: { id: taskId, title: value.task.title, priority: value.task.priority, dependsOn: value.task.dependsOn,
        descriptionPreview: value.task.description.slice(0, 240), previewTruncated: value.task.description.length > 240 },
        current: { revision: current.revision, status: current.status, contextOutdated: current.contextOutdated },
        links: { task: base + '&section=task', requirement: base + '&section=requirement', project: base + '&section=project', full: base, markdown: base + '&format=markdown', candidates: `/api/v1/tasks/${taskId}/candidates` },
        boundary: '摘要不是完整任务或执行许可；按明确派活指令读取固定版本，必要时获取完整验收与背景。current 是当前记录，不属于固定快照。' };
    },
    listDispatchRecords(taskId, requested) {
      const revision = snapshotRevision(taskId, requested);
      return db.prepare(`SELECT data FROM dispatch_records WHERE task_id=? AND revision=? ORDER BY json_extract(data, '$.occurredAt') DESC, rowid DESC`)
        .all(taskId, revision).map(row => JSON.parse(row.data));
    },
    createDispatchRecord(taskId, body, key) {
      object(body);
      idempotencyKey(key);
      if (!Number.isInteger(body.taskRevision) || body.taskRevision < 1) fail('taskRevision 必须是正整数');
      const occurredAt = text(body.occurredAt, 'occurredAt', 40, true);
      if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) {
        fail('occurredAt 必须为带时区的 ISO 时间');
      }
      const value = {
        taskId, taskRevision: body.taskRevision,
        outcome: oneOf(body.outcome, 'outcome', ['received', 'accepted', 'assessment_timeout', 'failed'], true),
        occurredAt: new Date(occurredAt).toISOString(),
        sourceRef: text(body.sourceRef, 'sourceRef', 2000, true),
        summary: text(body.summary, 'summary', 1000, true),
        nextAction: optional(body.nextAction, 'nextAction', 500),
        ticketRef: optional(body.ticketRef, 'ticketRef', 2000),
      };
      const digest = contentHash(value);
      return transaction(() => {
        snapshotRevision(taskId, body.taskRevision);
        const replay = db.prepare('SELECT hash,data FROM dispatch_records WHERE task_id=? AND idempotency_key=?').get(taskId, key);
        if (replay) {
          if (replay.hash !== digest) fail('该幂等键已用于另一条派活记录', 409);
          return { record: JSON.parse(replay.data), replayed: true };
        }
        const record = { ...value, id: id('dsp') };
        db.prepare('INSERT INTO dispatch_records VALUES (?,?,?,?,?)').run(taskId, value.taskRevision, key, digest, JSON.stringify(record));
        return { record, replayed: false };
      });
    },
    listCandidates(taskId) {
      get('tasks', taskId);
      return db.prepare('SELECT data FROM candidates WHERE task_id=? ORDER BY rowid ASC').all(taskId).map(row => candidateView(JSON.parse(row.data)));
    },
    createCandidate(taskId, body, key) {
      idempotencyKey(key);
      const value = candidateValues(body, null);
      const taskRevision = snapshotRevision(taskId, body.taskRevision);
      if (body.taskRevision !== undefined) value.taskRevision = taskRevision;
      const digest = contentHash(value);
      return transaction(() => {
        get('tasks', taskId);
        const replay = db.prepare('SELECT hash,data FROM candidates WHERE task_id=? AND idempotency_key=?').get(taskId, key);
        if (replay) {
          if (replay.hash !== digest) fail('该幂等键已用于另一份候选内容', 409);
          return { candidate: candidateView(JSON.parse(replay.data)), replayed: true };
        }
        const candidate = { ...value, taskRevision, id: id('cnd'), taskId, revision: 1, createdAt: now(), updatedAt: now() };
        db.prepare('INSERT INTO candidates (id,task_id,idempotency_key,hash,data) VALUES (?,?,?,?,?)').run(candidate.id, taskId, key, digest, JSON.stringify(candidate));
        return { candidate: candidateView(candidate), replayed: false };
      });
    },
    updateCandidate(taskId, candidateId, body) {
      object(body);
      return transaction(() => {
        const old = candidateRow(taskId, candidateId);
        expected(body, old.revision);
        if (body.taskRevision !== undefined) {
          snapshotRevision(taskId, body.taskRevision);
          if (old.taskRevision != null && old.taskRevision !== body.taskRevision) fail('已有候选不能改绑任务快照；请创建新的候选', 409);
        }
        const value = { ...old, ...candidateValues(body, old), revision: old.revision + 1, updatedAt: now() };
        if (body.taskRevision !== undefined) value.taskRevision = body.taskRevision;
        db.prepare('UPDATE candidates SET data=? WHERE id=? AND task_id=?').run(JSON.stringify(value), candidateId, taskId);
        return candidateView(value);
      });
    },
    listReports(taskId, candidateId) {
      candidateRow(taskId, candidateId);
      return reportsFor(candidateId);
    },
    createReport(taskId, candidateId, body, key) {
      idempotencyKey(key);
      const value = reportValues(body);
      const digest = contentHash(value);
      return transaction(() => {
        const candidate = candidateRow(taskId, candidateId);
        const replay = db.prepare('SELECT hash,data FROM candidate_reports WHERE candidate_id=? AND idempotency_key=?').get(candidateId, key);
        if (replay) {
          if (replay.hash !== digest) fail('该幂等键已用于另一条回报内容', 409);
          return { report: JSON.parse(replay.data), replayed: true };
        }
        if (value.kind === 'delivery' && value.sha && value.sha !== candidate.sha) {
          if (!candidate.sha) fail('候选尚无当前 SHA，请先更新候选 SHA 后再回报交付证据', 409);
          fail('交付 SHA 必须与候选当前 SHA 一致；请先更新候选 SHA', 409);
        }
        if (body.taskRevision !== undefined && body.taskRevision !== candidate.taskRevision) fail('回报快照版本与候选不一致', 409);
        const report = { ...value, taskRevision: candidate.taskRevision ?? null, occurredAt: body.occurredAt ?? null, id: id('rpt'), taskId, candidateId, at: now() };
        db.prepare('INSERT INTO candidate_reports (id,task_id,candidate_id,idempotency_key,hash,data) VALUES (?,?,?,?,?,?)').run(report.id, taskId, candidateId, key, digest, JSON.stringify(report));
        return { report, replayed: false };
      });
    },
    splitTasks(requirementId, body, key) {
      object(body);
      if (!Array.isArray(body.tasks) || !body.tasks.length || body.tasks.length > 100) fail('每次提交 1–100 项拆分任务');
      if (key && (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(key))) fail('幂等键格式不正确');
      const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const batchKey = key ? `${requirementId}:${key}` : null;
      return transaction(() => {
        if (batchKey) {
          const replay = db.prepare('SELECT hash,data FROM batches WHERE key=?').get(batchKey);
          if (replay) { if (replay.hash !== hash) fail('该幂等键已用于另一份拆分内容', 409); return JSON.parse(replay.data); }
        }
        const requirement = get('requirements', requirementId); expected(body, requirement.revision);
        const project = get('projects', requirement.projectId);
        if (body.expectedProjectRevision !== undefined && body.expectedProjectRevision !== project.revision) fail('项目资料已修改，请刷新仓库清单后再保存', 409);
        const keys = new Map();
        const tasks = body.tasks.map((item, index) => {
          object(item);
          const alias = item.key ?? `T${index + 1}`;
          if (typeof alias !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(alias) || keys.has(alias) || alias.startsWith('tsk_')) fail('拆分编号需唯一，使用 T1 等短编号');
          const value = { ...taskSpec(item), ...taskRepository(item, undefined, project),
            id: id('tsk'), projectId: project.id, projectRevision: project.revision, requirementId, requirementRevision: requirement.revision,
            revision: 1, statusRevision: 1, status: 'draft', createdAt: now(), updatedAt: now() };
          keys.set(alias, value.id); return value;
        });
        for (const task of tasks) task.dependsOn = task.dependsOn.map(dep => keys.get(dep) ?? dep);
        validateGraph([...all('tasks').filter(t => t.requirementId === requirementId), ...tasks]);
        for (const task of tasks) saveTask(task, contextFor(task, project, requirement), true);
        const result = { items: tasks, keys: Object.fromEntries(keys) };
        if (batchKey) db.prepare('INSERT INTO batches VALUES (?,?,?)').run(batchKey, hash, JSON.stringify(result));
        return result;
      });
    },
    updateTask(key, body) {
      object(body);
      return transaction(() => {
        const old = get('tasks', key); expected(body, old.revision);
        const previous = context(key);
        const requirement = body.refreshContext === true ? get('requirements', old.requirementId) : previous.requirement;
        const project = body.refreshContext === true ? get('projects', old.projectId) : previous.project;
        if (body.expectedProjectRevision !== undefined && body.expectedProjectRevision !== project.revision) fail('项目资料已修改，请刷新仓库清单后再保存', 409);
        const value = { ...old, ...taskSpec(body, old), ...taskRepository(body, previous.task, project),
          status: 'draft', statusRevision: (old.statusRevision ?? 1) + 1, revision: old.revision + 1,
          projectRevision: project.revision, requirementRevision: requirement.revision, updatedAt: now() };
        validateGraph([...all('tasks').filter(t => t.requirementId === old.requirementId && t.id !== key), value]);
        saveTask(value, contextFor(value, project, requirement)); return taskDetail(value);
      });
    },
    setStatus(key, body) {
      object(body);
      return transaction(() => {
        const old = get('tasks', key); expected(body, old.revision);
        if (body.expectedStatusRevision !== (old.statusRevision ?? 1)) fail('任务状态已被修改，请刷新后重试', 409);
        if (!statuses.includes(body.status)) fail('任务状态不正确');
        if (body.status === 'ready' || body.status === 'in_progress') {
          if (taskDetail(old).contextOutdated) fail('需求或项目背景已修订，请先显式更新任务上下文', 409);
          if (old.dependsOn.some(dep => get('tasks', dep).status !== 'done')) fail('还有未完成的依赖任务', 409);
        }
        const value = { ...old, status: body.status, statusRevision: (old.statusRevision ?? 1) + 1, updatedAt: now() }; put('tasks', value); return taskDetail(value);
      });
    },
  };
  return store;
}
