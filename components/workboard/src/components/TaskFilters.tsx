import type { TaskStatus } from '../domain/types';
import { TASK_STATUS_LABELS, TASK_STATUS_ORDER } from '../lib/labels';

interface TaskFiltersProps {
  value: TaskStatus | 'all';
  onChange: (next: TaskStatus | 'all') => void;
}

const OPTIONS: Array<TaskStatus | 'all'> = ['all', ...TASK_STATUS_ORDER];

export function TaskFilters({ value, onChange }: TaskFiltersProps) {
  return (
    <div className="filters" role="group" aria-label="按业务状态筛选任务">
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className={`filter-chip${value === option ? ' filter-chip--active' : ''}`}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {option === 'all' ? '全部' : TASK_STATUS_LABELS[option]}
        </button>
      ))}
    </div>
  );
}
