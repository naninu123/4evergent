import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { AgentRecord, ScheduleRecord } from '../types';
import { StatusBadge, Skeleton, EmptyState } from '../components';

export interface ScheduleWithAgent extends ScheduleRecord {
  agentName?: string;
}

export default function Schedules() {
  const [schedules, setSchedules] = useState<ScheduleWithAgent[] | null>(null);
  const [totalAgents, setTotalAgents] = useState<number | null>(null);
  const [agentsTruncated, setAgentsTruncated] = useState(false);
  const [truncatedSchedules, setTruncatedSchedules] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  // Keep a map of agents for quick lookup
  const agentsMapRef = useRef<Map<string, AgentRecord>>(new Map());

  const loadSchedules = useCallback(async () => {
    setError(null);
    try {
      // Step 1: Walk all pages of agents to ensure no agent is dropped
      const agentsResult = await api.listAllAgents();
      setTotalAgents(agentsResult.total);
      setAgentsTruncated(agentsResult.truncated);

      const map = new Map<string, AgentRecord>();
      for (const a of agentsResult.agents) {
        map.set(a.id, a);
      }
      agentsMapRef.current = map;

      // Step 2: Fetch schedules for each agent in parallel (client-side aggregation)
      const truncatedAgentList: string[] = [];
      const scheduleResults = await Promise.all(
        agentsResult.agents.map(async (agent) => {
          try {
            // Use 50 as standard page size
            const res = await api.listSchedules(agent.id, 50, 0);
            if (res.hasMore) {
              truncatedAgentList.push(agent.displayName || agent.id);
            }
            return res.schedules.map((s) => ({
              ...s,
              agentName: agent.displayName,
            }));
          } catch (err: any) {
            // If an individual agent's schedules fail to fetch, don't crash whole page
            console.error(`Failed to load schedules for agent ${agent.id}:`, err);
            return [];
          }
        })
      );

      setTruncatedSchedules(truncatedAgentList);

      const allSchedules = scheduleResults.flat();
      // Sort schedules: e.g. next run ascending (soonest first)
      allSchedules.sort((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime());

      setSchedules(allSchedules);
    } catch (e: any) {
      setError(e.message || 'Failed to load schedules');
    }
  }, []);

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  const handleAction = async (agentId: string, scheduleId: string, action: 'pause' | 'resume' | 'disable') => {
    setActionError(null);
    setActionLoadingId(scheduleId);
    try {
      if (action === 'pause') {
        await api.pauseSchedule(agentId, scheduleId);
      } else if (action === 'resume') {
        await api.resumeSchedule(agentId, scheduleId);
      } else if (action === 'disable') {
        await api.disableSchedule(agentId, scheduleId);
      }
      // Reload schedules to sync status
      await loadSchedules();
    } catch (e: any) {
      setActionError(e.message || `Failed to ${action} schedule`);
    } finally {
      setActionLoadingId(null);
    }
  };

  const retry = () => {
    setError(null);
    setActionError(null);
    setSchedules(null);
    loadSchedules();
  };

  if (error) {
    return (
      <EmptyState
        title="Failed to load schedules"
        message={error}
        error={true}
        actionLabel="Retry"
        onAction={retry}
      />
    );
  }

  if (schedules === null) {
    return <Skeleton label="Loading schedules..." />;
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Schedules</h1>
          <p className="muted">
            Overview of recurring schedules across all agents ({schedules.length} schedule{schedules.length === 1 ? '' : 's'}).
          </p>
        </div>
      </div>

      {actionError && (
        <div className="error" role="alert" style={{ marginBottom: 'var(--space-md)' }}>
          {actionError}
        </div>
      )}

      {agentsTruncated && totalAgents !== null && (
        <div className="notice-banner" role="status" style={{ marginBottom: 'var(--space-md)' }}>
          Showing schedules from {agentsMapRef.current.size} of {totalAgents} agents — the agent list is truncated at the pagination limit.
        </div>
      )}

      {truncatedSchedules.length > 0 && (
        <div className="notice-banner" role="status" style={{ marginBottom: 'var(--space-md)' }}>
          Some agents ({truncatedSchedules.join(', ')}) have more schedules than shown. Visit their agent detail pages to view all schedules.
        </div>
      )}

      {schedules.length === 0 ? (
        <EmptyState
          title="No schedules found"
          message="No recurring schedules are configured for any agent. Visit an agent's page to create one."
        />
      ) : (
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Agent</th>
                <th>Intent</th>
                <th>Expression</th>
                <th>Next Run</th>
                <th>Last Run</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => {
                const agent = agentsMapRef.current.get(s.agentId);
                const agentDisplayName = s.agentName || agent?.displayName || s.agentId;
                const isActionLoading = actionLoadingId === s.id;

                return (
                  <tr key={s.id}>
                    <td>
                      <Link
                        to={`/agents/${encodeURIComponent(s.agentId)}#schedules`}
                        className="table-row-link"
                        title="Manage schedule on agent page"
                      >
                        <code>{s.id.slice(0, 8)}</code>
                      </Link>
                    </td>
                    <td>
                      <Link
                        to={`/agents/${encodeURIComponent(s.agentId)}`}
                        className="table-row-link"
                      >
                        {agentDisplayName}
                      </Link>
                    </td>
                    <td>
                      <div>{s.intent.type}</div>
                      {s.intent.amount && (
                        <div className="muted">
                          {s.intent.amount} {s.intent.asset || ''}
                        </div>
                      )}
                    </td>
                    <td>
                      <code>{s.scheduleExpression}</code>
                      {s.timezone && <div className="muted">{s.timezone}</div>}
                    </td>
                    <td>{new Date(s.nextRunAt).toLocaleString()}</td>
                    <td>{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '-'}</td>
                    <td>
                      <StatusBadge status={s.status} />
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 'var(--space-2xs)', alignItems: 'center' }}>
                        {s.status === 'active' && (
                          <>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleAction(s.agentId, s.id, 'pause')}
                              disabled={isActionLoading}
                            >
                              Pause
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleAction(s.agentId, s.id, 'disable')}
                              disabled={isActionLoading}
                            >
                              Disable
                            </button>
                          </>
                        )}
                        {s.status === 'paused' && (
                          <>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleAction(s.agentId, s.id, 'resume')}
                              disabled={isActionLoading}
                            >
                              Resume
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleAction(s.agentId, s.id, 'disable')}
                              disabled={isActionLoading}
                            >
                              Disable
                            </button>
                          </>
                        )}
                        {s.status === 'disabled' && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => handleAction(s.agentId, s.id, 'resume')}
                            disabled={isActionLoading}
                          >
                            Resume
                          </button>
                        )}
                        <Link
                          to={`/agents/${encodeURIComponent(s.agentId)}#schedules`}
                          className="btn btn-ghost btn-sm"
                        >
                          Manage
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
