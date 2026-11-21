import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, Skeleton, EmptyState, StatusBadge, Section } from '../components';
import type { AgentRecord, ActivityRecord, ApprovalRecord } from '../types';

interface AttentionCounts {
  pendingApprovals: number;
  failedExecutions: number;
  deadLetterExecutions: number;
  retryingExecutions: number;
  stuckExecutions: number;
}

export default function Overview() {
  const [health, setHealth] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [approvalsError, setApprovalsError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attention, setAttention] = useState<AttentionCounts | null>(null);
  const [attentionError, setAttentionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHealthError(null);
    setAgentsError(null);
    setApprovalsError(null);
    setActivityError(null);
    setAttentionError(null);
    (async () => {
      try {
        const [hRes, aRes, apRes, actRes] = await Promise.allSettled([
          api.health(),
          // Page through GET /agents so the status counts cover every agent,
          // not just the first 200.
          api.listAllAgents(),
          api.listApprovals('pending_approval'),
          api.listActivity(),
        ]);
        if (cancelled) return;

        const allFailed =
          hRes.status === 'rejected' &&
          aRes.status === 'rejected' &&
          apRes.status === 'rejected' &&
          actRes.status === 'rejected';

        if (allFailed) {
          setError(hRes.reason?.message ?? 'Failed to fetch');
          return;
        }

        if (hRes.status === 'fulfilled') {
          setHealth(hRes.value.signerAccountId);
        } else {
          setHealth(null);
          setHealthError(hRes.reason?.message ?? 'Failed to load signer status');
        }

        if (aRes.status === 'fulfilled') {
          setAgents(aRes.value.agents);
        } else {
          setAgents([]);
          setAgentsError(aRes.reason?.message ?? 'Failed to load agents');
        }

        if (apRes.status === 'fulfilled') {
          setApprovals(apRes.value.approvals);
        } else {
          setApprovals([]);
          setApprovalsError(apRes.reason?.message ?? 'Failed to load pending approvals');
        }

        if (actRes.status === 'fulfilled') {
          setActivity(actRes.value.activity);
        } else {
          setActivity([]);
          setActivityError(actRes.reason?.message ?? 'Failed to load recent activity');
        }

        try {
          const att = await api.getOverviewAttention();
          if (!cancelled) setAttention(att);
        } catch (e: any) {
          if (!cancelled) setAttentionError(e.message ?? 'Failed to load operational status');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const retry = () => setReloadKey((k) => k + 1);

  const retryHealth = async () => {
    setHealthError(null);
    try {
      const h = await api.health();
      setHealth(h.signerAccountId);
    } catch (e: any) {
      setHealth(null);
      setHealthError(e.message ?? 'Failed to load signer status');
    }
  };

  const retryAgents = async () => {
    setAgentsError(null);
    try {
      const a = await api.listAllAgents();
      setAgents(a.agents);
    } catch (e: any) {
      setAgents([]);
      setAgentsError(e.message ?? 'Failed to load agents');
    }
  };

  const retryApprovals = async () => {
    setApprovalsError(null);
    try {
      const ap = await api.listApprovals('pending_approval');
      setApprovals(ap.approvals);
    } catch (e: any) {
      setApprovals([]);
      setApprovalsError(e.message ?? 'Failed to load pending approvals');
    }
  };

  const retryActivity = async () => {
    setActivityError(null);
    try {
      const act = await api.listActivity();
      setActivity(act.activity);
    } catch (e: any) {
      setActivity([]);
      setActivityError(e.message ?? 'Failed to load recent activity');
    }
  };

  if (loading) return <Skeleton label="Connecting to API..." />;
  if (error) return <EmptyState title="API Unavailable" message={error} error={true} actionLabel="Retry" onAction={retry} />;

  const activeAgents = agents.filter((a) => a.status === 'active').length;
  const pausedAgents = agents.filter((a) => a.status === 'paused').length;
  const disabledAgents = agents.filter((a) => a.status === 'disabled').length;
  const pendingApprovals = approvals.length;

  const hasAttention = attention && (
    attention.pendingApprovals > 0 ||
    attention.failedExecutions > 0 ||
    attention.deadLetterExecutions > 0 ||
    attention.retryingExecutions > 0 ||
    attention.stuckExecutions > 0
  );

  const recentActivity = activity.slice(0, 10);
  const hasRecentActivity = recentActivity.length > 0;

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Overview</h1>
          <p className="muted">What needs your attention right now.</p>
        </div>
      </div>

      <div className="card-grid">
        <Card title="Signer Account" value={healthError ? '—' : (health ? health.slice(0, 12) + '...' : 'unknown')} />
        <Card title="Active Agents" value={agentsError ? '—' : String(activeAgents)} />
        <Card title="Paused Agents" value={agentsError ? '—' : String(pausedAgents)} />
        <Card title="Disabled Agents" value={agentsError ? '—' : String(disabledAgents)} />
        <Card title="Pending Approvals" value={approvalsError ? '—' : String(pendingApprovals)} />
      </div>

      {healthError && (
        <div className="error-banner" role="alert">
          <span>Signer account: {healthError}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={retryHealth}>Retry</button>
        </div>
      )}
      {agentsError && (
        <div className="error-banner" role="alert">
          <span>Agents: {agentsError}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={retryAgents}>Retry</button>
        </div>
      )}
      {approvalsError && (
        <div className="error-banner" role="alert">
          <span>Pending approvals: {approvalsError}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={retryApprovals}>Retry</button>
        </div>
      )}

      <Section title="Needs Attention">
        {attention === null && !attentionError ? (
          <Skeleton label="Loading operational status..." />
        ) : attentionError ? (
          <div className="error-banner">{attentionError}</div>
        ) : hasAttention ? (
          <table className="table">
            <thead>
              <tr><th>Issue</th><th>Count</th><th>Action</th></tr>
            </thead>
            <tbody>
              {attention!.pendingApprovals > 0 && (
                <tr>
                  <td>Pending approvals</td>
                  <td>{attention!.pendingApprovals}</td>
                  <td><Link to="/approvals" className="btn btn-ghost btn-sm">Review</Link></td>
                </tr>
              )}
              {attention!.failedExecutions > 0 && (
                <tr>
                  <td>Failed executions</td>
                  <td>{attention!.failedExecutions}</td>
                  <td><Link to="/executions" className="btn btn-ghost btn-sm">Review</Link></td>
                </tr>
              )}
              {attention!.retryingExecutions > 0 && (
                <tr>
                  <td>Retrying executions</td>
                  <td>{attention!.retryingExecutions}</td>
                  <td><Link to="/executions" className="btn btn-ghost btn-sm">Review</Link></td>
                </tr>
              )}
              {attention!.deadLetterExecutions > 0 && (
                <tr>
                  <td>Dead-letter executions</td>
                  <td>{attention!.deadLetterExecutions}</td>
                  <td><Link to="/executions" className="btn btn-ghost btn-sm">Review</Link></td>
                </tr>
              )}
              {attention!.stuckExecutions > 0 && (
                <tr>
                  <td>Stuck executions</td>
                  <td>{attention!.stuckExecutions}</td>
                  <td><Link to="/executions" className="btn btn-ghost btn-sm">Review</Link></td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <h3>All systems operational</h3>
            <p>No pending approvals or failed executions.</p>
          </div>
        )}
      </Section>

      {(hasRecentActivity || activityError) && (
        <Section title="Recent Activity">
          {activityError ? (
            <div className="error-banner" role="alert">
              <span>{activityError}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={retryActivity}>Retry</button>
            </div>
          ) : (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr><th>Activity</th><th>Agent</th><th>Status</th><th>Time</th></tr>
                </thead>
                <tbody>
                  {recentActivity.map((a) => (
                    <tr key={a.id}>
                      <td><code>{a.id.slice(0, 8)}</code></td>
                      <td><code>{a.agentId.slice(0, 8)}</code></td>
                      <td><StatusBadge status={a.status} /></td>
                      <td className="muted">{new Date(a.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}
    </section>
  );
}
