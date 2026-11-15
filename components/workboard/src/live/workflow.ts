import type { DispatchRecord, LocalCandidate, LocalReport } from './types';

export type Tone = 'neutral' | 'active' | 'success' | 'warning';
export interface FlowNode {
  id: string;
  title: string;
  status: string;
  detail: string;
  tone: Tone;
  at?: string | null;
  references?: [string, string][];
}
export interface FlowRound {
  id: string;
  candidateId?: string;
  sha?: string;
  ticketId?: string;
  assignmentId?: string;
  nodes: FlowNode[];
  startedAt?: string | null;
  returnedFrom?: { label: string; nodeId: string };
}
export interface RelayEvidence {
  eventId: string;
  assignmentId: string;
  ticketId: string;
  candidateSha?: string;
  type: 'implementation.ready' | 'execution.blocked' | 'execution.failed';
  stage: 'received' | 'binding_required' | 'queue_unknown' | 'queued' | 'reviewing' | 'reply_pending' | 'reply_failed' | 'replied';
  conclusion?: 'accept' | 'revise' | 'pending';
  receivedAt: string;
  queuedAt?: string;
  startedAt?: string;
  reviewedAt?: string;
  repliedAt?: string;
  replyUrl?: string;
}
export interface RelayQueueEvidence {
  state: 'disabled' | 'unavailable' | 'live' | 'stale' | 'snapshot';
  observedAt?: string;
  total?: number;
  events: RelayEvidence[];
}

const dispatchStates = { received: '请求已收到', accepted: '已接单', assessment_timeout: '接单超时', failed: '派活失败' } as const;
const verificationStates = { passed: '验证通过', failed: '验证失败', partial: '部分通过', not_run: '未运行', unknown: '验证待确认' } as const;
const reviewStates = { accepted: '通过', changes_requested: '退回返工', pending: '待补证' } as const;
const relayStates = {
  received: ['Relay 已收报', '等 Relay 登记接续', 'neutral'],
  binding_required: ['等待 Owner 绑定', '等原 Owner 登记任务绑定', 'warning'],
  queue_unknown: ['入队结果待核对', '核对原会话是否已收到结果', 'warning'],
  queued: ['等待 Owner 接手', '已入队，等原会话开始', 'active'],
  reviewing: ['原 Owner 已接手', '等原 Owner 完成复审', 'active'],
  reply_pending: ['等待飞书回帖', 'Owner 已提交结论', 'active'],
  reply_failed: ['飞书回帖待重试', 'Owner 已提交结论，Relay 正在等待重试', 'warning'],
  replied: ['飞书已回帖', '结论已回到飞书原话题', 'success'],
} as const;

const moment = (at?: string | null) => at ? Date.parse(at) || 0 : 0;
const eventTime = (report: LocalReport) => report.occurredAt || report.at;
const ticketFrom = (value?: string | null) => /^ticket\/([\w-]+)\/result$/.exec(value ?? '')?.[1];
const latest = (nodes: FlowNode[]) => nodes.reduce<FlowNode | undefined>((best, node) => !best || moment(node.at) >= moment(best.at) ? node : best, undefined);

function reportNode(report: LocalReport): FlowNode {
  const at = eventTime(report);
  const references: [string, string][] = [];
  if (report.sourceRef) references.push(['来源', report.sourceRef]);
  if (report.reviewedSha) references.push(['评审提交', report.reviewedSha]);
  if (report.sha) references.push(['交付提交', report.sha]);
  if (report.prUrl) references.push(['交付地址', report.prUrl]);
  if (report.verification?.evidenceRef) references.push(['验证证据', report.verification.evidenceRef]);
  if (report.reviewedBy) references.push(['评审者', report.reviewedBy]);
  if (report.kind === 'review') {
    const title = report.reviewRole === 'owner' ? 'Owner 复审' : report.reviewRole === 'independent' ? '独立评审' : '评审记录';
    const status = report.verdict ? reviewStates[report.verdict] : '结论待确认';
    return { id: report.id, title, status, detail: report.summary, at, references,
      tone: report.verdict === 'accepted' ? 'success' : report.verdict === 'changes_requested' ? 'warning' : 'neutral' };
  }
  const status = report.kind === 'delivery' ? (report.verification ? verificationStates[report.verification.status] : '已记录')
    : report.kind === 'blocked' ? '执行阻塞' : '进度回报';
  return { id: report.id, title: report.kind === 'delivery' ? '候选交付' : status, status, at, references,
    detail: [report.summary, report.verification?.summary].filter(Boolean).join('\n\n'),
    tone: report.kind === 'blocked' || report.verification?.status === 'failed' ? 'warning'
      : report.verification?.status === 'passed' ? 'success' : 'neutral' };
}

