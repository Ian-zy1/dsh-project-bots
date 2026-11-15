import type { ReactNode } from 'react';

interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = '正在读取演示资料…' }: LoadingStateProps) {
  return (
    <div className="notice notice--loading" role="status" aria-live="polite">
      <span className="notice__marker" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  detail: string;
}

export function EmptyState({ title, detail }: EmptyStateProps) {
  return (
    <div className="notice notice--empty">
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

interface ErrorStateProps {
  title: string;
  detail: string;
  onRetry?: () => void;
  children?: ReactNode;
}

export function ErrorState({ title, detail, onRetry, children }: ErrorStateProps) {
  return (
    <div className="notice notice--error" role="alert">
      <h3>{title}</h3>
      <p>{detail}</p>
      {children}
      {onRetry ? (
        <button type="button" className="retry-button" onClick={onRetry}>
          重新尝试
        </button>
      ) : null}
    </div>
  );
}
