import rawDataset from './demoData.json';
import { reviewForCandidate } from '../../lib/evidence';
import type {
  Activity,
  Candidate,
  DemoMeta,
  Project,
  ProjectSummary,
  Requirement,
  Review,
  Sourced,
  Task,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  WorkboardReader,
} from '../../domain/types';

interface RawCandidate extends Omit<Candidate, 'review'> {
  reviewId: string | null;
}

interface RawDataset {
  meta: DemoMeta;
  projects: Project[];
  requirements: Requirement[];
  tasks: Task[];
  candidates: RawCandidate[];
  reviews: Review[];
  activities: Activity[];
}

const dataset = rawDataset as unknown as RawDataset;

export class DemoReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoReadError';
  }
}

export interface DemoReaderOptions {
  scenario?: 'normal' | 'error';
}

function sourced<T extends { id: string }>(entity: T, kind: string, updatedAt: string): Sourced<T> {
  return {
    ...entity,
    provenance: {
      demo: true,
      sourceType: 'demo',
      updatedAt,
      sourceRef: `demo-data.json#${kind}/${entity.id}`,
    },
  };
}

export function createDemoReader(options: DemoReaderOptions = {}): WorkboardReader {
  const scenario = options.scenario ?? 'normal';
  const reviewsById = new Map(dataset.reviews.map((review) => [review.id, review]));

  async function guard(): Promise<void> {
    if (scenario === 'error') {
      throw new DemoReadError('演示读取失败：数据源未就绪（?scenario=error 模拟）。');
    }
  }

  return {
    async getMeta(): Promise<DemoMeta> {
      await guard();
      return dataset.meta;
    },

    async listProjects(): Promise<ProjectSummary[]> {
      await guard();
      return dataset.projects
        .map((project) => ({
          ...sourced(project, 'projects', project.updatedAt),
          taskCount: dataset.tasks.filter((task) => task.projectId === project.id).length,
        }));
    },

    async listTasks(projectId: string, status: TaskStatus | 'all' = 'all'): Promise<TaskSummary[]> {
      await guard();
      return dataset.tasks
        .filter((task) => task.projectId === projectId && (status === 'all' || task.status === status))
        .map((task) => {
          const requirement = dataset.requirements.find((item) => item.id === task.requirementId);
          const candidates = dataset.candidates.filter((candidate) => candidate.taskId === task.id);
          return {
            ...sourced(task, 'tasks', task.updatedAt),
            requirementTitle: requirement?.title ?? '未知需求',
            candidateCount: candidates.length,
            attentionCount: candidates.filter(
              (candidate) => candidate.blockers.length > 0 || candidate.todos.length > 0,
            ).length,
          };
        })
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    },

    async getTask(taskId: string): Promise<TaskDetail | null> {
      await guard();
      const task = dataset.tasks.find((item) => item.id === taskId);
      if (!task) {
        return null;
      }
      const requirement = dataset.requirements.find((item) => item.id === task.requirementId);
      if (!requirement) {
        return null;
      }
      return {
        task: sourced(task, 'tasks', task.updatedAt),
        requirement: sourced(requirement, 'requirements', requirement.updatedAt),
      };
    },

    async getCandidates(taskId: string): Promise<Sourced<Candidate>[]> {
      await guard();
      return dataset.candidates
        .filter((candidate) => candidate.taskId === taskId)
        .map((candidate) => {
          const review = candidate.reviewId ? (reviewsById.get(candidate.reviewId) ?? null) : null;
          return sourced({ ...candidate, review: reviewForCandidate(review, candidate.id) }, 'candidates', candidate.updatedAt);
        });
    },

    async getActivities(projectId: string, taskId?: string | null): Promise<Sourced<Activity>[]> {
      await guard();
      return dataset.activities
        .filter((activity) => {
          if (activity.projectId !== projectId) {
            return false;
          }
          if (taskId === undefined) {
            return true;
          }
          return activity.taskId === taskId;
        })
        .map((activity) => sourced(activity, 'activities', activity.at))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    },
  };
}
