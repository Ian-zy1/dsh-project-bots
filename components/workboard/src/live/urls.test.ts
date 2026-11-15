import { afterEach, expect, test } from 'vitest';
import { apiPath, applicationOrigin } from './urls';
import { buildDispatchNote } from './dispatchNote';

afterEach(() => history.replaceState(null, '', '/'));

test('API and handoff URLs preserve a reverse proxy prefix and pinned revision', () => {
  history.replaceState(null, '', '/aw/?task=tsk_example&revision=3');
  expect(apiPath('/tasks/tsk_example/brief?revision=3')).toBe('/aw/api/v1/tasks/tsk_example/brief?revision=3');
  const note = buildDispatchNote({ task: { id: 'tsk_example', title: '历史任务', revision: 3 }, origin: applicationOrigin() });
  expect(note).toContain(`${location.origin}/aw/api/v1/tasks/tsk_example/context?revision=3`);
  expect(note).not.toContain(`${location.origin}/api/v1/`);
});

test('local root remains compatible', () => {
  history.replaceState(null, '', '/?task=tsk_example');
  expect(apiPath('/projects')).toBe('/api/v1/projects');
  expect(applicationOrigin()).toBe(location.origin);
});
