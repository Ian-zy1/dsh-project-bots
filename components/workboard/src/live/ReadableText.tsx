import { lazy, Suspense, useState } from 'react';
import type { Components } from 'react-markdown';

const Markdown = lazy(async () => {
  const [{ default: Renderer }, { default: gfm }] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
  ]);
  const plugins = [gfm];
  return { default: ({ text, inlineReferences }: { text: string; inlineReferences: boolean }) => (
    <Renderer skipHtml remarkPlugins={plugins} components={inlineReferences ? inlineComponents : components}>{text}</Renderer>
  ) };
});
const components: Components = {
  h1: 'h5',
  h2: 'h5',
  h3: 'h6',
  h4: 'h6',
  h5: 'h6',
  h6: 'h6',
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
    : <span>{children}</span>,
  img: ({ alt }) => alt ? <span>{alt}</span> : null,
  table: ({ children }) => <div className="aw-text-table" tabIndex={0} role="region" aria-label="内容表格"><table>{children}</table></div>,
};

function InlineReference({ value, children }: { value: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <span className="aw-flow-reference"><button type="button" className="local-link" aria-expanded={open} onClick={() => setOpen(!open)}>{children}</button>
    {open && <code>{value}</code>}
  </span>;
}
const inlineComponents: Components = { ...components, a: ({ href, children }) => href
  ? <InlineReference value={href}>{children}</InlineReference> : <span>{children}</span> };

export default function ReadableText({ text, empty = '尚未填写', inlineReferences = false }: { text?: string; empty?: string; inlineReferences?: boolean }) {
  if (!text?.trim()) return <p className="local-muted">{empty}</p>;
  return <div className="aw-readable-text">
    <Suspense fallback={<p role="status">正在排版…</p>}><Markdown text={text} inlineReferences={inlineReferences} /></Suspense>
  </div>;
}
