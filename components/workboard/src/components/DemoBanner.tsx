import type { DemoMeta } from '../domain/types';
import { formatDateTime } from '../lib/format';

interface DemoBannerProps {
  meta: DemoMeta;
}

export function DemoBanner({ meta }: DemoBannerProps) {
  return (
    <aside className="demo-banner" aria-label="演示数据说明">
      <span className="demo-banner__badge">演示数据</span>
      <div className="demo-banner__body">
        <p>{meta.sourceNote}</p>
        <p className="meta-line">
          数据更新时间：{formatDateTime(meta.dataUpdatedAt)} · 数据结构：{meta.schemaVersion}
        </p>
      </div>
    </aside>
  );
}
