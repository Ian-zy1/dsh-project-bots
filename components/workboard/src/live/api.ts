import { apiPath } from './urls';

export async function api<T>(path: string, method = 'GET', body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const response = await fetch(apiPath(path), {
    method,
    headers: body === undefined ? extraHeaders : { 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error('无法读取服务响应，请确认访问入口、认证和服务状态。'); }
  if (!response.ok) throw new Error((value as { error?: string }).error ?? `请求失败（${response.status}）`);
  return value as T;
}
export async function list<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  while (true) {
    const page = await api<{ items: T[]; total: number }>(`${path}${path.includes('?') ? '&' : '?'}limit=200&offset=${offset}`);
    items.push(...page.items);
    offset += page.items.length;
    if (offset >= page.total || page.items.length === 0) return items;
  }
}
