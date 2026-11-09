import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { ActivityRecord } from '../types';
import { StatusBadge, Skeleton, EmptyState, IntentAmount, PaginationFooter } from '../components';
import { useApiResource } from '../hooks/useApiResource';

const PAGE_SIZE = 50;

export default function Activity() {
  const [extraActivity, setExtraActivity] = useState<ActivityRecord[]>([]);
  const [hasMoreOverride, setHasMoreOverride] = useState<boolean | null>(null);
  const [nextOffsetOverride, setNextOffsetOverride] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const navigate = useNavigate();

  const { data: firstPage, error: initialError, loading, reload } = useApiResource(
    async () => {
      setExtraActivity([]);
      setHasMoreOverride(null);
      setNextOffsetOverride(null);
      setMoreError(null);
      return api.listActivity(PAGE_SIZE, 0);
    },
    []
  );

  const activity = firstPage ? [...firstPage.activity, ...extraActivity] : null;
  const hasMore = hasMoreOverride ?? Boolean(firstPage?.hasMore);
  const nextOffset = nextOffsetOverride ?? (firstPage ? firstPage.activity.length : 0);
  const error = initialError ?? moreError;

  const loadMore = () => {
    setLoadingMore(true);
    api.listActivity(PAGE_SIZE, nextOffset)
      .then((r) => {
        setExtraActivity((prev) => prev.concat(r.activity));
        setHasMoreOverride(r.hasMore);
        setNextOffsetOverride(nextOffset + r.activity.length);
      })
      .catch((e: any) => {
        setMoreError(e.message);
      })
      .finally(() => setLoadingMore(false));
  };

  if (error) return <EmptyState title="Failed to load activity" message={error} error={true} actionLabel="Retry" onAction={reload} />;
  if (loading || activity === null) return <Skeleton label="Loading activity..." />;
  if (activity.length === 0) {
    return (
      <EmptyState
        title="No activity"
        message="Submit an intent to generate activity records."
      />
    );
  }

  return (
    <section>
      <div className="page-header">
        <h1>Activity</h1>
        <p className="muted">Audit trail of all agent operations.</p>
      </div>

      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr>
              <th>Activity</th>
              <th>Agent</th>
              <th>Intent</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((r) => (
              <tr
                key={r.id}
                className="table-row-link"
                onClick={() => navigate(`/agents/${r.agentId}/activity/${r.id}`)}
              >
                <td><code>{r.id.slice(0, 8)}</code></td>
                <td><code>{r.agentId.slice(0, 8)}</code></td>
                <td>{r.intent.type}</td>
                <td><IntentAmount intent={r.intent} /></td>
                <td><StatusBadge status={r.status} /></td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PaginationFooter hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} itemCount={activity.length} />
    </section>
  );
}
