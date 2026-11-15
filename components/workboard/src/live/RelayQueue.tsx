import { useEffect, useState } from 'react';
import { applicationRoot } from './urls';

const stages = {
  received: 'Relay 已收报',
  binding_required: '等待绑定原 Owner',
  queue_unknown: '原会话入队结果待核对',
  queued: '已入队，等待原会话接手',
  reviewing: '原 Owner 已接手',
  reply_pending: '复审完成，等待飞书回帖',
  reply_failed: '复审完成，飞书回帖待重试',
  replied: '复审完成，飞书已回帖',
} as const;
const eventTypes = { 'implementation.ready': '候选交付', 'execution.blocked': '执行阻塞', 'execution.failed': '执行失败' } as const;
const conclusions = { accept: '通过', revise: '需修订', pending: '待补证' } as const;
type QueueEvent = {
  eventId: string;
  type: keyof typeof eventTypes;
  stage: keyof typeof stages;
  assignmentId: string;
  candidateSha?: string;
  conclusion?: keyof typeof conclusions;
  receivedAt: string;
  queuedAt?: string;
  startedAt?: string;
  reviewedAt?: string;
  repliedAt?: string;
  replyUrl?: string;
};
type Queue = { state: 'disabled' | 'unavailable' | 'live' | 'stale' | 'snapshot'; observedAt?: string; total?: number; events: QueueEvent[] };
const clock = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Timestamp({ value }: { value: string }) {
  return <time dateTime={value} title={value}>{clock.format(new Date(value))}</time>;
}

function wording(event: QueueEvent) {
  if (event.type !== 'implementation.ready' && event.stage === 'reviewing') return '原 Owner 正在核对';
  if (event.type !== 'implementation.ready' && event.stage === 'replied') return '核对完成，飞书已回帖';
  if (event.type !== 'implementation.ready' && event.stage === 'reply_pending') return '核对完成，等待飞书回帖';
  if (event.type !== 'implementation.ready' && event.stage === 'reply_failed') return '核对完成，飞书回帖待重试';
  return stages[event.stage];
}

function EventRow({ event }: { event: QueueEvent }) {
  const steps = [
    ['收报', event.receivedAt], ['入队确认', event.queuedAt], ['接手', event.startedAt],
    [event.type === 'implementation.ready' ? '复审完成' : '核对完成', event.reviewedAt], ['已回帖', event.repliedAt],
  ].filter((step): step is [string, string] => typeof step[1] === 'string');
  return <li>
    <div className="relay-event-heading"><strong>{eventTypes[event.type]}</strong><span>{wording(event)}</span></div>
    <div className="relay-event-reference">
      <span title={event.assignmentId}>执行轮次 <code>{event.assignmentId.slice(0, 12)}</code></span>
      {event.candidateSha && <span>候选 <code title={event.candidateSha}>{event.candidateSha.slice(0, 7)}</code></span>}
      {event.conclusion && <span>结论 {conclusions[event.conclusion]}</span>}
      {event.replyUrl && <a href={event.replyUrl} target="_blank" rel="noreferrer">飞书原话题</a>}
    </div>
    <dl className="relay-event-times">{steps.map(([label, at]) => <div key={label}><dt>{label}</dt><dd><Timestamp value={at} /></dd></div>)}</dl>
  </li>;
}

export default function RelayQueue({ taskId, revision }: { taskId: string; revision: number }) {
  const [queue, setQueue] = useState<Queue | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const url = new URL(`api/ui/tasks/${encodeURIComponent(taskId)}/relay-queue?revision=${revision}`, applicationRoot());
    let timer: number | undefined;
    async function refresh() {
      let poll = true;
      try {
        if (document.visibilityState !== 'hidden') {
          const response = await fetch(url.toString(), { signal: controller.signal });
          if (!response.ok) throw new Error('Queue request failed');
          const next: Queue = await response.json();
          if (!controller.signal.aborted) setQueue(previous => next.state === 'unavailable' && previous?.observedAt
            ? { ...previous, state: 'stale' } : next);
          poll = next.state !== 'disabled' && next.state !== 'snapshot';
        }
      } catch {
        if (!controller.signal.aborted) setQueue(previous => previous?.observedAt
          ? { ...previous, state: 'stale' } : { state: 'unavailable', events: [] });
      }
      if (poll && !controller.signal.aborted) timer = window.setTimeout(() => void refresh(), 12000);
    }
    void refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [taskId, revision]);

  if (!queue || queue.state === 'disabled') return null;
  const latest = queue.events[0];
  const status = latest ? wording(latest) : queue.state === 'unavailable' ? '暂时无法读取队列' : '暂无 Relay 收报';
  const tone = latest?.stage === 'replied' ? 'done'
    : (latest && ['binding_required', 'queue_unknown', 'reply_failed'].includes(latest.stage)) || queue.state === 'unavailable' ? 'attention' : 'neutral';
  const body = <>
    <span className="relay-queue-label">Owner 接续</span>
    <span className="relay-queue-status" data-tone={tone}>{status}</span>
    {queue.observedAt && <span className="relay-queue-updated">
      {queue.state === 'live' ? '更新于' : '状态截至'} <Timestamp value={queue.observedAt} />
      {queue.state === 'stale' && ' · 更新已中断'}
    </span>}
  </>;
  return latest ? <details className="relay-queue">
    <summary>{body}</summary>
    <ol aria-label="Owner 接续历史" className="relay-event-list">{queue.events.map(event => <EventRow key={event.eventId} event={event} />)}</ol>
    {!!queue.total && queue.total > queue.events.length && <p className="relay-queue-note">显示最近 {queue.events.length} 条，共 {queue.total} 条</p>}
  </details> : <div className="relay-queue relay-queue-empty">{body}</div>;
}
