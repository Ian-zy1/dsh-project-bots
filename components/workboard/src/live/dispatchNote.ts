export type DispatchStage = 'readonly' | 'plan' | 'implement';

export const dispatchStageLabels: Record<DispatchStage, string> = {
  readonly: '只读排查',
  plan: '形成计划',
  implement: '实施',
};

const stageInstructions: Record<DispatchStage, string> = {
  readonly: '只读取固定版本上下文并回报排查结论；不修改代码、测试或任务状态，不创建执行。',
  plan: '读取固定版本上下文后形成实施计划并回报；获得来源中的明确批准前，不修改代码、测试或任务状态。',
  implement: '仅在来源中已有明确实施批准时按批准范围实施、自测并回报；本说明本身不构成批准，复制或转发也不改变任务状态。',
};

export interface DispatchNoteInput {
  task: { id: string; title: string; revision: number };
  origin: string;
  stage?: DispatchStage;
}

export function buildDispatchNote({ task, origin, stage = 'readonly' }: DispatchNoteInput): string {
  const base = `${origin}/api/v1/tasks/${encodeURIComponent(task.id)}`;
  const contextUrl = `${base}/context?revision=${task.revision}`;
  return [
    `# 派活说明：${task.title}`,
    '',
    `任务 ID：${task.id}`,
    `任务内容版本：v${task.revision}`,
    `授权阶段：${dispatchStageLabels[stage]}`,
    '',
    '固定版本读取地址（JSON / Markdown）：',
    `JSON：${contextUrl}`,
    `Markdown：${contextUrl}&format=markdown`,
    `任务详情（核对当前状态与依赖）：${base}`,
    '固定上下文是快照，不含当前任务状态与依赖；处理前请读取任务详情核对。',
    '',
    '阶段要求：',
    stageInstructions[stage],
    '',
    '回报证据：',
    '请回报实际改动或产物位置、验证命令与结果、限制与待决事项；有候选版本时附 SHA。不要只声称完成。',
    '',
    '边界：',
    '本说明仅用于交接，不代表批准记录，也不启动执行。未经用户确认不合入、不自动合并、不部署。',
    '',
  ].join('\n');
}
