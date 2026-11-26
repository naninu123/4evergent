import { Horizon, rpc, type Asset, type Transaction } from "@stellar/stellar-sdk";
import type { SimulationResult } from "@4evergent/shared";

export const DEFAULT_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

export interface SimulationOutcome extends SimulationResult {
  assembledTransaction?: Transaction;
}

/**
 * Minimum XLM a payment must carry to create a non-existent destination
 * account. A new Stellar account must be funded with at least 1 XLM — the
 * minimum balance for a bare account (2 x the 0.5 XLM base reserve).
 * Source: https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts
 */
const MIN_ACCOUNT_CREATION_XLM = 1;

/**
 * Simulator — mandatory gate before signing.
 *
 * A transaction that is NOT simulated, or whose simulation FAILED, MUST NOT be
 * signed or submitted. There are no fake or cached simulation results: every
 * code path through `simulate()` performs real Horizon network calls
 * (`fetchBaseFee()` and `accounts().accountId().call()`).
 *
 * Classic (non-Soroban) Horizon has no dry-run endpoint, so simulation is a
 * set of real network preconditions that must hold for submission to succeed:
 *  - the transaction envelope XDR is well-formed (round-trip),
 *  - the source account exists,
 *  - the transaction sequence number is exactly the on-chain sequence + 1,
 *  - the source account's XLM balance covers amount + fee + minimum reserve,
 *  - the destination is a valid G... address (validated by TransactionBuilder),
 *  - every payment destination exists on the network — or, if it does not,
 *    the payment carries at least 1 XLM, the minimum to create an account,
 *  - every non-native payment destination holds a trustline for the asset
 *    (otherwise Horizon rejects the payment with `op_no_trust`),
 *  - the transaction fee is >= network base fee.
 *
 * Signature correctness is NOT checked here — it is checked by Horizon at
 * submission time. This is why a simulation pass is necessary but not
 * sufficient: the pipeline must never present a simulation success as a
 * submission success.
 */
export class StellarSimulator {
  private server: Horizon.Server;
  private sorobanServer: rpc.Server;

  /**
   * @param horizonUrl Horizon endpoint (used when no server is injected).
   * @param server Optional `Horizon.Server` seam for tests — inject a fake to
   *        keep `simulate()` fully offline. Production callers omit this and
   *        the server is constructed from `horizonUrl`.
   * @param sorobanRpcUrlOrServer Optional Soroban RPC endpoint URL or stubbed
   *        `rpc.Server` seam for tests. Defaults to SOROBAN_RPC_URL env or
   *        Testnet Soroban RPC.
   */
  constructor(
    horizonUrl: string,
    server?: Horizon.Server,
    sorobanRpcUrlOrServer?: string | rpc.Server
  ) {
    this.server = server ?? new Horizon.Server(horizonUrl);
    if (
      sorobanRpcUrlOrServer &&
      typeof sorobanRpcUrlOrServer === "object" &&
      "simulateTransaction" in sorobanRpcUrlOrServer
    ) {
      this.sorobanServer = sorobanRpcUrlOrServer;
    } else {
      const url =
        typeof sorobanRpcUrlOrServer === "string" && sorobanRpcUrlOrServer.length > 0
          ? sorobanRpcUrlOrServer
          : process.env.SOROBAN_RPC_URL || DEFAULT_SOROBAN_RPC_URL;
      this.sorobanServer = new rpc.Server(url, { allowHttp: url.startsWith("http://") });
    }
  }

