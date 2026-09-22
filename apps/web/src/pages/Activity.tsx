import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ActivityRecord } from '../types';

export default function Activity({ onActivityClick }: { onActivityClick?: (agentId: string, activityId: string) => void }) {
  const [activity, setActivity] = useState<ActivityRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listActivity()
      .then((r) => setActivity(r.activity))
      .catch((e: any) => setError(e.message));
  }, []);

  if (error) return <EmptyState title="Failed to load activity" message={error} />;
  if (activity === null) return <Skeleton label="Loading activity..." />;
  if (activity.length === 0) return (
    <EmptyState
      title="No activity"
      message="Submit an intent to generate activity records."
    />
  );

  return (
    <section>
      <h1>Activity</h1>
      <table>
        <thead>
          <tr><th>ID</th><th>Agent</th><th>Type</th><th>Amount</th><th>Status</th><th>Time</th></tr>
        </thead>
        <tbody>
          {activity.map((r) => (
            <tr
              key={r.id}
              onClick={() => onActivityClick?.(r.agentId, r.id)}
              style={{ cursor: onActivityClick ? 'pointer' : undefined }}
            >
              <td><code>{r.id.slice(0, 8)}</code></td>
              <td><code>{r.agentId}</code></td>
              <td>{r.intent.type}</td>
              <td>{r.intent.amount || '-'} {r.intent.asset || ''}</td>
              <td><StatusBadge status={r.status} /></td>
              <td>{new Date(r.createdAt).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'submitted' ? 'badge-ok'
    : status === 'failed' || status === 'rejected' ? 'badge-err'
    : 'badge-info';
  return <span className={'badge ' + cls}>{status}</span>;
}

function Skeleton({ label }: { label: string }) {
  return <div className="skeleton">{label}</div>;
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{message}</p>
    </div>
  );
}
