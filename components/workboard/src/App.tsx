import { useEffect, useRef, useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from './components/AsyncNotice';
import { DemoBanner } from './components/DemoBanner';
import { TaskDetail } from './components/TaskDetail';
import { TaskFilters } from './components/TaskFilters';
import { TaskList } from './components/TaskList';
import type {
  Activity,
  Candidate,
  DemoMeta,
  ProjectSummary,
  Sourced,
  TaskDetail as TaskDetailModel,
  TaskStatus,
  TaskSummary,
  WorkboardReader,
} from './domain/types';
import { formatDateTime } from './lib/format';

interface AppProps {
  reader: WorkboardReader;
}

export default function App({ reader }: AppProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [meta, setMeta] = useState<DemoMeta | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [appLoading, setAppLoading] = useState(true);
  const [appError, setAppError] = useState<string | null>(null);

  const [status, setStatus] = useState<TaskStatus | 'all'>('all');
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [detail, setDetail] = useState<TaskDetailModel | null>(null);
  const [candidates, setCandidates] = useState<Sourced<Candidate>[]>([]);
  const [activities, setActivities] = useState<Sourced<Activity>[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const paneSwitchRequested = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setAppLoading(true);
    setAppError(null);
    setMeta(null);
    setProjects([]);

    Promise.all([reader.getMeta(), reader.listProjects()])
      .then(([nextMeta, nextProjects]) => {
        if (cancelled) {
          return;
        }
        setMeta(nextMeta);
        setProjects(nextProjects);
        setProjectId((current) =>
          current && nextProjects.some((project) => project.id === current)
            ? current
            : (nextProjects[0]?.id ?? null),
        );
        setAppLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setAppError('无法读取演示资料。');
          setAppLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [reader, reloadKey]);

  useEffect(() => {
    if (!projectId) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    setTasksLoading(true);
    setTasksError(null);

    reader
      .listTasks(projectId, status)
      .then((nextTasks) => {
        if (cancelled) {
          return;
        }
        setTasks(nextTasks);
        setTasksLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setTasksError('无法读取任务列表。');
        setTasks([]);
        setTasksLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reader, projectId, status, reloadKey]);

  useEffect(() => {
    if (tasksLoading || tasksError) {
      return;
    }
    setSelectedTaskId((current) => {
      if (current && tasks.some((task) => task.id === current)) {
        return current;
      }
      return tasks[0]?.id ?? null;
    });
  }, [tasks, tasksLoading, tasksError]);

  useEffect(() => {
    if (!selectedTaskId || !projectId) {
      setDetail(null);
      setCandidates([]);
      setActivities([]);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);

    Promise.all([
      reader.getTask(selectedTaskId),
      reader.getCandidates(selectedTaskId),
      reader.getActivities(projectId, selectedTaskId),
    ])
      .then(([nextDetail, nextCandidates, nextActivities]) => {
        if (cancelled) {
          return;
        }
        if (!nextDetail) {
          setDetail(null);
          setDetailError('未找到该任务。');
        } else {
          setDetail(nextDetail);
        }
        setCandidates(nextCandidates);
        setActivities(nextActivities);
        setDetailLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setDetail(null);
        setCandidates([]);
        setActivities([]);
        setDetailError('无法读取任务详情。');
        setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reader, selectedTaskId, projectId, reloadKey]);

  useEffect(() => {
    if (!paneSwitchRequested.current) {
      return;
    }
    paneSwitchRequested.current = false;
    if (typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 900px)').matches) {
      return;
    }
    const pane = document.querySelector<HTMLElement>(mobileDetail ? '.detail-pane' : '.task-pane');
    pane?.scrollIntoView({ block: 'start', behavior: 'auto' });
    if (mobileDetail) {
      pane?.focus({ preventScroll: true });
    } else if (selectedTaskId) {
      document.querySelector<HTMLElement>(`.task-card[data-task-id="${selectedTaskId}"]`)?.focus({ preventScroll: true });
    }
  }, [mobileDetail, selectedTaskId]);

  const currentProject = projects.find((project) => project.id === projectId) ?? null;

  function handleProjectChange(nextProjectId: string) {
    setProjectId(nextProjectId);
    setSelectedTaskId(null);
    setMobileDetail(false);
  }

  function handleSelectTask(taskId: string) {
    paneSwitchRequested.current = true;
    setSelectedTaskId(taskId);
    setMobileDetail(true);
  }

  function handleBackToList() {
    paneSwitchRequested.current = true;
    setMobileDetail(false);
  }

  function handleStatusChange(nextStatus: TaskStatus | 'all') {
    setStatus(nextStatus);
    setMobileDetail(false);
  }

  function retry() {
    setReloadKey((current) => current + 1);
  }

  if (appLoading) {
    return (
      <div className="app-shell">
        <LoadingState label="正在读取演示资料…" />
      </div>
    );
  }

  if (appError) {
    return (
      <div className="app-shell">
        <ErrorState
          title="读取失败"
          detail="演示数据读取失败。展示版不会把读取失败显示为成功或空数据。"
          onRetry={retry}
        >
          <p className="meta-line">可用 ?scenario=error 复现该状态；页面不需要网络或 Token。</p>
        </ErrorState>
      </div>
    );
  }

  if (!meta || !currentProject) {
    return (
      <div className="app-shell">
        <EmptyState title="没有可展示的项目" detail="演示资料为空；这不代表真实项目已经完成或同步成功。" />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Agent Workboard · 只读展示版</p>
          <h1>项目、任务与候选实现</h1>
        </div>
        <label className="project-select">
          <span>项目</span>
          <select
            aria-label="选择项目"
            value={currentProject.id}
            onChange={(event) => handleProjectChange(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </header>

      <DemoBanner meta={meta} />

      <section className="project-card" aria-labelledby="project-heading">
        <div className="project-card__main">
          <h2 id="project-heading">{currentProject.name}</h2>
          <p>{currentProject.summary}</p>
          <p className="meta-line">
            任务 {currentProject.taskCount} · 更新 {formatDateTime(currentProject.updatedAt)}
          </p>
        </div>
        <div className="project-card__refs">
          <div>
            <h3>关联仓库</h3>
            <ul>
              {currentProject.repositories.map((repository) => (
                <li key={repository.name}>
                  <span className="mono">{repository.name}</span> · {repository.role}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3>项目资料</h3>
            <ul>
              {currentProject.resources.map((resource) => (
                <li key={resource.ref}>
                  {resource.label} · {resource.ref}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <div className={`workspace${mobileDetail ? ' workspace--detail' : ''}`}>
        <aside className="task-pane" aria-label="任务列表">
          <div className="pane-heading">
            <h2>任务</h2>
            <span className="meta-line">共 {tasks.length} 项</span>
          </div>
          <TaskFilters value={status} onChange={handleStatusChange} />
          {tasksLoading ? (
            <LoadingState label="正在读取任务列表…" />
          ) : tasksError ? (
            <ErrorState title="任务列表读取失败" detail={tasksError} onRetry={retry} />
          ) : tasks.length === 0 ? (
            <EmptyState
              title="没有符合条件的任务"
              detail="切换项目或状态筛选查看其他任务；空列表不代表读取成功。"
            />
          ) : (
            <TaskList tasks={tasks} selectedTaskId={selectedTaskId} onSelect={handleSelectTask} />
          )}
        </aside>

        <section className="detail-pane" aria-label="任务详情" tabIndex={-1}>
          {detailLoading ? (
            <LoadingState label="正在读取任务详情…" />
          ) : detailError ? (
            <ErrorState title="任务详情读取失败" detail={detailError} onRetry={retry} />
          ) : detail ? (
            <TaskDetail
              detail={detail}
              candidates={candidates}
              activities={activities}
              onBack={handleBackToList}
            />
          ) : (
            <EmptyState
              title="未选择任务"
              detail="从任务列表选择一项，查看需求依据、候选证据与活动记录。"
            />
          )}
        </section>
      </div>

      <footer className="app-footer">
        只读展示版：不创建、派发、停止、审批或合入任务；全部为演示数据，无需网络或 Token。
      </footer>
    </div>
  );
}
