/**
 * Policy engine: evaluates an agent intent against its policy rules and
 * reserves daily spending when the intent is allowed.
 *
 * Asset-bearing intents are resolved to the canonical identity from
 * `asset-identity.ts` before limits and allowlists are applied, so the same
 * asset is capped regardless of whether the intent carries `assetDetails`.
 */

import type { AgentIntent, PolicyRules } from "@4evergent/shared";
import type { DailySpendingStore } from "@4evergent/shared";
import {
  extractAssetIdentity,
  isCanonicalAssetIdentity,
  isCanonicalTrustlineIdentity,
} from "./asset-identity.js";

export interface PolicyEvaluationResult {
  allowed: boolean;
  requiresApproval: boolean;
  reasons: string[];
}

export interface PolicyEngineDeps {
  dailySpending: DailySpendingStore;
  now?: () => Date;
}

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function parseAmount(value: string): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function formatAmount(value: number): string {
  return String(value);
}

/**
 * Resolve an intent's asset to the canonical key used by policy limits.
 * Kept as a named export for callers that need the same identity mapping.
 */
export { extractAssetIdentity } from "./asset-identity.js";

function policyAssetKeys(rules: PolicyRules): string[] {
  return [
    ...Object.keys(rules.maxTxAmount),
    ...Object.keys(rules.dailySpendingLimit),
    ...rules.allowedAssets,
  ];
}

function limitFor(map: Record<string, string>, identity: string): string | undefined {
  if (map[identity] !== undefined) return map[identity];
  // `native` is a legacy fallback key, accepted only for limits. It is not an
  // asset identity and is never used for allowlist matching.
  if (identity === "XLM" && map.native !== undefined) return map.native;
  return undefined;
}

function allowsAsset(rules: PolicyRules, identity: string): boolean {
  if (rules.allowedAssets.length === 0) return true;
  if (rules.allowedAssets.includes(identity)) return true;
  // A policy may allow the payment identity (`CODE:ISSUER`) and still receive
  // the trustline identity (`trustline:CODE:ISSUER`) for the same asset.
  if (isCanonicalTrustlineIdentity(identity)) {
    return rules.allowedAssets.includes(identity.slice("trustline:".length));
  }
  return false;
}

function describeAsset(identity: string): string {
  if (identity === "XLM") return "XLM";
  if (isCanonicalTrustlineIdentity(identity)) return `trustline ${identity.slice("trustline:".length)}`;
  return identity;
}

export function evaluatePolicy(
  rules: PolicyRules,
  intent: AgentIntent,
  deps: PolicyEngineDeps,
): Promise<PolicyEvaluationResult> {
  return evaluatePolicySync(rules, intent, deps);
}

async function evaluatePolicySync(
  rules: PolicyRules,
  intent: AgentIntent,
  deps: PolicyEngineDeps,
): Promise<PolicyEvaluationResult> {
  const reasons: string[] = [];
  const now = deps.now ? deps.now() : new Date();
  const amount = parseAmount(intent.amount);
  const assetIdentity = extractAssetIdentity(intent, policyAssetKeys(rules));

  if (!rules.txTypeRestrictions[intent.type]) {
    reasons.push(`transaction type '${intent.type}' is not allowed by policy`);
  }

  if (intent.type === "contract_call") {
    if (rules.allowedContractIds.length > 0 && !rules.allowedContractIds.includes(intent.contractId)) {
      reasons.push(`contract '${intent.contractId}' is not in allowedContractIds`);
    }
  }

  if (intent.type === "payment" && rules.allowedDestinations.length > 0) {
    if (!rules.allowedDestinations.includes(intent.destination)) {
      reasons.push(`destination '${intent.destination}' is not in allowedDestinations`);
    }
  }

  // Contract calls and account settings carry no asset. Payments and trustlines
  // must resolve to a canonical identity; an unresolved asset-bearing intent is
  // denied rather than skipping the per-asset checks.
  const assetBearing = intent.type === "payment" || intent.type === "trustline";
  if (assetBearing && assetIdentity === null) {
    reasons.push(`asset '${intent.asset}' could not be resolved to a canonical asset identity`);
  }

  if (assetIdentity !== null) {
    const display = describeAsset(assetIdentity);

    if (!allowsAsset(rules, assetIdentity)) {
      reasons.push(`asset '${display}' is not in allowedAssets`);
    }

    const maxTx = limitFor(rules.maxTxAmount, assetIdentity);
    if (maxTx !== undefined) {
      const limit = parseAmount(maxTx);
      if (limit === null || amount === null || amount > limit) {
        reasons.push(
          `amount ${intent.amount} exceeds maxTxAmount for ${display} (${maxTx})`,
        );
      }
    }

    const dailyLimit = limitFor(rules.dailySpendingLimit, assetIdentity);
    if (dailyLimit !== undefined) {
      const limit = parseAmount(dailyLimit);
      if (limit === null || amount === null) {
        reasons.push(`invalid dailySpendingLimit for ${display}`);
      } else {
        const day = todayUtc(now);
        const used = deps.dailySpending.get(intent.agentId, day, assetIdentity);
        const remaining = limit - used;
        if (amount > remaining) {
          reasons.push(
            `amount ${intent.amount} exceeds remaining dailySpendingLimit for ${display} (${formatAmount(remaining)} of ${dailyLimit})`,
          );
        }
      }
    }
  }

  const allowed = reasons.length === 0;

  let requiresApproval = false;
  if (allowed) {
    const threshold = parseAmount(rules.requireHumanApprovalForAmountAbove);
    if (threshold !== null && amount !== null && amount >= threshold) {
      requiresApproval = true;
    }
  }

  if (allowed && assetIdentity !== null) {
    const dailyLimit = limitFor(rules.dailySpendingLimit, assetIdentity);
    if (dailyLimit !== undefined) {
      await deps.dailySpending.reserve({
        agentId: intent.agentId,
        day: todayUtc(now),
        asset: assetIdentity,
        amount: amount ?? 0,
        intentId: intent.id,
      });
    }
  }

  return { allowed, requiresApproval, reasons };
}

/** Whether a limit or allowlist key is a valid canonical asset identity. */
export function isCanonicalPolicyAssetKey(key: string): boolean {
  return isCanonicalAssetIdentity(key) || isCanonicalTrustlineIdentity(key);
}
