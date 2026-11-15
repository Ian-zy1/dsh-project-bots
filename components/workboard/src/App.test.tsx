import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from './App';
import { createDemoReader } from './data/demo/demoReader';

describe('App', () => {
  it('shows the demo banner, project entry and default task detail', async () => {
    render(<App reader={createDemoReader()} />);

    expect(await screen.findByText('演示数据')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Agent Workboard 展示版' })).toBeInTheDocument();
    expect(await screen.findByText(/本页全部为虚构演示数据/)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '实现单页只读看板' })).toBeInTheDocument();
    expect(await screen.findByText('Agent-Super-1')).toBeInTheDocument();
    expect(await screen.findByText('Agent-Local-2')).toBeInTheDocument();
  });

  it('filters the task list and shows an empty state when nothing matches', async () => {
    const user = userEvent.setup();
    render(<App reader={createDemoReader()} />);

    await screen.findByRole('button', { name: /实现单页只读看板/ });
    await user.click(screen.getByRole('button', { name: '待处理' }));

    expect(await screen.findByText('没有符合条件的任务')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /实现单页只读看板/ })).not.toBeInTheDocument();
  });

  it('keeps candidate evidence separate when switching tasks', async () => {
    const user = userEvent.setup();
    render(<App reader={createDemoReader()} />);

    await screen.findByText('Agent-Super-1');
    await user.click(screen.getByRole('button', { name: /候选证据分区与 SHA 绑定/ }));

    expect(await screen.findByText('Agent-Super-2')).toBeInTheDocument();
    expect(await screen.findByText(/该结论不能沿用到当前版本/)).toBeInTheDocument();
    expect(screen.queryByText('Agent-Super-1')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent-Local-2')).not.toBeInTheDocument();
  });

  it('shows missing evidence as unprovided or unknown rather than success', async () => {
    const user = userEvent.setup();
    render(<App reader={createDemoReader()} />);

    await screen.findByRole('button', { name: /阻塞候选的证据补全/ });
    await user.click(screen.getByRole('button', { name: /阻塞候选的证据补全/ }));

    expect(await screen.findByText('未验证')).toBeInTheDocument();
    expect(await screen.findByText(/尚无评审记录（未评审）/)).toBeInTheDocument();
    expect(screen.getAllByText('未提供').length).toBeGreaterThan(0);
    expect(screen.getByText('缺少验收条件的中文文案，尚未开始验证。')).toBeInTheDocument();
  });

  it('shows no-candidate state and keeps adoption separate from review', async () => {
    const user = userEvent.setup();
    render(<App reader={createDemoReader()} />);

    await screen.findByRole('button', { name: /实现单页只读看板/ });
    await user.selectOptions(screen.getByLabelText('选择项目'), 'proj-docs-portal');
    await user.click(screen.getByRole('button', { name: /后续管理操作入口（未开始）/ }));

    expect(await screen.findByText('尚无候选实现')).toBeInTheDocument();
    expect(await screen.findByText(/尚未记录采纳决定/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /窄屏阅读与空状态走查/ }));
    expect(await screen.findByText('已采纳候选：')).toBeInTheDocument();
    expect((await screen.findAllByText('Agent-Human-4')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('已采纳').length).toBeGreaterThan(0);
  });

  it('renders a read failure state for the error scenario', async () => {
    render(<App reader={createDemoReader({ scenario: 'error' })} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(await screen.findByText('读取失败')).toBeInTheDocument();
    expect(screen.queryByText('演示数据', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新尝试' })).toBeInTheDocument();
  });
});
