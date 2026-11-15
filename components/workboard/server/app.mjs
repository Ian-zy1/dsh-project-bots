import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { InputError, SCHEMA_VERSION } from './store.mjs';
import { publicUrl as parsePublicUrl } from './config.mjs';
import { taskRelayQueue } from './relay-queue.mjs';
import { timingSafeEqual } from 'node:crypto';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
export function contextMarkdown(context) {
  const { task: t, project: p, requirement: r } = context;
  const execution = t.repoId ? `## 任务仓库\n${t.repoId} · ${t.repositoryUrl}\n\n基线 SHA：${t.baseSha}\n环境标识：${t.environmentRef}\n验证命令：${t.verifyCommand}\n\n` : '';
  const repositories = p.repositories?.length
    ? p.repositories.map(repo => `- ${repo.name}（${repo.repoId}）· ${repo.repositoryUrl} · ${repo.baseline}`).join('\n')
    : `仓库：${p.repositoryUrl || '尚未填写'}\n基线：${p.baseline || '尚未填写'}`;
  const architecture = p.architectureRef ? `\n\n架构原件：${p.architectureRef.repoId}@${p.architectureRef.commitSha}:${p.architectureRef.path}` : '';
  return `# ${t.title}\n\n任务 ID：${t.id} · 任务版本：${t.revision} · 需求版本：${r.revision}\n\n## 任务说明\n${t.description}\n\n## 任务验收\n${t.acceptance}\n\n${execution}## 依赖\n${t.dependsOn.join('\n') || '无'}\n\n## 需求：${r.title}\n${r.description}\n\n### 实施计划\n${r.plan || '尚未填写'}\n\n### 需求验收\n${r.acceptance || '尚未填写'}\n\n## 项目：${p.name}\n${repositories}${architecture}\n\n### 环境\n${p.environment || '尚未填写'}\n\n### 项目规则\n${p.rules || '尚未填写'}\n\n## 授权边界\n${context.authorization}\n`;
}
const contextValue = value => Array.isArray(value) && value.every(item => typeof item === 'string')
  ? value.join(', ') : value && typeof value === 'object' ? JSON.stringify(value, null, 2) : value;
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new InputError('请使用 application/json 请求', 415);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) throw new InputError('请求内容超过 512 KiB', 413);
    chunks.push(chunk);
  }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new InputError('请求内容不是有效的 JSON 对象'); }
}
function revision(url) {
  if (!url.searchParams.has('revision')) return undefined;
  const raw = url.searchParams.get('revision');
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw new InputError('版本必须是正整数');
  return Number(raw);
}
function page(items, url) {
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 100);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new InputError('分页参数不正确（limit 1–200）');
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
}
const dispatchPath = /^\/api\/v1\/tasks\/([\w-]+)\/dispatch-records$/;
function validDispatchAuthorization(actual, expected) {
  if (!expected || typeof actual !== 'string') return false;
  const supplied = Buffer.from(actual);
  const secret = Buffer.from(expected);
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}
export function createApp(store, { dist = resolve('dist'), publicUrl, agentHost, dispatchAuthorization,
  ownerWriteLocalOnly = false, readOnly = false, relayQueueFile } = {}) {
  const external = parsePublicUrl(publicUrl);
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    function send(status, data, type = 'application/json; charset=utf-8') {
      res.statusCode = status; res.setHeader('Content-Type', type);
      res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
    }
    try {
      // An explicit public URL permits one authenticated proxy host; forwarded headers never expand trust.
      const host = req.headers.host ?? '';
      const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
      const url = new URL(req.url, `http://${host}`);
      const privateAgent = !!agentHost && host === agentHost && !req.headers.origin && !req.headers['sec-fetch-site'];
      const agentRead = privateAgent && req.method === 'GET' && url.pathname.startsWith('/api/v1/');
      const dispatchWrite = privateAgent && req.method === 'POST' && dispatchPath.test(url.pathname)
        && validDispatchAuthorization(req.headers.authorization, dispatchAuthorization);
      if (!local && host !== external?.host && !agentRead && !dispatchWrite) throw new InputError('请求 Host 不在配置的入口范围内', 403);
      const origin = external && host === external.host ? external.origin : url.origin;
      if (req.headers.origin && req.headers.origin !== origin) throw new InputError('不接受跨站请求', 403);
      if (url.pathname.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') throw new InputError('不接受跨站请求', 403);
      const method = req.method;
      const path = url.pathname.replace(/\/$/, '') || '/';
      const read = method === 'GET' || method === 'HEAD';
      const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (ownerWriteLocalOnly && !read && !localPeer && !dispatchWrite) throw new InputError('通过本机 Owner 入口执行写入', 403);
      if (path === '/api/health' && method === 'GET') return send(200, { status: 'ok', mode: external ? 'proxy' : 'local', readOnly, schemaVersion: SCHEMA_VERSION });
      const queueTask = path.match(/^\/api\/ui\/tasks\/([\w-]+)\/relay-queue$/);
      if (queueTask && method === 'GET') {
        const task = store.getTask(queueTask[1]);
        const selectedRevision = revision(url) ?? task.revision;
        if (selectedRevision > task.revision) throw new InputError('任务版本不存在', 404);
        return send(200, await taskRelayQueue(relayQueueFile, task, selectedRevision));
      }
      if (readOnly && !read) throw new InputError('迁移期间此实例仅供读取，请使用当前维护入口写入', 503);
      if (path === '/api/v1/projects') {
        if (method === 'GET') return send(200, page(store.listProjects(), url));
        if (method === 'POST') return send(201, store.createProject(await body(req)));
      }
      let match = path.match(/^\/api\/v1\/projects\/([\w-]+)$/);
      if (match) {
        if (method === 'GET') return send(200, store.getProject(match[1]));
        if (method === 'PUT') return send(200, store.updateProject(match[1], await body(req)));
      }
      if (path === '/api/v1/requirements') {
        if (method === 'GET') return send(200, page(store.listRequirements(url.searchParams.get('projectId')), url));
        if (method === 'POST') return send(201, store.createRequirement(await body(req)));
      }
      match = path.match(/^\/api\/v1\/requirements\/([\w-]+)(\/tasks)?$/);
      if (match) {
        if (match[2] && method === 'POST') return send(201, store.splitTasks(match[1], await body(req), req.headers['idempotency-key']));
        if (!match[2] && method === 'GET') return send(200, store.getRequirement(match[1], revision(url)));
        if (!match[2] && method === 'PUT') return send(200, store.updateRequirement(match[1], await body(req)));
      }
      if (path === '/api/v1/tasks' && method === 'GET') return send(200, page(store.listTasks(Object.fromEntries(['projectId', 'requirementId', 'status'].map(k => [k, url.searchParams.get(k)]))), url));
      match = path.match(/^\/api\/v1\/tasks\/([\w-]+)\/(snapshots|brief)$/);
      if (match && method === 'GET') {
        if (match[2] === 'snapshots') return send(200, page(store.listSnapshots(match[1]), url));
        const brief = store.getBrief(match[1], revision(url));
        const prefix = external?.pathname.replace(/\/$/, '') ?? '';
        return send(200, { ...brief, links: Object.fromEntries(Object.entries(brief.links).map(([key, value]) => [key, prefix + value])) });
      }
      match = path.match(dispatchPath);
      if (match && method === 'GET') return send(200, page(store.listDispatchRecords(match[1], revision(url)), url));
      if (match && method === 'POST') {
        const result = store.createDispatchRecord(match[1], await body(req), req.headers['idempotency-key']);
        return send(result.replayed ? 200 : 201, result.record);
      }
      match = path.match(/^\/api\/v1\/tasks\/([\w-]+)\/candidates$/);
      if (match) {
        const taskId = match[1];
        if (method === 'GET') return send(200, page(store.listCandidates(taskId), url));
        if (method === 'POST') {
          const result = store.createCandidate(taskId, await body(req), req.headers['idempotency-key']);
          return send(result.replayed ? 200 : 201, result.candidate);
        }
      }
      match = path.match(/^\/api\/v1\/tasks\/([\w-]+)\/candidates\/([\w-]+)(\/reports)?$/);
      if (match) {
        const taskId = match[1], candidateId = match[2];
        if (match[3]) {
          if (method === 'GET') return send(200, page(store.listReports(taskId, candidateId), url));
          if (method === 'POST') {
            const result = store.createReport(taskId, candidateId, await body(req), req.headers['idempotency-key']);
            return send(result.replayed ? 200 : 201, result.report);
          }
        } else if (method === 'PUT') {
          return send(200, store.updateCandidate(taskId, candidateId, await body(req)));
        }
      }
      match = path.match(/^\/api\/v1\/tasks\/([\w-]+)(\/(context|status))?$/);
      if (match) {
        const key = match[1], action = match[3];
        if (method === 'GET' && !action) return send(200, store.getTask(key));
        if (method === 'PUT' && !action) return send(200, store.updateTask(key, await body(req)));
        if (method === 'PATCH' && action === 'status') return send(200, store.setStatus(key, await body(req)));
        if (method === 'GET' && action === 'context') {
          const context = store.getContext(key, revision(url));
          const section = url.searchParams.get('section') ?? 'all';
          if (!['all', 'task', 'requirement', 'project'].includes(section)) throw new InputError('section 必须为 all / task / requirement / project');
          if (section !== 'all') {
            const value = { taskId: key, revision: context.task.revision, section, content: context[section], authorization: context.authorization };
            return url.searchParams.get('format') === 'markdown' ? send(200, `# ${section} · ${key} v${context.task.revision}\n\n${Object.entries(context[section]).map(([k, v]) => `${k}: ${contextValue(v)}`).join('\n\n')}\n\n${context.authorization}`, 'text/plain; charset=utf-8') : send(200, value);
          }
          return url.searchParams.get('format') === 'markdown' ? send(200, contextMarkdown(context), 'text/plain; charset=utf-8') : send(200, context);
        }
      }
      if (path.startsWith('/api/')) throw new InputError('接口不存在或不支持该方法', 404);
      if (method !== 'GET' && method !== 'HEAD') throw new InputError('不支持该方法', 405);
      const decoded = decodeURIComponent(path);
      const file = resolve(dist, '.' + decoded);
      if (file !== dist && !file.startsWith(dist + sep)) throw new InputError('路径不正确', 404);
      const target = extname(decoded) ? file : resolve(dist, 'index.html');
      try { return send(200, await readFile(target), mime[extname(target)] ?? 'application/octet-stream'); }
      catch { return send(404, { error: '页面资源不存在，请先执行 npm run build' }); }
    } catch (error) {
      if (error instanceof InputError) return send(error.status, { error: error.message });
      if (error instanceof URIError) return send(400, { error: '请求地址不正确' });
      console.error('[workboard] Request failed:', error instanceof Error ? error.message : 'unknown error');
      return send(500, { error: '服务读取或保存失败，请检查本地服务日志' });
    }
  });
}
