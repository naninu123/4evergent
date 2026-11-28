import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAgentNames } from '../agentNames';
import type { ExecutionRecord, QueueSummary, ExecutionStatus } from '../types';
import { AgentName, EmptyState, PaginationFooter, Skeleton } from '../components';

type StatusFilter = 'all' | ExecutionStatus;

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'queued', label: 'Queued' },
  { value: 'executing', label: 'Executing' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'failed', label: 'Failed' },
  { value: 'dead_letter', label: 'Dead Letter' },
  { value: 'cancelled', label: 'Cancelled' },
];

const PAGE_SIZE = 50;

function statusLabel(status: ExecutionStatus): string {
  switch (status) {
    case 'queued': return 'Queued';
    case 'executing': return 'Executing';
    case 'submitted': return 'Submitted';
    case 'confirmed': return 'Confirmed';
    case 'failed': return 'Failed';
    case 'dead_letter': return 'Dead Letter';
    case 'cancelled': return 'Cancelled';
    case 'requires_approval': return 'Requires Approval';
  }
}

function statusClass(status: ExecutionStatus): string {
  switch (status) {
    case 'queued': return 'badge-info';
    case 'executing': return 'badge-warn';
    case 'submitted': return 'badge-ok';
    case 'confirmed': return 'badge-ok';
    case 'failed': return 'badge-err';
    case 'dead_letter': return 'badge-err';
    case 'cancelled': return 'badge-neutral';
    case 'requires_approval': return 'badge-warn';
  }
}

// inferRetrying is kept for per-row badge rendering only (unchanged per #383).
function inferRetrying(e: ExecutionRecord): boolean {
  return e.status === 'failed' && e.nextRetryAt !== null && e.errorClass === 'transient';
}

export default function Executions({ onExecutionClick }: { onExecutionClick?: (id: string) => void }) {
  const [executions, setExecutions] = useState<ExecutionRecord[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [queue, setQueue] = useState<QueueSummary | null>(null);
  // #383: server-side retrying count from GET /overview/attention, same
  // definition as Overview ("failed executions with a scheduled retry").
  const [serverRetryingCount, setServerRetryingCount] = useState<number | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const agentNames = useAgentNames();

  const loadPage = useCallback(async (offset: number, replace: boolean) => {
    try {
      const r = await api.listAllExecutions(PAGE_SIZE, offset);
      setExecutions(replace ? r.executions : (prev) => (prev ?? []).concat(r.executions));
      setHasMore(r.hasMore);
      setNextOffset(offset + r.executions.length);
      if (!replace) setLoadMoreError(null);
    } catch (e: any) {
      if (replace) setError(e.message ?? 'Failed to load executions');
      else setLoadMoreError(e.message ?? 'Failed to load more executions');
    }
  }, []);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const [r, q, attention] = await Promise.all([
        api.listAllExecutions(PAGE_SIZE, 0),
        api.getQueueStatus(),
        api.getOverviewAttention(),
      ]);
      setExecutions(r.executions);
      setHasMore(r.hasMore);
      setNextOffset(r.executions.length);
      setQueue(q);
      setServerRetryingCount(attention.retryingExecutions);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load executions');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = () => {
    setLoadingMore(true);
    loadPage(nextOffset, false).finally(() => setLoadingMore(false));
  };

  const retryLoadMore = () => {
    setLoadMoreError(null);
    setLoadingMore(true);
    loadPage(nextOffset, false).finally(() => setLoadingMore(false));
  };

  const retry = () => {
    setError(null);
    loadInitial();
  };

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  if (loading) return <Skeleton label="Loading executions..." />;
  if (error) return <EmptyState title="Failed to load executions" message={error} error={true} actionLabel="Retry" onAction={retry} />;
  if (executions === null) return <Skeleton label="Loading executions..." />;

  const filtered = filter === 'all'
    ? executions
    : executions.filter((e) => e.status === filter || (filter === 'failed' && inferRetrying(e)));

  return (
    <section>
      <h1>Executions</h1>

      {queue && (
        <div className="cards" style={{ marginBottom: 16 }}>
          <Card title="Queue Running" value={queue.running ? 'Yes' : 'No'} />
          <Card title="Queued" value={String(queue.byStatus['queued'] ?? 0)} />
          <Card title="Executing" value={String(queue.byStatus['executing'] ?? 0)} />
          {/* #383: Retrying count comes from the server-side overview/attention
              endpoint (failed executions with a scheduled retry), not from
              counting the loaded page. This matches Overview's definition. */}
          <Card title="Retrying" value={serverRetryingCount !== null ? String(serverRetryingCount) : '—'} />
          <Card title="Failed" value={String(queue.byStatus['failed'] ?? 0)} />
          <Card title="Dead Letter" value={String(queue.byStatus['dead_letter'] ?? 0)} />
        </div>
      )}

      <div className="filter-bar">
        <label>Status:</label>
        <select value={filter} onChange={(e) => setFilter(e.target.value as StatusFilter)}>
          {FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No executions found"
          message={filter === 'all'
            ? 'Executions will appear here when an approved intent enters the execution queue.'
            : 'No executions match the selected filter.'}
        />
      ) : (
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Agent</th>
                <th>Intent</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Attempt</th>
                <th>Next Retry</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const isRetrying = inferRetrying(e);
                const statusDisplay = isRetrying ? 'Retrying' : statusLabel(e.status);
                const statusCls = isRetrying ? 'badge-warn' : statusClass(e.status);
                return (
                  <tr
                    key={e.id}
                    onClick={() => onExecutionClick?.(e.id)}
                    style={{ cursor: onExecutionClick ? 'pointer' : undefined }}
                  >
                    <td>
                      {e.id ? (
                        <Link to={`/executions/${encodeURIComponent(e.id)}`} className="table-row-link">
                          <code>{e.id.slice(0, 8)}</code>
                        </Link>
                      ) : (
                        <code>{e.id.slice(0, 8)}</code>
                      )}
                    </td>
                    <td><AgentName agentId={e.agentId} agentNames={agentNames} /></td>
                    <td>{e.intent.type}</td>
                    <td>{e.intent.type === 'payment' ? `${e.intent.amount} ${(e.intent.assetDetails as { code?: string } | undefined)?.code ?? e.intent.asset}` : '-'}</td>
                    <td>
                      <span className={`badge ${statusCls}`}>
                        {statusDisplay}
                        {e.status === 'dead_letter' && ' ⚠'}
                      </span>
                    </td>
                    <td>{e.attempt > 0 ? String(e.attempt) : '-'}</td>
                    <td>{e.nextRetryAt ? new Date(e.nextRetryAt).toLocaleString() : '-'}</td>
                    <td>{new Date(e.createdAt).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <PaginationFooter hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} itemCount={executions.length} />
      {loadMoreError && <div className="error" role="alert">{loadMoreError} <button className="btn btn-secondary btn-sm" onClick={retryLoadMore}>Retry</button></div>}
    </section>
  );
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className="card-value">{value}</div>
    </div>
  );
}

