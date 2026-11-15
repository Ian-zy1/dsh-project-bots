import { createServer as httpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export class ValidationError extends Error {}

async function payload(request) {
  if (!request.headers['content-type']?.split(';')[0] || request.headers['content-type'].split(';')[0].trim() !== 'application/json') {
    throw new ValidationError('请使用 JSON 请求。');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) throw new ValidationError('请求内容超出限制。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ValidationError('请求内容不是有效的 JSON。'); }
}

export function createServer(file, domain) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  domain.init(db);
  const json = (res, status, value) => res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(value));
  const server = httpServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && assets.has(path)) {
        const [name, type] = assets.get(path);
        const body = await readFile(new URL('../web/' + name, import.meta.url));
        return res.writeHead(200, {'Content-Type':type, 'X-Content-Type-Options':'nosniff'}).end(body);
      }
      if (req.method === 'GET' && path === '/api/overview') return json(res, 200, domain.overview(db));
      if (req.method === 'POST' && path === domain.createPath) return json(res, 201, domain.create(db, await payload(req)));
      const resolution = /^\/api\/incidents\/([1-9][0-9]*)\/resolve$/.exec(path);
      if (req.method === 'POST' && resolution && domain.resolve) {
        return json(res, 200, domain.resolve(db, Number(resolution[1])));
      }
      json(res, 404, {error:'找不到请求的内容。'});
    } catch (error) {
      if (error instanceof ValidationError) return json(res, 400, {error:error.message});
      console.error(error);
      json(res, 500, {error:'暂时无法处理，请稍后重试。'});
    }
  });
  server.on('close', () => db.close());
  return server;
}

export function inputText(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new ValidationError(label + '不能为空，最多 ' + max + ' 字。');
  return text;
}
