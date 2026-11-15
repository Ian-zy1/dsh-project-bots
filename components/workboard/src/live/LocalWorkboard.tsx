import { useEffect, useState } from 'react';
import { api, list } from './api';
import ReadableText from './ReadableText';
import RequirementProgress from './RequirementProgress';
import { applicationRoot } from './urls';
import type { LocalProject, LocalRequirement, LocalTask } from './types';
import './local.css';

type LocationSelection = { project?: string; requirement?: string; task?: string; revision?: number };
type Load<T> = { scope: string; data?: T; error?: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : '读取失败';
const date = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function selectionFromUrl(): LocationSelection {
  const params = new URLSearchParams(location.search);
  const revision = params.get('revision');
  return { project: params.get('project') || undefined, requirement: params.get('requirement') || undefined,
    task: params.get('task') || undefined, revision: revision && /^[1-9]\d{0,8}$/.test(revision) ? Number(revision) : undefined };
}

export default function LocalWorkboard() {
  const [selection, setSelection] = useState(selectionFromUrl);
  const [refresh, setRefresh] = useState(0);
  const [entry, setEntry] = useState<Load<{ projects: LocalProject[]; deepTask?: LocalTask }>>();
  const [requirementList, setRequirements] = useState<Load<LocalRequirement[]>>();
  const [taskList, setTasks] = useState<Load<LocalTask[]>>();
  const directId = !selection.project && !selection.requirement ? selection.task : undefined;

  useEffect(() => {
    let active = true;
    const scope = directId ?? '';
    setEntry(previous => !directId && previous?.data ? { scope, data: { projects: previous.data.projects } } : { scope });
    const deep = directId ? api<LocalTask>('/tasks/' + encodeURIComponent(directId)) : Promise.resolve(undefined);
    Promise.allSettled([list<LocalProject>('/projects'), deep])
      .then(([projects, task]) => {
        if (!active) return;
        if (projects.status === 'rejected') setEntry({ scope, error: errorText(projects.reason) });
        else if (task.status === 'rejected') setEntry({ scope, data: { projects: projects.value }, error: '无法打开指定任务。' + errorText(task.reason) });
        else setEntry({ scope, data: { projects: projects.value, deepTask: task.value } });
      })
      .catch(error => { if (active) setEntry({ scope, error: errorText(error) }); });
    return () => { active = false; };
  }, [directId, refresh]);

  const projects = entry?.data?.projects ?? [];
  const deepTask = entry?.data?.deepTask;
  const project = projects.find(item => item.id === (selection.project ?? deepTask?.projectId)) ?? projects[0];
  const projectId = project?.id;
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setRequirements({ scope: projectId });
    list<LocalRequirement>('/requirements?projectId=' + encodeURIComponent(projectId))
      .then(data => { if (active) setRequirements({ scope: projectId, data }); })
      .catch(error => { if (active) setRequirements({ scope: projectId, error: errorText(error) }); });
    return () => { active = false; };
  }, [projectId, refresh]);

  const loadedRequirements = requirementList?.scope === projectId ? requirementList : undefined;
  const requirements = loadedRequirements?.data ?? [];
  const requirement = requirements.find(item => item.id === (selection.requirement ?? deepTask?.requirementId)) ?? requirements[0];
  const requirementId = requirement?.id;
  useEffect(() => {
    if (!requirementId) return;
    let active = true;
    setTasks({ scope: requirementId });
    list<LocalTask>('/tasks?requirementId=' + encodeURIComponent(requirementId))
      .then(data => { if (active) setTasks({ scope: requirementId, data }); })
      .catch(error => { if (active) setTasks({ scope: requirementId, error: errorText(error) }); });
    return () => { active = false; };
  }, [requirementId, refresh]);

  const loadedTasks = taskList?.scope === requirementId ? taskList : undefined;
  const tasks = loadedTasks?.data ?? [];
  const task = tasks.find(item => item.id === selection.task) ?? tasks[0];
  const revision = task?.id === selection.task ? selection.revision ?? task?.revision : task?.revision;
  const errors = [entry?.error, loadedRequirements?.error, loadedTasks?.error].filter(Boolean);
  const waiting = !entry?.data && !entry?.error
    || !!project && !loadedRequirements?.data && !loadedRequirements?.error
    || !!requirement && !loadedTasks?.data && !loadedTasks?.error;

  function navigate(next: LocationSelection) {
    const url = applicationRoot();
    if (next.project) url.searchParams.set('project', next.project);
    if (next.requirement) url.searchParams.set('requirement', next.requirement);
    if (next.task) url.searchParams.set('task', next.task);
    if (next.revision) url.searchParams.set('revision', String(next.revision));
    history.replaceState(null, '', url);
    setSelection(next);
  }
  function selectTask(next: LocalTask, version = next.revision) {
    navigate({ project: next.projectId, requirement: next.requirementId, task: next.id, revision: version });
  }

  return <div className="local-app aw-board">
    <aside className="local-sidebar">
      <div className="local-brand"><span className="local-logo aw-brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Agent Workboard</span></div>
      <nav aria-label="项目列表">{projects.map(item => <button key={item.id} type="button"
        className={item.id === projectId ? 'active' : ''} aria-current={item.id === projectId ? 'true' : undefined}
        onClick={() => navigate({ project: item.id })}><span>{item.name}</span></button>)}</nav>
    </aside>
    <main className="local-main">
      <header className="local-header">
        <h1>{project?.name ?? 'Agent Workboard'}</h1>
        <div className="local-toolbar"><button type="button" onClick={() => setRefresh(n => n + 1)} disabled={waiting}>刷新</button></div>
      </header>
      {errors.length > 0 && <p role="alert" className="local-error">{errors.join(' · ')}</p>}
      {waiting && <p role="status" className="local-muted">正在读取资料…</p>}
      {!waiting && errors.length === 0 && !project && <section className="local-empty"><h2>暂无项目</h2><p>Owner 录入项目和需求后，这里会显示执行轨迹。</p></section>}
      {project && <>
        <details className="local-project-details"><summary>项目资料</summary>
          <section className="aw-flow-project">
            {project.repositoryUrl && <p>仓库 <code>{project.repositoryUrl}</code></p>}
            {project.baseline && <p>基线 <code>{project.baseline}</code></p>}
            {project.environment && <ReadableText text={project.environment} inlineReferences />}
            {project.rules && <ReadableText text={project.rules} inlineReferences />}
          </section>
        </details>
        <div className="local-workspace">
          <aside className="local-requirements">
            <div className="local-section-title"><h2>需求</h2></div>
            {requirements.map(item => <button key={item.id} type="button" className={`local-req-card${item.id === requirementId ? ' selected' : ''}`}
              aria-current={item.id === requirementId ? 'true' : undefined} onClick={() => navigate({ project: project.id, requirement: item.id })}>
              <strong>{item.title}</strong><small>{date.format(new Date(item.updatedAt))}</small>
            </button>)}
            {!waiting && errors.length === 0 && requirements.length === 0 && <p className="local-muted">暂无需求。</p>}
          </aside>
          {requirement && <section className="local-content" aria-label="需求详情">
            <header className="local-requirement-header"><h2>{requirement.title}</h2></header>
            {task && revision && revision > task.revision ? <p className="local-error" role="alert">指定版本 v{revision} 不存在。
              <button onClick={() => selectTask(task)}>查看最新版本</button></p>
              : !loadedTasks?.data && !loadedTasks?.error ? null
                : <RequirementProgress key={requirement.id} requirement={requirement} tasks={tasks} task={task} revision={revision} refresh={refresh}
                  onSelect={selectTask} onRevision={version => { if (task) selectTask(task, version); }} />}
          </section>}
        </div>
      </>}
    </main>
  </div>;
}
