import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CandidateDelivery from './CandidateDelivery';
import type { LocalCandidate, LocalReport } from './types';

const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
const at = '2026-11-11T08:00:00.000Z';

function report(kind: LocalReport['kind'], overrides: Partial<LocalReport> = {}): LocalReport {
  return {
    id: `rpt_${kind}`, taskId: 'tsk_test', candidateId: 'cnd_test', kind,
    summary: `${kind} 摘要`, sourceRef: 'https://example.com/evidence', submittedBy: 'Worker',
    at, sha: null, reviewedSha: null, verdict: null, reviewedBy: null, prUrl: null, verification: null, ...overrides,
  };
}

function candidate(overrides: Partial<LocalCandidate> = {}): LocalCandidate {
  return {
    id: 'cnd_test', taskId: 'tsk_test', executorName: '候选测试执行者', executorKind: 'superagent',
    method: 'DSH Ticket', sourceRef: 'https://example.com/issues/6', baseSha: shaA,
    branch: 'agent/candidate', prUrl: 'https://example.com/pull/9', sha: shaB, revision: 2,
    createdAt: at, updatedAt: at, latestReports: {}, lastReportAt: null, reportCount: 0,
    reviewStale: false, verificationStale: false, ...overrides,
  };
}

function response(value: unknown) {
  return { ok: true, status: 200, json: async () => value } as Response;
}

describe('CandidateDelivery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows candidate evidence and the latest report of each kind', async () => {
    render(<CandidateDelivery loading={false} error="" onRetry={() => {}} candidates={[candidate({
      latestReports: {
        progress: report('progress', { summary: '正在实现页面' }),
        blocked: report('blocked', { summary: '等待评审环境' }),
        delivery: report('delivery', {
          summary: '候选已提交', sha: shaB, prUrl: 'https://example.com/pull/9',
          verification: { status: 'passed', summary: '测试通过', evidenceRef: 'run-1' },
        }),
        review: report('review', { summary: '独立评审通过', reviewedSha: shaB, verdict: 'accepted', reviewedBy: 'Independent Reviewer', submittedBy: 'Owner（代录）' }),
      },
      lastReportAt: at, reportCount: 4,
    })]} />);

    expect(screen.getByRole('region', { name: '候选实现与最近回报' })).toBeInTheDocument();
    expect(screen.getByText('候选测试执行者')).toBeInTheDocument();
    expect(screen.getByText('执行方式：DSH Ticket')).toBeInTheDocument();
    expect(await screen.findByText('正在实现页面')).toBeInTheDocument();
    expect(screen.getByText('等待评审环境')).toBeInTheDocument();
    expect(screen.getByText('候选已提交')).toBeInTheDocument();
    expect(screen.getByText('独立评审通过')).toBeInTheDocument();
    expect(screen.getByText('验证通过')).toBeInTheDocument();
    expect(screen.getByText('评审通过')).toBeInTheDocument();
    expect(screen.getByText(/评审者：Independent Reviewer · 提交者：Owner（代录）/)).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(shaB)).length).toBeGreaterThan(0);
    expect(screen.getByText(/最近回报时间/)).toBeInTheDocument();
    expect(screen.queryByText(/旧评审保留/)).not.toBeInTheDocument();
    expect(screen.queryByText(/旧验证保留/)).not.toBeInTheDocument();
  });

  it('keeps old review and verification visible but warns they are stale', async () => {
    render(<CandidateDelivery loading={false} error="" onRetry={() => {}} candidates={[candidate({
      sha: shaB,
      verificationStale: true,
      reviewStale: true,
      latestReports: {
        delivery: report('delivery', {
          summary: '旧版本交付', sha: shaA,
          verification: { status: 'passed', summary: '旧版本测试', evidenceRef: 'run-old' },
        }),
        review: report('review', { summary: '旧版本评审通过', reviewedSha: shaA, verdict: 'accepted' }),
      },
      lastReportAt: at, reportCount: 2,
    })]} />);

    expect(screen.getByText(/旧评审保留，但不能视为当前版本已通过/)).toBeInTheDocument();
    expect(screen.getByText(/旧验证保留，但不适用于新版本/)).toBeInTheDocument();
    expect(await screen.findByText('旧版本交付')).toBeInTheDocument();
    expect(screen.getByText('旧版本评审通过')).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(shaA)).length).toBeGreaterThan(0);
  });

  it('shows missing fields explicitly and never implies success without evidence', () => {
    render(<CandidateDelivery loading={false} error="" onRetry={() => {}} candidates={[candidate({
      method: null, sourceRef: null, baseSha: null, branch: null, prUrl: null, sha: null,
      latestReports: {}, lastReportAt: null, reportCount: 0, reviewStale: false, verificationStale: false,
    })]} />);

    expect(screen.getByText('执行方式：未提供')).toBeInTheDocument();
    expect(screen.getByText('尚无回报；未提供不等于验证或评审通过。')).toBeInTheDocument();
    expect(screen.getByText('最近回报时间：尚无回报')).toBeInTheDocument();
    expect(screen.getAllByText('未提供').length).toBeGreaterThanOrEqual(4);
  });

  it('renders empty, loading and error states distinctly', () => {
    const retry = vi.fn();
    const { rerender } = render(<CandidateDelivery loading={false} error="" onRetry={retry} candidates={[]} />);
    expect(screen.getByText(/尚无候选实现/)).toBeInTheDocument();

    rerender(<CandidateDelivery loading error="" onRetry={retry} candidates={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在读取候选与回报');

    rerender(<CandidateDelivery loading={false} error="无法读取候选回报。" onRetry={retry} candidates={[]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('无法读取候选回报。');
    screen.getByRole('button', { name: '重试' }).click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('loads all stored reports on demand with source and SHA facts', async () => {
    const user = userEvent.setup();
    const reports = [
      report('review', {
        id: 'rpt_review', summary: '更早的评审', reviewedSha: shaA, verdict: 'changes_requested',
        sourceRef: 'https://example.com/review/1', submittedBy: 'Reviewer',
      }),
      report('progress', { id: 'rpt_progress', summary: '更早的进度' }),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/v1/tasks/tsk_test/candidates/cnd_test/reports') {
        return response({ items: reports, total: 2, offset: 0, limit: 200 });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CandidateDelivery loading={false} error="" onRetry={() => {}} candidates={[candidate({
      latestReports: { progress: reports[1] }, lastReportAt: at, reportCount: 2,
    })]} />);

    await user.click(screen.getByRole('button', { name: '查看全部 2 条回报' }));
    expect(await screen.findByText('更早的评审')).toBeInTheDocument();
    expect(screen.getAllByText('更早的进度').length).toBeGreaterThan(0);
    expect(screen.getByText(/结论：要求修改/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新全部回报' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
