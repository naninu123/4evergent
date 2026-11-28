import { useId } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { describeApiError } from '../apiErrors';
import { ConfirmationModal, Skeleton } from '../components';
import type { ScheduleRecord, SubmitPaymentIntent } from '../types';
import { validateStellarAddressField, validateCronExpressionShape } from '../validation';

interface ScheduleManagementProps {
  agentId: string;
  onError?: (msg: string) => void;
}

const SUPPORTED_TIMEZONES = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];

const CRON_PRESETS = [
  { label: 'Every hour', expression: '0 * * * *' },
  { label: 'Every 6 hours', expression: '0 */6 * * *' },
  { label: 'Every 12 hours', expression: '0 */12 * * *' },
  { label: 'Daily (midnight)', expression: '0 0 * * *' },
  { label: 'Daily (noon)', expression: '0 12 * * *' },
  { label: 'Weekly (Monday)', expression: '0 0 * * 1' },
];

export function ScheduleManagement({ agentId, onError }: ScheduleManagementProps) {
  const [schedules, setSchedules] = useState<ScheduleRecord[] | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track which schedule is being edited and its draft fields
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAsset, setEditAsset] = useState<string>('XLM');
  const [editIssuer, setEditIssuer] = useState<string>('');
  const [editAmount, setEditAmount] = useState<string>('');
  const [editDestination, setEditDestination] = useState<string>('');
  const [editReason, setEditReason] = useState<string>('');
  const [editExpression, setEditExpression] = useState<string>('');
  const [editTimezone, setEditTimezone] = useState<string>('UTC');
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const load = () => {
    api.listSchedules(agentId)
      .then((r) => setSchedules(r.schedules))
      .catch((e: any) => {
        const msg = describeApiError(e, 'Failed to load schedules');
        setError(msg);
        onError?.(msg);
      });
  };

  useEffect(() => { load(); }, [agentId]);

  const handleAction = async (scheduleId: string, action: 'pause' | 'resume' | 'disable') => {
    try {
      if (action === 'pause') await api.pauseSchedule(agentId, scheduleId);
      else if (action === 'resume') await api.resumeSchedule(agentId, scheduleId);
      else await api.disableSchedule(agentId, scheduleId);
      load();
    } catch (e: any) {
      onError?.(describeApiError(e, 'Failed to update schedule'));
    }
  };

  const handleDelete = async (scheduleId: string) => {
    setDeleteId(null);
    try {
      await api.deleteSchedule(agentId, scheduleId);
      load();
    } catch (e: any) {
      onError?.(describeApiError(e, 'Failed to delete schedule'));
    }
  };

  const startEdit = (schedule: ScheduleRecord) => {
    const intentWithDetails = schedule.intent as typeof schedule.intent & { assetDetails?: { issuer?: string } };
    setEditingId(schedule.id);
    setEditAsset(schedule.intent.asset ?? 'XLM');
    setEditIssuer(intentWithDetails.assetDetails?.issuer ?? '');
    setEditAmount(schedule.intent.amount ?? '');
    setEditDestination(schedule.intent.destination ?? '');
    setEditReason(schedule.intent.reason ?? '');
    setEditExpression(schedule.scheduleExpression ?? '');
    setEditTimezone(schedule.timezone ?? 'UTC');
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditAsset('XLM');
    setEditIssuer('');
    setEditAmount('');
    setEditDestination('');
    setEditReason('');
    setEditExpression('');
    setEditTimezone('UTC');
    setEditError(null);
  };

  const saveEdit = async (schedule: ScheduleRecord) => {
    if (!editingId || editSaving) return;
    const trimmedExpr = editExpression.trim();
    if (!trimmedExpr) {
      setEditError('Schedule expression is required.');
      return;
    }
    const cronCheck = validateCronExpressionShape(trimmedExpr);
    if (!cronCheck.valid) {
      setEditError(`Invalid cron expression: ${cronCheck.error ?? 'must be 5 fields'}`);
      return;
    }
    const destErr = validateStellarAddressField(editDestination, 'Destination');
    if (destErr) {
      setEditError(destErr);
      return;
    }
    if (editAsset !== 'XLM') {
      const issuerErr = validateStellarAddressField(editIssuer, 'Asset issuer');
      if (issuerErr) {
        setEditError(issuerErr);
        return;
      }
    }

    const patch: {
      scheduleExpression?: string;
      timezone?: string;
      intent?: Partial<SubmitPaymentIntent>;
    } = {};

    if (trimmedExpr !== schedule.scheduleExpression) {
      patch.scheduleExpression = trimmedExpr;
    }
    if (editTimezone !== schedule.timezone) {
      patch.timezone = editTimezone;
    }

    const trimmedAmount = editAmount.trim();
    const trimmedDestination = editDestination.trim();
    const trimmedReason = editReason.trim();
    const trimmedIssuer = editIssuer.trim();
    const origIssuer = (schedule.intent as typeof schedule.intent & { assetDetails?: { issuer?: string } }).assetDetails?.issuer ?? '';

    const intentChanged =
      editAsset !== schedule.intent.asset ||
      (editAsset !== 'XLM' && trimmedIssuer !== origIssuer) ||
      trimmedAmount !== (schedule.intent.amount ?? '') ||
      trimmedDestination !== (schedule.intent.destination ?? '') ||
      trimmedReason !== (schedule.intent.reason ?? '');

    if (intentChanged) {
      patch.intent = {
        type: 'payment',
        asset: editAsset,
        ...(editAsset !== 'XLM' ? { assetDetails: { code: editAsset, issuer: trimmedIssuer } } : {}),
        amount: trimmedAmount,
        destination: trimmedDestination,
        reason: trimmedReason,
      };
    }

    if (Object.keys(patch).length === 0) {
      cancelEdit();
      return;
    }

    setEditSaving(true);
    setEditError(null);
    try {
      const result = await api.updateSchedule(agentId, schedule.id, patch);
      // Update the local schedule list with the server response
      setSchedules((prev) =>
        prev
          ? prev.map((s) => (s.id === schedule.id ? result.schedule : s))
          : prev
      );
      cancelEdit();
    } catch (e: any) {
      setEditError(describeApiError(e, 'Failed to update schedule.'));
    } finally {
      setEditSaving(false);
    }
  };

  if (error && schedules === null) return <div className="error" role="alert">{error}</div>;

  return (
    <div className="schedule-management">
      <div className="schedule-header">
        <h3>Recurring Schedules</h3>
        <button onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel' : 'Create Schedule'}
        </button>
      </div>

      {showCreate && (
        <CreateScheduleForm
          agentId={agentId}
          onSuccess={() => { setShowCreate(false); load(); }}
          onError={(e) => { setError(e); onError?.(e); }}
        />
      )}

      {schedules === null ? (
        <Skeleton label="Loading schedules..." />
      ) : schedules.length === 0 ? (
        <div className="empty-state">
          <p>No schedules for this agent. Create a recurring schedule to automate agent operations.</p>
        </div>
      ) : (
        <table className="schedule-table">
          <thead>
            <tr>
              <th>ID</th>
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
                <td><code>{s.id.slice(0, 8)}</code></td>
                <td>
                  <div>{s.intent.type}</div>
                  <div className="muted">{s.intent.amount} {s.intent.asset} → {s.intent.destination?.slice(0, 8)}...</div>
                </td>
                <td>
                  {editingId === s.id ? (
                    <form
                      className="schedule-edit-form"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await saveEdit(s);
                      }}
                    >
                      <div className="form-grid">
                        <label>
                          <span>Asset</span>
                          <select
                            value={editAsset}
                            onChange={(e) => setEditAsset(e.target.value)}
                            disabled={editSaving}
                            aria-label="Edit asset"
                          >
                            <option value="XLM">XLM (native)</option>
                            <option value="USDC">USDC</option>
                            <option value="BTC">BTC</option>
                          </select>
                        </label>
                        {editAsset !== 'XLM' && (
                          <label>
                            <span>Asset Issuer (G...)</span>
                            <input
                              type="text"
                              value={editIssuer}
                              onChange={(e) => setEditIssuer(e.target.value)}
                              placeholder="G... (asset issuer)"
                              disabled={editSaving}
                              aria-label="Edit asset issuer"
                            />
                          </label>
                        )}
                        <label>
                          <span>Amount</span>
                          <input
                            type="number"
                            step="0.0000001"
                            min="0"
                            value={editAmount}
                            onChange={(e) => setEditAmount(e.target.value)}
                            placeholder="10"
                            disabled={editSaving}
                            aria-label="Edit amount"
                          />
                        </label>
                        <label>
                          <span>Destination (G...)</span>
                          <input
                            type="text"
                            value={editDestination}
                            onChange={(e) => setEditDestination(e.target.value)}
                            placeholder="G..."
                            disabled={editSaving}
                            aria-label="Edit destination"
                          />
                        </label>
                        <label>
                          <span>Reason</span>
                          <input
                            type="text"
                            value={editReason}
                            onChange={(e) => setEditReason(e.target.value)}
                            placeholder="Recurring payment"
                            disabled={editSaving}
                            aria-label="Edit reason"
                          />
                        </label>
                        <label>
                          <span>Timezone</span>
                          <select
                            value={editTimezone}
                            onChange={(e) => setEditTimezone(e.target.value)}
                            disabled={editSaving}
                            aria-label="Edit timezone"
                          >
                            {SUPPORTED_TIMEZONES.map((tz) => (
                              <option key={tz} value={tz}>{tz}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label>
                        <span>Cron expression</span>
                        <input
                          type="text"
                          value={editExpression}
                          onChange={(e) => setEditExpression(e.target.value)}
                          placeholder="0 0 * * *"
                          disabled={editSaving}
                          aria-label="Edit schedule expression"
                          aria-describedby="schedule-edit-cron-help"
                        />
                      </label>
                      <small id="schedule-edit-cron-help">
                        5-field cron expression: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-6, 0=Sunday)
                      </small>
                      <div className="cron-presets">
                        <span className="muted">Presets:</span>
                        {CRON_PRESETS.map((preset) => (
                          <button
                            key={preset.expression}
                            type="button"
                            className="preset-btn"
                            onClick={() => setEditExpression(preset.expression)}
                            disabled={editSaving}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                      {editError && <div className="error" role="alert">{editError}</div>}
                      <div className="form-actions">
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={editSaving}
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={editSaving}
                        >
                          {editSaving ? 'Saving...' : 'Save'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <code>{s.scheduleExpression}</code>
                      <div className="muted">{s.timezone}</div>
                    </>
                  )}
                </td>
                <td>{new Date(s.nextRunAt).toLocaleString()}</td>
                <td>{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '-'}</td>
                <td><ScheduleStatusBadge status={s.status} /></td>
                <td className="schedule-actions">
                  {editingId === s.id ? (
                    <span className="muted">editing</span>
                  ) : (
                    <button onClick={() => startEdit(s)}>Edit</button>
                  )}
                  {s.status === 'active' && (
                    <>
                      <button onClick={() => handleAction(s.id, 'pause')}>Pause</button>
                      {' '}
                      <button onClick={() => handleAction(s.id, 'disable')}>Disable</button>
                    </>
                  )}
                  {s.status === 'paused' && (
                    <>
                      <button onClick={() => handleAction(s.id, 'resume')}>Resume</button>
                      {' '}
                      <button onClick={() => handleAction(s.id, 'disable')}>Disable</button>
                    </>
                  )}
                  {s.status === 'disabled' && (
                    <button onClick={() => handleAction(s.id, 'resume')}>Resume</button>
                  )}
                  {' '}
                  <button className="danger" onClick={() => setDeleteId(s.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {deleteId !== null && (
        <ConfirmationModal title="Delete this schedule?" actionLabel="Delete"
          onCancel={() => setDeleteId(null)} onConfirm={() => handleDelete(deleteId)} />
      )}
    </div>
  );
}

function CreateScheduleForm({ agentId, onSuccess, onError }: {
  agentId: string;
  onSuccess: () => void;
  onError: (e: string) => void;
}) {
  const [asset, setAsset] = useState('XLM');
  const [issuer, setIssuer] = useState('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [scheduleExpression, setScheduleExpression] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ destination?: string; issuer?: string; expression?: string }>({});
  const cronHelpId = useId();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;

    setError(null);
    const nextFieldErrors: { destination?: string; issuer?: string; expression?: string } = {};
    const destErr = validateStellarAddressField(destination, 'Destination');
    if (destErr) nextFieldErrors.destination = destErr;
    if (asset !== 'XLM') {
      const issuerErr = validateStellarAddressField(issuer, 'Asset issuer');
      if (issuerErr) nextFieldErrors.issuer = issuerErr;
    }
    const cronCheck = validateCronExpressionShape(scheduleExpression);
    if (!cronCheck.valid) nextFieldErrors.expression = cronCheck.error;

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      return;
    }
    setFieldErrors({});
    setSaving(true);

    const intent: SubmitPaymentIntent = {
      type: 'payment',
      asset: asset === 'XLM' ? 'XLM' : asset,
      // A non-native payment needs its issuer to build a Stellar transaction;
      // without assetDetails the schedule would fail on every run.
      ...(asset !== 'XLM' ? { assetDetails: { code: asset, issuer } } : {}),
      destination,
      amount,
      reason,
    };

    try {
      await api.createSchedule(agentId, {
        intent,
        scheduleExpression,
        timezone,
      });
      onSuccess();
    } catch (e: any) {
      const msg = describeApiError(e, 'Failed to create schedule');
      setError(msg);
      onError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="schedule-create-form">
      {error && <div className="error" role="alert">{error}</div>}

      <h4>New Recurring Schedule</h4>
      <p className="muted">This will create a recurring payment that executes automatically. All scheduled executions are subject to policy enforcement and approval workflows.</p>

      <div className="form-grid">
        <label>
          <span>Asset</span>
          <select id="schedule-asset" value={asset} onChange={(e) => setAsset(e.target.value)} aria-label="Asset">
            <option value="XLM">XLM (native)</option>
            <option value="USDC">USDC</option>
            <option value="BTC">BTC</option>
          </select>
        </label>
        {asset !== 'XLM' && (
          <label>
            <span>Asset Issuer (G...)</span>
            <input
              id="schedule-issuer"
              type="text"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="G... (asset issuer)"
              required
              aria-label="Asset Issuer (G...)"
              aria-invalid={Boolean(fieldErrors.issuer)}
            />
            {fieldErrors.issuer && <div className="field-error error" role="alert" data-testid="schedule-issuer-error">{fieldErrors.issuer}</div>}
          </label>
        )}
        <label>
          <span>Amount</span>
          <input
            id="schedule-amount"
            type="number"
            step="0.0000001"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="10"
            required
            aria-label="Amount"
          />
        </label>
        <label>
          <span>Destination (G...)</span>
          <input
            id="schedule-destination"
            type="text"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="G..."
            required
            aria-label="Destination (G...)"
            aria-invalid={Boolean(fieldErrors.destination)}
          />
          {fieldErrors.destination && <div className="field-error error" role="alert" data-testid="schedule-destination-error">{fieldErrors.destination}</div>}
        </label>
        <label>
          <span>Reason</span>
          <input
            id="schedule-reason"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Recurring payment"
            minLength={3}
            required
            aria-label="Reason"
          />
        </label>
      </div>

      <label className="full-width">
        <span>Schedule (cron expression)</span>
        <input
          id="schedule-expression"
          type="text"
          value={scheduleExpression}
          onChange={(e) => setScheduleExpression(e.target.value)}
          placeholder="0 0 * * * (minute hour day-of-month month day-of-week)"
          required
          aria-describedby={cronHelpId}
          aria-invalid={Boolean(fieldErrors.expression)}
        />
        <small id={cronHelpId}>5-field cron expression: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-6, 0=Sunday)</small>
        {fieldErrors.expression && <div className="field-error error" role="alert" data-testid="schedule-expression-error">{fieldErrors.expression}</div>}
      </label>

      <div className="cron-presets">
        <span className="muted">Presets:</span>
        {CRON_PRESETS.map((preset) => (
          <button
            key={preset.expression}
            type="button"
            className="preset-btn"
            onClick={() => setScheduleExpression(preset.expression)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="form-grid">
        <label>
          <span>Timezone</span>
          <select id="schedule-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} aria-label="Timezone">
            {SUPPORTED_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="form-actions">
        <button type="button" onClick={onSuccess} disabled={saving}>Cancel</button>
        <button type="submit" disabled={saving}>
          {saving ? 'Creating...' : 'Create Schedule'}
        </button>
      </div>
    </form>
  );
}

function ScheduleStatusBadge({ status }: { status: string }) {
  const cls = status === 'active' ? 'badge-ok'
    : status === 'paused' ? 'badge-warn'
    : 'badge-err';
  return <span className={'badge ' + cls}>{status}</span>;
}