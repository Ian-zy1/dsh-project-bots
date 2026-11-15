export interface LocalProject {
  id: string; name: string; repositoryUrl: string; baseline: string; environment: string; rules: string;
  revision: number; createdAt: string; updatedAt: string; requirementCount?: number; taskCount?: number;
}
export interface LocalRequirement {
  id: string; projectId: string; title: string; description: string; plan: string; acceptance: string;
  revision: number; createdAt: string; updatedAt: string; taskCount?: number;
}
export type LocalStatus = 'draft' | 'ready' | 'in_progress' | 'blocked' | 'done';
export interface LocalTask {
  sourceRef?: string;
  id: string; projectId: string; projectRevision: number; requirementId: string; requirementRevision: number; revision: number; statusRevision: number;
  title: string; description: string; acceptance: string; priority: 'low' | 'normal' | 'high'; dependsOn: string[];
  status: LocalStatus; updatedAt: string; createdAt: string; requirementTitle?: string; contextOutdated?: boolean;
  dependencies?: { id: string; title: string; status: LocalStatus }[];
}
export interface TaskContext {
  schemaVersion: number; snapshotCreatedAt?: string; task: LocalTask; project: LocalProject; requirement: LocalRequirement; authorization: string;
}
export interface SnapshotInfo {
  taskId: string; revision: number; title: string; projectRevision: number; requirementRevision: number;
  savedAt: string | null; sourceRef: string | null; digest: string; contentBytes: number;
}
export interface ContextSection { taskId: string; revision: number; section: string; content: Record<string, unknown>; authorization: string }
export type ExecutorKind = 'superagent' | 'local-agent' | 'human';
export type ReportKind = 'progress' | 'blocked' | 'delivery' | 'review';
export type ReviewRole = 'independent' | 'owner';
export type ReviewVerdict = 'accepted' | 'changes_requested' | 'pending';
export type VerificationStatus = 'passed' | 'failed' | 'partial' | 'not_run' | 'unknown';
export interface LocalVerification {
  status: VerificationStatus; summary: string | null; evidenceRef: string | null;
}
export interface LocalReport {
  taskRevision?: number | null; occurredAt?: string | null; reviewRole?: ReviewRole;
  id: string; taskId: string; candidateId: string; kind: ReportKind;
  summary: string; sourceRef: string; submittedBy: string; at: string;
  sha: string | null; reviewedSha: string | null; verdict: ReviewVerdict | null; reviewedBy: string | null;
  prUrl: string | null; verification: LocalVerification | null;
}
export interface LocalCandidate {
  taskRevision?: number | null;
  id: string; taskId: string; executorName: string; executorKind: ExecutorKind | null;
  method: string | null; sourceRef: string | null; baseSha: string | null; branch: string | null;
  prUrl: string | null; sha: string | null; revision: number; createdAt: string; updatedAt: string;
  latestReports: Partial<Record<ReportKind, LocalReport>>;
  currentReviews?: Partial<Record<ReviewRole | 'unspecified', LocalReport>>;
  lastReportAt: string | null; reportCount: number; reviewStale: boolean; verificationStale: boolean;
}
export const statusLabels: Record<LocalStatus, string> = { draft: '草稿', ready: '可执行', in_progress: '进行中', blocked: '阻塞', done: '完成' };

export interface DispatchRecord {
  id: string;
  taskId: string;
  taskRevision: number;
  outcome: 'received' | 'accepted' | 'assessment_timeout' | 'failed';
  occurredAt: string;
  sourceRef: string;
  summary: string;
  nextAction: string | null;
  ticketRef: string | null;
}
