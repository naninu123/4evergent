import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { buildAgentNameMap } from '../agentNames';
import type { AgentRecord, ScheduleRecord } from '../types';
import { AgentName, EmptyState, Skeleton } from '../components';

const PAGE_SIZE = 50;

function ScheduleStatusBadge({ status }: { status: string }) {
  const cls = status === 'active' ? 'badge-ok'
    : status === 'paused' ? 'badge-warn'
    : 'badge-err';
  return <span className={'badge ' + cls}>{status}</span>;
}

export default function Schedules() {
  const [schedules, setSchedules] = useState<ScheduleRecord[] | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const { agents: allAgents } = await api.listAllAgents();
      setAgents(allAgents);

      const perAgentLists = await Promise.all(
        allAgents.map(async (agent) => {
          const collected: ScheduleRecord[] = [];
          let offset = 0;
          for (;;) {
            const page = await api.listSchedules(agent.id, PAGE_SIZE, offset);
            collected.push(...page.schedules);
            if (!page.hasMore || page.schedules.length === 0) break;
            offset += page.schedules.length;
          }
          return collected;
        })
      );

      const combined = perAgentLists
        .flat()
        .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
      setSchedules(combined);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load schedules');
    }
  }, []);

  useEffect(() => {
    loadAll().catch(() => {});
  }, [loadAll]);

  const handleAction = async (agentId: string, scheduleId: string, action: 'pause' | 'resume' | 'disable') => {
    try {
      setActionError(null);
      if (action === 'pause') await api.pauseSchedule(agentId, scheduleId);
      else if (action === 'resume') await api.resumeSchedule(agentId, scheduleId);
      else await api.disableSchedule(agentId, scheduleId);
      await loadAll();
    } catch (e: any) {
      setActionError(e?.message ?? 'Failed to update schedule');
    }
  };

  if (error) {
    return (
      <EmptyState
        title="Failed to load schedules"
        message={error}
        error={true}
        actionLabel="Retry"
        onAction={() => { loadAll().catch(() => {}); }}
      />
    );
  }

  if (schedules === null) {
    return <Skeleton label="Loading schedules..." />;
  }

  const agentNames = buildAgentNameMap(agents);

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Schedules</h1>
          <p className="muted">
            Recurring payment schedules across all agents ({schedules.length} total).
          </p>
        </div>
      </div>

      {actionError && <div className="error" role="alert">{actionError}</div>}

      {schedules.length === 0 ? (
        <EmptyState
          title="No schedules configured"
          message="Create a recurring schedule from an agent's detail page to automate scheduled payments."
        />
      ) : (
        <table className="schedule-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Agent</th>
              <th>Intent</th>
              <th>Schedule</th>
              <th>Next Run</th>
              <th>Last Run</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/agents/${encodeURIComponent(s.agentId)}`}>
                    <code>{s.id.slice(0, 8)}</code>
                  </Link>
                </td>
                <td>
                  <Link to={`/agents/${encodeURIComponent(s.agentId)}`}>
                    <AgentName agentId={s.agentId} agentNames={agentNames} />
                  </Link>
                </td>
                <td>
                  <div>{s.intent.type}</div>
                  <div className="muted">
                    {s.intent.amount} {s.intent.asset} → {s.intent.destination?.slice(0, 8)}...
                  </div>
                </td>
                <td>
                  <code>{s.scheduleExpression}</code>
                  <div className="muted">{s.timezone}</div>
                </td>
                <td>{new Date(s.nextRunAt).toLocaleString()}</td>
                <td>{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '-'}</td>
                <td><ScheduleStatusBadge status={s.status} /></td>
                <td className="schedule-actions">
                  {s.status === 'active' && (
                    <>
                      <button onClick={() => handleAction(s.agentId, s.id, 'pause')}>Pause</button>
                      {' '}
                      <button onClick={() => handleAction(s.agentId, s.id, 'disable')}>Disable</button>
                    </>
                  )}
                  {s.status === 'paused' && (
                    <>
                      <button onClick={() => handleAction(s.agentId, s.id, 'resume')}>Resume</button>
                      {' '}
                      <button onClick={() => handleAction(s.agentId, s.id, 'disable')}>Disable</button>
                    </>
                  )}
                  {s.status === 'disabled' && (
                    <button onClick={() => handleAction(s.agentId, s.id, 'resume')}>Resume</button>
                  )}
                  {' '}
                  <Link
                    to={`/agents/${encodeURIComponent(s.agentId)}`}
                    className="btn btn-ghost btn-sm"
                  >
                    Manage
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
