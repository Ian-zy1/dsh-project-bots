import { describe, expect, it } from 'vitest';
import { createDemoReader, DemoReadError } from './demoReader';
import { isReviewStale } from '../../lib/evidence';

describe('demoReader', () => {
  it('returns clearly marked demo data for two projects', async () => {
    const reader = createDemoReader();
    const meta = await reader.getMeta();
    const projects = await reader.listProjects();

    expect(meta.demo).toBe(true);
    expect(meta.sourceNote).toContain('虚构演示数据');
    expect(projects).toHaveLength(2);
    expect(projects.every((project) => project.provenance.demo)).toBe(true);
    expect(projects.find((project) => project.id === 'proj-workboard')?.taskCount).toBe(3);
  });

  it('filters tasks by business status', async () => {
    const reader = createDemoReader();

    const blocked = await reader.listTasks('proj-workboard', 'blocked');
    const all = await reader.listTasks('proj-workboard', 'all');

    expect(blocked.map((task) => task.id)).toEqual(['task-empty-evidence']);
    expect(blocked[0].attentionCount).toBe(1);
    expect(all).toHaveLength(3);
    expect(all[0].updatedAt >= all[1].updatedAt).toBe(true);

    const running = await reader.listTasks('proj-docs-portal', 'in_progress');
    expect(running[0].attentionCount).toBe(1);
  });

  it('keeps two candidates for the same task and binds each review to its own candidate', async () => {
    const reader = createDemoReader();
    const candidates = await reader.getCandidates('task-display-board');

    expect(candidates.map((candidate) => candidate.id)).toEqual(['cand-a', 'cand-b']);
    expect(candidates[0].review?.reviewedSha).toBe(candidates[0].sha);
    expect(candidates[1].review?.reviewedSha).toBe(candidates[1].sha);
    expect(candidates[0].execution.status).toBe('succeeded');
    expect(candidates[1].execution.status).toBe('succeeded');
  });

  it('does not invent missing evidence', async () => {
    const reader = createDemoReader();
    const [candidate] = await reader.getCandidates('task-empty-evidence');

    expect(candidate.branch).toBeTruthy();
    expect(candidate.pr).toBeNull();
    expect(candidate.sha).toBeNull();
    expect(candidate.baseSha).toBeNull();
    expect(candidate.verification.status).toBe('not_run');
    expect(candidate.verification.summary).toBeNull();
    expect(candidate.verification.evidenceRef).toBeNull();
    expect(candidate.review).toBeNull();
    expect(candidate.blockers.length).toBeGreaterThan(0);
  });

  it('flags a review that targets an older SHA', async () => {
    const reader = createDemoReader();
    const [staleCandidate] = await reader.getCandidates('task-candidate-evidence');
    const cleanCandidates = await reader.getCandidates('task-display-board');

    expect(isReviewStale(staleCandidate)).toBe(true);
    expect(cleanCandidates.some(isReviewStale)).toBe(false);
  });

  it('returns task-level activities in newest-first order', async () => {
    const reader = createDemoReader();
    const activities = await reader.getActivities('proj-workboard', 'task-display-board');

    expect(activities).toHaveLength(6);
    expect(activities[0].at >= activities[1].at).toBe(true);
    expect(activities.every((activity) => activity.taskId === 'task-display-board')).toBe(true);
  });

  it('rejects reads in the simulated failure scenario', async () => {
    const reader = createDemoReader({ scenario: 'error' });

    await expect(reader.listProjects()).rejects.toBeInstanceOf(DemoReadError);
    await expect(reader.listTasks('proj-workboard')).rejects.toBeInstanceOf(DemoReadError);
  });
});
