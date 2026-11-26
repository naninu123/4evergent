import type { AgentIntent } from "@4evergent/shared";
import { StrKey } from "@stellar/stellar-sdk";

/**
 * Stellar asset codes are 1-12 characters from `[A-Za-z0-9_]` — the same
 * constraint `new Asset(...)` enforces at build time. Anything outside that
 * set is rejected here so the pipeline fails fast with a validation error
 * instead of a construction error.
 */
function isValidAssetCode(code: string): boolean {
  return /^[A-Za-z0-9_]{1,12}$/.test(code);
}

/**
 * A Stellar account address is a 56-character StrKey-encoded ed25519 public
 * key — length and `G` prefix alone are not enough, the checksum must verify.
 * `StrKey.isValidEd25519PublicKey` checks all three.
 */
function isValidStellarAccount(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

export class IntentValidator {
  static readonly VALID_ASSETS = ["XLM"];
  static readonly MAX_AMOUNT = "1000000";

  static validate(intent: AgentIntent): { valid: boolean; error?: string } {
    switch (intent.type) {
      case "payment":
        return validatePayment(intent);
      case "trustline":
        return validateTrustline(intent);
      case "contract_call":
        return validateContractCall(intent);
      case "account_settings":
        return validateAccountSettings(intent);
      default:
        return { valid: false, error: `Unknown intent type: ${(intent as { type: string }).type}` };
    }
  }
}

function parseAsset(intent: AgentIntent): { code: string; issuer: string | null } | null {
  if (intent.type !== "payment") return null;
  if (intent.assetDetails) {
    if (!intent.assetDetails.code || !isValidAssetCode(intent.assetDetails.code)) return null;
    if (intent.assetDetails.code === "XLM") {
      return { code: "XLM", issuer: null };
    }
    if (!intent.assetDetails.issuer || !isValidStellarAccount(intent.assetDetails.issuer)) return null;
    return { code: intent.assetDetails.code, issuer: intent.assetDetails.issuer };
  }
  if (intent.asset === "XLM") return { code: "XLM", issuer: null };
  return null;
}

function validatePayment(intent: AgentIntent): { valid: boolean; error?: string } {
  if (intent.type !== "payment") return { valid: false, error: "not a payment" };
  if (!intent.amount || isNaN(parseFloat(intent.amount)) || parseFloat(intent.amount) <= 0) {
    return { valid: false, error: "amount must be a positive number" };
  }
  if (!intent.destination || !isValidStellarAccount(intent.destination)) {
    return { valid: false, error: "destination must be a valid Stellar account (G...)" };
  }
  if (parseFloat(intent.amount) > parseFloat(IntentValidator.MAX_AMOUNT)) {
    return { valid: false, error: "amount exceeds global maximum" };
  }
  const asset = parseAsset(intent);
  if (!asset) {
    return { valid: false, error: "asset must be XLM or specify assetDetails with code + issuer" };
  }
  if (!intent.reason || intent.reason.length < 3) {
    return { valid: false, error: "reason must be at least 3 characters" };
  }
  return { valid: true };
}

function validateTrustline(intent: AgentIntent): { valid: boolean; error?: string } {
  if (intent.type !== "trustline") return { valid: false, error: "not a trustline" };
  if (!intent.assetCode || intent.assetCode.length < 1) {
    return { valid: false, error: "assetCode required" };
  }
  if (intent.assetCode === "XLM") {
    return { valid: false, error: "XLM is native and cannot be used as a trustline" };
  }
  if (!isValidAssetCode(intent.assetCode)) {
    return { valid: false, error: "assetCode must be 1-12 alphanumeric characters (A-Z, a-z, 0-9, _)" };
  }
  if (!intent.issuer || !isValidStellarAccount(intent.issuer)) {
    return { valid: false, error: "issuer must be a valid Stellar account" };
  }
  if (intent.limit !== undefined) {
    if (isNaN(parseFloat(intent.limit)) || parseFloat(intent.limit) < 0) {
      return { valid: false, error: "limit must be a non-negative number" };
    }
  }
  return { valid: true };
}

/**
 * A Stellar contract address is a 56-character StrKey-encoded C... address
 * with a valid checksum. StrKey.isValidContract checks all three.
 */
function isValidStellarContract(address: string): boolean {
  return typeof address === "string" && StrKey.isValidContract(address);
}

function validateContractCall(intent: AgentIntent): { valid: boolean; error?: string } {
  if (intent.type !== "contract_call") return { valid: false, error: "not a contract_call" };
  if (!intent.contractId || !isValidStellarContract(intent.contractId)) {
    return { valid: false, error: "contractId must be a valid Stellar contract address (C...)" };
  }
  if (!intent.function || intent.function.length < 1) {
    return { valid: false, error: "function required" };
  }
  if (!intent.reason || intent.reason.length < 3) {
    return { valid: false, error: "reason required" };
  }
  return { valid: true };
}

function validateAccountSettings(intent: AgentIntent): { valid: boolean; error?: string } {
  if (intent.type !== "account_settings") return { valid: false, error: "not account_settings" };
  if (!intent.setting) {
    return { valid: false, error: "setting field required" };
  }
  return { valid: true };
}
