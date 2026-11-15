import type { Activity } from '../domain/types';
import { formatDateTime } from '../lib/format';
import { ACTIVITY_KIND_LABELS } from '../lib/labels';

interface ActivityTimelineProps {
  activities: Activity[];
}

export function ActivityTimeline({ activities }: ActivityTimelineProps) {
  if (activities.length === 0) {
    return <p className="notice notice--empty">尚无活动记录；空记录不应推断为成功。</p>;
  }

  return (
    <ol className="timeline">
      {activities.map((activity) => (
        <li key={activity.id} className="timeline__item">
          <div className="timeline__head">
            <span className={`activity-kind activity-kind--${activity.kind}`}>
              {ACTIVITY_KIND_LABELS[activity.kind]}
            </span>
            <time dateTime={activity.at}>{formatDateTime(activity.at)}</time>
          </div>
          <p className="timeline__summary">{activity.summary}</p>
          <p className="meta-line">
            主体：{activity.actor} · 来源：{activity.sourceRef}
          </p>
        </li>
      ))}
    </ol>
  );
}
