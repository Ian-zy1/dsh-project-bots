import type { TaskContext } from './types';

const fields: [keyof Pick<TaskContext, 'task' | 'project' | 'requirement'>, string, string][] = [
  ['task', 'title', '任务标题'], ['task', 'description', '任务说明'], ['task', 'acceptance', '任务验收'],
  ['task', 'sourceRef', '任务来源'], ['task', 'dependsOn', '依赖'], ['task', 'priority', '优先级'],
  ['project', 'name', '项目名称'], ['project', 'repositoryUrl', '仓库'], ['project', 'baseline', '代码基线'],
  ['project', 'environment', '环境'], ['project', 'rules', '项目规则'],
  ['requirement', 'title', '需求标题'], ['requirement', 'description', '需求描述'],
  ['requirement', 'plan', '实施计划'], ['requirement', 'acceptance', '需求验收'],
];
export function snapshotDiff(before: TaskContext, after: TaskContext) {
  return fields.flatMap(([section, key, label]) => {
    const a = (before[section] as unknown as Record<string, unknown>)[key] ?? '';
    const b = (after[section] as unknown as Record<string, unknown>)[key] ?? '';
    const text = (v: unknown) => Array.isArray(v) ? v.join('\n') : String(v);
    return text(a) === text(b) ? [] : [{ label, before: text(a), after: text(b) }];
  });
}
