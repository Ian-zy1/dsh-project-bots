import ReadableText from './ReadableText';
import { useState } from 'react';
import { list } from './api';
import type {
  ExecutorKind,
  LocalCandidate,
  LocalReport,
  ReportKind,
  ReviewVerdict,
  VerificationStatus,
} from './types';

const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
}).format(new Date(value));
const missing = (value: string | null | undefined) => value || '未提供';
const isHttp = (value: string) => /^https?:\/\//i.test(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : '读取失败，请重试';

const executorLabels: Record<ExecutorKind, string> = {
  superagent: 'Superagent',
  'local-agent': '本地 Agent',
  human: '人工',
};
const reportLabels: Record<ReportKind, string> = {
  progress: '进度',
  blocked: '阻塞',
  delivery: '交付',
  review: '评审',
};
const verdictLabels: Record<ReviewVerdict, string> = {
  accepted: '评审通过',
  changes_requested: '要求修改',
  pending: '评审待处理',
};
const verificationLabels: Record<VerificationStatus, string> = {
  passed: '验证通过',
  failed: '验证未通过',
  partial: '部分验证',
  not_run: '未验证',
  unknown: '未知',
};

function SourceRef({ value }: { value: string }) {
  return isHttp(value)
    ? <a href={value} target="_blank" rel="noreferrer">{value}</a>
    : <span>{value}</span>;
}

function ReportMeta({ report }: { report: LocalReport }) {
  return <p className="local-report-meta">{report.submittedBy} · 接收于 {formatTime(report.at)}{report.occurredAt && <> · 发生于 {formatTime(report.occurredAt)}</>}{report.taskRevision != null && <> · 快照 v{report.taskRevision}</>} · 来源：<SourceRef value={report.sourceRef} /></p>;
}

function ReportBars({ candidate }: { candidate: LocalCandidate }) {
  const { progress, blocked, delivery, review } = candidate.latestReports;
  return <>
    {progress && <div className="local-report-block">
      <div className="local-report-heading"><span className="local-report-kind">最近进度</span><span>{formatTime(progress.at)}</span></div>
      <ReadableText text={progress.summary} /><ReportMeta report={progress} />
    </div>}
    {blocked && <div className="local-report-block local-report-block--blocked">
      <div className="local-report-heading"><span className="local-report-kind local-report-kind--blocked">最近阻塞</span><span>{formatTime(blocked.at)}</span></div>
      <ReadableText text={blocked.summary} /><ReportMeta report={blocked} />
    </div>}
    {delivery && <div className="local-report-block">
      <div className="local-report-heading"><span className="local-report-kind">最近交付</span><span>{formatTime(delivery.at)}</span></div>
      <ReadableText text={delivery.summary} />
      <div className="local-delivery-facts">
        {delivery.prUrl ? <span>PR/MR：<a href={delivery.prUrl} target="_blank" rel="noreferrer">查看交付链接 ↗</a></span> : <span>PR/MR：未提供</span>}
        <span>交付 SHA：<code>{missing(delivery.sha)}</code></span>
        {!delivery.verification && <span>验证：未提供</span>}
        {delivery.verification && <>
          <span>验证：<span className={`local-result local-result--${delivery.verification.status}`}>{verificationLabels[delivery.verification.status]}</span></span>
          {delivery.verification.summary && <span>验证摘要：{delivery.verification.summary}</span>}
          {delivery.verification.evidenceRef && <span>证据引用：<SourceRef value={delivery.verification.evidenceRef} /></span>}
        </>}
      </div>
      {candidate.verificationStale && <p className="local-warning" role="note">验证证据绑定 {missing(delivery.sha)}，当前候选 {missing(candidate.sha)}；旧验证保留，但不适用于新版本。</p>}
      <ReportMeta report={delivery} />
    </div>}
    {review && <div className="local-report-block">
      <div className="local-report-heading">
        <span className="local-report-kind">最近评审</span>
        <span className={`local-result local-result--${candidate.reviewStale ? 'unknown' : review.verdict ?? 'pending'}`}>{candidate.reviewStale ? '历史评审' : review.verdict ? verdictLabels[review.verdict] : '评审结论未提供'}</span>
        <span>{formatTime(review.at)}</span>
      </div>
      <ReadableText text={review.summary} />
      <div className="local-delivery-facts"><span>评审 SHA：<code>{missing(review.reviewedSha)}</code></span>{review.reviewedBy && <span>评审者：{review.reviewedBy} · 提交者：{review.submittedBy}</span>}</div>
      {candidate.reviewStale && <p className="local-warning" role="note">评审针对 {missing(review.reviewedSha)}，当前候选 {missing(candidate.sha)}；旧评审保留，但不能视为当前版本已通过。</p>}
      <ReportMeta report={review} />
    </div>}
    {!progress && !blocked && !delivery && !review && <p className="local-muted">尚无回报；未提供不等于验证或评审通过。</p>}
  </>;
}

