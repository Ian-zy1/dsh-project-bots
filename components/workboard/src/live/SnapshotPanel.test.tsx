import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SnapshotPanel from './SnapshotPanel';
import type { LocalCandidate, LocalTask } from './types';

const task = { id: 'tsk_one', revision: 2, title: '当前任务', priority: 'normal', description: '第二版正文' } as LocalTask;
const snapshots = [2, 1].map(revision => ({ taskId: task.id, revision, title: `版本${revision}标题`, projectRevision: 1, requirementRevision: revision, savedAt: null, sourceRef: 'file:requirement', digest: String(revision).repeat(64), contentBytes: 1400 }));
function setup() {
  history.replaceState(null, '', '/');
  const requests: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost'); requests.push(url.pathname + url.search);
    const revision = Number(url.searchParams.get('revision') || 2), section = url.searchParams.get('section');
    const content = { task: { id: task.id, revision, title: `版本${revision}标题`, description: `版本${revision}正文`, acceptance: '验收' }, requirement: { revision, title: '需求', description: '需求背景' }, project: { revision: 1, name: '项目', environment: 'JDK 8' } };
    return { ok: true, status: 200, json: async () => url.pathname.endsWith('/snapshots') ? { items: snapshots, total: 2 } : section ? { taskId: task.id, revision, section, content: content[section as keyof typeof content], authorization: '读取不是派活' } : content } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  const onSelect = vi.fn();
  render(<SnapshotPanel task={task} candidates={[]} candidatesLoading={false} candidatesError="" onRetry={() => {}} onSelect={onSelect} />);
  return { requests, onSelect, user: userEvent.setup() };
}
afterEach(() => vi.unstubAllGlobals());

describe('snapshot reading', () => {
  it('starts with only task content and fetches project background on demand', async () => {
    const { requests, user } = setup();
    expect(await screen.findByText('版本2正文')).toBeInTheDocument();
    expect(requests.some(u => u.includes('section=project'))).toBe(false);
    expect(requests.filter(u => u.includes('/context')).every(u => u.includes('section=task'))).toBe(true);
    await user.click(screen.getByRole('button', { name: '项目环境' }));
    expect(await screen.findByText('JDK 8')).toBeInTheDocument();
  });

  it('browses old content and compares versions without changing the task', async () => {
    const { user, onSelect, requests } = setup();
    await screen.findByText('版本2正文');
    await user.click(screen.getByRole('button', { name: '版本差异' }));
    const diff = screen.getByRole('region', { name: '版本差异' });
    expect(await within(diff).findByText('版本1正文')).toBeInTheDocument();
    expect(within(diff).getByText('版本2正文')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('快照版本'), '1');
    await user.click(screen.getByRole('button', { name: '快照正文' }));
    expect(await screen.findByText('版本1正文')).toBeInTheDocument();
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1 }));
    expect(location.search).toContain('revision=1');
    await user.click(screen.getByRole('button', { name: 'Agent 读取' }));
    expect(screen.getByRole('link', { name: '精简摘要 ↗' })).toHaveAttribute('href', expect.stringContaining('revision=1'));
    expect(requests.every(u => u.includes('/snapshots') || u.includes('/context'))).toBe(true);
  });

  it('filters results by frozen task revision and keeps unknown legacy results explicit', async () => {
    const base = { taskId: task.id, executorName: 'Agent', revision: 1, latestReports: {}, reportCount: 0, reviewStale: false, verificationStale: false };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({ ok: true, json: async () => String(input).includes('/snapshots') ? { items: snapshots, total: 2 } : { content: {}, authorization: '' } })));
    history.replaceState(null, '', '/');
    render(<SnapshotPanel task={task} candidates={[{ ...base, id: 'old', executorName: '旧版 Agent', taskRevision: 1 }, { ...base, id: 'new', executorName: '新版 Agent', taskRevision: 2 }, { ...base, id: 'legacy', executorName: '历史未绑定 Agent' }] as LocalCandidate[]} candidatesLoading={false} candidatesError="" onRetry={() => {}} onSelect={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^关联结果/ }));
    expect(screen.queryByRole('heading', { name: '旧版 Agent' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '新版 Agent' })).toBeInTheDocument();
    expect(screen.getByText('快照版本未记录')).toBeInTheDocument();
  });
});
