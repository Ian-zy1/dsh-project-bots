import { describe, expect, it } from 'vitest';
import { buildDispatchNote, dispatchStageLabels } from './dispatchNote';

const task = { id: 'tsk_19507253a0b342e7', title: '实现任务派活说明的预览、阶段选择与复制', revision: 2 };
const origin = 'http://127.0.0.1:4180';

describe('buildDispatchNote', () => {
  it('includes the task identity, content version and fixed revision read addresses', () => {
    const note = buildDispatchNote({ task, origin });

    expect(note).toContain(task.id);
    expect(note).toContain(task.title);
    expect(note).toContain('任务内容版本：v2');
    expect(note).toContain(`JSON：${origin}/api/v1/tasks/${task.id}/context?revision=2`);
    expect(note).toContain(`${origin}/api/v1/tasks/${task.id}/context?revision=2&format=markdown`);
  });

  it('defaults to read-only investigation', () => {
    const note = buildDispatchNote({ task, origin });

    expect(note).toContain(`授权阶段：${dispatchStageLabels.readonly}`);
    expect(note).toContain('只读取固定版本上下文');
  });

  it.each([
    ['plan', '形成计划', '获得来源中的明确批准前'],
    ['implement', '实施', '本说明本身不构成批准'],
  ] as const)('updates the text for the %s stage', (stage, label, instruction) => {
    const note = buildDispatchNote({ task, origin, stage });

    expect(note).toContain(`授权阶段：${label}`);
    expect(note).toContain(instruction);
    expect(note).not.toContain(`授权阶段：${dispatchStageLabels.readonly}`);
  });

  it('states the reporting evidence and human merge boundary', () => {
    const note = buildDispatchNote({ task, origin, stage: 'implement' });

    expect(note).toContain('回报证据');
    expect(note).toContain('验证命令与结果');
    expect(note).toContain('候选版本时附 SHA');
    expect(note).toContain('未经用户确认不合入、不自动合并、不部署');
  });

  it('does not depend on a hosting platform, proxy or unrelated task content', () => {
    const note = buildDispatchNote({ task, origin });
    const lower = note.toLowerCase();

    for (const term of ['github', 'gitlab', '钉钉', 'proxy', '17892', 'token', '密码']) {
      expect(lower).not.toContain(term);
    }
    expect(note).not.toContain('48 ');
    expect(note).not.toContain('req_');
    expect(note).not.toContain('tsk_other');
  });
});
