import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import ReadableText from './ReadableText';

it('renders agent-authored Markdown as readable, inert content', async () => {
  render(<ReadableText text={[
    '## 验收要点', '', '1. **接口结果正确**', '2. 执行 `npm test`', '',
    '| 项目 | 结果 |', '| --- | --- |', '| 构建 | 通过 |', '',
    '[查看证据](https://example.com/report)', '', '<div>原始 HTML</div>',
  ].join('\n')} />);
  expect(await screen.findByRole('heading', { name: '验收要点' })).toBeVisible();
  expect(screen.getByText('接口结果正确').tagName).toBe('STRONG');
  expect(screen.getByText('npm test').tagName).toBe('CODE');
  expect(screen.getByRole('cell', { name: '通过' })).toBeVisible();
  expect(screen.getByRole('link', { name: '查看证据' })).toHaveAttribute('href', 'https://example.com/report');
  expect(screen.queryByText('原始 HTML')).not.toBeInTheDocument();
});
