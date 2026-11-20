import type { PolicyRules } from "@4evergent/shared";
import { DEFAULT_RULES } from "./types.js";
import {
  isCanonicalAllowedAsset,
  isCanonicalPolicyLimitKey,
} from "./asset-identity.js";

const TX_TYPES = ["payment", "trustline", "contract_call", "account_settings"] as const;

type TxType = (typeof TX_TYPES)[number];

export interface PolicyValidationResult {
  valid: boolean;
  errors: string[];
  rules: PolicyRules;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function validateAmountMap(
  field: "maxTxAmount" | "dailySpendingLimit",
  value: unknown,
  errors: string[],
  allowZero: boolean,
): Record<string, string> {
  if (!isRecord(value)) {
    errors.push(`${field} must be an object mapping asset identities to amounts`);
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isCanonicalPolicyLimitKey(key)) {
      errors.push(
        `${field} key '${key}' is not a canonical asset identity; use 'XLM', 'CODE:ISSUER', or the legacy 'native' key`,
      );
      continue;
    }
    const amount = parseAmount(raw);
    if (amount === null) {
      errors.push(`${field}.${key} must be a finite number`);
      continue;
    }
    if (allowZero ? amount < 0 : amount <= 0) {
      errors.push(`${field}.${key} must be ${allowZero ? "zero or greater" : "greater than zero"}`);
      continue;
    }
    result[key] = typeof raw === "string" ? raw : String(raw);
  }
  return result;
}

function validateAllowedAssets(value: unknown, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push("allowedAssets must be an array of canonical asset identities");
    return [];
  }

  const result: string[] = [];
  for (const entry of value) {
    if (!isNonEmptyString(entry)) {
      errors.push("allowedAssets entries must be non-empty strings");
      continue;
    }
    if (!isCanonicalAllowedAsset(entry)) {
      errors.push(
        `allowedAssets entry '${entry}' is not a canonical asset identity; use 'XLM', 'CODE:ISSUER', or 'trustline:CODE:ISSUER'`,
      );
      continue;
    }
    result.push(entry);
  }
  return result;
}

export function normalizePolicyRules(input: unknown): PolicyRules {
  const raw = isRecord(input) ? input : {};
  const rules: PolicyRules = {
    ...DEFAULT_RULES,
    maxTxAmount: { ...DEFAULT_RULES.maxTxAmount },
    dailySpendingLimit: { ...DEFAULT_RULES.dailySpendingLimit },
    allowedAssets: [...DEFAULT_RULES.allowedAssets],
    allowedDestinations: [...DEFAULT_RULES.allowedDestinations],
    allowedContractIds: [...DEFAULT_RULES.allowedContractIds],
    txTypeRestrictions: { ...DEFAULT_RULES.txTypeRestrictions },
  };

  if (raw.maxTxAmount !== undefined) {
    rules.maxTxAmount = validateAmountMap("maxTxAmount", raw.maxTxAmount, [], false);
  }
  if (raw.dailySpendingLimit !== undefined) {
    rules.dailySpendingLimit = validateAmountMap(
      "dailySpendingLimit",
      raw.dailySpendingLimit,
      [],
      true,
    );
  }
  if (raw.allowedAssets !== undefined) {
    rules.allowedAssets = Array.isArray(raw.allowedAssets)
      ? raw.allowedAssets.filter(isNonEmptyString)
      : [];
  }
  if (Array.isArray(raw.allowedDestinations)) {
    rules.allowedDestinations = raw.allowedDestinations.filter(isNonEmptyString);
  }
  if (Array.isArray(raw.allowedContractIds)) {
    rules.allowedContractIds = raw.allowedContractIds.filter(isNonEmptyString);
  }
  if (isRecord(raw.txTypeRestrictions)) {
    for (const type of TX_TYPES) {
      const value = raw.txTypeRestrictions[type];
      if (typeof value === "boolean") rules.txTypeRestrictions[type] = value;
    }
  }

  if (raw.requireHumanApprovalForAmountAbove !== undefined) {
    rules.requireHumanApprovalForAmountAbove = String(raw.requireHumanApprovalForAmountAbove);
  } else if (raw.approvalThreshold !== undefined) {
    rules.requireHumanApprovalForAmountAbove = String(raw.approvalThreshold);
  }
  if (raw.approvalThreshold !== undefined) {
    rules.approvalThreshold = String(raw.approvalThreshold);
  } else if (raw.requireHumanApprovalForAmountAbove !== undefined) {
    rules.approvalThreshold = String(raw.requireHumanApprovalForAmountAbove);
  }

  return rules;
}

export function validatePolicyRules(input: unknown): PolicyValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { valid: false, errors: ["policy must be an object"], rules: { ...DEFAULT_RULES } };
  }

  const rules = normalizePolicyRules(input);

  if (input.maxTxAmount !== undefined) {
    const maxTxAmount = validateAmountMap("maxTxAmount", input.maxTxAmount, errors, false);
    if (errors.length === 0) rules.maxTxAmount = maxTxAmount;
  }
  if (input.dailySpendingLimit !== undefined) {
    const dailySpendingLimit = validateAmountMap(
      "dailySpendingLimit",
      input.dailySpendingLimit,
      errors,
      true,
    );
    if (errors.length === 0) rules.dailySpendingLimit = dailySpendingLimit;
  }
  if (input.allowedAssets !== undefined) {
    const allowedAssets = validateAllowedAssets(input.allowedAssets, errors);
    if (errors.length === 0) rules.allowedAssets = allowedAssets;
  }

  return { valid: errors.length === 0, errors, rules };
}
