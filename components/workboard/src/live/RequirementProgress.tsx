import { useEffect, useId, useState } from 'react';
import { api, list } from './api';
import { copyText } from './browser';
import ReadableText from './ReadableText';
import { apiPath, applicationRoot } from './urls';
import { buildWorkflow, type FlowNode, type RelayQueueEvidence } from './workflow';
import type { DispatchRecord, LocalCandidate, LocalReport, LocalRequirement, LocalTask, SnapshotInfo } from './types';
import './workflow.css';

const clock = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const time = (value: string) => clock.format(new Date(value));
const messageOf = (error: unknown) => error instanceof Error ? error.message : '读取失败';
const unavailableRelay: RelayQueueEvidence = { state: 'unavailable', events: [] };
const disabledRelay: RelayQueueEvidence = { state: 'disabled', events: [] };
type FlowData = {
  snapshots: SnapshotInfo[];
  dispatches: DispatchRecord[];
  candidates: LocalCandidate[];
  unversioned: LocalCandidate[];
  reports: LocalReport[];
  relay: RelayQueueEvidence;
  incomplete: string[];
};

async function readFlow(taskId: string, revision: number): Promise<FlowData> {
  const path = '/tasks/' + encodeURIComponent(taskId);
  const queueUrl = new URL(`api/ui/tasks/${encodeURIComponent(taskId)}/relay-queue?revision=${revision}`, applicationRoot());
  const [snapshots, dispatches, allCandidates, relay] = await Promise.all([
    list<SnapshotInfo>(path + '/snapshots'),
    list<DispatchRecord>(`${path}/dispatch-records?revision=${revision}`),
    list<LocalCandidate>(path + '/candidates'),
    fetch(queueUrl.toString()).then(async response => {
      if (response.status === 404) return disabledRelay;
      return response.ok ? await response.json() as RelayQueueEvidence : unavailableRelay;
    })
      .catch(() => unavailableRelay),
  ]);
  const candidates = allCandidates.filter(item => item.taskRevision === revision);
  const batches = await Promise.allSettled(candidates.filter(item => item.reportCount > 0)
    .map(item => list<LocalReport>(`${path}/candidates/${encodeURIComponent(item.id)}/reports`)));
  const reports = batches.flatMap(batch => batch.status === 'fulfilled'
    ? batch.value.filter(item => item.taskRevision == null || item.taskRevision === revision) : []);
  const incomplete = [];
  if (batches.some(batch => batch.status === 'rejected')) incomplete.push('部分交付或评审记录暂不可读');
  if (relay.state === 'unavailable') incomplete.push('暂时无法读取 Relay 队列');
  return { snapshots, dispatches, candidates, reports, relay, incomplete,
    unversioned: allCandidates.filter(item => item.taskRevision == null) };
}

