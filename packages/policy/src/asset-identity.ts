/**
 * Canonical asset identities for policy configuration, enforcement, and
 * reporting.
 *
 * Policy limits and allowlists are keyed by strings that clients can produce.
 * The same asset must resolve to the same key regardless of whether an intent
 * carries structured `assetDetails` or only an `asset` string.
 *
 * Canonical forms:
 * - native XLM: `XLM`
 * - issued payment asset: `CODE:ISSUER`
 * - trustline: `trustline:CODE:ISSUER`
 */

import type { AgentIntent, AssetDetails } from "@4evergent/shared";

const ASSET_CODE_PATTERN = /^[A-Za-z0-9_]{1,12}$/;
const STELLAR_ACCOUNT_PATTERN = /^G[A-Z2-7]{55}$/;
const CANONICAL_ASSET_PATTERN = /^([A-Za-z0-9_]{1,12}):(G[A-Z2-7]{55})$/;
const CANONICAL_TRUSTLINE_PATTERN = /^trustline:([A-Za-z0-9_]{1,12}):(G[A-Z2-7]{55})$/;

export const NATIVE_ASSET_IDENTITY = "XLM";

/** Build the canonical identity for an issued asset. */
export function canonicalAssetIdentity(code: string, issuer: string): string {
  return `${code}:${issuer}`;
}

/** Build the canonical identity for a trustline. */
export function canonicalTrustlineIdentity(code: string, issuer: string): string {
  return `trustline:${code}:${issuer}`;
}

/** Whether `key` is `XLM` or `CODE:ISSUER` with a valid code and issuer. */
export function isCanonicalAssetIdentity(key: string): boolean {
  if (key === NATIVE_ASSET_IDENTITY) return true;
  const match = CANONICAL_ASSET_PATTERN.exec(key);
  return match !== null && ASSET_CODE_PATTERN.test(match[1]);
}

/** Whether `key` is `trustline:CODE:ISSUER` with a valid code and issuer. */
export function isCanonicalTrustlineIdentity(key: string): boolean {
  return CANONICAL_TRUSTLINE_PATTERN.test(key);
}

/** Whether `key` is a canonical `maxTxAmount` / `dailySpendingLimit` key. */
export function isCanonicalPolicyLimitKey(key: string): boolean {
  // `native` remains a legacy fallback lookup key for existing policies.
  return key === "native" || isCanonicalAssetIdentity(key);
}

/** Whether `key` is a canonical `allowedAssets` entry. */
export function isCanonicalAllowedAsset(key: string): boolean {
  return isCanonicalAssetIdentity(key) || isCanonicalTrustlineIdentity(key);
}

function fromAssetDetails(details: AssetDetails): string | null {
  if (details.type === "native") return NATIVE_ASSET_IDENTITY;
  const { code, issuer } = details;
  if (typeof code !== "string" || typeof issuer !== "string") return null;
  if (!ASSET_CODE_PATTERN.test(code) || !STELLAR_ACCOUNT_PATTERN.test(issuer)) return null;
  return canonicalAssetIdentity(code, issuer);
}

function fromAssetString(
  asset: string,
  trustline: boolean,
  policyAssetKeys: readonly string[],
): string | null {
  if (asset === "native" || asset === NATIVE_ASSET_IDENTITY) {
    return trustline ? null : NATIVE_ASSET_IDENTITY;
  }

  const assetMatch = CANONICAL_ASSET_PATTERN.exec(asset);
  if (assetMatch) {
    return trustline
      ? canonicalTrustlineIdentity(assetMatch[1], assetMatch[2])
      : canonicalAssetIdentity(assetMatch[1], assetMatch[2]);
  }

  // A bare code has no issuer. Resolve it only when the policy names exactly
  // one issuer for that code; otherwise the caller must deny the intent rather
  // than let it bypass per-asset limits.
  if (ASSET_CODE_PATTERN.test(asset)) {
    const issuers = new Set<string>();
    for (const key of policyAssetKeys) {
      const match = CANONICAL_ASSET_PATTERN.exec(key);
      if (match && match[1] === asset) issuers.add(match[2]);
    }
    if (issuers.size === 1) {
      const [issuer] = issuers;
      return trustline
        ? canonicalTrustlineIdentity(asset, issuer)
        : canonicalAssetIdentity(asset, issuer);
    }
  }

  return null;
}

/**
 * Resolve an intent to the canonical asset key used by policy limits.
 *
 * Returns `null` when the intent carries no asset (contract calls and account
 * settings), or when an asset-bearing intent cannot be resolved unambiguously.
 */
export function extractAssetIdentity(
  intent: AgentIntent,
  policyAssetKeys: readonly string[] = [],
): string | null {
  if (intent.type === "contract_call" || intent.type === "account_settings") {
    return null;
  }

  const trustline = intent.type === "trustline";

  if (intent.assetDetails) {
    const identity = fromAssetDetails(intent.assetDetails);
    if (!identity) return null;
    return trustline && identity !== NATIVE_ASSET_IDENTITY
      ? `trustline:${identity}`
      : identity;
  }

  if (typeof intent.asset === "string" && intent.asset.length > 0) {
    return fromAssetString(intent.asset, trustline, policyAssetKeys);
  }

  // A payment with no asset fields is a native XLM payment (the shared type
  // defaults `asset` to `XLM`). A trustline with no asset fields is invalid.
  return trustline ? null : NATIVE_ASSET_IDENTITY;
}
