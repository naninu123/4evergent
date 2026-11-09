import {
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  type Account,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { PaymentIntent, TrustlineIntent, AccountSettingsIntent } from "@4evergent/shared";

export interface AssetIdentifier {
  code: string;
  issuer: string | null;
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

export type SetOptionsSigner =
  | { ed25519PublicKey: string; weight: number }
  | { key: string; weight: number }
  | { sha256Hash: Buffer | string; weight: number }
  | { preAuthTx: Buffer | string; weight: number };

export interface SetOptionsInput {
  inflationDest?: string;
  clearFlags?: number;
  setFlags?: number;
  masterWeight?: number;
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
  homeDomain?: string;
  signer?: SetOptionsSigner;
  memo?: string;
}

const SET_OPTIONS_KEYS = [
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

export class StellarTransactionBuilder {
  /**
   * Build a Stellar transaction containing a single `Operation.setOptions`
   * operation.
   *
   * Each field in `options` is optional; omitting a field leaves that account
   * setting unchanged on-chain. Passing an empty options object (no
   * `setOptions` fields defined) throws an error rather than producing a
   * no-op transaction that would waste network fees.
   */
  async buildSetOptions(
    sourceAccount: Account,
    options: SetOptionsInput,
    networkPassphrase: string
  ): Promise<Transaction> {
    if (!options || typeof options !== "object") {
      throw new Error("StellarTransactionBuilder: options object is required");
    }

    const hasAnyField = SET_OPTIONS_KEYS.some((k) => options[k] !== undefined);
    if (!hasAnyField) {
      throw new Error(
        "StellarTransactionBuilder: buildSetOptions requires at least one option field"
      );
    }

    const sdkOptions: Record<string, unknown> = {};

    if (options.inflationDest !== undefined) {
      if (
        typeof options.inflationDest !== "string" ||
        !options.inflationDest.startsWith("G") ||
        options.inflationDest.length !== 56
      ) {
        throw new Error(
          "StellarTransactionBuilder: inflationDest must be a valid Stellar address (G...)"
        );
      }
      sdkOptions.inflationDest = options.inflationDest;
    }

    if (options.clearFlags !== undefined) {
      if (
        typeof options.clearFlags !== "number" ||
        !Number.isInteger(options.clearFlags) ||
        options.clearFlags < 0 ||
        options.clearFlags > 255
      ) {
        throw new Error(
          "StellarTransactionBuilder: clearFlags must be an integer between 0 and 255"
        );
      }
      sdkOptions.clearFlags = options.clearFlags;
    }

    if (options.setFlags !== undefined) {
      if (
        typeof options.setFlags !== "number" ||
        !Number.isInteger(options.setFlags) ||
        options.setFlags < 0 ||
        options.setFlags > 255
      ) {
        throw new Error(
          "StellarTransactionBuilder: setFlags must be an integer between 0 and 255"
        );
      }
      sdkOptions.setFlags = options.setFlags;
    }

    for (const field of [
      "masterWeight",
      "lowThreshold",
      "medThreshold",
      "highThreshold",
    ] as const) {
      const val = options[field];
      if (val !== undefined) {
        if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 255) {
          throw new Error(
            `StellarTransactionBuilder: ${field} must be an integer between 0 and 255`
          );
        }
        sdkOptions[field] = val;
      }
    }

    if (options.homeDomain !== undefined) {
      if (typeof options.homeDomain !== "string" || options.homeDomain.length > 32) {
        throw new Error(
          "StellarTransactionBuilder: homeDomain must be a string of at most 32 characters"
        );
      }
      sdkOptions.homeDomain = options.homeDomain;
    }

    if (options.signer !== undefined) {
      if (typeof options.signer !== "object" || options.signer === null) {
        throw new Error(
          "StellarTransactionBuilder: signer must be an object with key and weight"
        );
      }
      const weight = options.signer.weight;
      if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 0 || weight > 255) {
        throw new Error(
          "StellarTransactionBuilder: signer.weight must be a number between 0 and 255"
        );
      }
      if ("ed25519PublicKey" in options.signer || "key" in options.signer) {
        const pubKey =
          "ed25519PublicKey" in options.signer
            ? options.signer.ed25519PublicKey
            : options.signer.key;
        if (typeof pubKey !== "string" || !pubKey.startsWith("G") || pubKey.length !== 56) {
          throw new Error(
            "StellarTransactionBuilder: signer.key must be a valid Stellar address (G...)"
          );
        }
        sdkOptions.signer = { ed25519PublicKey: pubKey, weight };
      } else if ("sha256Hash" in options.signer) {
        sdkOptions.signer = { sha256Hash: options.signer.sha256Hash, weight };
      } else if ("preAuthTx" in options.signer) {
        sdkOptions.signer = { preAuthTx: options.signer.preAuthTx, weight };
      } else {
        throw new Error(
          "StellarTransactionBuilder: signer must specify ed25519PublicKey, key, sha256Hash, or preAuthTx"
        );
      }
    }

    const setOptionsOp = Operation.setOptions(sdkOptions as any);

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: "100000",
    });
    if (options.memo !== undefined) {
      builder.addMemo(Memo.text(truncateToMemo(options.memo)));
    }
    builder.addOperation(setOptionsOp);
    builder.setTimeout(30);

    return builder.build();
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
      fee: "100000",
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
      fee: "100000",
    });
    builder.addMemo(Memo.text(truncateToMemo(intent.reason)));
    builder.addOperation(changeTrustOp);
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
    return this.buildSetOptions(
      sourceAccount,
      { ...options, memo: intent.reason },
      networkPassphrase
    );
  }

  private resolveAccountSettingsOptions(intent: AccountSettingsIntent): SetOptionsInput {
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
          lowThreshold: v.low as number,
          medThreshold: v.medium as number,
          highThreshold: v.high as number,
          masterWeight: v.master as number,
        };
      }
      case "set_flags": {
        if (!Array.isArray(value)) {
          throw new Error("StellarTransactionBuilder: set_flags value must be an array of numbers");
        }
        if (!value.every((n) => typeof n === "number" && n >= 0 && n <= 255)) {
          throw new Error("StellarTransactionBuilder: set_flags entries must be numbers between 0 and 255");
        }
        return { setFlags: (value as number[]).reduce((a, b) => a | b, 0) };
      }
      case "clear_flags": {
        if (!Array.isArray(value)) {
          throw new Error("StellarTransactionBuilder: clear_flags value must be an array of numbers");
        }
        if (!value.every((n) => typeof n === "number" && n >= 0 && n <= 255)) {
          throw new Error("StellarTransactionBuilder: clear_flags entries must be numbers between 0 and 255");
        }
        return { clearFlags: (value as number[]).reduce((a, b) => a | b, 0) };
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
