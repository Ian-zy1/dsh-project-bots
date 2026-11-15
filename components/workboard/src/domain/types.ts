export interface Provenance {
  demo: true;
  sourceType: 'demo';
  updatedAt: string;
  sourceRef: string;
}

export type Sourced<T> = T & { provenance: Provenance };

export interface DemoMeta {
  demo: true;
  dataUpdatedAt: string;
  sourceNote: string;
  schemaVersion: string;
}

export type AgentKind = 'superagent' | 'local-agent' | 'human';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'in_review'
  | 'ready_to_merge'
  | 'done';

export type ExecutionStatus = 'queued' | 'running' | 'succeeded' | 'blocked' | 'stopped' | 'unknown';

export type VerificationStatus = 'passed' | 'failed' | 'partial' | 'not_run' | 'unknown';

export type ReviewStatus = 'pending' | 'accepted' | 'changes_requested' | 'unknown';

export type ActivityKind =
  | 'plan_confirmed'
  | 'execution_report'
  | 'review'
  | 'adoption'
  | 'status_change'
  | 'blocked';

export interface RepositoryRef {
  name: string;
  role: string;
}

export interface ResourceRef {
  label: string;
  ref: string;
}

export interface PlanRecord {
  version: string;
  approvedAt: string | null;
  approvedBy: string | null;
  sourceRef: string;
  note?: string;
}

export interface BaselineRef {
  branch: string;
  sha: string;
  recordedAt: string;
}

export interface AdoptionRecord {
  candidateId: string;
  decidedBy: string;
  at: string;
  sourceRef: string;
}

export interface Project {
  id: string;
  name: string;
  summary: string;
  updatedAt: string;
  repositories: RepositoryRef[];
  resources: ResourceRef[];
}

export interface Requirement {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  scope: string[];
  acceptanceCriteria: string[];
  plans: PlanRecord[];
  baseline: BaselineRef | null;
  repositories: RepositoryRef[];
  resources: ResourceRef[];
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  requirementId: string;
  title: string;
  status: TaskStatus;
  updatedAt: string;
  adoption: AdoptionRecord | null;
}

export interface Review {
  id: string;
  candidateId: string;
  reviewer: string;
  reviewedSha: string | null;
  status: ReviewStatus;
  summary: string;
  at: string;
  sourceRef: string;
}

export interface CandidateExecution {
  status: ExecutionStatus;
  summary: string;
  nativeRef: string | null;
  updatedAt: string;
}

export interface CandidateVerification {
  status: VerificationStatus;
  summary: string | null;
  evidenceRef: string | null;
}

export interface Candidate {
  id: string;
  taskId: string;
  executorName: string;
  executorKind: AgentKind;
  method: string;
  execution: CandidateExecution;
  branch: string | null;
  pr: string | null;
  sha: string | null;
  baseSha: string | null;
  verification: CandidateVerification;
  review: Review | null;
  blockers: string[];
  todos: string[];
  updatedAt: string;
}

export interface Activity {
  id: string;
  projectId: string;
  taskId: string | null;
  kind: ActivityKind;
  actor: string;
  at: string;
  summary: string;
  sourceRef: string;
}

export interface ProjectSummary extends Sourced<Project> {
  taskCount: number;
}

export interface TaskSummary extends Sourced<Task> {
  requirementTitle: string;
  candidateCount: number;
  attentionCount: number;
}

export interface TaskDetail {
  task: Sourced<Task>;
  requirement: Sourced<Requirement>;
}

export interface WorkboardReader {
  getMeta(): Promise<DemoMeta>;
  listProjects(): Promise<ProjectSummary[]>;
  listTasks(projectId: string, status?: TaskStatus | 'all'): Promise<TaskSummary[]>;
  getTask(taskId: string): Promise<TaskDetail | null>;
  getCandidates(taskId: string): Promise<Sourced<Candidate>[]>;
  getActivities(projectId: string, taskId?: string | null): Promise<Sourced<Activity>[]>;
}