function AllReports({ reports }: { reports: LocalReport[] }) {
  if (reports.length === 0) return <p className="local-muted">没有已留存回报。</p>;
  return <div className="local-report-list">
    {reports.map(report => <div className="local-report-row" key={report.id}>
      <div className="local-report-row-heading">
        <span className={`local-report-kind local-report-kind--${report.kind}`}>{reportLabels[report.kind]}</span>
        <span>{formatTime(report.at)}</span>
      </div>
      <ReadableText text={report.summary} />
      {report.kind === 'review' && reports.some(other => other.id !== report.id && reports.indexOf(other) < reports.indexOf(report) && other.kind === 'review' && other.sourceRef === report.sourceRef && other.reviewedSha === report.reviewedSha && other.verdict === report.verdict) && <p className="snapshot-caption">同源评审的重复转录；不是一次新的独立评审。</p>}
      <div className="local-delivery-facts">
        {report.kind === 'delivery' && report.prUrl && <span>PR/MR：<a href={report.prUrl} target="_blank" rel="noreferrer">交付链接 ↗</a></span>}
        {report.kind === 'delivery' && <span>交付 SHA：<code>{missing(report.sha)}</code></span>}
        {report.kind === 'review' && <span>评审 SHA：<code>{missing(report.reviewedSha)}</code></span>}
        {report.kind === 'review' && <span>结论：{report.verdict ? verdictLabels[report.verdict] : '未提供'}</span>}
        {report.kind === 'review' && report.reviewedBy && <span>评审者：{report.reviewedBy} · 提交者：{report.submittedBy}</span>}
      </div>
      <ReportMeta report={report} />
    </div>)}
  </div>;
}

function CandidateCard({ candidate }: { candidate: LocalCandidate }) {
  const [reports, setReports] = useState<LocalReport[] | null>(null);
  const [reportsBusy, setReportsBusy] = useState(false);
  const [reportsError, setReportsError] = useState('');

  async function loadReports() {
    setReportsBusy(true); setReportsError('');
    try {
      setReports(await list<LocalReport>(`/tasks/${candidate.taskId}/candidates/${candidate.id}/reports`));
    } catch (error) {
      setReportsError(errorText(error));
    } finally {
      setReportsBusy(false);
    }
  }

  return <article className="local-candidate" aria-label={`候选 ${candidate.executorName}`}>
    <header className="local-candidate-head">
      <div>
        <h4>{candidate.executorName}</h4>
        <p className="local-muted">执行方式：{missing(candidate.method)}</p>
      </div>
      <div className="local-candidate-badges">
        <span className="local-report-kind">{candidate.taskRevision != null ? `任务快照 v${candidate.taskRevision}` : '快照版本未记录'}</span>
        {candidate.executorKind && <span className="local-report-kind">{executorLabels[candidate.executorKind]}</span>}
        <span className="local-report-kind">候选 v{candidate.revision}</span>
      </div>
    </header>

    {candidate.taskRevision == null && <p className="snapshot-caption">旧候选未记录任务快照版本；不能据当前任务版本推断其依据。</p>}
    <dl className="local-evidence">
      <div><dt>来源</dt><dd>{candidate.sourceRef ? <SourceRef value={candidate.sourceRef} /> : '未提供'}</dd></div>
      <div><dt>分支</dt><dd className="mono">{missing(candidate.branch)}</dd></div>
      <div><dt>PR/MR</dt><dd>{candidate.prUrl ? <a href={candidate.prUrl} target="_blank" rel="noreferrer">查看 PR/MR ↗</a> : '未提供'}</dd></div>
      <div><dt>基线 SHA</dt><dd className="mono">{missing(candidate.baseSha)}</dd></div>
      <div className="local-evidence-wide"><dt>当前候选 SHA</dt><dd className="mono">{missing(candidate.sha)}</dd></div>
    </dl>

    <ReportBars candidate={candidate} />

    <footer className="local-candidate-footer">
      <span>最近回报时间：{candidate.lastReportAt ? formatTime(candidate.lastReportAt) : '尚无回报'}</span>
      {candidate.reportCount > 0 && <button type="button" onClick={loadReports} disabled={reportsBusy}>{reportsBusy ? '正在读取…' : reports ? '刷新全部回报' : `查看全部 ${candidate.reportCount} 条回报`}</button>}
    </footer>
    {reportsError && <div className="local-error" role="alert">{reportsError}<button type="button" onClick={loadReports}>重试</button></div>}
    {reports && <AllReports reports={reports} />}
  </article>;
}

interface CandidateDeliveryProps {
  candidates: LocalCandidate[];
  loading: boolean;
  error: string;
  onRetry: () => void;
}

export default function CandidateDelivery({ candidates, loading, error, onRetry }: CandidateDeliveryProps) {
  return <section className="local-delivery" aria-label="候选实现与最近回报">
    <div className="local-section-title"><h3>候选实现与最近回报</h3><span className="local-muted">{candidates.length} 份候选</span></div>
    <p className="local-hint">回报按任务与候选追加保存；此处显示最近回报，不是实时监控。执行完成、评审通过和最终合入分别判断；任务状态为手工记录，不等于已合入。</p>
    {loading && <p className="local-muted" role="status">正在读取候选与回报…</p>}
    {error && <div className="local-error" role="alert">{error}<button type="button" onClick={onRetry}>重试</button></div>}
    {!loading && !error && candidates.length === 0 && <p className="local-muted">尚无候选实现；没有候选、验证或评审证据，页面不会显示成功。</p>}
    {!loading && !error && candidates.map(candidate => <CandidateCard candidate={candidate} key={candidate.id} />)}
  </section>;
}
