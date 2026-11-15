import type { Candidate, Review } from '../domain/types';

export function reviewForCandidate(review: Review | null, candidateId: string): Review | null {
  return review && review.candidateId === candidateId ? review : null;
}

export function isReviewStale(candidate: Candidate): boolean {
  const review = candidate.review;
  if (!review) {
    return false;
  }
  if (!review.reviewedSha || !candidate.sha) {
    return true;
  }
  return review.reviewedSha !== candidate.sha;
}
