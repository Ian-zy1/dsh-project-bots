import type { TaskSummary } from '../domain/types';
import { formatDateTime } from '../lib/format';
import { TASK_STATUS_LABELS, taskStatusTone } from '../lib/labels';
import { StatusBadge } from './StatusBadge';

interface TaskListProps {
  tasks: TaskSummary[];
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
}

export function TaskList({ tasks, selectedTaskId, onSelect }: TaskListProps) {
  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <li key={task.id}>
          <button
            type="button"
            className={`task-card${selectedTaskId === task.id ? ' task-card--selected' : ''}`}
            aria-current={selectedTaskId === task.id ? 'true' : undefined}
            data-task-id={task.id}
            onClick={() => onSelect(task.id)}
          >
            <span className="task-card__top">
              <StatusBadge tone={taskStatusTone(task.status)}>{TASK_STATUS_LABELS[task.status]}</StatusBadge>
              <span className="task-card__updated">更新 {formatDateTime(task.updatedAt)}</span>
            </span>
            <span className="task-card__title">{task.title}</span>
            <span className="task-card__requirement">{task.requirementTitle}</span>
            <span className="task-card__meta">
              候选 {task.candidateCount}
              {task.attentionCount > 0
                ? ` · ${task.attentionCount} 个候选有阻塞或待办`
                : ' · 暂无阻塞或待办'}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
