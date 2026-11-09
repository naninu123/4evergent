import type { AgentIntent } from "@4evergent/shared";

const ASSET_CODE_REGEX = /^[A-Za-z0-9_]{1,12}$/;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ED25519_PUBLIC_KEY_VERSION_BYTE = 6 << 3; // 48 ('G')

export function isValidEd25519PublicKey(value: string): boolean {
  if (typeof value !== "string" || value.length !== 56 || !value.startsWith("G")) {
    return false;
  }

  const decoded = new Uint8Array(35);
  let buffer = 0;
  let bitsLeft = 0;
  let byteIndex = 0;

  for (let i = 0; i < 56; i++) {
    const val = BASE32_ALPHABET.indexOf(value[i]!);
    if (val === -1) {
      return false;
    }
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      decoded[byteIndex++] = (buffer >>> bitsLeft) & 0xff;
      buffer &= (1 << bitsLeft) - 1;
    }
  }

  if (byteIndex !== 35 || decoded[0] !== ED25519_PUBLIC_KEY_VERSION_BYTE) {
    return false;
  }

  let crc = 0x0000;
  for (let i = 0; i < 33; i++) {
    let code = (crc >>> 8) & 0xff;
    code ^= decoded[i]!;
    code ^= code >>> 4;
    crc = (crc << 8) & 0xffff;
    crc ^= code;
    code = (code << 5) & 0xffff;
    crc ^= code;
    code = (code << 7) & 0xffff;
    crc ^= code;
  }

  const expectedLow = crc & 0xff;
  const expectedHigh = (crc >>> 8) & 0xff;
  return decoded[33] === expectedLow && decoded[34] === expectedHigh;
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
    if (!intent.assetDetails.code || !ASSET_CODE_REGEX.test(intent.assetDetails.code)) return null;
    if (intent.assetDetails.code === "XLM") {
      return { code: "XLM", issuer: null };
    }
    if (!intent.assetDetails.issuer || !isValidEd25519PublicKey(intent.assetDetails.issuer)) return null;
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
  if (!intent.destination || !isValidEd25519PublicKey(intent.destination)) {
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
  if (!ASSET_CODE_REGEX.test(intent.assetCode)) {
    return { valid: false, error: "assetCode must be 1-12 characters from [A-Za-z0-9_]" };
  }
  if (intent.assetCode === "XLM") {
    return { valid: false, error: "XLM is native and cannot be used as a trustline" };
  }
  if (!intent.issuer || !isValidEd25519PublicKey(intent.issuer)) {
    return { valid: false, error: "issuer must be a valid Stellar account" };
  }
  if (intent.limit !== undefined) {
    if (isNaN(parseFloat(intent.limit)) || parseFloat(intent.limit) < 0) {
      return { valid: false, error: "limit must be a non-negative number" };
    }
  }
  return { valid: true };
}

function validateContractCall(intent: AgentIntent): { valid: boolean; error?: string } {
  if (intent.type !== "contract_call") return { valid: false, error: "not a contract_call" };
  if (!intent.contractId || intent.contractId.length < 3) {
    return { valid: false, error: "contractId required" };
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
