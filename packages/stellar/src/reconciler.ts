import type { ActivityRecord, ActivityStore, ApprovalStore, ExecutionRecord, ExecutionStore } from "@4evergent/database";

/**
 * TransactionStatus — typed result of a Stellar transaction lookup.
 *
 *   confirmed    — transaction included in a ledger and successful
 *   failed       — transaction included in a ledger but failed
 *   not_found    — transaction not found (may be pending, or may have never been submitted)
 *   network_error — could not reach Horizon (timeout, 5xx, rate limit, etc.)
 */
export type TransactionStatus = "confirmed" | "failed" | "not_found" | "network_error";

export interface TransactionStatusProvider {
  getStatus(txHash: string): Promise<TransactionStatus>;
}

/**
 * Marker appended to the `error` of a `failed` activity whose `txHash`
 * Horizon reports as `not_found` (#277). The submission outcome is
 * genuinely unknown — the transaction may still land, or it may never
 * have been accepted — so the record stays `failed` and the pass
 * re-checks it on later ticks. Applied once: a record that already
 * carries the marker is left untouched, so re-runs are no-ops.
 */
export const FAILED_ACTIVITY_AMBIGUOUS_MARKER =
  "Ambiguous submission: txHash not found on Horizon; outcome unknown";

export interface FailedActivityReconciliationResult {
  /** Failed activities carrying a txHash that were examined. */
  checked: number;
  /** Failed activities corrected to `submitted` (tx confirmed on-chain). */
  corrected: number;
  /** Failed activities left failed with the ambiguity marker newly applied. */
  ambiguous: number;
  /** Failed activities whose tx failed on-chain (error text corrected). */
  onChainFailed: number;
  /** Failed activities with no txHash — nothing to reconcile. */
  skipped: number;
  /** Horizon errors / provider throws / store failures. */
  errors: number;
}

/**
 * Default lifetime of a `submitted` execution that Horizon still reports as
 * `not_found` before the reconciler retires it to `failed`: 6 hours.
 *
 * Generous on purpose: a slow network must never cause a premature failure.
 * A Stellar transaction that has not landed after 6h is, in practice, never
 * going to land — it was dropped from the mempool, its timebounds expired,
 * or its fee was too low to ever be picked up.
 */
export const DEFAULT_SUBMITTED_MAX_AGE_MS = 6 * 60 * 60_000;

export interface ReconcilerOptions {
  intervalMs?: number;
  clock?: () => Date;
  /**
   * Maximum age of a `submitted` execution still reported `not_found` before
   * it is retired to `failed`. Defaults to DEFAULT_SUBMITTED_MAX_AGE_MS (6h).
   * Must be a positive finite number when provided. Only `not_found` ages:
   * a `network_error` never consumes the budget, so a Horizon outage cannot
   * retire executions.
   */
  maxAgeMs?: number;
  /**
   * Optional store for releasing the daily-spending reservation (#353) of a
   * retired execution, or syncing on-chain failure to the linked activity (#363).
   * Only used for release when the retired record carries proof of a
   * reservation (`policyDecision.reservedDailySpending`); records without
   * proof (e.g. schedule-driven executions, whose decision is never written
   * back to the record) release nothing. Best-effort: a release or update failure
   * is swallowed so bookkeeping can never mask the reconciler outcome.
   */
  activityStore?: ActivityStore | (Pick<ActivityStore, "releaseDailySpending"> & Partial<ActivityStore>);
  /**
   * Optional store for syncing on-chain failure to the linked approval (#363).
   */
  approvalStore?: ApprovalStore | Partial<ApprovalStore>;
}

