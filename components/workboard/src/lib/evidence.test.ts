import { describe, expect, it } from 'vitest';
import type { Candidate } from '../domain/types';
import { isReviewStale, reviewForCandidate } from './evidence';

function candidateWith(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'demo-candidate',
    taskId: 'demo-task',
    executorName: 'Demo-Agent',
    executorKind: 'superagent',
    method: '演示方式',
    execution: {
      status: 'succeeded',
      summary: '执行结束。',
      nativeRef: null,
      updatedAt: '2026-11-11T00:00:00+08:00',
    },
    branch: null,
    pr: null,
    sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    baseSha: null,
    verification: { status: 'passed', summary: '通过。', evidenceRef: null },
    review: {
      id: 'demo-review',
      candidateId: 'demo-candidate',
      reviewer: 'Demo-Reviewer',
      reviewedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'accepted',
      summary: '通过。',
      at: '2026-11-11T01:00:00+08:00',
      sourceRef: 'demo/review',
    },
    blockers: [],
    todos: [],
    updatedAt: '2026-11-11T01:00:00+08:00',
    ...overrides,
  };
}

describe('reviewForCandidate', () => {
  it('only binds a review whose candidate id matches', () => {
    const review = candidateWith().review!;
    expect(reviewForCandidate(review, 'demo-candidate')).toBe(review);
    expect(reviewForCandidate(review, 'another-candidate')).toBeNull();
    expect(reviewForCandidate(null, 'demo-candidate')).toBeNull();
  });
});

describe('isReviewStale', () => {
  it('accepts a review bound to the current candidate SHA', () => {
    expect(isReviewStale(candidateWith())).toBe(false);
  });

  it('flags a review for a different SHA', () => {
    expect(
      isReviewStale(
        candidateWith({
          review: { ...candidateWith().review!, reviewedSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        }),
      ),
    ).toBe(true);
  });

  it('does not silently carry over a review when a SHA is missing', () => {
    expect(isReviewStale(candidateWith({ sha: null }))).toBe(true);
    expect(
      isReviewStale(candidateWith({ review: { ...candidateWith().review!, reviewedSha: null } })),
    ).toBe(true);
  });

  it('treats an absent review as not stale', () => {
    expect(isReviewStale(candidateWith({ review: null }))).toBe(false);
  });
});
