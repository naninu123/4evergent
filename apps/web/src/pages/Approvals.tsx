import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAgentNames } from '../agentNames';
import type { ApprovalRecord } from '../types';
import { AgentName, ConfirmationModal, Skeleton, EmptyState, PaginationFooter } from '../components';

const PAGE_SIZE = 50;

export default function Approvals() {
  const [approvals, setApprovals] = useState<ApprovalRecord[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const agentNames = useAgentNames();

  const loadPage = useCallback(async (offset: number, replace: boolean) => {
    try {
      const r = await api.listApprovals('pending_approval', PAGE_SIZE, offset);
      setApprovals(replace ? r.approvals : (prev) => (prev ?? []).concat(r.approvals));
      setHasMore(r.hasMore);
      setTotal(r.total ?? null);
      setNextOffset(offset + r.approvals.length);
      if (!replace) setLoadMoreError(null);
    } catch (e: any) {
      if (replace) setError(e.message);
      else setLoadMoreError(e.message ?? 'Failed to load more approvals');
    }
  }, []);

  useEffect(() => {
    loadPage(0, true).catch(() => {});
  }, [loadPage]);

  const loadMore = () => {
    setLoadingMore(true);
    loadPage(nextOffset, false).finally(() => setLoadingMore(false));
  };

  const retryLoadMore = () => {
    setLoadMoreError(null);
    setLoadingMore(true);
    loadPage(nextOffset, false).finally(() => setLoadingMore(false));
  };

  const handleAction = (id: string, action: 'approve' | 'reject') => {
    setLoadingId(id);
    const call = action === 'approve' ? api.approve(id) : api.reject(id);
    call
      .then(() => loadPage(0, true))
      .catch(() => { /* list untouched on failure; row remains */ })
      .finally(() => setLoadingId(null));
  };

  const retry = () => {
    setError(null);
    loadPage(0, true).catch(() => {});
  };

  if (error) return <EmptyState title="Failed to load approvals" message={error} error={true} actionLabel="Retry" onAction={retry} />;
  if (approvals === null) return <Skeleton label="Loading approvals..." />;
  if (approvals.length === 0) {
    return (
      <EmptyState title="No pending approvals" message="Approvals requiring action will appear here." />
    );
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Approvals</h1>
          <p className="muted">Operational review queue for human-in-the-loop authorization.</p>
          {total !== null && total > approvals.length && (
            <p className="muted">Showing {approvals.length} of {total} pending approvals</p>
          )}
        </div>
      </div>

      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr><th>Approval</th><th>Agent</th><th>Intent</th><th>Amount</th><th>Asset</th><th>Expires</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={a.id}>
                <td><Link to={`/approvals/${a.id}`} className="table-row-link">{a.id.slice(0, 8)}</Link></td>
                <td><AgentName agentId={a.agentId} agentNames={agentNames} /></td>
                <td>{a.intent.type}</td>
                <td>{a.intent.amount || '-'}</td>
                <td>{a.intent.asset || ''}</td>
                <td>{a.expiresAt ? new Date(a.expiresAt).toLocaleString() : 'no expiry'}</td>
                <td>
                  {(() => {
                    const isExpired = a.status === 'expired' || (a.expiresAt ? new Date(a.expiresAt) <= new Date() : false);
                    if (isExpired) {
                      return <span className="badge badge-err">expired</span>;
                    }
                    return (
                      <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
                        <button className="btn btn-primary btn-sm" disabled={loadingId === a.id} onClick={() => handleAction(a.id, 'approve')}>
                          {loadingId === a.id ? 'Processing...' : 'Approve'}
                        </button>
                        <button className="btn btn-danger btn-sm" disabled={loadingId === a.id} onClick={() => setRejectId(a.id)}>Reject</button>
                      </div>
                    );
                  })()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PaginationFooter hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} itemCount={approvals.length} />
      {loadMoreError && <div className="error" role="alert">{loadMoreError} <button className="btn btn-secondary btn-sm" onClick={retryLoadMore}>Retry</button></div>}
      {rejectId !== null && (
        <ConfirmationModal title="Reject this approval?" actionLabel="Reject"
          onCancel={() => setRejectId(null)}
          onConfirm={() => {
            setRejectId(null);
            handleAction(rejectId, 'reject');
          }}
        />
      )}
    </section>
  );
}
