import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import LocalWorkboard from './LocalWorkboard';
import type { LocalCandidate, LocalProject, LocalReport, LocalRequirement, LocalTask } from './types';
import { buildWorkflow } from './workflow';

const at = (minute: number) => `2026-11-15T02:${String(minute).padStart(2, '0')}:00.000Z`;
const shaA = 'a'.repeat(40), shaB = 'b'.repeat(40);
const project: LocalProject = { id: 'prj_test', name: '设备巡检台', revision: 1, repositoryUrl: 'https://github.example/project', baseline: shaA,
  environment: 'Node 24', rules: '', createdAt: at(0), updatedAt: at(0) };
const requirement: LocalRequirement = { id: 'req_test', projectId: project.id, title: '设备状态筛选', description: '需求范围 [证据文档](https://example.test/evidence)',
  plan: '计划正文', acceptance: '验收正文', revision: 1, createdAt: at(1), updatedAt: at(2) };
const task: LocalTask = { id: 'tsk_test', projectId: project.id, requirementId: requirement.id, projectRevision: 1, requirementRevision: 1, revision: 2,
  statusRevision: 1, title: '筛选任务', description: '任务说明', acceptance: '验收正文', priority: 'normal', dependsOn: [], status: 'draft', createdAt: at(1), updatedAt: at(2) };
const candidate: LocalCandidate = { id: 'cnd_test', taskId: task.id, taskRevision: 2, executorName: 'SA-ExampleA', executorKind: 'superagent',
  method: null, sourceRef: 'ticket/ticket1/result', baseSha: null, branch: 'codex/fixture', prUrl: null, sha: shaB, revision: 2,
  createdAt: at(4), updatedAt: at(10), reportCount: 4, latestReports: {}, lastReportAt: at(12), reviewStale: false, verificationStale: false };
const defaults = { taskId: task.id, candidateId: candidate.id, taskRevision: 2, submittedBy: 'Owner', reviewedBy: null, prUrl: null,
  verification: null, sourceRef: 'ticket/ticket1/result', sha: null, reviewedSha: null, verdict: null };
const reports: LocalReport[] = [
  { ...defaults, id: 'del-a', kind: 'delivery', sha: shaA, summary: '首轮候选', at: at(4) },
  { ...defaults, id: 'rev-a', kind: 'review', reviewRole: 'independent', reviewedSha: shaA, verdict: 'changes_requested', summary: '保存后计数未刷新', at: at(6) },
  { ...defaults, id: 'del-b', kind: 'delivery', sha: shaB, summary: '已修复计数', at: at(10) },
  { ...defaults, id: 'rev-b', kind: 'review', reviewRole: 'owner', reviewedSha: shaB, verdict: 'accepted', summary: 'Owner 确认通过', at: at(12) },
];
const snapshot = (revision: number) => ({ taskId: task.id, title: task.title, revision, savedAt: at(revision), requirementRevision: 1 });
const page = (items: unknown[]) => ({ items, total: items.length });

