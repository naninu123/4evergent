import {
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  StrKey,
  nativeToScVal,
  xdr,
  type Account,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { PaymentIntent, TrustlineIntent, AccountSettingsIntent, ContractCallIntent } from "@4evergent/shared";

/** Signer for setOptions. weight 0 removes the signer; >0 adds or updates it. */
export type SetOptionsSigner =
  | { ed25519PublicKey: string; weight: number }
  | { sha256Hash: string | Buffer; weight: number }
  | { preAuthTx: string | Buffer; weight: number };

/** Every field is optional; omitted fields leave the account setting unchanged. */
export interface SetOptionsParams {
  inflationDest?: string;
  clearFlags?: number;
  setFlags?: number;
  masterWeight?: number;
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
  homeDomain?: string;
  signer?: SetOptionsSigner;
  /** Optional memo text (truncated to 28 bytes). */
  memo?: string;
}

const SET_OPTIONS_FIELDS = [
  "inflationDest",
  "clearFlags",
  "setFlags",
  "masterWeight",
  "lowThreshold",
  "medThreshold",
  "highThreshold",
  "homeDomain",
  "signer",
] as const;

function assertByte(name: string, v: unknown): void {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255) {
    throw new Error(`StellarTransactionBuilder: ${name} must be an integer between 0 and 255`);
  }
}

export interface AssetIdentifier {
  code: string;
  issuer: string | null;
}

/**
 * Single fee source for every transaction this builder constructs.
 *
 * Stellar's network base fee is 100 stroops (0.00001 XLM). The builder used
 * to hardcode 100000 stroops (0.01 XLM) — 1000x the base fee — in each of
 * buildPayment/buildTrustline/buildAccountSettings.
 *
 * Resolution order: explicit constructor option > STELLAR_BASE_FEE env var >
 * DEFAULT_BASE_FEE_STROOPS ("100"). A configured value must be a positive
 * integer number of stroops; anything else fails fast at construction so a
 * typo can never silently submit at an unintended fee. This is a static
 * configured fee only — no dynamic surge pricing. The simulator still
 * enforces fee >= live network base fee (see simulator.ts), untouched here.
 */
export const DEFAULT_BASE_FEE_STROOPS = "100";
export const STELLAR_BASE_FEE_ENV_VAR = "STELLAR_BASE_FEE";

export interface StellarTransactionBuilderOptions {
  /** Base fee in stroops, e.g. "100". Overrides STELLAR_BASE_FEE. */
  baseFeeStroops?: string;
}

export function resolveBaseFeeStroops(explicit?: string): string {
  const raw = explicit ?? process.env[STELLAR_BASE_FEE_ENV_VAR] ?? DEFAULT_BASE_FEE_STROOPS;
  if (!/^[0-9]+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new Error(
      `StellarTransactionBuilder: base fee must be a positive integer number of stroops, got '${raw}' ` +
        `(set ${STELLAR_BASE_FEE_ENV_VAR} or pass baseFeeStroops)`
    );
  }
  return raw;
}

function parseAssetInput(input: { asset?: string; assetDetails?: { code: string; issuer: string | null } }): AssetIdentifier {
  if (input.assetDetails) {
    return { code: input.assetDetails.code, issuer: input.assetDetails.issuer };
  }
  if (input.asset === "XLM") return { code: "XLM", issuer: null };
  return { code: input.asset ?? "XLM", issuer: null };
}

function toStellarAsset(id: AssetIdentifier): Asset {
  if (id.code === "XLM" || !id.issuer) return Asset.native();
  return new Asset(id.code, id.issuer);
}

export class StellarTransactionBuilder {
  private readonly baseFeeStroops: string;

  constructor(options: StellarTransactionBuilderOptions = {}) {
    this.baseFeeStroops = resolveBaseFeeStroops(options.baseFeeStroops);
  }

  /** The fee (stroops) this builder puts on every transaction it builds. */
  getBaseFeeStroops(): string {
    return this.baseFeeStroops;
  }

  async buildPayment(
    sourceAccount: Account,
    intent: PaymentIntent,
    networkPassphrase: string
  ): Promise<Transaction> {
    if (intent.type !== "payment") {
      throw new Error(`StellarTransactionBuilder: expected payment intent, got ${intent.type}`);
    }

    const amount = intent.amount.trim();
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      throw new Error("StellarTransactionBuilder: amount must be a positive number");
    }

    const destination = intent.destination.trim();
    if (!destination || !destination.startsWith("G")) {
      throw new Error("StellarTransactionBuilder: destination must be a valid Stellar account");
    }

    const assetId = parseAssetInput(intent);
    if (assetId.code !== "XLM" && !assetId.issuer) {
      throw new Error("StellarTransactionBuilder: non-XLM asset requires issuer");
    }
    const stellarAsset = toStellarAsset(assetId);

