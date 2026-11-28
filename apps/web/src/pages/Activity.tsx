import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAgentNames } from '../agentNames';
import { useApiResource } from '../hooks/useApiResource';
import type { ActivityRecord } from '../types';
import { AgentName, StatusBadge, Skeleton, EmptyState, IntentAmount, PaginationFooter } from '../components';

const PAGE_SIZE = 50;

export default function Activity() {
  const navigate = useNavigate();
  const agentNames = useAgentNames();
  
  // Additional state for pagination (manual load-more)
  const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const fetcher = useCallback(async () => {
    const r = await api.listActivity(PAGE_SIZE, 0);
    // Update both hook state and local pagination state
    setActivity(r.activity);
    setHasMore(r.hasMore);
    setNextOffset(r.activity.length);
    return r.activity;
  }, []);

  const { data, error, loading, reload } = useApiResource<ActivityRecord[]>(fetcher, []);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const r = await api.listActivity(PAGE_SIZE, nextOffset);
      setActivity((prev) => prev.concat(r.activity));
      setHasMore(r.hasMore);
      setNextOffset(nextOffset + r.activity.length);
    } catch (e: any) {
      setLoadMoreError(e.message ?? 'Failed to load more activity');
    } finally {
      setLoadingMore(false);
    }
  }, [nextOffset]);

  const retryLoadMore = () => {
    setLoadMoreError(null);
    loadMore();
  };

  if (error) return <EmptyState title="Failed to load activity" message={error} error={true} actionLabel="Retry" onAction={reload} />;
  if (loading || data === null) return <Skeleton label="Loading activity..." />;
  
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
                <td><AgentName agentId={r.agentId} agentNames={agentNames} /></td>
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
      {loadMoreError && <div className="error" role="alert">{loadMoreError} <button className="btn btn-secondary btn-sm" onClick={retryLoadMore}>Retry</button></div>}
    </section>
  );
}
