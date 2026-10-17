import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { ActivityRecord } from '../types';
import { StatusBadge, Skeleton, EmptyState, IntentAmount, PaginationFooter } from '../components';
import { useApiResource } from '../hooks/useApiResource';

const PAGE_SIZE = 50;

export default function Activity() {
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const navigate = useNavigate();

  const { data, error, loading, reload } = useApiResource(
    async () => {
      const r = await api.listActivity(PAGE_SIZE, 0);
      setHasMore(r.hasMore);
      setNextOffset(r.activity.length);
      return r.activity;
    },
    [],
  );

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await api.listActivity(PAGE_SIZE, nextOffset);
      setHasMore(r.hasMore);
      setNextOffset(nextOffset + r.activity.length);
    } catch {
      // Surface load-more failures through reload so the page remains consistent.
      await reload();
    } finally {
      setLoadingMore(false);
    }
  };

  if (error) return <EmptyState title="Failed to load activity" message={error} />;
  if (loading || data === null) return <Skeleton label="Loading activity..." />;
  if (data.length === 0) {
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
            {data.map((r) => (
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

      <PaginationFooter hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} itemCount={data.length} />
    </section>
  );
}