describe('read-only Workboard Flow', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let relayStatus: number;
  beforeEach(() => {
    relayStatus = 200;
    history.replaceState(null, '', '/aw/?task=tsk_test&revision=2');
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      const url = new URL(String(input), location.origin);
      const path = url.pathname.replace('/aw', '');
      const data = path === '/api/v1/projects' ? page([project])
        : path === '/api/v1/requirements' ? page([requirement])
        : path === '/api/v1/tasks' ? page([task])
        : path === '/api/v1/tasks/tsk_test' ? task
        : path.endsWith('/snapshots') ? page([snapshot(2), snapshot(1)])
        : path.endsWith('/dispatch-records') ? page([])
        : path.endsWith('/candidates') ? page([candidate])
        : path.endsWith('/reports') ? page(reports)
        : path.endsWith('/relay-queue') ? { state: 'disabled', events: [] }
        : path.endsWith('/brief') ? { taskTitle: '摘要正文', revision: Number(url.searchParams.get('revision')) }
        : path.endsWith('/context') ? { taskDescription: '固定正文' } : undefined;
      if (data === undefined) throw Error('unexpected request: ' + path);
      return new Response(JSON.stringify(data), {
        status: path.endsWith('/relay-queue') ? relayStatus : 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

  it.each([404, 503])('handles optional Relay endpoint HTTP %s without hiding task progress', async status => {
    relayStatus = status;
    render(<LocalWorkboard />);
    await screen.findByText('Owner 复审 · 通过');
    if (status === 404) expect(screen.queryByText('暂时无法读取 Relay 队列')).not.toBeInTheDocument();
    else expect(screen.getByText('暂时无法读取 Relay 队列')).toBeVisible();
  });

  it('renders the real report sequence, preserves old conclusions and opens the rework reason inline', async () => {
    render(<LocalWorkboard />);
    await screen.findByText('Owner 复审 · 通过');
    expect(screen.queryByText('草稿')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /拆分|编辑|创建|生成派活/ })).not.toBeInTheDocument();
    expect(screen.getByText('独立评审退回返工')).toBeVisible();
    expect(screen.getByRole('button', { name: /候选交付 aaaaaaaa/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /候选交付 bbbbbbbb/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查看原因' }));
    const inspector = screen.getByRole('region', { name: '节点详情' });
    expect(await within(inspector).findByText('保存后计数未刷新')).toBeVisible();
    expect(within(inspector).queryByText('Owner 确认通过')).not.toBeInTheDocument();
    const review = screen.getByRole('button', { name: /独立评审 退回返工/ });
    expect(review).toHaveFocus();
    expect(review).toHaveAttribute('aria-expanded', 'true');
    expect(review.nextElementSibling).toBe(inspector);
    fireEvent.click(review);
    expect(screen.queryByRole('region', { name: '节点详情' })).not.toBeInTheDocument();
  });

  it('opens Markdown references, both snapshot formats and fixed task revisions in the same page', async () => {
    render(<LocalWorkboard />);
    await screen.findByText('Owner 复审 · 通过');
    expect(screen.getByText('实施计划').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('需求与范围'));
    const reference = await screen.findByRole('button', { name: '证据文档' });
    fireEvent.click(reference);
    expect(screen.getByText('https://example.test/evidence')).toBeVisible();
    fireEvent.click(screen.getByText('任务快照与 Agent 读取'));
    fireEvent.click(screen.getByRole('button', { name: '固定摘要 v2' }));
    expect(await screen.findByText(/摘要正文/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '固定 JSON v2' }));
    expect(await screen.findByText(/固定正文/)).toBeVisible();
    expect(document.querySelectorAll('a[target], a[href]')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('任务版本'), { target: { value: '1' } });
    await screen.findByText('快照已保存，暂无派活记录');
    expect(screen.queryByText('Owner 复审 · 通过')).not.toBeInTheDocument();
    expect(location.pathname).toBe('/aw/');
    expect(location.search).toContain('revision=1');
    await waitFor(() => {
      expect(fetchMock.mock.calls.every(([input]) => new URL(String(input), location.origin).pathname.startsWith('/aw/api/'))).toBe(true);
    });
  });
});

it('does not link unproven parallel candidates or let the snapshot timestamp hide execution facts', () => {
  const first = { ...candidate, id: 'candidate-a', sha: shaA, createdAt: at(4) };
  const second = { ...candidate, id: 'candidate-b', sha: shaB };
  const history = reports.map(report => ({ ...report, candidateId: report.id.endsWith('-a') ? first.id : second.id }));
  const flow = buildWorkflow({ revision: 2, snapshotAt: at(50), dispatches: [], candidates: [first, second], reports: history, relay: [] });
  expect(flow.rounds).toHaveLength(2);
  expect(flow.rounds.every(round => !round.returnedFrom)).toBe(true);
  expect(flow.current?.id).toBe('rev-b');
});
