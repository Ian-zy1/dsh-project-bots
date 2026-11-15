import type { Candidate, Sourced } from '../domain/types';
import { isReviewStale } from '../lib/evidence';
import { formatDateTime } from '../lib/format';
import {
  AGENT_KIND_LABELS,
  EXECUTION_STATUS_LABELS,
  REVIEW_STATUS_LABELS,
  VERIFICATION_STATUS_LABELS,
  executionStatusTone,
  reviewStatusTone,
  verificationStatusTone,
} from '../lib/labels';
import { StatusBadge } from './StatusBadge';

interface CandidateCardProps {
  candidate: Sourced<Candidate>;
  adopted: boolean;
}

export function CandidateCard({ candidate, adopted }: CandidateCardProps) {
  const staleReview = isReviewStale(candidate);
  const review = candidate.review;

  return (
    <article className="candidate-card" aria-label={`候选实现 ${candidate.executorName}`}>
      <header className="candidate-card__header">
        <div>
          <h4>{candidate.executorName}</h4>
          <p className="meta-line">{candidate.method}</p>
        </div>
        <div className="candidate-card__badges">
          <StatusBadge tone="neutral">{AGENT_KIND_LABELS[candidate.executorKind]}</StatusBadge>
          <StatusBadge tone={executionStatusTone(candidate.execution.status)}>
            {EXECUTION_STATUS_LABELS[candidate.execution.status]}
          </StatusBadge>
          {adopted ? <StatusBadge tone="done">已采纳</StatusBadge> : null}
        </div>
      </header>

      <p className="candidate-card__run">{candidate.execution.summary}</p>

      <dl className="evidence-grid">
        <div>
          <dt>分支</dt>
          <dd className="mono">{candidate.branch ?? '未提供'}</dd>
        </div>
        <div>
          <dt>PR</dt>
          <dd className="mono">{candidate.pr ?? '未提供'}</dd>
        </div>
        <div className="evidence-grid__wide">
          <dt>候选 SHA</dt>
          <dd className="mono mono--sha">{candidate.sha ?? '未提供'}</dd>
        </div>
        <div className="evidence-grid__wide">
          <dt>基线 SHA</dt>
          <dd className="mono">{candidate.baseSha ?? '未记录'}</dd>
        </div>
      </dl>

      <div className="evidence-block">
        <h5>验证</h5>
        <div className="evidence-block__summary">
          <StatusBadge tone={verificationStatusTone(candidate.verification.status)}>
            {VERIFICATION_STATUS_LABELS[candidate.verification.status]}
          </StatusBadge>
          <p>{candidate.verification.summary ?? '未提供验证摘要。'}</p>
        </div>
        <p className="meta-line">证明引用：{candidate.verification.evidenceRef ?? '未提供'}</p>
      </div>

      <div className="evidence-block">
        <h5>评审</h5>
        {review ? (
          <div className="evidence-block__body">
            <div className="evidence-block__summary">
              <StatusBadge tone={reviewStatusTone(review.status)}>{REVIEW_STATUS_LABELS[review.status]}</StatusBadge>
              <span className="meta-line">
                {review.reviewer} · {formatDateTime(review.at)}
              </span>
            </div>
            <p>{review.summary}</p>
            <p className="meta-line mono">评审 SHA：{review.reviewedSha ?? '未记录'}</p>
            <p className="meta-line">来源：{review.sourceRef}</p>
            {staleReview ? (
              <p className="warning-text" role="note">
                {candidate.sha && review.reviewedSha
                  ? '评审 SHA 与当前候选 SHA 不一致；该结论不能沿用到当前版本，需要重新评审。'
                  : '评审 SHA 或候选 SHA 未记录；无法确认该结论适用于当前版本。'}
              </p>
            ) : null}
          </div>
        ) : (
          <p>尚无评审记录（未评审）；未评审不应显示为评审通过。</p>
        )}
      </div>

      {candidate.blockers.length > 0 ? (
        <div className="callout callout--danger">
          <h5>阻塞原因</h5>
          <ul>
            {candidate.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {candidate.todos.length > 0 ? (
        <div className="callout callout--warning">
          <h5>待处理事项</h5>
          <ul>
            {candidate.todos.map((todo) => (
              <li key={todo}>{todo}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <footer className="candidate-card__footer meta-line">
        来源：演示数据 · {candidate.provenance.sourceRef} · 更新 {formatDateTime(candidate.updatedAt)}
      </footer>
    </article>
  );
}
