import type { AgentIntent, PolicyRules } from "@4evergent/shared";

/**
 * Canonical policy asset identities (#367).
 *
 * One asset must produce one key everywhere policy is written, enforced, or
 * reported:
 *
 * - native XLM: `XLM`
 * - issued asset: `CODE:ISSUER` (for example `USDC:G...`)
 * - trustline limit key: `trustline:CODE:ISSUER`
 *
 * `native` is kept as a legacy fallback *lookup* key in `maxTxAmount` and
 * `dailySpendingLimit`; it is not an asset identity and is never matched by a
 * `contract_call` or `account_settings` intent. Those intents carry no asset,
 * so asset-scoped checks (including `allowedAssets`) do not apply to them.
 */
export const NATIVE_ASSET_IDENTITY = "XLM";
export const NATIVE_FALLBACK_KEY = "native";
const TRUSTLINE_PREFIX = "trustline:";

const ASSET_CODE_PATTERN = /^[A-Za-z0-9_]{1,12}$/;
// StrKey-encoded ed25519 public key: version byte 'G' + 55 base32 characters.
const ISSUER_PATTERN = /^G[A-Z2-7]{55}$/;

/** Build the canonical identity for an asset, or `null` if it is malformed. */
export function canonicalAssetIdentity(
  code: string | null | undefined,
  issuer: string | null | undefined
): string | null {
  if (code === NATIVE_ASSET_IDENTITY) return NATIVE_ASSET_IDENTITY;
  if (!code || !ASSET_CODE_PATTERN.test(code)) return null;
  if (!issuer || !ISSUER_PATTERN.test(issuer)) return null;
  return `${code}:${issuer}`;
}

/** True when `value` is `XLM` or a canonical `CODE:ISSUER` identity. */
export function isCanonicalAssetIdentity(value: string): boolean {
  if (value === NATIVE_ASSET_IDENTITY) return true;
  const separator = value.indexOf(":");
  if (separator <= 0) return false;
  const code = value.slice(0, separator);
  const issuer = value.slice(separator + 1);
  return canonicalAssetIdentity(code, issuer) === value;
}

/** True when `value` is a canonical `trustline:CODE:ISSUER` limit key. */
export function isCanonicalTrustlineIdentity(value: string): boolean {
  if (!value.startsWith(TRUSTLINE_PREFIX)) return false;
  const asset = value.slice(TRUSTLINE_PREFIX.length);
  if (asset === NATIVE_ASSET_IDENTITY) return false;
  return isCanonicalAssetIdentity(asset);
}

/** True for keys accepted in `maxTxAmount` / `dailySpendingLimit`. */
export function isCanonicalPolicyLimitKey(value: string): boolean {
  return (
    value === NATIVE_FALLBACK_KEY ||
    isCanonicalAssetIdentity(value) ||
    isCanonicalTrustlineIdentity(value)
  );
}

/** True for entries accepted in `allowedAssets`. */
export function isCanonicalAllowedAsset(value: string): boolean {
  return isCanonicalAssetIdentity(value) || isCanonicalTrustlineIdentity(value);
}

/**
 * Resolve the canonical asset identity an intent is checked against.
 *
 * Returns `null` for intents that carry no asset (`contract_call`,
 * `account_settings`) and for payments whose non-native asset cannot be
 * identified. A payment without `assetDetails` can still be canonicalized:
 * either its `asset` field is already `CODE:ISSUER`, or the policy names
 * exactly one issuer for that bare code. Anything ambiguous is rejected by the
 * engine rather than silently bypassing per-asset limits (#367).
 */
export function extractAssetIdentity(
  intent: AgentIntent,
  rules?: Partial<PolicyRules>
): string | null {
  if (intent.type === "payment") {
    if (intent.assetDetails) {
      return canonicalAssetIdentity(intent.assetDetails.code, intent.assetDetails.issuer);
    }
    if (intent.asset === NATIVE_ASSET_IDENTITY) return NATIVE_ASSET_IDENTITY;
    if (isCanonicalAssetIdentity(intent.asset)) return intent.asset;
    return resolveBareAssetCode(intent.asset, rules);
  }
  if (intent.type === "trustline") {
    const asset = canonicalAssetIdentity(intent.assetCode, intent.issuer);
    return asset === null ? null : `${TRUSTLINE_PREFIX}${asset}`;
  }
  return null;
}

/**
 * A bare non-native code has no issuer of its own. It is only resolvable when
 * the policy names exactly one canonical issuer for that code; otherwise the
 * payment is ambiguous and the engine denies it instead of letting it bypass
 * the per-asset configuration.
 */
function resolveBareAssetCode(
  code: string,
  rules?: Partial<PolicyRules>
): string | null {
  if (!rules || !ASSET_CODE_PATTERN.test(code)) return null;

  const candidates = new Set<string>();
  const collect = (key: string) => {
    if (!key.startsWith(`${code}:`)) return;
    const issuer = key.slice(code.length + 1);
    if (canonicalAssetIdentity(code, issuer) === key) candidates.add(key);
  };

  for (const key of Object.keys(rules.maxTxAmount ?? {})) collect(key);
  for (const key of Object.keys(rules.dailySpendingLimit ?? {})) collect(key);
  for (const key of rules.allowedAssets ?? []) collect(key);

  return candidates.size === 1 ? [...candidates][0]! : null;
}