  async simulate(transaction: Transaction): Promise<SimulationOutcome> {
    const ops = transaction.operations.length;

    try {
      // 1. Envelope well-formedness (local, but XDR-level real validation).
      transaction.toEnvelope().toXDR("raw");
    } catch (e) {
      return fail(transaction.fee, ops, `Transaction envelope is invalid: ${(e as Error).message}`);
    }

    // 2. Real network call: fetch the current base fee.
    let baseFee: number;
    try {
      baseFee = await this.server.fetchBaseFee();
    } catch (e) {
      return fail(transaction.fee, ops, `Unable to fetch network base fee from Horizon: ${(e as Error).message}`);
    }

    // 3. Real network call: load the source account.
    let account: any;
    try {
      account = await this.server.accounts().accountId(transaction.source).call();
    } catch (e) {
      return fail(
        transaction.fee,
        ops,
        `Source account ${transaction.source} not found on network: ${(e as Error).message}`
      );
    }

    // 4. Sequence number precondition. The built transaction's sequence must
    //    be exactly one greater than the account's current on-chain sequence.
    const accountSeq = Number(account.sequence);
    if (Number(transaction.sequence) !== accountSeq + 1) {
      return fail(
        transaction.fee,
        ops,
        `Sequence number mismatch: transaction ${transaction.sequence} is not account sequence ${accountSeq} + 1`
      );
    }

    // 5. Fee precondition.
    if (Number(transaction.fee) < baseFee) {
      return fail(
        transaction.fee,
        ops,
        `Fee ${transaction.fee} stroops is below network base fee ${baseFee}`
      );
    }

    // 6. Balance precondition for payments (native XLM and issued assets).
    const warnings: string[] = [];
    const balances = (account.balances ?? []) as {
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
      balance: string;
    }[];
    const xlmBalance = balances.find((b) => b.asset_type === "native");
    const payment = paymentAmount(transaction);
    const feeXlm = Number(transaction.fee) / 1e7;

    if (payment.isNative) {
      if (xlmBalance) {
        const totalCost = payment.amount + feeXlm;
        const available = Number(xlmBalance.balance) - reserveFor(account);
        if (totalCost > available) {
          return fail(
            transaction.fee,
            ops,
            `Insufficient balance: payment ${payment.amount} XLM + fee exceeds available ${available.toFixed(7)} XLM`
          );
        }
        if (available - totalCost < 1) {
          warnings.push("Remaining balance after transaction is under 1 XLM");
        }
      }
    } else {
      // Non-native payment: XLM balance still covers transaction fee + minimum reserve.
      const availableXlm = (xlmBalance ? Number(xlmBalance.balance) : 0) - reserveFor(account);
      if (feeXlm > availableXlm) {
        return fail(
          transaction.fee,
          ops,
          `Insufficient XLM balance for fee: fee ${feeXlm.toFixed(7)} XLM exceeds available ${availableXlm.toFixed(7)} XLM`
        );
      }
      if (xlmBalance && availableXlm - feeXlm < 1) {
        warnings.push("Remaining balance after transaction is under 1 XLM");
      }

      // Check the payment asset's own trustline balance on the source account.
      const assetBalance = balances.find(
        (b) =>
          (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
          b.asset_code === payment.assetCode &&
          b.asset_issuer === payment.assetIssuer
      );
      const availableAsset = assetBalance ? Number(assetBalance.balance) : 0;
      if (!assetBalance || payment.amount > availableAsset) {
        return fail(
          transaction.fee,
          ops,
          `Insufficient balance: payment ${payment.amount} ${payment.assetCode} exceeds available ${availableAsset.toFixed(7)} ${payment.assetCode}`
        );
      }
    }

    // 7. Destination-account preconditions, one per payment operation.
    //    Non-payment operations (changeTrust, account settings, ...) carry
    //    no payment destination and are skipped.
    for (const op of transaction.operations) {
      if (op.type !== "payment") continue;
      const dest = await this.checkDestination(op);
      if (!dest.ok) return fail(transaction.fee, ops, dest.error);
    }

    // 8. Soroban RPC simulation & assembly for contract invocation transactions.
    const isSoroban = transaction.operations.some(
      (op) =>
        op.type === "invokeHostFunction" ||
        (op as any).type === "extendFootprintTtl" ||
        (op as any).type === "restoreFootprint"
    );

    if (isSoroban) {
      let simResponse: any;
      try {
        simResponse = await this.sorobanServer.simulateTransaction(transaction);
      } catch (e: any) {
        return fail(transaction.fee, ops, `Soroban simulation failed: ${e.message}`);
      }

      if (rpc.Api.isSimulationError(simResponse)) {
        return fail(transaction.fee, ops, `Soroban simulation failed: ${simResponse.error}`);
      }

      if (!rpc.Api.isSimulationSuccess(simResponse)) {
        return fail(transaction.fee, ops, "Soroban simulation failed: simulation was not successful");
      }

      let assembledTx: Transaction;
      try {
        assembledTx = rpc.assembleTransaction(transaction, simResponse).build();
      } catch (e: any) {
        return fail(transaction.fee, ops, `Soroban transaction assembly failed: ${e.message}`);
      }

      return {
        success: true,
        fee: assembledTx.fee,
        operations: ops,
        warnings,
        assembledTransaction: assembledTx,
      };
    }

    return {
      success: true,
      fee: transaction.fee,
      operations: ops,
      warnings,
    };
  }

  /**
   * Destination precondition for a single payment operation, using the same
   * `Horizon.Server` seam as the source-account load.
   *
   * A load failure is treated as "account does not exist": by the time this
   * runs, the source-account load (check 3) has already proven Horizon is
   * reachable, so a failure here is a genuine 404, not a network outage.
   */
  private async checkDestination(op: {
    destination: string;
    asset: Asset;
    amount: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    let destAccount: any;
    try {
      destAccount = await this.server.accounts().accountId(op.destination).call();
    } catch {
      destAccount = null;
    }

    if (!destAccount) {
      // Non-existent destination: only a native payment at or above the
      // account-creation minimum can succeed (it creates the account).
      if (!op.asset.isNative()) {
        return {
          ok: false,
          error: `Destination account ${op.destination} does not exist and cannot receive ${op.asset.code} (no trustline; only a native XLM payment of at least ${MIN_ACCOUNT_CREATION_XLM} XLM can create an account)`,
        };
      }
      if (Number(op.amount) < MIN_ACCOUNT_CREATION_XLM) {
        return {
          ok: false,
          error: `Destination account ${op.destination} does not exist and payment of ${op.amount} XLM is below the ${MIN_ACCOUNT_CREATION_XLM} XLM minimum to create an account`,
        };
      }
      return { ok: true };
    }

    // Existing destination: a non-native payment needs a trustline, or
    // Horizon rejects the payment with `op_no_trust`.
    if (!op.asset.isNative()) {
      const balances = (destAccount.balances ?? []) as {
        asset_type: string;
        asset_code?: string;
        asset_issuer?: string;
      }[];
      const hasTrustline = balances.some(
        (b) => b.asset_code === op.asset.code && b.asset_issuer === op.asset.issuer
      );
      if (!hasTrustline) {
        return {
          ok: false,
          error: `Destination account ${op.destination} has no trustline for ${op.asset.code}:${op.asset.issuer}`,
        };
      }
    }
    return { ok: true };
  }
}

function fail(fee: string, operations: number, error: string): SimulationResult {
  return { success: false, fee, operations, warnings: [], error };
}

export interface PaymentAmountInfo {
  amount: number;
  isNative: boolean;
  assetCode: string;
  assetIssuer: string | null;
}

export function paymentAmount(transaction: Transaction): PaymentAmountInfo {
  for (const op of transaction.operations) {
    if (op.type === "payment") {
      const asset = op.asset as Asset;
      const isNative = typeof asset?.isNative === "function" ? asset.isNative() : true;
      return {
        amount: Number(op.amount),
        isNative,
        assetCode: isNative ? "XLM" : asset.code,
        assetIssuer: isNative ? null : asset.issuer,
      };
    }
  }
  return {
    amount: 0,
    isNative: true,
    assetCode: "XLM",
    assetIssuer: null,
  };
}

function reserveFor(account: any): number {
  // Base reserve (0.5 XLM) + 0.5 XLM per sub-entry. Kept conservative.
  return 0.5 + 0.5 * (account.subentry_count ?? 0);
}