function FlowTrack({ nodes, selected, current, idPrefix, select }: {
  nodes: FlowNode[]; selected: string | null; current?: string; idPrefix: string; select: (id: string) => void;
}) {
  return <ol className="aw-flow-track">
    {nodes.map(node => {
      const nodeId = `${idPrefix}-${node.id}`;
      const expanded = node.id === selected;
      return <li key={node.id} className="aw-flow-entry" data-tone={node.tone} data-current={node.id === current}>
        <button id={nodeId} className="aw-flow-node" type="button" aria-expanded={expanded}
          aria-label={[node.title, node.status, node.at && time(node.at)].filter(Boolean).join(' ')}
          aria-controls={`${nodeId}-details`} aria-current={node.id === current ? 'step' : undefined} onClick={() => select(node.id)}>
          <span className="aw-flow-node-copy"><strong>{node.title}</strong><span>{node.status}</span></span>
          {node.at && <time dateTime={node.at}>{time(node.at)}</time>}
          <span className="aw-flow-chevron" aria-hidden="true" />
        </button>
        <section id={`${nodeId}-details`} className="aw-flow-inspector" aria-label="节点详情" hidden={!expanded}>
          {expanded && <>
            <ReadableText text={node.detail} inlineReferences />
            {!!node.references?.length && <details className="aw-progress-detail"><summary>证据引用</summary>
              <dl>{node.references.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl>
            </details>}
          </>}
        </section>
      </li>;
    })}
  </ol>;
}

function TaskFlow({ task, revision, refresh, selectRevision }: {
  task: LocalTask; revision: number; refresh: number; selectRevision: (revision: number) => void;
}) {
  const [data, setData] = useState<FlowData>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const idPrefix = useId();
  useEffect(() => {
    let active = true;
    setError('');
    readFlow(task.id, revision).then(value => { if (active) setData(value); })
      .catch(problem => { if (active) setError(messageOf(problem)); });
    return () => { active = false; };
  }, [task.id, revision, refresh, attempt]);

  if (error) return <p role="alert" className="local-error">进展读取失败。{error}<button type="button" onClick={() => setAttempt(n => n + 1)}>重试</button></p>;
  if (!data) return <p role="status" className="local-muted">正在读取执行记录…</p>;
  const flow = buildWorkflow({ revision, snapshotAt: data.snapshots.find(item => item.revision === revision)?.savedAt,
    dispatches: data.dispatches, candidates: data.candidates, reports: data.reports, relay: data.relay.events });
  const current = flow.current;
  const summary = !current || current.id === 'snapshot' ? '快照已保存，暂无派活记录'
    : current.title === current.status ? current.status : `${current.title} · ${current.status}`;
  const select = (id: string) => setSelected(value => value === id ? null : id);
  const trackProps = { selected, current: current?.id, idPrefix, select };
  const showReason = (id: string) => {
    setSelected(id);
    const control = document.getElementById(`${idPrefix}-${id}`);
    control?.focus({ preventScroll: true });
    control?.scrollIntoView?.({ block: 'nearest' });
  };
  return <>
    {data.snapshots.length > 1 && <label className="aw-flow-version">任务版本
      <select value={revision} onChange={event => selectRevision(Number(event.target.value))}>
        {data.snapshots.map(snapshot => <option key={snapshot.revision} value={snapshot.revision}>v{snapshot.revision}{snapshot.revision === task.revision ? ' · 最新' : ''}</option>)}
      </select>
    </label>}
    <div className="aw-flow-current" data-tone={current?.tone ?? 'neutral'} aria-live="polite">
      <strong>{summary}</strong>
      {current?.at && <time dateTime={current.at}>{time(current.at)}</time>}
    </div>
    {data.incomplete.length > 0 && <p className="local-muted" role="status">{data.incomplete.join(' · ')}</p>}
    {data.relay.observedAt && data.relay.state !== 'live' && <p className="local-muted aw-flow-caption">Relay 状态截至 <time dateTime={data.relay.observedAt}>{time(data.relay.observedAt)}</time>{data.relay.state === 'stale' ? ' · 更新已中断' : ''}</p>}
    <div className="aw-flow-lanes">
      <section aria-label="快照与派活"><FlowTrack nodes={flow.setup} {...trackProps} /></section>
      {flow.rounds.map((round, index) => <section key={round.id} className="aw-flow-lane">
        {round.returnedFrom && <div className="aw-flow-return">
          <span>{round.returnedFrom.label}</span>
          <button type="button" className="local-link" onClick={() => showReason(round.returnedFrom!.nodeId)}>查看原因</button>
        </div>}
        <h4>{round.returnedFrom ? `第 ${index + 1} 轮 · 返工后` : round.assignmentId ? '执行记录' : '候选记录'}
          {round.sha && <code>{round.sha.slice(0, 8)}</code>}</h4>
        <FlowTrack nodes={round.nodes} {...trackProps} />
      </section>)}
    </div>
    {data.unversioned.length > 0 && <details className="aw-progress-detail aw-flow-legacy"><summary>未绑定快照的历史记录（{data.unversioned.length}）</summary>
      {data.unversioned.map(candidate => <details className="aw-progress-detail" key={candidate.id}>
        <summary>{candidate.executorName} {candidate.sha?.slice(0, 8)}</summary>
        {Object.values(candidate.currentReviews ?? {}).map(item => <div key={item.id}>
          <strong>{item.reviewRole === 'owner' ? 'Owner 复审' : item.reviewRole === 'independent' ? '独立评审' : '评审记录'}</strong>
          <ReadableText text={item.summary} inlineReferences />
        </div>)}
      </details>)}
    </details>}
  </>;
}

function SnapshotDetails({ task, revision }: { task: LocalTask; revision: number }) {
  const [kind, setKind] = useState<'brief' | 'context'>();
  const [result, setResult] = useState<{ kind: string; value: unknown }>();
  const [error, setError] = useState('');
  const [copyState, setCopyState] = useState('');
  const path = kind ? `/tasks/${encodeURIComponent(task.id)}/${kind}?revision=${revision}` : '';
  useEffect(() => {
    if (!path || !kind) return;
    let active = true;
    setError('');
    api<unknown>(path).then(value => { if (active) setResult({ kind, value }); })
      .catch(problem => { if (active) setError(messageOf(problem)); });
    return () => { active = false; };
  }, [path, kind]);
  return <details className="aw-progress-detail"><summary>任务快照与 Agent 读取</summary>
    <div className="aw-flow-snapshot-actions">
      <button type="button" aria-pressed={kind === 'brief'} onClick={() => setKind(kind === 'brief' ? undefined : 'brief')}>固定摘要 v{revision}</button>
      <button type="button" aria-pressed={kind === 'context'} onClick={() => setKind(kind === 'context' ? undefined : 'context')}>固定 JSON v{revision}</button>
      {kind && <button type="button" className="local-link" onClick={() => {
        copyText(new URL(apiPath(path), location.origin).href).then(() => setCopyState('地址已复制'), () => setCopyState('复制失败'));
      }}>复制读取地址</button>}
      <span role="status">{copyState}</span>
    </div>
    {kind && (error ? <p role="alert">{error}</p> : result?.kind === kind
      ? <pre className="aw-flow-json" tabIndex={0}><code>{JSON.stringify(result.value, null, 2)}</code></pre>
      : <p role="status">正在读取快照…</p>)}
  </details>;
}

export default function RequirementProgress({ requirement, tasks, task, revision, refresh, onSelect, onRevision }: {
  requirement: LocalRequirement; tasks: LocalTask[]; task?: LocalTask; revision?: number; refresh: number;
  onSelect: (task: LocalTask) => void; onRevision: (revision: number) => void;
}) {
  const fixed = revision ?? task?.revision;
  return <div className="aw-flow-workspace">
    <section className="aw-flow-activity" aria-label="执行轨迹">
      <h3>执行轨迹</h3>
      {tasks.length > 1 && <label className="aw-flow-task-picker">任务
        <select value={task?.id ?? ''} onChange={event => { const next = tasks.find(item => item.id === event.target.value); if (next) onSelect(next); }}>
          {tasks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>}
      {task && fixed ? <TaskFlow key={`${task.id}:${fixed}`} task={task} revision={fixed} selectRevision={onRevision} refresh={refresh} />
        : <p className="local-muted">暂无任务记录。</p>}
    </section>
    <section className="aw-requirement-card aw-requirement-materials aw-flow-materials" aria-label="需求资料">
      <h3>需求资料</h3>
      {task && (task.requirementRevision !== requirement.revision || fixed !== task.revision)
        && <p className="local-muted">当前需求资料 v{requirement.revision}。历史执行依据可在任务快照中查看。</p>}
      <details className="aw-progress-detail"><summary>需求与范围</summary><ReadableText text={requirement.description} inlineReferences /></details>
      <details className="aw-progress-detail"><summary>实施计划</summary><ReadableText text={requirement.plan} inlineReferences /></details>
      <details className="aw-progress-detail"><summary>验收条件</summary><ReadableText text={requirement.acceptance} inlineReferences /></details>
      {task && fixed && <SnapshotDetails key={`${task.id}:${fixed}`} task={task} revision={fixed} />}
    </section>
  </div>;
}