/**
 * TransactionStatusReconciler — polls Horizon for on-chain status of submitted
 * transactions and updates execution records accordingly.
 *
 * SAFETY:
 *   - Only processes executions with status === "submitted" AND txHash != null
 *   - Uses atomic conditional update (updateIfStatus) to prevent races
 *   - Does NOT sign, submit, or create queue records
 *   - Does NOT change confirmed/failed/dead_letter executions
 *   - Does NOT retry submission on network error or not_found
 *   - A `submitted` execution still `not_found` after maxAgeMs is retired to
 *     `failed` (atomic updateIfStatus, so a concurrent confirm wins the race
 *     and the retire is a no-op). `network_error` never ages an execution.
 *   - Stops cleanly on server shutdown
 *
 * The same tick also runs `reconcileFailedActivities` (#277): direct-path
 * activities left `failed` with a `txHash` are corrected from Horizon
 * state. That pass is read-only — it never submits — and is a no-op
 * without an activity store.
 */
export class TransactionStatusReconciler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private intervalMs: number;
  private clock: () => Date;
  private maxAgeMs: number;
  private activityStore?: ActivityStore | (Pick<ActivityStore, "releaseDailySpending"> & Partial<ActivityStore>);
  private approvalStore?: ApprovalStore | Partial<ApprovalStore>;

  constructor(
    private executionStore: ExecutionStore,
    private statusProvider: TransactionStatusProvider,
    options: ReconcilerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.clock = options.clock ?? (() => new Date());
    if (
      options.maxAgeMs !== undefined &&
      (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs <= 0)
    ) {
      throw new Error(
        `Invalid reconciler maxAgeMs: expected a positive number of milliseconds, got '${options.maxAgeMs}'.`
      );
    }
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_SUBMITTED_MAX_AGE_MS;
    this.activityStore = options.activityStore;
    this.approvalStore = options.approvalStore;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Single reconciliation pass — queries Horizon for all submitted executions
   * and updates their status based on on-chain state.
   */
  async reconcile(): Promise<ReconciliationResult> {
    const result: ReconciliationResult = {
      checked: 0,
      confirmed: 0,
      failed: 0,
      retired: 0,
      skipped: 0,
      errors: 0,
    };

    try {
      const executions = await this.executionStore.listSubmitted();
      result.checked = executions.length;

      for (const execution of executions) {
        if (!execution.txHash) {
          result.skipped++;
          continue;
        }

        let status: TransactionStatus;
        try {
          status = await this.statusProvider.getStatus(execution.txHash);
        } catch (_err) {
          result.errors++;
          continue;
        }

        if (status === "confirmed") {
          const updated = await this.executionStore.updateIfStatus(
            execution.id,
            "submitted",
            { status: "confirmed", completedAt: this.clock().toISOString(), updatedAt: this.clock().toISOString(), nextRetryAt: null }
          );
          if (updated) result.confirmed++;
        } else if (status === "failed") {
          const updated = await this.executionStore.updateIfStatus(
            execution.id,
            "submitted",
            // #378: a terminal on-chain outcome carries no retry schedule.
            // Without this, a stale nextRetryAt from an earlier attempt
            // would survive on the failed record (complete() clears it on
            // submit, but a record submitted before that fix keeps it).
            { status: "failed", error: "Transaction failed on-chain", updatedAt: this.clock().toISOString(), nextRetryAt: null }
          );
          if (updated) {
            result.failed++;
            await this.syncFailedOnChain(execution, "Transaction failed on-chain");
          }
        } else if (status === "not_found") {
          await this.retireIfOverAge(execution, result);
        }
        // network_error: leave as submitted, will retry next tick. A Horizon
        // outage must not consume the not_found age budget, so it can never
        // retire an execution on its own.
      }
    } catch (_err) {
      result.errors++;
    }

    return result;
  }

  /**
   * Reconcile direct-path activities left `failed` with a `txHash` (#277).
   *
   * Direct POST /agents/:id/intents creates only an ActivityRecord, so a
   * submission that fails ambiguously (e.g. a Horizon timeout after the
   * transaction was accepted) is never seen by the submitted-execution
   * pass above. This pass scans failed activities carrying a txHash and
   * corrects them from Horizon state:
   *   - `confirmed` → status `submitted` (the pipeline's post-submit
   *     state; ActivityStatus has no `confirmed` value), error annotated
   *     with the correction. The original submit error is preserved.
   *   - `failed` on-chain → status stays `failed`; only the error text
   *     is corrected to the on-chain outcome (once).
   *   - `not_found` → stays `failed` with the ambiguity marker appended
   *     to `error` (once); re-checked on later ticks.
   *   - `network_error` (or a provider throw) → untouched, retried later.
   *
   * SAFETY: read-only correction. The pass only calls the status
   * provider (a Horizon GET) and `ActivityStore.update` — it never
   * signs, submits, or creates executions or approvals. Each write is
   * guarded by a fresh read: only a record still `failed` with the same
   * txHash is written, so a concurrent correction wins the race and this
   * pass is a no-op for it. Re-running the pass is a no-op for corrected
   * records (they are no longer `failed`) and for already-marked ones.
   */
  async reconcileFailedActivities(): Promise<FailedActivityReconciliationResult> {
    const result: FailedActivityReconciliationResult = {
      checked: 0,
      corrected: 0,
      ambiguous: 0,
      onChainFailed: 0,
      skipped: 0,
      errors: 0,
    };
    const store = this.activityStore;
    if (
      !store ||
      typeof store.listAll !== "function" ||
      typeof store.get !== "function" ||
      typeof store.update !== "function"
    ) {
      return result;
    }
    // Bind the guarded methods: the partial stand-in may only carry
    // these three, and the pass must not assume the rest of the store.
    // (Binding keeps `this` for the in-memory/SQLite implementations.)
    const activityStore: Pick<ActivityStore, "listAll" | "get" | "update"> = {
      listAll: store.listAll.bind(store),
      get: store.get.bind(store),
      update: store.update.bind(store),
    };
    try {
      // Paginated scan: updates never change listAll ordering (createdAt),
      // so offset paging is stable across pages even as records are
      // corrected. Mirrors the paginated daily-spending scan in
      // @4evergent/policy.
      const PAGE_SIZE = 200;
      let offset = 0;
      for (;;) {
        let page: ActivityRecord[];
        try {
          page = await activityStore.listAll(PAGE_SIZE, offset);
        } catch (_err) {
          result.errors++;
          return result;
        }
        if (page.length === 0) break;
        for (const activity of page) {
          await this.reconcileFailedActivity(activityStore, activity, result);
        }
        if (page.length < PAGE_SIZE) break;
        offset += page.length;
      }
    } catch (_err) {
      result.errors++;
    }
    return result;
  }

  private async reconcileFailedActivity(
    store: Pick<ActivityStore, "get" | "update">,
    activity: ActivityRecord,
    result: FailedActivityReconciliationResult
  ): Promise<void> {
    if (activity.status !== "failed") return;
    if (!activity.txHash) {
      result.skipped++;
      return;
    }
    result.checked++;

    let status: TransactionStatus;
    try {
      status = await this.statusProvider.getStatus(activity.txHash);
    } catch (_err) {
      result.errors++;
      return;
    }
    // network_error: leave untouched, retried next tick. A Horizon outage
    // must not rewrite the record or consume any retry budget — same rule
    // as the submitted-execution pass above.
    if (status === "network_error") return;

    const now = this.clock().toISOString();
    if (status === "confirmed") {
      const updated = await this.updateFailedActivity(store, activity, {
        status: "submitted",
        error: annotateError(
          activity.error,
          "Reconciled: transaction confirmed on-chain after ambiguous submission failure"
        ),
        updatedAt: now,
      });
      if (updated) result.corrected++;
    } else if (status === "failed") {
      // The transaction itself failed on-chain: the activity is already
      // `failed`, so only the error text is corrected (once).
      const note = "Transaction failed on-chain";
      if (activity.error?.includes(note)) return;
      const updated = await this.updateFailedActivity(store, activity, {
        error: annotateError(activity.error, note),
        updatedAt: now,
      });
      if (updated) result.onChainFailed++;
    } else {
      // not_found: genuinely unknown — stay failed, mark once.
      if (activity.error?.includes(FAILED_ACTIVITY_AMBIGUOUS_MARKER)) return;
      const updated = await this.updateFailedActivity(store, activity, {
        error: annotateError(activity.error, FAILED_ACTIVITY_AMBIGUOUS_MARKER),
        updatedAt: now,
      });
      if (updated) result.ambiguous++;
    }
  }

  /**
   * Write `patch` to a failed activity only if a fresh read still shows
   * it `failed` with the same txHash. A concurrent correction (or any
   * other writer) wins the race and this write becomes a no-op.
   * Best-effort: a store failure is logged and never aborts the pass.
   */
  private async updateFailedActivity(
    store: Pick<ActivityStore, "get" | "update">,
    activity: ActivityRecord,
    patch: Partial<ActivityRecord>
  ): Promise<boolean> {
    try {
      const fresh = await store.get(activity.id);
      if (!fresh || fresh.status !== "failed" || fresh.txHash !== activity.txHash) return false;
      const updated = await store.update(activity.id, patch);
      return updated !== null;
    } catch (err) {
      console.warn(`[reconciler] failed to update activity ${activity.id}:`, err);
      return false;
    }
  }

  /**
   * Retire a `submitted` execution that Horizon still reports `not_found`
   * after maxAgeMs: it never landed (dropped from mempool, timebounds
   * expired, fee too low) and would otherwise be polled forever.
   *
   * AGE ANCHOR — `updatedAt`: there is no `submittedAt` field. `updatedAt`
   * is bumped on every transition into `submitted` (execution-queue
   * `complete()`, recovery pre-check) and nothing writes a `submitted`
   * record without changing its status, so for a record still `submitted`
   * it is the time the record entered `submitted`. `createdAt` would wrongly
   * include the time spent queued before submission; `startedAt` is when the
   * record entered `executing`, i.e. before submission. An unparseable
   * timestamp is treated as young (never retired) rather than failing.
   *
   * The transition is guarded by updateIfStatus: if a concurrent confirm
   * already moved the record out of `submitted`, the retire loses the race
   * and the reservation is NOT released.
   */
  private async retireIfOverAge(
    execution: ExecutionRecord,
    result: ReconciliationResult
  ): Promise<void> {
    const submittedAtMs = Date.parse(execution.updatedAt);
    if (!Number.isFinite(submittedAtMs)) return;
    const ageMs = this.clock().getTime() - submittedAtMs;
    if (ageMs < this.maxAgeMs) return;

    const updated = await this.executionStore.updateIfStatus(
      execution.id,
      "submitted",
      {
        status: "failed",
        error: `Transaction not found on-chain after ${formatDuration(this.maxAgeMs)}; presumed dropped (never landed)`,
        updatedAt: this.clock().toISOString(),
      }
    );
    if (!updated) return;
    result.failed++;
    result.retired++;
    await this.releaseReservation(execution);
  }

  /**
   * Release the daily-spending reservation recorded on a decision (#353).
   * No-op when the decision reserved nothing or the store cannot release.
   * A release failure is swallowed: the outcome being reported must not be
   * masked by a bookkeeping error; the stale row is swept at the day
   * boundary. Mirrors TransactionPipeline.releaseReservation.
   */
  private async releaseReservation(execution: ExecutionRecord): Promise<void> {
    const reserved = execution.policyDecision?.reservedDailySpending;
    if (!reserved || !this.activityStore?.releaseDailySpending) return;
    try {
      await this.activityStore.releaseDailySpending(execution.agentId, reserved.asset, reserved.amount);
    } catch {
      // Best-effort bookkeeping — see above.
    }
  }

  /**
   * Synchronize on-chain failure to linked activity and approval (#363).
   *
   * Best-effort:
   *   - Updates linked approval from `submitted` -> `failed` with on-chain error.
   *   - Updates linked activity from `submitted` -> `failed` with on-chain error,
   *     preserving txHash.
   *   - Errors or missing records are logged/swallowed; the execution failure
   *     remains the source of truth and the reconciler pass is never aborted.
   */
  private async syncFailedOnChain(execution: ExecutionRecord, errorMessage: string): Promise<void> {
    const now = this.clock().toISOString();

    // 1. Move linked approval from submitted -> failed
    if (execution.approvalId && this.approvalStore) {
      try {
        if (typeof this.approvalStore.updateIfStatus === "function") {
          await this.approvalStore.updateIfStatus(execution.approvalId, "submitted", {
            status: "failed",
            error: errorMessage,
            updatedAt: now,
          });
        } else if (typeof this.approvalStore.get === "function" && typeof this.approvalStore.update === "function") {
          const approval = await this.approvalStore.get(execution.approvalId);
          if (approval && approval.status === "submitted") {
            await this.approvalStore.update(execution.approvalId, {
              status: "failed",
              error: errorMessage,
              updatedAt: now,
            });
          }
        }
      } catch (err) {
        console.warn(`[reconciler] failed to update approval ${execution.approvalId} on on-chain failure:`, err);
      }
    }

    // 2. Determine activityId: either from execution or falling back to linked approval
    let activityId = execution.activityId;
    if (!activityId && execution.approvalId && this.approvalStore && typeof this.approvalStore.get === "function") {
      try {
        const approval = await this.approvalStore.get(execution.approvalId);
        if (approval?.activityId) {
          activityId = approval.activityId;
        }
      } catch {
        // Best-effort lookup
      }
    }

    // 3. Move linked activity from submitted -> failed, preserving txHash
    if (activityId && this.activityStore) {
      try {
        if (typeof (this.activityStore as any).updateIfStatus === "function") {
          await (this.activityStore as any).updateIfStatus(activityId, "submitted", {
            status: "failed",
            error: errorMessage,
            updatedAt: now,
          });
        } else if (typeof this.activityStore.get === "function" && typeof this.activityStore.update === "function") {
          const act = await this.activityStore.get(activityId);
          if (act && act.status === "submitted") {
            await this.activityStore.update(activityId, {
              status: "failed",
              error: errorMessage,
              updatedAt: now,
            });
          }
        }
      } catch (err) {
        console.warn(`[reconciler] failed to update activity ${activityId} on on-chain failure:`, err);
      }
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.reconcile();
      // #277: correct direct-path failed activities carrying a txHash.
      // Best-effort like the execution pass: a failure inside is
      // contained (errors counted, never thrown), so the loop survives.
      await this.reconcileFailedActivities();
    } catch (err) {
      console.error("[reconciler] tick error:", err);
    }
    if (!this.running) return;
    this.timer = setTimeout(() => { void this.tick(); }, this.intervalMs);
  }
}

/**
 * Append a reconciliation note to an existing error, preserving the
 * original text (the audit trail). A null error becomes just the note.
 */
function annotateError(existing: string | null, note: string): string {
  return existing ? `${existing} | ${note}` : note;
}

/** Human-readable duration for retire error messages: 6h, 90m, 5000ms. */
function formatDuration(ms: number): string {
  if (ms >= 3_600_000) {
    const hours = ms / 3_600_000;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  if (ms >= 60_000) {
    const minutes = ms / 60_000;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
  }
  return `${ms}ms`;
}

export interface ReconciliationResult {
  checked: number;
  confirmed: number;
  failed: number;
  /** Subset of `failed`: over-age `not_found` executions retired by this pass. */
  retired: number;
  skipped: number;
  errors: number;
}
