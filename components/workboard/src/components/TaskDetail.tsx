import type { Activity, Candidate, Sourced, TaskDetail as TaskDetailModel } from '../domain/types';
import { isReviewStale } from '../lib/evidence';
import { formatDateTime } from '../lib/format';
import { TASK_STATUS_LABELS, taskStatusTone } from '../lib/labels';
import { ActivityTimeline } from './ActivityTimeline';
import { CandidateCard } from './CandidateCard';
import { EmptyState } from './AsyncNotice';
import { StatusBadge } from './StatusBadge';

interface TaskDetailProps {
  detail: TaskDetailModel;
  candidates: Sourced<Candidate>[];
  activities: Sourced<Activity>[];
  onBack: () => void;
}

export function TaskDetail({ detail, candidates, activities, onBack }: TaskDetailProps) {
  const { task, requirement } = detail;
  const adoptedCandidate = task.adoption
    ? candidates.find((candidate) => candidate.id === task.adoption?.candidateId)
    : undefined;

  return (
    <div className="task-detail">
      <button type="button" className="back-button" onClick={onBack}>
        ← 返回任务列表
      </button>

      <header className="detail-header">
        <div>
          <p className="eyebrow">需求 · {requirement.title}</p>
          <h2>{task.title}</h2>
          <p className="meta-line">最后更新：{formatDateTime(task.updatedAt)}</p>
        </div>
        <StatusBadge tone={taskStatusTone(task.status)}>{TASK_STATUS_LABELS[task.status]}</StatusBadge>
      </header>

      <section className="detail-section" aria-labelledby="requirement-heading">
        <h3 id="requirement-heading">需求依据</h3>
        <p className="lead">{requirement.goal}</p>

        <div className="two-column">
          <div>
            <h4>实现范围</h4>
            <ul>
              {requirement.scope.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4>验收条件</h4>
            <ul className="checklist">
              {requirement.acceptanceCriteria.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>

        <h4>计划与批准版本</h4>
        <div className="plan-list">
          {requirement.plans.map((plan) => (
            <div className="plan-card" key={plan.version}>
              <div className="plan-card__head">
                <strong>{plan.version}</strong>
                {plan.approvedAt ? (
                  <StatusBadge tone="done">已批准</StatusBadge>
                ) : (
                  <StatusBadge tone="warning">未批准</StatusBadge>
                )}
              </div>
              {plan.approvedAt ? (
                <p className="meta-line">
                  批准人：{plan.approvedBy ?? '未知'} · {formatDateTime(plan.approvedAt)}
                </p>
              ) : (
                <p className="meta-line">尚无批准时间与批准人。</p>
              )}
              {plan.note ? <p>{plan.note}</p> : null}
              <p className="meta-line">来源：{plan.sourceRef}</p>
            </div>
          ))}
        </div>

        <div className="two-column">
          <div>
            <h4>代码基线</h4>
            {requirement.baseline ? (
              <dl className="compact-dl">
                <div>
                  <dt>分支</dt>
                  <dd className="mono">{requirement.baseline.branch}</dd>
                </div>
                <div>
                  <dt>基线 SHA</dt>
                  <dd className="mono">{requirement.baseline.sha}</dd>
                </div>
                <div>
                  <dt>记录时间</dt>
                  <dd>{formatDateTime(requirement.baseline.recordedAt)}</dd>
                </div>
              </dl>
            ) : (
              <p>未记录代码基线。</p>
            )}
          </div>
          <div>
            <h4>关联仓库与资料</h4>
            <dl className="compact-dl">
              <div>
                <dt>仓库</dt>
                <dd>
                  {requirement.repositories.map((repository) => (
                    <span className="ref-line" key={repository.name}>
                      <span className="mono">{repository.name}</span> · {repository.role}
                    </span>
                  ))}
                </dd>
              </div>
              <div>
                <dt>资料</dt>
                <dd>
                  {requirement.resources.map((resource) => (
                    <span className="ref-line" key={resource.ref}>
                      {resource.label} · {resource.ref}
                    </span>
                  ))}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <section className="detail-section" aria-labelledby="candidates-heading">
        <div className="section-heading">
          <h3 id="candidates-heading">候选实现</h3>
          <span className="meta-line">{candidates.length} 份候选</span>
        </div>
        <p className="section-note">
          执行结束、评审通过与最终采纳分别记录；评审结论只对明确的候选 SHA 生效。候选之间不共享状态或证据。
        </p>

        {candidates.length === 0 ? (
          <EmptyState
            title="尚无候选实现"
            detail="该任务还没有候选；没有执行、验证或评审证据，页面不会显示成功状态。"
          />
        ) : (
          <div className="candidate-list">
            {candidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                adopted={task.adoption?.candidateId === candidate.id}
              />
            ))}
          </div>
        )}
      </section>

      <section className="detail-section" aria-labelledby="adoption-heading">
        <h3 id="adoption-heading">采纳与业务状态</h3>
        {task.adoption ? (
          <div className="adoption-card">
            <p>
              已采纳候选：
              <strong>{adoptedCandidate?.executorName ?? task.adoption.candidateId}</strong>
            </p>
            <p className="meta-line">
              决定人：{task.adoption.decidedBy} · {formatDateTime(task.adoption.at)}
            </p>
            <p className="meta-line">来源：{task.adoption.sourceRef}</p>
          </div>
        ) : (
          <p>尚未记录采纳决定。业务状态为“{TASK_STATUS_LABELS[task.status]}”，不等于已合入或已部署。</p>
        )}
      </section>

      <section className="detail-section" aria-labelledby="activity-heading">
        <h3 id="activity-heading">活动记录</h3>
        <ActivityTimeline activities={activities} />
      </section>

      {candidates.some((candidate) => isReviewStale(candidate)) ? (
        <p className="detail-footnote">
          提示：部分候选的评审 SHA 与当前候选 SHA 不一致或缺失，相关结论只适用于已记录的版本。
        </p>
      ) : null}
    </div>
  );
}
