import type { ReactNode } from 'react';
import type { BadgeTone } from '../lib/labels';

interface StatusBadgeProps {
  tone: BadgeTone;
  children: ReactNode;
}

export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
