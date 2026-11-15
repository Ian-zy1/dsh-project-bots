import type {
  ActivityKind,
  AgentKind,
  ExecutionStatus,
  ReviewStatus,
  TaskStatus,
  VerificationStatus,
} from '../domain/types';

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待处理',
  in_progress: '执行中',
  blocked: '阻塞',
  in_review: '待评审',
  ready_to_merge: '待合入',
  done: '完成',
};

export const TASK_STATUS_ORDER: TaskStatus[] = [
  'pending',
  'in_progress',
  'blocked',
  'in_review',
  'ready_to_merge',
  'done',
];

export const AGENT_KIND_LABELS: Record<AgentKind, string> = {
  superagent: 'Superagent',
  'local-agent': '本地 Agent',
  human: '人工',
};

export const EXECUTION_STATUS_LABELS: Record<ExecutionStatus, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '执行结束',
  blocked: '执行阻塞',
  stopped: '已停止',
  unknown: '未知',
};

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  passed: '验证通过',
  failed: '验证未通过',
  partial: '部分验证',
  not_run: '未验证',
  unknown: '未知',
};

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: '评审待处理',
  accepted: '评审通过',
  changes_requested: '要求修改',
  unknown: '评审未知',
};

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  plan_confirmed: '计划确认',
  execution_report: '执行回报',
  review: '评审',
  adoption: '采纳',
  status_change: '状态变更',
  blocked: '阻塞',
};

export type BadgeTone = 'neutral' | 'active' | 'warning' | 'review' | 'ready' | 'done' | 'danger';

export function taskStatusTone(status: TaskStatus): BadgeTone {
  switch (status) {
    case 'pending':
      return 'neutral';
    case 'in_progress':
      return 'active';
    case 'blocked':
      return 'danger';
    case 'in_review':
      return 'review';
    case 'ready_to_merge':
      return 'ready';
    case 'done':
      return 'done';
  }
}

export function executionStatusTone(status: ExecutionStatus): BadgeTone {
  switch (status) {
    case 'queued':
      return 'neutral';
    case 'running':
      return 'active';
    case 'succeeded':
      return 'done';
    case 'blocked':
      return 'danger';
    case 'stopped':
      return 'warning';
    case 'unknown':
      return 'neutral';
  }
}

export function verificationStatusTone(status: VerificationStatus): BadgeTone {
  switch (status) {
    case 'passed':
      return 'done';
    case 'failed':
      return 'danger';
    case 'partial':
      return 'warning';
    case 'not_run':
    case 'unknown':
      return 'neutral';
  }
}

export function reviewStatusTone(status: ReviewStatus): BadgeTone {
  switch (status) {
    case 'accepted':
      return 'done';
    case 'changes_requested':
      return 'warning';
    case 'pending':
      return 'review';
    case 'unknown':
      return 'neutral';
  }
}