    const paymentOp = Operation.payment({
      destination,
      asset: stellarAsset,
      amount,
    });

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: this.baseFeeStroops,
    });
    builder.addMemo(Memo.text(truncateToMemo(intent.reason)));
    builder.addOperation(paymentOp);
    builder.setTimeout(30);

    return builder.build();
  }

  async buildTrustline(
    sourceAccount: Account,
    intent: TrustlineIntent,
    networkPassphrase: string
  ): Promise<Transaction> {
    if (intent.type !== "trustline") {
      throw new Error(`StellarTransactionBuilder: expected trustline intent, got ${intent.type}`);
    }

    if (!intent.assetCode || intent.assetCode.length < 1) {
      throw new Error("StellarTransactionBuilder: assetCode required");
    }
    if (intent.assetCode === "XLM") {
      throw new Error("StellarTransactionBuilder: XLM is native and cannot be used as a trustline");
    }
    if (!intent.issuer || !intent.issuer.startsWith("G")) {
      throw new Error("StellarTransactionBuilder: issuer must be a valid Stellar account");
    }

    const asset = new Asset(intent.assetCode, intent.issuer);
    const limit = intent.limit && parseFloat(intent.limit) >= 0 ? intent.limit : undefined;

    const changeTrustOp = limit !== undefined
      ? Operation.changeTrust({ asset, limit })
      : Operation.changeTrust({ asset });

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: this.baseFeeStroops,
    });
    builder.addMemo(Memo.text(truncateToMemo(intent.reason)));
    builder.addOperation(changeTrustOp);
    builder.setTimeout(30);

    return builder.build();
  }

  /**
   * Builds a transaction with a single setOptions operation.
   *
   * Each field is optional; omitted fields leave the existing setting
   * unchanged. An options object with no setOptions field set throws (a
   * setOptions with no changes is a wasted fee, so it is rejected up front).
   */
  async buildSetOptions(
    sourceAccount: Account,
    options: SetOptionsParams,
    networkPassphrase: string
  ): Promise<Transaction> {
    if (!options || typeof options !== "object") {
      throw new Error("StellarTransactionBuilder: setOptions options object required");
    }
    const opts: Record<string, unknown> = {};
    for (const key of SET_OPTIONS_FIELDS) {
      if (options[key] !== undefined) opts[key] = options[key];
    }
    if (Object.keys(opts).length === 0) {
      throw new Error("StellarTransactionBuilder: setOptions requires at least one option to change");
    }

    for (const k of ["clearFlags", "setFlags", "masterWeight", "lowThreshold", "medThreshold", "highThreshold"] as const) {
      if (options[k] !== undefined) assertByte(k, options[k]);
    }
    if (options.homeDomain !== undefined) {
      if (typeof options.homeDomain !== "string" || new TextEncoder().encode(options.homeDomain).length > 32) {
        throw new Error("StellarTransactionBuilder: homeDomain must be a string of at most 32 bytes");
      }
    }
    if (options.inflationDest !== undefined) {
      if (typeof options.inflationDest !== "string" || !options.inflationDest.startsWith("G") || options.inflationDest.length !== 56) {
        throw new Error("StellarTransactionBuilder: inflationDest must be a valid Stellar address (G...)");
      }
    }
    if (options.signer !== undefined) {
      const sg = options.signer as unknown as Record<string, unknown>;
      if (typeof sg !== "object" || sg === null) {
        throw new Error("StellarTransactionBuilder: signer must be an object with a key and weight");
      }
      assertByte("signer.weight", sg.weight);
      const keys = ["ed25519PublicKey", "sha256Hash", "preAuthTx"].filter((k) => sg[k] !== undefined);
      if (keys.length !== 1) {
        throw new Error("StellarTransactionBuilder: signer needs exactly one of ed25519PublicKey, sha256Hash, preAuthTx");
      }
    }

    const setOptionsOp = Operation.setOptions(opts as any);

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: this.baseFeeStroops,
    });
    if (options.memo) builder.addMemo(Memo.text(truncateToMemo(options.memo)));
    builder.addOperation(setOptionsOp);
    builder.setTimeout(30);

    return builder.build();
  }

  async buildAccountSettings(
    sourceAccount: Account,
    intent: AccountSettingsIntent,
    networkPassphrase: string
  ): Promise<Transaction> {
    if (intent.type !== "account_settings") {
      throw new Error(`StellarTransactionBuilder: expected account_settings intent, got ${intent.type}`);
    }
    if (!intent.setting || intent.setting.trim().length === 0) {
      throw new Error("StellarTransactionBuilder: setting field required");
    }

    const options = this.resolveAccountSettingsOptions(intent);
    const setOptionsOp = Operation.setOptions(options as any);

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: this.baseFeeStroops,
    });
    builder.addMemo(Memo.text(truncateToMemo(intent.reason)));
    builder.addOperation(setOptionsOp);
    builder.setTimeout(30);

    return builder.build();
  }

  async buildContractCall(
    sourceAccount: Account,
    intent: ContractCallIntent,
    networkPassphrase: string
  ): Promise<Transaction> {
    if (intent.type !== "contract_call") {
      throw new Error(`StellarTransactionBuilder: expected contract_call intent, got ${intent.type}`);
    }

    const contractId = intent.contractId?.trim();
    if (!contractId || !StrKey.isValidContract(contractId)) {
      throw new Error("StellarTransactionBuilder: contractId must be a valid Stellar contract address");
    }

    const functionName = intent.function?.trim();
    if (!functionName || functionName.length === 0) {
      throw new Error("StellarTransactionBuilder: function required");
    }

    const scValArgs: xdr.ScVal[] = (intent.args ?? []).map((arg: unknown) =>
      arg instanceof xdr.ScVal ? arg : nativeToScVal(arg)
    );

    const invokeOp = Operation.invokeContractFunction({
      contract: contractId,
      function: functionName,
      args: scValArgs,
    });

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: this.baseFeeStroops,
    });
    builder.addMemo(Memo.text(truncateToMemo(intent.reason)));
    builder.addOperation(invokeOp);
    builder.setTimeout(30);

    return builder.build();
  }

  private resolveAccountSettingsOptions(intent: AccountSettingsIntent) {
    const setting = intent.setting.trim().toLowerCase();
    const value = intent.value;

    switch (setting) {
      case "home_domain": {
        if (typeof value !== "string" || value.length === 0) {
          throw new Error("StellarTransactionBuilder: home_domain value must be a non-empty string");
        }
        return { homeDomain: value };
      }
      case "inflation_destination": {
        if (typeof value !== "string" || !value.startsWith("G") || value.length !== 56) {
          throw new Error("StellarTransactionBuilder: inflation_destination must be a valid Stellar address (G...)");
        }
        return { inflationDest: value };
      }
      case "signer": {
        if (typeof value !== "object" || value === null) {
          throw new Error("StellarTransactionBuilder: signer value must be { key, weight }");
        }
        const v = value as { key?: unknown; weight?: unknown };
        if (typeof v.key !== "string" || !v.key.startsWith("G") || v.key.length !== 56) {
          throw new Error("StellarTransactionBuilder: signer.key must be a valid Stellar address (G...)");
        }
        if (typeof v.weight !== "number" || v.weight < 0 || v.weight > 255) {
          throw new Error("StellarTransactionBuilder: signer.weight must be a number between 0 and 255");
        }
        return { signer: { ed25519PublicKey: v.key, weight: v.weight } };
      }
      case "thresholds": {
        if (typeof value !== "object" || value === null) {
          throw new Error("StellarTransactionBuilder: thresholds value must be { low, medium, high, master }");
        }
        const v = value as { low?: unknown; medium?: unknown; high?: unknown; master?: unknown };
        for (const k of ["low", "medium", "high", "master"] as const) {
          if (typeof v[k] !== "number" || v[k] < 0 || v[k] > 255) {
            throw new Error(`StellarTransactionBuilder: thresholds.${k} must be a number between 0 and 255`);
          }
        }
        return {
          lowThreshold: v.low,
          medThreshold: v.medium,
          highThreshold: v.high,
          masterWeight: v.master,
        };
      }
      case "set_flags": {
        if (!Array.isArray(value)) {
          throw new Error("StellarTransactionBuilder: set_flags value must be an array of numbers");
        }
        if (!value.every((n) => typeof n === "number" && n >= 0 && n <= 255)) {
          throw new Error("StellarTransactionBuilder: set_flags entries must be numbers between 0 and 255");
        }
        return { setFlags: value.reduce((a, b) => a | b, 0) };
      }
      case "clear_flags": {
        if (!Array.isArray(value)) {
          throw new Error("StellarTransactionBuilder: clear_flags value must be an array of numbers");
        }
        if (!value.every((n) => typeof n === "number" && n >= 0 && n <= 255)) {
          throw new Error("StellarTransactionBuilder: clear_flags entries must be numbers between 0 and 255");
        }
        return { clearFlags: value.reduce((a, b) => a | b, 0) };
      }
      default:
        throw new Error(`StellarTransactionBuilder: unknown account_settings type: ${intent.setting}`);
    }
  }
}

function truncateToMemo(text: string): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= 28) return text;
  let cutoff = 28;
  while (cutoff > 0 && (encoded[cutoff]! & 0xc0) === 0x80) cutoff--;
  return new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, cutoff));
}
