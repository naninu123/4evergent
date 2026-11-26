import type { ActivityStore, ApprovalRecord, ApprovalStore } from "@4evergent/database";
import type { AuthModule } from "./auth.js";

export interface DataRetentionOptions {
  store: Pick<ActivityStore, "sweepDailySpending" | "releaseExpiredIdempotencyKeys">;
  approvalStore?: Pick<ApprovalStore, "sweepExpired"> | null;
  authModule?: Pick<AuthModule, "sweepExpiredSessions"> | null;
  now?: number;
  authSessionDays?: number;
  dailySpendingDays?: number;
  /**
   * #109: Idempotency-Key replay window in ms. Keys bound to activities older
   * than this are released (the activity record itself is kept). Omit to skip.
   */
  idempotencyWindowMs?: number;
  batchSize?: number;
  onApprovalExpired?: (approval: ApprovalRecord) => void | Promise<void>;
}

export interface DataRetentionResult {
  authSessionsRemoved: number;
  dailySpendingRemoved: number;
  expiredApprovalsSwept: number;
  idempotencyKeysReleased: number;
}

/** One bounded sweep. A zero-day window disables cleanup for that table. */
export async function sweepRetainedData(options: DataRetentionOptions): Promise<DataRetentionResult> {
  const now = options.now ?? Date.now();
  const sessionDays = Number.isFinite(options.authSessionDays) && (options.authSessionDays ?? -1) >= 0
    ? options.authSessionDays!
    : 30;
  const spendingDays = Number.isFinite(options.dailySpendingDays) && (options.dailySpendingDays ?? -1) >= 0
    ? options.dailySpendingDays!
    : 90;
  const batchSize = Number.isInteger(options.batchSize) && (options.batchSize ?? 0) > 0
    ? options.batchSize!
    : 500;
  const sessionCutoff = now - sessionDays * 24 * 60 * 60_000;
  const spendingCutoffDate = new Date(now);
  spendingCutoffDate.setUTCDate(spendingCutoffDate.getUTCDate() - spendingDays);
  const spendingCutoff = spendingCutoffDate.toISOString().slice(0, 10);

  const authSessionsRemoved = sessionDays > 0
    ? options.authModule?.sweepExpiredSessions(sessionCutoff, batchSize) ?? 0
    : 0;
  const dailySpendingRemoved = spendingDays > 0
    ? await options.store.sweepDailySpending(spendingCutoff, batchSize)
    : 0;
  const expiredApprovalsSwept = options.approvalStore
    ? await options.approvalStore.sweepExpired(new Date(now).toISOString(), batchSize, options.onApprovalExpired)
    : 0;

  const idempotencyWindowMs = options.idempotencyWindowMs;
  const idempotencyKeysReleased =
    typeof idempotencyWindowMs === "number" && Number.isFinite(idempotencyWindowMs) && idempotencyWindowMs > 0
      && options.store.releaseExpiredIdempotencyKeys
      ? await options.store.releaseExpiredIdempotencyKeys(new Date(now - idempotencyWindowMs).toISOString(), batchSize)
      : 0;

  return { authSessionsRemoved, dailySpendingRemoved, expiredApprovalsSwept, idempotencyKeysReleased };
}