function relayNode(event: RelayEvidence): FlowNode {
  const [status, detail, tone] = relayStates[event.stage];
  const conclusion = event.conclusion === 'accept' ? '通过'
    : event.conclusion === 'revise' ? '需返工' : event.conclusion === 'pending' ? '待补证' : '';
  const references: [string, string][] = [['Ticket', event.ticketId], ['执行轮次', event.assignmentId]];
  if (event.replyUrl) references.push(['飞书原话题', event.replyUrl]);
  const title = event.type === 'execution.failed' ? '执行失败回报'
    : event.type === 'execution.blocked' ? '执行阻塞回报' : 'Owner 接续';
  return { id: 'relay:' + event.eventId, title, status: conclusion ? `${status} · ${conclusion}` : status,
    detail: conclusion ? `${detail}。复审结论：${conclusion}。` : detail,
    at: event.repliedAt ?? event.reviewedAt ?? event.startedAt ?? event.queuedAt ?? event.receivedAt,
    tone: event.conclusion === 'revise' || event.type !== 'implementation.ready' ? 'warning' : tone, references };
}

export function buildWorkflow(input: {
  revision: number;
  snapshotAt?: string | null;
  dispatches: DispatchRecord[];
  candidates: LocalCandidate[];
  reports: LocalReport[];
  relay: RelayEvidence[];
}) {
  const setup: FlowNode[] = [{ id: 'snapshot', title: '任务快照', status: `固定 v${input.revision}`, detail: '这一版保存执行时使用的项目背景、任务范围及验收条件。', at: input.snapshotAt, tone: 'neutral' }];
  setup.push(...[...input.dispatches].sort((a, b) => moment(a.occurredAt) - moment(b.occurredAt)).map<FlowNode>(record => ({
    id: record.id, title: '派活', status: dispatchStates[record.outcome], at: record.occurredAt,
    detail: [record.summary, record.nextAction].filter(Boolean).join('\n\n'),
    tone: record.outcome === 'failed' || record.outcome === 'assessment_timeout' ? 'warning' : 'neutral',
    references: [['来源', record.sourceRef], ...(record.ticketRef ? [['Ticket', record.ticketRef] as [string, string]] : [])],
  })));

  const rounds: FlowRound[] = [];
  const rework = new Map(input.reports.filter(report => report.verdict === 'changes_requested')
    .map(report => [report.id, `${reportNode(report).title}退回返工`]));
  for (const item of input.relay) if (item.conclusion === 'revise') rework.set('relay:' + item.eventId, 'Owner 复审退回返工');
  for (const candidate of input.candidates) {
    const reports = input.reports.filter(report => report.candidateId === candidate.id)
      .sort((a, b) => moment(eventTime(a)) - moment(eventTime(b)));
    const groups = new Map<string | undefined, LocalReport[]>();
    for (const report of reports) {
      // An unqualified report stays at candidate level once more than one submitted SHA is known.
      const sha = report.reviewedSha ?? report.sha ?? undefined;
      groups.set(sha, [...groups.get(sha) ?? [], report]);
    }
    const currentSha = candidate.sha ?? undefined;
    if (!groups.has(currentSha)) groups.set(currentSha, []);
    if (groups.size === 2 && groups.has(undefined) && currentSha) {
      groups.set(currentSha, [...groups.get(currentSha)!, ...groups.get(undefined)!]
        .sort((a, b) => moment(eventTime(a)) - moment(eventTime(b))));
      groups.delete(undefined);
    }
    for (const [sha, history] of groups) {
      const active = sha === currentSha;
      const delivery = history.find(report => report.kind === 'delivery');
      const references: [string, string][] = [];
      if (sha) references.push(['候选 SHA', sha]);
      if (active && candidate.baseSha) references.push(['基线', candidate.baseSha]);
      if (active && candidate.branch) references.push(['分支', candidate.branch]);
      if (active && candidate.prUrl) references.push(['交付地址', candidate.prUrl]);
      const delivered = delivery ? reportNode(delivery) : undefined;
      const first: FlowNode = delivered ? {
        ...delivered, status: sha ? `${sha.slice(0, 8)} · ${delivered.status}` : delivered.status,
        references: [...references, ...delivered.references ?? []].filter(([label, value], i, rows) =>
          rows.findIndex(([otherLabel, otherValue]) => label === otherLabel && value === otherValue) === i),
      } : {
        id: 'candidate:' + candidate.id + ':' + (sha ?? 'record'),
        title: '候选记录', status: sha?.slice(0, 8) ?? '未关联提交',
        at: active ? candidate.updatedAt : history[0] ? eventTime(history[0]) : candidate.createdAt,
        detail: candidate.executorName, tone: 'neutral', references,
      };
      const nodes = [first, ...history.filter(report => report !== delivery).map(reportNode)];
      rounds.push({ id: nodes[0]!.id, candidateId: candidate.id, sha,
        ticketId: ticketFrom(delivery?.sourceRef) ?? (active ? ticketFrom(candidate.sourceRef) : undefined), nodes, startedAt: first.at });
    }
  }

  for (const event of input.relay) {
    const matching = event.candidateSha ? rounds.filter(round => round.sha === event.candidateSha
      && (!round.ticketId || round.ticketId === event.ticketId) && round.candidateId) : [];
    const repeated = input.relay.some(other => other.eventId !== event.eventId && other.candidateSha === event.candidateSha
      && other.ticketId === event.ticketId && other.assignmentId !== event.assignmentId);
    if (matching.length === 1 && !repeated) {
      const round = matching[0]!;
      round.assignmentId = event.assignmentId;
      round.ticketId = event.ticketId;
      if (!round.startedAt || moment(event.receivedAt) < moment(round.startedAt)) round.startedAt = event.receivedAt;
      round.nodes.push(relayNode(event));
    } else {
      const existing = rounds.find(round => !round.candidateId && round.ticketId === event.ticketId && round.assignmentId === event.assignmentId);
      if (existing) existing.nodes.push(relayNode(event));
      else rounds.push({ id: 'assignment:' + event.eventId, sha: event.candidateSha, ticketId: event.ticketId,
        assignmentId: event.assignmentId, startedAt: event.receivedAt, nodes: [relayNode(event)] });
    }
  }

  rounds.sort((a, b) => moment(a.startedAt) - moment(b.startedAt));
  for (const [index, round] of rounds.entries()) {
    const beganAt = moment(round.startedAt);
    const previous = rounds.slice(0, index).filter(old => (
      (round.candidateId && old.candidateId === round.candidateId)
      || (round.ticketId && old.ticketId === round.ticketId && round.assignmentId && old.assignmentId && round.assignmentId !== old.assignmentId)
    )).reverse().find(old => old.nodes.some(node => rework.has(node.id)
      && moment(node.at) <= beganAt));
    const returned = previous && latest(previous.nodes.filter(node => rework.has(node.id)
      && moment(node.at) <= beganAt));
    if (returned) round.returnedFrom = { label: rework.get(returned.id)!, nodeId: returned.id };
  }

  const current = latest([...setup.slice(1), ...rounds.flatMap(round => round.nodes)]) ?? setup[0];
  return { setup, rounds, current };
}
