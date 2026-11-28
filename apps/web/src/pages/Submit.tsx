import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { describeApiError } from '../apiErrors';
import type { SubmitPaymentIntent } from '../types';
import {
  isValidStellarAddress,
  validateAssetCodeField,
  validateStellarAddressField,
} from '../validation';

interface SubmitResult {
  agentId: string;
  activityId: string;
  approvalId?: string;
  status: string;
}

interface SubmitFailure {
  message: string;
  agentId: string;
  activityId?: string;
  policyDecision?: {
    result: string;
    reason: string;
    rule: string;
  };
}

interface SubmitFieldErrors {
  assetCode?: string;
  issuer?: string;
  destination?: string;
  trustlineAssetCode?: string;
  trustlineIssuer?: string;
}

export default function Submit() {
  const [agents, setAgents] = useState<{ id: string; displayName: string }[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [intentType, setIntentType] = useState<'payment' | 'trustline'>('payment');
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [assetCode, setAssetCode] = useState<'XLM' | 'USDC' | 'BTC' | 'other'>('XLM');
  const [otherAssetCode, setOtherAssetCode] = useState('');
  const [issuer, setIssuer] = useState('');
  const [trustlineAssetCode, setTrustlineAssetCode] = useState('');
  const [trustlineIssuer, setTrustlineIssuer] = useState('');
  const [trustlineLimit, setTrustlineLimit] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<SubmitFieldErrors>({});
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const getOrCreateIdempotencyKey = (agentId: string, intent: unknown): string => {
    const fingerprint = JSON.stringify({ agentId, intent });
    if (attemptRef.current && attemptRef.current.fingerprint === fingerprint) {
      return attemptRef.current.key;
    }
    const key = crypto.randomUUID();
    attemptRef.current = { fingerprint, key };
    return key;
  };

  useEffect(() => {
    api.listAllAgents()
      .then((a) => {
        setAgents(a.agents.map((x) => ({ id: x.id, displayName: x.displayName })));
        if (a.agents.length > 0) setSelectedAgent(a.agents[0]!.id);
      })
      .catch((e: any) => setError(describeApiError(e, 'Failed to load agents')));
  }, []);

  const handleFailure = (agentId: string, e: any) => {
    if (e instanceof ApiError && e.responseBody && typeof e.responseBody === 'object') {
      const body = e.responseBody as any;
      if (body.activityId) {
        setFailure({
          message: describeApiError(e, 'Failed to submit intent'),
          agentId,
          activityId: body.activityId,
          policyDecision: body.policyDecision,
        });
        return;
      }
    }
    setError(describeApiError(e, 'Failed to submit intent'));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setFieldErrors({});
    setFailure(null);
    setResult(null);
    if (!selectedAgent) return setError('Select an agent');
    if (!reason || reason.length < 3) return setError('Reason must be at least 3 characters');

    if (intentType === 'payment') {
      if (!amount || parseFloat(amount) <= 0) {
        return setError('Amount must be positive');
      }
      const nextErrors: SubmitFieldErrors = {};
      if (assetCode === 'other') {
        const assetErr = validateAssetCodeField(otherAssetCode, 'Custom asset code');
        if (assetErr) nextErrors.assetCode = assetErr;
      }
      if (assetCode !== 'XLM' && issuer.trim() !== '' && !isValidStellarAddress(issuer)) {
        nextErrors.issuer = 'Issuer must be a 56-character Stellar G... public key (base32 A-Z, 2-7)';
      }
      const destErr = validateStellarAddressField(destination, 'Destination');
      if (destErr) nextErrors.destination = destErr;

      if (Object.keys(nextErrors).length > 0) {
        setFieldErrors(nextErrors);
        return;
      }

      setLoading(true);
      const isNativeXLM = assetCode === 'XLM';
      const actualAssetCode = assetCode === 'other' ? otherAssetCode.trim() : assetCode;
      const trimmedIssuer = issuer.trim();
      const intent: SubmitPaymentIntent = {
        type: 'payment',
        asset: actualAssetCode === 'XLM' ? 'XLM' : actualAssetCode,
        ...((!isNativeXLM && trimmedIssuer) ? { assetDetails: { code: actualAssetCode, issuer: trimmedIssuer } } : {}),
        destination: destination.trim(),
        amount,
        reason,
      };
      const idempotencyKey = getOrCreateIdempotencyKey(selectedAgent, intent);
      api.submitPayment(selectedAgent, intent, idempotencyKey)
        .then((r) => {
          attemptRef.current = null;
          setResult({ agentId: r.agentId || selectedAgent, activityId: r.activityId, approvalId: r.approvalId, status: r.status });
        })
        .catch((e: any) => handleFailure(selectedAgent, e))
        .finally(() => setLoading(false));
    } else {
      const nextErrors: SubmitFieldErrors = {};
      const tlCodeErr = validateAssetCodeField(trustlineAssetCode, 'Trustline asset code');
      if (tlCodeErr) {
        nextErrors.trustlineAssetCode = tlCodeErr;
      } else if (trustlineAssetCode.trim() === 'XLM') {
        nextErrors.trustlineAssetCode = 'XLM is native — use payment instead';
      }
      const tlIssuerErr = validateStellarAddressField(trustlineIssuer, 'Trustline issuer');
      if (tlIssuerErr) nextErrors.trustlineIssuer = tlIssuerErr;

      if (Object.keys(nextErrors).length > 0) {
        setFieldErrors(nextErrors);
        return;
      }

      setLoading(true);
      const intent = {
        type: 'trustline' as const,
        assetCode: trustlineAssetCode.trim(),
        issuer: trustlineIssuer.trim(),
        limit: trustlineLimit || undefined,
        reason,
      };
      const idempotencyKey = getOrCreateIdempotencyKey(selectedAgent, intent);
      api.submitTrustline(selectedAgent, intent, idempotencyKey)
        .then((r) => {
          attemptRef.current = null;
          setResult({ agentId: r.agentId || selectedAgent, activityId: r.activityId, approvalId: r.approvalId, status: r.status });
        })
        .catch((e: any) => handleFailure(selectedAgent, e))
        .finally(() => setLoading(false));
    }
  };

  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Submit Intent</h1>
          <p className="muted">Create a new intent for an agent to execute.</p>
        </div>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {failure && (
        <div
          className="error-banner"
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-sm)',
            flexWrap: 'wrap',
          }}
        >
          <span>
            {failure.policyDecision?.reason || failure.message}
            {failure.activityId ? `. Activity: ${failure.activityId}` : ''}
          </span>
          {failure.activityId && (
            <Link
              to={`/agents/${encodeURIComponent(failure.agentId)}/activity/${encodeURIComponent(failure.activityId)}`}
              className="btn btn-ghost btn-sm"
              style={{ flex: '0 0 auto' }}
            >
              View activity
            </Link>
          )}
        </div>
      )}
      {result && (
        <div
          className="success-banner"
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-sm)',
            flexWrap: 'wrap',
          }}
        >
          <span>
            Intent submitted. Activity: {result.activityId}
            {result.approvalId ? `, Approval: ${result.approvalId}` : ''}. Status: {result.status}
          </span>
          {result.activityId && (
            <Link
              to={`/agents/${encodeURIComponent(result.agentId)}/activity/${encodeURIComponent(result.activityId)}`}
              className="btn btn-ghost btn-sm"
              style={{ flex: '0 0 auto' }}
            >
              View activity
            </Link>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} onReset={() => { attemptRef.current = null; setFieldErrors({}); }} className="surface" style={{ maxWidth: '500px' }}>
        <div className="field">
          <label htmlFor="intent-type">Intent Type</label>
          <select id="intent-type" value={intentType} onChange={(e) => { setIntentType(e.target.value as any); setFieldErrors({}); }} className="select">
            <option value="payment">Payment</option>
            <option value="trustline">Trustline</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="agent-select">Agent</label>
          <select id="agent-select" value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)} className="select">
            {agents.map((a) => <option key={a.id} value={a.id}>{a.displayName || a.id}</option>)}
          </select>
        </div>

        {intentType === 'payment' ? (
          <>
            <div className="field">
              <label htmlFor="asset">Asset</label>
              <select id="asset" value={assetCode} onChange={(e) => { setAssetCode(e.target.value as "XLM" | "USDC" | "BTC" | "other"); setFieldErrors((p) => ({ ...p, assetCode: undefined, issuer: undefined })); }} className="select">
                <option value="XLM">XLM (native)</option>
                <option value="USDC">USDC</option>
                <option value="BTC">BTC</option>
                <option value="other">Other (specify)</option>
              </select>
            </div>
            {assetCode === 'other' && (
              <div className="field">
                <label htmlFor="asset-code">Asset Code</label>
                <input id="asset-code" type="text" value={otherAssetCode} onChange={(e) => setOtherAssetCode(e.target.value)} placeholder="e.g. USDC" className="input" aria-describedby="asset-code-hint" aria-invalid={Boolean(fieldErrors.assetCode)} />
                <div id="asset-code-hint" className="field-hint">Enter the asset code (1-12 characters), e.g. USDC.</div>
                {fieldErrors.assetCode && <div className="field-error error" role="alert" data-testid="asset-code-error">{fieldErrors.assetCode}</div>}
              </div>
            )}
            {assetCode !== 'XLM' && (
              <div className="field">
                <label htmlFor="issuer">Issuer (Stellar G...)</label>
                <input id="issuer" type="text" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="G..." className="input" aria-invalid={Boolean(fieldErrors.issuer)} />
                {fieldErrors.issuer && <div className="field-error error" role="alert" data-testid="issuer-error">{fieldErrors.issuer}</div>}
              </div>
            )}
            <div className="field">
              <label htmlFor="amount">Amount</label>
              <input id="amount" type="number" step="0.0000001" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="input" />
            </div>
            <div className="field">
              <label htmlFor="destination">Destination (Stellar G...)</label>
              <input id="destination" type="text" value={destination} onChange={(e) => setDestination(e.target.value)} className="input" aria-invalid={Boolean(fieldErrors.destination)} />
              {fieldErrors.destination && <div className="field-error error" role="alert" data-testid="destination-error">{fieldErrors.destination}</div>}
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="tl-asset-code">Asset Code</label>
              <input id="tl-asset-code" type="text" value={trustlineAssetCode} onChange={(e) => setTrustlineAssetCode(e.target.value)} placeholder="e.g. USDC" className="input" aria-invalid={Boolean(fieldErrors.trustlineAssetCode)} />
              {fieldErrors.trustlineAssetCode && <div className="field-error error" role="alert" data-testid="tl-asset-code-error">{fieldErrors.trustlineAssetCode}</div>}
            </div>
            <div className="field">
              <label htmlFor="tl-issuer">Issuer (Stellar G...)</label>
              <input id="tl-issuer" type="text" value={trustlineIssuer} onChange={(e) => setTrustlineIssuer(e.target.value)} placeholder="G..." className="input" aria-invalid={Boolean(fieldErrors.trustlineIssuer)} />
              {fieldErrors.trustlineIssuer && <div className="field-error error" role="alert" data-testid="tl-issuer-error">{fieldErrors.trustlineIssuer}</div>}
            </div>
            <div className="field">
              <label htmlFor="tl-limit">Trustline Limit (optional)</label>
              <input id="tl-limit" type="number" step="0.0000001" min="0" value={trustlineLimit} onChange={(e) => setTrustlineLimit(e.target.value)} placeholder="No limit" className="input" />
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="reason">Reason</label>
          <input id="reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Monthly payment" className="input" aria-describedby="reason-hint" />
          <div id="reason-hint" className="field-hint">Minimum 3 characters. Describes the purpose of this intent.</div>
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Submitting...' : 'Submit Intent'}</button>
        </div>
      </form>
    </section>
  );
}
