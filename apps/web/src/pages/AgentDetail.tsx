import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import type { AgentRecord, PolicyRules } from '../types';
import { ScheduleManagement } from './ScheduleManagement';
import { ExecutionList } from './ExecutionList';
import { StatusBadge, Skeleton, EmptyState } from '../components';
import { useApiResource } from '../hooks/useApiResource';

type SpendingData = Record<string, { used: number; limit: string; remaining: number }>;

function SpendingCard({ asset, data }: { asset: string; data: SpendingData[string] }) {
  const limitNum = parseFloat(data.limit) || 0;
  const pct = limitNum > 0 ? Math.min(100, Math.round((data.used / limitNum) * 100)) : 0;
  return (
    <div className="spending-asset">
      <div className="spending-header">
        <span className="spending-asset-name">{asset}</span>
        <span className="spending-values">{data.used} / {data.limit}</span>
      </div>
      <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
      <div className="spending-remaining">Remaining: {data.remaining}</div>
    </div>
  );
}

function StatusControls({
  agentId,
  currentStatus,
  onStatusChange,
}: {
  agentId: string;
  currentStatus: string;
  onStatusChange: (newStatus: string) => void;
}) {
  const [mutating, setMutating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (newStatus: string) => {
    if (mutating) return;
    setMutating(newStatus);
    setError(null);
    try {
      const res = await api.updateAgentStatus(agentId, newStatus);
      onStatusChange(res.status);
    } catch (e: any) {
      setError(e.message ?? 'Failed to update status');
    } finally {
      setMutating(null);
    }
  };

  if (currentStatus === 'disabled') {
    return (
      <div className="status-controls">
        <span className="muted">Disabled agents cannot be re-enabled.</span>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="status-controls">
      {currentStatus === 'active' && (
        <>
          <button disabled={mutating !== null} onClick={() => handleChange('paused')}>
            {mutating === 'paused' ? 'Pausing...' : 'Pause'}
          </button>
          <button disabled={mutating !== null} onClick={() => handleChange('disabled')}>
            {mutating === 'disabled' ? 'Disabling...' : 'Disable'}
          </button>
        </>
      )}
      {currentStatus === 'paused' && (
        <>
          <button disabled={mutating !== null} onClick={() => handleChange('active')}>
            {mutating === 'active' ? 'Resuming...' : 'Resume'}
          </button>
          <button disabled={mutating !== null} onClick={() => handleChange('disabled')}>
            {mutating === 'disabled' ? 'Disabling...' : 'Disable'}
          </button>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function AgentHeader({
  agent,
  onStatusChange,
}: {
  agent: AgentRecord;
  onStatusChange: (newStatus: string) => void;
}) {
  const statusClass = agent.status === 'active' ? 'badge-ok'
    : agent.status === 'paused' ? 'badge-warn'
    : 'badge-err';
  return (
    <div className="agent-header">
      <div className="agent-header-main">
        <h1>{agent.displayName}</h1>
        <div className="agent-header-meta">
          <span className={`badge ${statusClass}`}>{agent.status}</span>
          <code className="agent-address">{agent.stellarAddress.slice(0, 12)}...</code>
          <span className="muted">ID: {agent.id.slice(0, 8)}</span>
        </div>
      </div>
      <StatusControls agentId={agent.id} currentStatus={agent.status} onStatusChange={onStatusChange} />
    </div>
  );
}

const _DEFAULT_POLICY: PolicyRules = {
  maxTxAmount: { XLM: '100' },
  dailySpendingLimit: { XLM: '500' },
  allowedAssets: ['XLM'],
  allowedDestinations: [],
  allowedContractIds: [],
  txTypeRestrictions: {
    payment: true,
    trustline: true,
    contract_call: false,
    account_settings: false,
  },
  approvalThreshold: '50',
  requireHumanApprovalForAmountAbove: '50',
};

function deepClonePolicy(policy: PolicyRules): PolicyRules {
  return {
    maxTxAmount: { ...policy.maxTxAmount },
    dailySpendingLimit: { ...policy.dailySpendingLimit },
    allowedAssets: [...policy.allowedAssets],
    allowedDestinations: [...policy.allowedDestinations],
    allowedContractIds: [...policy.allowedContractIds],
    txTypeRestrictions: { ...policy.txTypeRestrictions },
    approvalThreshold: policy.approvalThreshold,
    requireHumanApprovalForAmountAbove: policy.requireHumanApprovalForAmountAbove,
  };
}

function PolicySummary({ agentId }: { agentId: string }) {
  const fetcher = useCallback(() => api.getPolicy(agentId).then((r) => r.policy), [agentId]);
  const { data: policy, error } = useApiResource<PolicyRules>(fetcher, [agentId]);

  if (error) return null;
  if (!policy) return null;

  const limits = Object.entries(policy.maxTxAmount);
  const assets = Object.entries(policy.dailySpendingLimit);

  return (
    <div className="policy-summary">
      <div className="policy-summary-grid">
        {limits.map(([asset, amount]) => (
          <div key={`-tx-${asset}`} className="policy-summary-item">
            <span className="policy-summary-label">Max Tx ({asset})</span>
            <span className="policy-summary-value">{amount}</span>
          </div>
        ))}
        <div className="policy-summary-item">
          <span className="policy-summary-label">Approval Threshold</span>
          <span className="policy-summary-value">{policy.approvalThreshold}</span>
        </div>
        {assets.map(([asset, limit]) => (
          <div key={`daily-${asset}`} className="policy-summary-item">
            <span className="policy-summary-label">Daily Limit ({asset})</span>
            <span className="policy-summary-value">{limit}</span>
          </div>
        ))}
        <div className="policy-summary-item">
          <span className="policy-summary-label">Allowed Assets</span>
          <span className="policy-summary-value">{policy.allowedAssets.join(', ')}</span>
        </div>
        <div className="policy-summary-item">
          <span className="policy-summary-label">Destinations</span>
          <span className="policy-summary-value">
            {policy.allowedDestinations.length === 0 ? 'Any' : policy.allowedDestinations.length + ' whitelisted'}
          </span>
        </div>
      </div>
    </div>
  );
}

function PolicySettings({ agentId }: { agentId: string }) {
  const fetcher = useCallback(() => api.getPolicy(agentId), [agentId]);
  const { data: policyResponse, error: loadError, loading, reload } = useApiResource(
    fetcher,
    [agentId],
  );

  const [policy, setPolicy] = useState<PolicyRules | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<PolicyRules | null>(null);

  useEffect(() => {
    if (!policyResponse) return;
    setPolicy(deepClonePolicy(policyResponse.policy));
    setForm(deepClonePolicy(policyResponse.policy));
    setVersion(policyResponse.version);
    setUpdatedAt(policyResponse.updatedAt);
  }, [policyResponse]);

  const updateForm = (patch: Partial<PolicyRules>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateAmountField = (
    field: 'maxTxAmount' | 'dailySpendingLimit',
    asset: string,
    value: string,
  ) => {
    setForm((prev) => {
      if (!prev) return prev;
      const next = { ...prev[field] };
      if (value.trim() === '') {
        delete next[asset];
      } else {
        next[asset] = value;
      }
      return { ...prev, [field]: next };
    });
  };

  const addListItem = (field: 'allowedAssets' | 'allowedDestinations' | 'allowedContractIds', value: string) => {
    if (!value.trim()) return;
    setForm((prev) => {
      if (!prev) return prev;
      if (prev[field].includes(value.trim())) return prev;
      return { ...prev, [field]: [...prev[field], value.trim()] };
    });
  };

  const removeListItem = (field: 'allowedAssets' | 'allowedDestinations' | 'allowedContractIds', value: string) => {
    setForm((prev) => {
      if (!prev) return prev;
      return { ...prev, [field]: prev[field].filter((v) => v !== value) };
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || saving) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.updatePolicy(agentId, form);
      setPolicy(deepClonePolicy(res.policy));
      setForm(deepClonePolicy(res.policy));
      setVersion(res.version);
      setUpdatedAt(new Date().toISOString());
      setSuccess(`Policy updated (version ${res.version})`);
      // Refresh the underlying resource so any derived views stay in sync.
      await reload();
    } catch (e: any) {
      setError(e.message ?? 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  if (loading || (!form && !loadError)) return <Skeleton label="Loading policy..." />;
  if (loadError && !form) return <div className="error">{loadError}</div>;
  if (!form) return <div className="error">Unable to load policy</div>;

  const isDirty =
    policy && JSON.stringify(form) !== JSON.stringify(policy);

  return (
    <form onSubmit={handleSave} className="policy-form">
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="policy-section">
        <h3>Limits</h3>
        <div className="form-grid">
          <label>
            <span>Max Transaction Amount (XLM)</span>
            <input
              type="number"
              step="0.0000001"
              min="0"
              value={form.maxTxAmount.XLM ?? ''}
              onChange={(e) => updateAmountField('maxTxAmount', 'XLM', e.target.value)}
              placeholder="100"
            />
            <small>Maximum amount allowed for a single intent. Transactions above this are denied.</small>
          </label>
          <label>
            <span>Daily Spending Limit (XLM)</span>
            <input
              type="number"
              step="0.0000001"
              min="0"
              value={form.dailySpendingLimit.XLM ?? ''}
              onChange={(e) => updateAmountField('dailySpendingLimit', 'XLM', e.target.value)}
              placeholder="500"
            />
            <small>Aggregate daily spending limit enforced by backend. Once reached, further intents are denied until the next day.</small>
          </label>
          <label>
            <span>Approval Threshold (XLM)</span>
            <input
              type="number"
              step="0.0000001"
              min="0"
              value={form.approvalThreshold}
              onChange={(e) => updateForm({ approvalThreshold: e.target.value })}
              placeholder="50"
            />
            <small>Intents above this amount require human approval before execution.</small>
          </label>
          <label>
            <span>Require Human Approval Above (XLM)</span>
            <input
              type="number"
              step="0.0000001"
              min="0"
              value={form.requireHumanApprovalForAmountAbove}
              onChange={(e) => updateForm({ requireHumanApprovalForAmountAbove: e.target.value })}
              placeholder="50"
            />
            <small>Amounts above this threshold require human approval.</small>
          </label>
        </div>
      </div>

      <div className="policy-section">
        <h3>Allowed Assets</h3>
        <div className="list-editor">
          {form.allowedAssets.map((asset) => (
            <span key={asset} className="chip">
              {asset}
              <button type="button" onClick={() => removeListItem('allowedAssets', asset)}>✓</button>
            </span>
          ))}
          <input
            type="text"
            placeholder="Add asset (enter)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addListItem('allowedAssets', (e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).value = '';
              }
            }}
          />
        </div>
      </div>

      <div className="policy-section">
        <h3>Allowed Destinations</h3>
        <div className="list-editor">
          {form.allowedDestinations.map((dest) => (
            <span key={dest} className="chip">
              {dest}
              <button type="button" onClick={() => removeListItem('allowedDestinations', dest)}>✓</button>
            </span>
          ))}
          <input
            type="text"
            placeholder="Add destination (enter)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addListItem('allowedDestinations', (e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).value = '';
              }
            }}
          />
        </div>
      </div>

      <div className="policy-section">
        <h3>Allowed Contract Ids</h3>
        <div className="list-editor">
          {form.allowedContractIds.map((id) => (
            <span key={id} className="chip">
              {id}
              <button type="button" onClick={() => removeListItem('allowedContractIds', id)}>✓</button>
            </span>
          ))}
          <input
            type="text"
            placeholder="Add contract id (enter)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addListItem('allowedContractIds', (e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).value = '';
              }
            }}
          />
        </div>
      </div>

      <div className="policy-section">
        <h3>Transaction Types</h3>
        <div className="checkbox-grid">
          {(Object.keys(form.txTypeRestrictions) as Array<keyof PolicyRules['txTypeRestrictions']>).map((type) => (
            <label key={type} className="checkbox-label">
              <input
                type="checkbox"
                checked={form.txTypeRestrictions[type]}
                onChange={(e) =>
                  updateForm({
                    txTypeRestrictions: {
                      ...form.txTypeRestrictions,
                      [type]: e.target.checked,
                    },
                  })
                }
              />
              {type}
            </label>
          ))}
        </div>
      </div>

      <div className="form-actions">
        <button type="submit" disabled={saving || !isDirty}>
          {saving ? 'Saving...' : 'Save Policy'}
        </button>
        {version !== null && <span className="muted">Version {version}</span>}
        {updatedAt && <span className="muted">Updated {new Date(updatedAt).toLocaleString()}</span>}
      </div>
    </form>
  );
}

export function AgentDetail() {
  const { agentId } = useParams() as { agentId: string };
  const fetcher = useCallback(() => api.getAgent(agentId), [agentId]);
  const { data: agent, error: loadError, loading, reload } = useApiResource(
    fetcher,
    [agentId],
  );

  const handleStatusChange = () => {
    void reload();
  };

  if (loading && !agent) return <Skeleton label="Loading agent..." />;
  if (loadError && !agent) return <EmptyState title="Error" description={loadError} />;
  if (!agent) return <EmptyState title="Not found" description="Agent not found" />;

  return (
    <div className="agent-detail">
      <AgentHeader agent={agent} onStatusChange={handleStatusChange} />
      <PolicySummary agentId={agentId} />
      <PolicySettings agentId={agentId} />
      <ScheduleManagement agentId={agentId} />
      <ExecutionList agentId={agentId} />
    </div>
  );
}
