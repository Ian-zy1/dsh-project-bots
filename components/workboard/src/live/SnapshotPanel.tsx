import { useEffect, useState } from 'react';
import { api, list } from './api';
import CandidateDelivery from './CandidateDelivery';
import ReadableText from './ReadableText';
import { snapshotDiff } from './snapshotDiff';
import { apiPath } from './urls';
import type { ContextSection, LocalCandidate, LocalTask, SnapshotInfo, TaskContext } from './types';

type View = 'snapshot' | 'results' | 'changes' | 'agent';
export type SelectedSnapshot = Pick<SnapshotInfo, 'taskId' | 'revision' | 'title'>;
const errorText = (e: unknown) => e instanceof Error ? e.message : '读取失败';
const proseFields = new Set(['description', 'acceptance', 'plan', 'environment', 'rules']);
const labels: Record<string, string> = { title: '标题', description: '说明', acceptance: '验收条件', sourceRef: '来源引用', priority: '优先级', dependsOn: '依赖任务', name: '项目名称', repositoryUrl: '仓库', baseline: '代码基线', environment: '环境说明', rules: '项目规则', plan: '实施计划' };

export default function SnapshotPanel({ task, candidates, candidatesLoading, candidatesError, onRetry, onSelect }: {
  task: LocalTask; candidates: LocalCandidate[]; candidatesLoading: boolean; candidatesError: string;
  onRetry: () => void; onSelect: (info: SelectedSnapshot | null) => void;
}) {
  const [revision, setRevision] = useState(() => {
    const q = new URLSearchParams(location.search);
    const n = Number(q.get('revision'));
    return q.get('task') === task.id && Number.isInteger(n) && n > 0 ? n : task.revision;
  });
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [view, setView] = useState<View>('snapshot');
  const [section, setSection] = useState<'task' | 'requirement' | 'project'>('task');
  const [content, setContent] = useState<ContextSection | null>(null);
  const [changes, setChanges] = useState<ReturnType<typeof snapshotDiff> | null>(null);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [retry, setRetry] = useState(0);
  const info = snapshots.find(s => s.revision === revision);
  const previous = snapshots.find(s => s.revision < revision);
  const base = apiPath(`/tasks/${task.id}/context?revision=${revision}`);

  useEffect(() => {
    let active = true; setHistoryError('');
    list<SnapshotInfo>(`/tasks/${task.id}/snapshots`).then(rows => { if (active) setSnapshots(rows); }).catch(e => { if (active) setHistoryError(errorText(e)); });
    return () => { active = false; };
  }, [task.id, retry]);

  useEffect(() => {
    if (info) onSelect(info);
    else if (content?.taskId === task.id && content.revision === revision && content.section === 'task' && typeof content.content.title === 'string') {
      onSelect({ taskId: task.id, revision, title: content.content.title });
    }
  }, [info, content, task.id, revision, onSelect]);

  useEffect(() => {
    let active = true; setContent(null); setChanges(null); setError('');
    if (view === 'snapshot') api<ContextSection>(`/tasks/${task.id}/context?revision=${revision}&section=${section}`)
      .then(value => { if (active) setContent(value); }).catch(e => { if (active) setError(errorText(e)); });
    if (view === 'changes' && previous) Promise.all([
      api<TaskContext>(`/tasks/${task.id}/context?revision=${previous.revision}`),
      api<TaskContext>(`/tasks/${task.id}/context?revision=${revision}`),
    ]).then(([a, b]) => { if (active) setChanges(snapshotDiff(a, b)); }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [task.id, revision, section, view, previous?.revision, retry]);

  function select(value: string) {
    const n = Number(value); setRevision(n);
    history.replaceState(null, '', `?task=${task.id}&revision=${n}`);
    onSelect(snapshots.find(s => s.revision === n) ?? null);
  }
  const related = candidates.filter(c => c.taskRevision == null || c.taskRevision === revision);

  return <section className="snapshot-panel" aria-label="任务快照">
    <header className="snapshot-heading">
      <div><p className="local-eyebrow">VERSIONED CONTEXT</p><h3>任务快照 <span className="snapshot-pill">v{revision}</span></h3></div>
      <label className="snapshot-version">浏览版本<select aria-label="快照版本" value={revision} onChange={e => select(e.target.value)}>
        {snapshots.length ? snapshots.map(s => <option value={s.revision} key={s.revision}>v{s.revision}{s.revision === task.revision ? ' · 最新' : ' · 历史'}</option>) : <option value={revision}>v{revision}</option>}
      </select></label>
    </header>
    <p className="snapshot-caption">快照保留当时的任务依据；后续回报单独关联。浏览与读取不会派活。</p>
    {revision !== task.revision && <p className="local-warning" role="note">正在查看历史快照 v{revision}，当前最新为 v{task.revision}。复制地址与交接说明均使用所选版本。</p>}
    {historyError && <div className="local-error" role="alert">版本列表：{historyError}<button onClick={() => setRetry(n => n + 1)}>重试版本列表</button></div>}
    {info && <div className="snapshot-facts"><span>需求 <strong>v{info.requirementRevision}</strong></span><span>项目 <strong>v{info.projectRevision}</strong></span><span>{info.contentBytes.toLocaleString()} 字节</span><span title={info.digest}>SHA-256 <code>{info.digest.slice(0, 12)}</code></span><span>{info.savedAt ? new Date(info.savedAt).toLocaleString('zh-CN') : '旧快照 · 未记录生成时间'}</span></div>}
    <nav className="snapshot-tabs" aria-label="快照视图">{([['snapshot', '快照正文'], ['results', '关联结果'], ['changes', '版本差异'], ['agent', 'Agent 读取']] as [View, string][]).map(([id, label]) =>
      <button key={id} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>{label}{id === 'results' && <span>{related.length}</span>}</button>)}</nav>
    {error && <div className="local-error" role="alert">{error}<button onClick={() => setRetry(n => n + 1)}>重试快照读取</button></div>}
    {view === 'snapshot' && <>
      <div className="snapshot-sections" aria-label="背景分段">{([['task', '任务'], ['requirement', '需求背景'], ['project', '项目环境']] as const).map(([id, label]) => <button key={id} aria-pressed={section === id} onClick={() => setSection(id)}>{label}</button>)}</div>
      {!content && !error && <p role="status">正在读取所选快照…</p>}
      {content && <div className="snapshot-document">
        <p className="snapshot-document-label">{section === 'task' ? '任务依据' : section === 'requirement' ? '需求背景' : '项目环境'} · 固定于 v{revision}</p>
        {Object.entries(content.content).filter(([key]) => key in labels).map(([key, value]) => <section className="local-copy" key={key}><h4>{labels[key]}</h4>{proseFields.has(key) && typeof value === 'string'
          ? <ReadableText text={value} empty="未提供" />
          : <div>{Array.isArray(value) ? value.join('\n') || '无' : String(value || '未提供')}</div>}</section>)}
        <p className="snapshot-caption">以上为快照生成时的内容；当前状态与后来的决定请对照带来源的回报。{content.authorization}</p>
      </div>}
    </>}
    {view === 'results' && <><p className="snapshot-caption">仅显示关联 v{revision} 的候选；未记录版本的旧候选单独标注，不推断其依据。</p><CandidateDelivery key={`${task.id}:${revision}`} candidates={related} loading={candidatesLoading} error={candidatesError} onRetry={onRetry} /></>}
    {view === 'changes' && !historyError && snapshots.length > 0 && <section className="snapshot-changes" aria-label="版本差异">
      <h4>{previous ? `v${previous.revision} → v${revision}` : '首个快照'}</h4>
      {!previous ? <p>没有更早的快照可供比较。</p> : changes ? <><p>{changes.length ? `${changes.length} 项内容变更` : '正文没有变化，仅版本或来源修订信息不同。'}</p>{changes.map(c => <article className="snapshot-change" key={c.label}><h4>{c.label}</h4><div><section><span>v{previous.revision} · 修改前</span><pre>{c.before || '未提供'}</pre></section><section><span>v{revision} · 修改后</span><pre>{c.after || '未提供'}</pre></section></div></article>)}</> : !error && <p role="status">正在比较两个固定版本…</p>}
    </section>}
    {view === 'agent' && <section className="snapshot-agent" aria-label="Agent 按需读取">
      <h4>先读摘要，再取需要的背景</h4><p>这些地址固定到 v{revision}。摘要中的 current 单独说明当前记录，不会改变快照。</p>
      <div className="snapshot-endpoints"><a href={apiPath(`/tasks/${task.id}/brief?revision=${revision}`)} target="_blank" rel="noreferrer">精简摘要 ↗</a>{(['task', 'requirement', 'project'] as const).map(s => <a key={s} href={`${base}&section=${s}`} target="_blank" rel="noreferrer">{s === 'task' ? '任务与验收' : s === 'requirement' ? '需求背景' : '项目环境'} ↗</a>)}<a href={base} target="_blank" rel="noreferrer">完整 JSON ↗</a><a href={`${base}&format=markdown`} target="_blank" rel="noreferrer">完整 Markdown ↗</a></div>
      <label className="local-field"><span>可复制的读取示例</span><textarea aria-label="Agent 读取示例" readOnly rows={4} value={`curl -fsS '${location.origin}${apiPath(`/tasks/${task.id}/brief?revision=${revision}`)}'\n# 需要任务正文与验收时：\ncurl -fsS '${location.origin}${base}&section=task'`} /></label>
      {info && <p className="snapshot-digest">快照指纹 SHA-256<code>{info.digest}</code></p>}
      <p className="snapshot-caption">本机入口仅供受信任调用。远端 Agent 需使用已配置的访问通道，不能把远端的 localhost 当作此机器。</p>
    </section>}
  </section>;
}
