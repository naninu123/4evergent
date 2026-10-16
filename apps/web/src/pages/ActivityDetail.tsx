import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { ActivityRecord, ExecutionRecord } from '../types';
import { Skeleton, EmptyState, IntentAmount, DetailCard, Section, StatusBadge, Address } from '../components';

export default function ActivityDetail() {
  const { agentId, activityId } = useParams<{ agentId: string; activityId: string }>();
  const navigate = useNavigate();
  const [activity, setActivity] = useState<ActivityRecord | null>(null);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);

  const load = useCallback(() => {
    if (!agentId || !activityId) return;
    const currentRequest = ++requestId.current;
    setError(null);
    setActivity(null);
    setExecutions([]);
    setLoading(true);
    api.activityDetail(agentId, activityId)
      .then((r) => {
        if (requestId.current !== currentRequest) return;
        setActivity(r.activity);
        if (r.activity) {
          api.listAgentExecutions(agentId)
            .then((r2) => {
              if (requestId.current === currentRequest) {
                setExecutions(r2.executions.filter((e: ExecutionRecord) => e.activityId === activityId));
              }
            })
            .catch(() => {});
        }
      })
      .catch((e: any) => {
        if (requestId.current === currentRequest) setError(e.message ?? 'Failed to load activity');
      })
      .finally(() => {
        if (requestId.current === currentRequest) setLoading(false);
      });
  }, [agentId, activityId]);

  useEffect(() => {
    load();
    return () => { requestId.current += 1; };
  }, [load]);

  if (loading) return <Skeleton label="Loading activity..." />;
  if (error) return <EmptyState title="Failed to load activity" message={error} actionLabel="Retry" onAction={load} />;
  if (!activity) return (
    <EmptyState title="Activity not found" message="This activity does not exist or you do not have access." />
  );

  const policyDecision = activity.policyDecision;

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Activity Detail</h1>
          <p className="muted">Agent: {agentId?.slice(0, 8)} · Activity: {activityId?.slice(0, 8)}</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>← Back</button>
      </div>

      <div className="detail-grid">
        <DetailCard title="Activity ID"><code>{activity.id}</code></DetailCard>
        <DetailCard title="Status">
          <StatusBadge status={activity.status} />
        </DetailCard>
        <DetailCard title="Intent Type">{activity.intent.type}</DetailCard>
        <DetailCard title="Amount"><IntentAmount intent={activity.intent} /></DetailCard>
        <DetailCard title="Destination">
          {activity.intent.destination
            ? <Address address={activity.intent.destination} />
            : '-'}
        </DetailCard>
        <DetailCard title="Created">{new Date(activity.createdAt).toLocaleString()}</DetailCard>
        <DetailCard title="Updated">{new Date(activity.updatedAt).toLocaleString()}</DetailCard>
      </div>

      {policyDecision && (
        <Section title="Policy Decision">
          <DetailCard title="Result">
            <span className="muted">{policyDecision.result}</span>
          </DetailCard>
          {policyDecision.reason && (
            <DetailCard title="Reason">{policyDecision.reason}</DetailCard>
          )}
          {policyDecision.rule && (
            <DetailCard title="Rule">{policyDecision.rule}</DetailCard>
          )}
        </Section>
      )}

      {activity.authorizationStatus && (
        <Section title="Authorization">
          <DetailCard title="Status">
            <span className="muted">{activity.authorizationStatus}</span>
          </DetailCard>
        </Section>
      )}

      {activity.simulationResult && (
        <Section title="Simulation">
          <DetailCard title="Success">{activity.simulationResult.success ? 'Yes' : 'No'}</DetailCard>
          {activity.simulationResult.fee && (
            <DetailCard title="Fee">{activity.simulationResult.fee} stroops</DetailCard>
          )}
          {activity.simulationResult.operations && (
            <DetailCard title="Operations">{activity.simulationResult.operations}</DetailCard>
          )}
        </Section>
      )}

      {activity.error && (
        <Section title="Error">
          <DetailCard title="Details">{activity.error}</DetailCard>
        </Section>
      )}

      {activity.txHash && (
        <Section title="Transaction">
          <DetailCard title="Transaction Hash">
            <Address address={activity.txHash} />
          </DetailCard>
        </Section>
      )}

      {executions.length > 0 && (
        <Section title={`Related Executions (${executions.length})`}>
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {executions.map((e) => (
                <tr key={e.id}>
                  <td><code>{e.id.slice(0, 8)}</code></td>
                  <td><StatusBadge status={e.status} /></td>
                  <td className="muted">{new Date(e.createdAt).toLocaleString()}</td>
                  <td>
                    <Link to={`/executions/${e.id}`} className="btn btn-ghost btn-sm">View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </section>
  );
}
