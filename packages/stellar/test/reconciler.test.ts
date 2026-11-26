import { test } from "node:test";
import assert from "node:assert/strict";
import { TransactionStatusReconciler, FAILED_ACTIVITY_AMBIGUOUS_MARKER } from "../src/reconciler.js";
import { InMemoryExecutionStore, InMemoryActivityStore, InMemoryApprovalStore } from "@4evergent/database";
import type { ExecutionRecord, ActivityRecord, ApprovalRecord } from "@4evergent/database";

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    agentId: "agent-a",
    approvalId: null,
    activityId: null,
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "10", reason: "test" },
    status: "submitted",
    policyDecision: null,
    simulationResult: null,
    txHash: "tx-hash-123",
    error: null,
    attempt: 1,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeActivity(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: "agent-a",
    ownerId: "owner-a",
    idempotencyKey: null,
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "10", reason: "test" },
    policyDecision: { result: "allow", reason: "test", rule: "default" },
    authorizationStatus: "authorized",
    simulationResult: null,
    txHash: "tx-hash-123",
    status: "submitted",
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeApproval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    activityId: "act-1",
    agentId: "agent-a",
    ownerId: "owner-a",
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "10", reason: "test" },
    policyDecision: { result: "requires_approval", reason: "test", rule: "default" },
    status: "submitted",
    requestedAt: now,
    approvedAt: now,
    rejectedAt: null,
    expiredAt: null,
    approver: "approver-1",
    expiresAt: null,
    txHash: "tx-hash-123",
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("Reconciler: submitted + confirmed → confirmed", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "submitted", txHash: "tx-1" });
  await store.record(execution);

  const provider = {
    getStatus: async () => "confirmed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.confirmed, 1);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "confirmed");
  assert.ok(updated?.completedAt);
});

test("Reconciler: submitted + failed → failed", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "submitted", txHash: "tx-2" });
  await store.record(execution);

  const provider = {
    getStatus: async () => "failed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.failed, 1);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "failed");
});

test("Reconciler: submitted + not_found → remains submitted", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "submitted", txHash: "tx-3" });
  await store.record(execution);

  const provider = {
    getStatus: async () => "not_found" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.confirmed, 0);
  assert.equal(result.failed, 0);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "submitted");
});

test("Reconciler: submitted + network_error → remains submitted", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "submitted", txHash: "tx-4" });
  await store.record(execution);

  const provider = {
    getStatus: async () => "network_error" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.confirmed, 0);
  assert.equal(result.failed, 0);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "submitted");
});

test("Reconciler: txHash missing → safely skipped", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "submitted", txHash: null });
  await store.record(execution);

  const provider = {
    getStatus: async () => "confirmed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.confirmed, 0);
});

test("Reconciler: confirmed execution is not reprocessed", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "confirmed", txHash: "tx-5" });
  await store.record(execution);

  const provider = {
    getStatus: async () => "confirmed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 0);
  assert.equal(result.confirmed, 0);
});

test("Reconciler: concurrency — execution changes from submitted before update → conditional update prevents stale mutation", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "submitted", txHash: "tx-6" });
  await store.record(execution);

  const provider = {
    getStatus: async () => "confirmed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });

  // Simulate concurrent state change: another actor moves execution to failed
  await store.update(execution.id, { status: "failed" });

  const result = await reconciler.reconcile();

  // Should not update because status changed from submitted to failed
  assert.equal(result.confirmed, 0);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "failed");
});

test("Reconciler: start/stop lifecycle", async () => {
  const store = new InMemoryExecutionStore();
  const provider = {
    getStatus: async () => "confirmed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });

  assert.equal(reconciler.isRunning(), false);
  reconciler.start();
  assert.equal(reconciler.isRunning(), true);
  reconciler.stop();
  assert.equal(reconciler.isRunning(), false);
});

test("Reconciler: failed outcome clears the stale retry schedule (#378)", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({
    status: "submitted",
    txHash: "tx-5",
    nextRetryAt: "2020-01-01T00:00:00.000Z",
  });
  await store.record(execution);

  const provider = {
    getStatus: async () => "failed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.failed, 1);
  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "failed");
  assert.equal(updated?.nextRetryAt, null);
});

test("Reconciler: confirmed outcome clears the stale retry schedule (#378)", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({
    status: "submitted",
    txHash: "tx-6",
    nextRetryAt: "2020-01-01T00:00:00.000Z",
  });
  await store.record(execution);

  const provider = {
    getStatus: async () => "confirmed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.confirmed, 1);
  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "confirmed");
  assert.equal(updated?.nextRetryAt, null);
});

// --- #276: retire over-age not_found executions stuck in submitted ---

// Fixed clock so age is deterministic: "now" is 2026-11-19T00:00:00Z and
// record ages are set relative to it via updatedAt (the age anchor:
// updatedAt is bumped on every transition into `submitted`).
const FIXED_NOW = new Date("2026-11-19T00:00:00.000Z");
const HOUR_MS = 60 * 60_000;

function makeAgedExecution(ageMs: number, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const at = new Date(FIXED_NOW.getTime() - ageMs).toISOString();
  return makeExecution({ createdAt: at, updatedAt: at, ...overrides });
}

function makeReservedDecision(): NonNullable<ExecutionRecord["policyDecision"]> {
  return {
    result: "allow",
    reason: "test",
    rule: "default",
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "10", reason: "test" },
    reservedDailySpending: { asset: "XLM", amount: "10" },
  };
}

test("Reconciler #276: young not_found stays submitted", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(1 * HOUR_MS, { txHash: "tx-young" });
  await store.record(execution);

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, { clock: () => FIXED_NOW });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.retired, 0);
  assert.equal((await store.get(execution.id))?.status, "submitted");
});

test("Reconciler #276: over-age not_found retires to failed with a clear error", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(7 * HOUR_MS, { txHash: "tx-old" });
  await store.record(execution);

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, { clock: () => FIXED_NOW });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.retired, 1);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "failed");
  assert.match(updated?.error ?? "", /not found on-chain after 6h/);
});

test("Reconciler #276: network_error never retires, even over-age", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(7 * HOUR_MS, { txHash: "tx-neterr" });
  await store.record(execution);

  const provider = { getStatus: async () => "network_error" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, { clock: () => FIXED_NOW });
  const result = await reconciler.reconcile();

  assert.equal(result.failed, 0);
  assert.equal(result.retired, 0);
  assert.equal((await store.get(execution.id))?.status, "submitted");
});

test("Reconciler #276: over-age confirmed still confirms (not retired)", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(7 * HOUR_MS, { txHash: "tx-old-confirmed" });
  await store.record(execution);

  const provider = { getStatus: async () => "confirmed" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, { clock: () => FIXED_NOW });
  const result = await reconciler.reconcile();

  assert.equal(result.confirmed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.retired, 0);
  assert.equal((await store.get(execution.id))?.status, "confirmed");
});

test("Reconciler #276: over-age on-chain failed still fails (not counted as retired)", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(7 * HOUR_MS, { txHash: "tx-old-failed" });
  await store.record(execution);

  const provider = { getStatus: async () => "failed" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, { clock: () => FIXED_NOW });
  const result = await reconciler.reconcile();

  assert.equal(result.failed, 1);
  assert.equal(result.retired, 0);
  assert.equal((await store.get(execution.id))?.status, "failed");
});

test("Reconciler #276: max age is configurable via options", async () => {
  const store = new InMemoryExecutionStore();
  const justOver = makeAgedExecution(61_000, { txHash: "tx-61s" });
  const justUnder = makeAgedExecution(30_000, { txHash: "tx-30s" });
  await store.record(justOver);
  await store.record(justUnder);

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, {
    clock: () => FIXED_NOW,
    maxAgeMs: 60_000,
  });
  const result = await reconciler.reconcile();

  assert.equal(result.retired, 1);
  assert.equal((await store.get(justOver.id))?.status, "failed");
  assert.equal((await store.get(justUnder.id))?.status, "submitted");
});

test("Reconciler #276: unparseable updatedAt is treated as young, never retired", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ txHash: "tx-bad-ts", updatedAt: "not-a-date" });
  await store.record(execution);

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, { clock: () => FIXED_NOW });
  const result = await reconciler.reconcile();

  assert.equal(result.retired, 0);
  assert.equal((await store.get(execution.id))?.status, "submitted");
});

test("Reconciler #276: invalid maxAgeMs fails fast", async () => {
  const store = new InMemoryExecutionStore();
  const provider = { getStatus: async () => "not_found" as const };
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new TransactionStatusReconciler(store, provider, { maxAgeMs: bad }),
      /maxAgeMs/
    );
  }
});

test("Reconciler #276: retire releases the proven reservation exactly once", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(7 * HOUR_MS, {
    txHash: "tx-retire-release",
    policyDecision: makeReservedDecision(),
  });
  await store.record(execution);

  const releases: Array<[string, string, string]> = [];
  const activityStore = {
    releaseDailySpending: async (agentId: string, asset: string, amount: string) => {
      releases.push([agentId, asset, amount]);
    },
  };

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, {
    clock: () => FIXED_NOW,
    activityStore,
  });
  const result = await reconciler.reconcile();

  assert.equal(result.retired, 1);
  assert.deepEqual(releases, [["agent-a", "XLM", "10"]]);

  // Second pass: already failed, no longer submitted — no second release.
  const second = await reconciler.reconcile();
  assert.equal(second.checked, 0);
  assert.deepEqual(releases, [["agent-a", "XLM", "10"]]);
});

test("Reconciler #276: no release without proof of reservation, or when young", async () => {
  const store = new InMemoryExecutionStore();
  const oldNoProof = makeAgedExecution(7 * HOUR_MS, { txHash: "tx-old-noproof" });
  const youngWithProof = makeAgedExecution(1 * HOUR_MS, {
    txHash: "tx-young-proof",
    policyDecision: makeReservedDecision(),
  });
  await store.record(oldNoProof);
  await store.record(youngWithProof);

  const releases: Array<[string, string, string]> = [];
  const activityStore = {
    releaseDailySpending: async (agentId: string, asset: string, amount: string) => {
      releases.push([agentId, asset, amount]);
    },
  };

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, {
    clock: () => FIXED_NOW,
    activityStore,
  });
  const result = await reconciler.reconcile();

  assert.equal(result.retired, 1); // only the old record without proof
  assert.deepEqual(releases, []);
});

test("Reconciler #276: a release failure never masks the retire", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(7 * HOUR_MS, {
    txHash: "tx-release-fails",
    policyDecision: makeReservedDecision(),
  });
  await store.record(execution);

  const activityStore = {
    releaseDailySpending: async () => {
      throw new Error("store down");
    },
  };

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, {
    clock: () => FIXED_NOW,
    activityStore,
  });
  const result = await reconciler.reconcile();

  assert.equal(result.retired, 1);
  assert.equal((await store.get(execution.id))?.status, "failed");
});

test("Reconciler #363: on-chain failed transaction transitions linked activity and approval to failed with error", async () => {
  const executionStore = new InMemoryExecutionStore();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();

  const activity = makeActivity({ status: "submitted", txHash: "tx-fail-363" });
  await activityStore.record(activity);

  const approval = makeApproval({ activityId: activity.id, status: "submitted", txHash: "tx-fail-363" });
  await approvalStore.record(approval);

  const execution = makeExecution({
    status: "submitted",
    txHash: "tx-fail-363",
    activityId: activity.id,
    approvalId: approval.id,
  });
  await executionStore.record(execution);

  const provider = { getStatus: async () => "failed" as const };
  const reconciler = new TransactionStatusReconciler(executionStore, provider, {
    activityStore,
    approvalStore,
  });

  const result = await reconciler.reconcile();
  assert.equal(result.failed, 1);

  const updatedExecution = await executionStore.get(execution.id);
  assert.equal(updatedExecution?.status, "failed");
  assert.equal(updatedExecution?.error, "Transaction failed on-chain");

  const updatedActivity = await activityStore.get(activity.id);
  assert.equal(updatedActivity?.status, "failed");
  assert.equal(updatedActivity?.error, "Transaction failed on-chain");
  assert.equal(updatedActivity?.txHash, "tx-fail-363");

  const updatedApproval = await approvalStore.get(approval.id);
  assert.equal(updatedApproval?.status, "failed");
  assert.equal(updatedApproval?.error, "Transaction failed on-chain");
  assert.equal(updatedApproval?.txHash, "tx-fail-363");
});

test("Reconciler #363: confirmed on-chain transaction leaves linked activity and approval untouched", async () => {
  const executionStore = new InMemoryExecutionStore();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();

  const activity = makeActivity({ status: "submitted", txHash: "tx-confirm-363", error: null });
  await activityStore.record(activity);

  const approval = makeApproval({ activityId: activity.id, status: "submitted", txHash: "tx-confirm-363", error: null });
  await approvalStore.record(approval);

  const execution = makeExecution({
    status: "submitted",
    txHash: "tx-confirm-363",
    activityId: activity.id,
    approvalId: approval.id,
  });
  await executionStore.record(execution);

  const provider = { getStatus: async () => "confirmed" as const };
  const reconciler = new TransactionStatusReconciler(executionStore, provider, {
    activityStore,
    approvalStore,
  });

  const result = await reconciler.reconcile();
  assert.equal(result.confirmed, 1);

  const updatedExecution = await executionStore.get(execution.id);
  assert.equal(updatedExecution?.status, "confirmed");

  const updatedActivity = await activityStore.get(activity.id);
  assert.equal(updatedActivity?.status, "submitted");
  assert.equal(updatedActivity?.error, null);
  assert.equal(updatedActivity?.txHash, "tx-confirm-363");

  const updatedApproval = await approvalStore.get(approval.id);
  assert.equal(updatedApproval?.status, "submitted");
  assert.equal(updatedApproval?.error, null);
  assert.equal(updatedApproval?.txHash, "tx-confirm-363");
});

test("Reconciler #363: failure with null activityId and approvalId reconciles cleanly", async () => {
  const executionStore = new InMemoryExecutionStore();
  const execution = makeExecution({
    status: "submitted",
    txHash: "tx-null-links",
    activityId: null,
    approvalId: null,
  });
  await executionStore.record(execution);

  const provider = { getStatus: async () => "failed" as const };
  const reconciler = new TransactionStatusReconciler(executionStore, provider);

  const result = await reconciler.reconcile();
  assert.equal(result.failed, 1);
  assert.equal(result.errors, 0);

  const updatedExecution = await executionStore.get(execution.id);
  assert.equal(updatedExecution?.status, "failed");
  assert.equal(updatedExecution?.error, "Transaction failed on-chain");
});

test("Reconciler #363: failure of activity/approval update does not break reconciler pass", async () => {
  const executionStore = new InMemoryExecutionStore();
  const execution = makeExecution({
    status: "submitted",
    txHash: "tx-store-throws",
    activityId: "act-err",
    approvalId: "app-err",
  });
  await executionStore.record(execution);

  const badActivityStore = {
    get: async () => {
      throw new Error("activity store offline");
    },
    update: async () => {
      throw new Error("activity store offline");
    },
    releaseDailySpending: async () => {},
  };

  const badApprovalStore = {
    updateIfStatus: async () => {
      throw new Error("approval store offline");
    },
  };

  const provider = { getStatus: async () => "failed" as const };
  const reconciler = new TransactionStatusReconciler(executionStore, provider, {
    activityStore: badActivityStore as any,
    approvalStore: badApprovalStore as any,
  });

  const result = await reconciler.reconcile();
  assert.equal(result.failed, 1);
  assert.equal(result.errors, 0);

  const updatedExecution = await executionStore.get(execution.id);
  assert.equal(updatedExecution?.status, "failed");
  assert.equal(updatedExecution?.error, "Transaction failed on-chain");
});

test("Reconciler #363: activity and approval not in submitted status are not overwritten", async () => {
  const executionStore = new InMemoryExecutionStore();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();

  const activity = makeActivity({ status: "requires_approval", txHash: "tx-not-submitted" });
  await activityStore.record(activity);

  const approval = makeApproval({ activityId: activity.id, status: "rejected", txHash: "tx-not-submitted" });
  await approvalStore.record(approval);

  const execution = makeExecution({
    status: "submitted",
    txHash: "tx-not-submitted",
    activityId: activity.id,
    approvalId: approval.id,
  });
  await executionStore.record(execution);

  const provider = { getStatus: async () => "failed" as const };
  const reconciler = new TransactionStatusReconciler(executionStore, provider, {
    activityStore,
    approvalStore,
  });

  const result = await reconciler.reconcile();
  assert.equal(result.failed, 1);

  const updatedActivity = await activityStore.get(activity.id);
  assert.equal(updatedActivity?.status, "requires_approval");

  const updatedApproval = await approvalStore.get(approval.id);
  assert.equal(updatedApproval?.status, "rejected");
});

test("Reconciler #363: discovers linked activity from approval when execution.activityId is null", async () => {
  const executionStore = new InMemoryExecutionStore();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();

  const activity = makeActivity({ status: "submitted", txHash: "tx-via-approval" });
  await activityStore.record(activity);

  const approval = makeApproval({ activityId: activity.id, status: "submitted", txHash: "tx-via-approval" });
  await approvalStore.record(approval);

  const execution = makeExecution({
    status: "submitted",
    txHash: "tx-via-approval",
    activityId: null,
    approvalId: approval.id,
  });
  await executionStore.record(execution);

  const provider = { getStatus: async () => "failed" as const };
  const reconciler = new TransactionStatusReconciler(executionStore, provider, {
    activityStore,
    approvalStore,
  });

  const result = await reconciler.reconcile();
  assert.equal(result.failed, 1);

  const updatedActivity = await activityStore.get(activity.id);
  assert.equal(updatedActivity?.status, "failed");
  assert.equal(updatedActivity?.error, "Transaction failed on-chain");
  assert.equal(updatedActivity?.txHash, "tx-via-approval");

  const updatedApproval = await approvalStore.get(approval.id);
  assert.equal(updatedApproval?.status, "failed");
  assert.equal(updatedApproval?.error, "Transaction failed on-chain");
});

// ---- Issue #277: reconcile failed activities carrying a txHash ----

function makeFailedActivityReconciler(
  activityStore: InMemoryActivityStore,
  provider: { getStatus(txHash: string): Promise<"confirmed" | "failed" | "not_found" | "network_error"> },
  extra: { approvalStore?: InMemoryApprovalStore } = {}
) {
  const executionStore = new InMemoryExecutionStore();
  const reconciler = new TransactionStatusReconciler(executionStore, provider, {
    activityStore,
    approvalStore: extra.approvalStore,
  });
  return { executionStore, reconciler };
}

test("Reconciler #277: failed + confirmed → submitted (landed after timeout)", async () => {
  const activityStore = new InMemoryActivityStore();
  const activity = makeActivity({
    status: "failed",
    txHash: "tx-277-landed",
    error: "Horizon timeout",
  });
  await activityStore.record(activity);

  const provider = { getStatus: async () => "confirmed" as const };
  const { executionStore, reconciler } = makeFailedActivityReconciler(activityStore, provider);

  const result = await reconciler.reconcileFailedActivities();
  assert.equal(result.checked, 1);
  assert.equal(result.corrected, 1);
  assert.equal(result.ambiguous, 0);
  assert.equal(result.errors, 0);

  const updated = await activityStore.get(activity.id);
  assert.equal(updated?.status, "submitted");
  assert.equal(updated?.txHash, "tx-277-landed");
  // The audit trail is preserved: the original submit error stays, with
  // the correction noted alongside it.
  assert.match(updated?.error ?? "", /Horizon timeout/);
  assert.match(updated?.error ?? "", /confirmed on-chain/);

  // The pass never creates executions or approvals: read-only correction.
  assert.equal((await executionStore.listSubmitted()).length, 0);
});

test("Reconciler #277: failed + not_found → stays failed with ambiguity marker, re-run is a no-op", async () => {
  const activityStore = new InMemoryActivityStore();
  const activity = makeActivity({
    status: "failed",
    txHash: "tx-277-unknown",
    error: "Horizon timeout",
  });
  await activityStore.record(activity);

  const provider = { getStatus: async () => "not_found" as const };
  const { reconciler } = makeFailedActivityReconciler(activityStore, provider);

  const first = await reconciler.reconcileFailedActivities();
  assert.equal(first.checked, 1);
  assert.equal(first.ambiguous, 1);
  assert.equal(first.corrected, 0);

  const afterFirst = await activityStore.get(activity.id);
  assert.equal(afterFirst?.status, "failed");
  assert.equal(afterFirst?.txHash, "tx-277-unknown");
  assert.ok((afterFirst?.error ?? "").includes(FAILED_ACTIVITY_AMBIGUOUS_MARKER));
  assert.match(afterFirst?.error ?? "", /Horizon timeout/);

  // Second run: the marker is already there, so nothing is written again.
  const second = await reconciler.reconcileFailedActivities();
  assert.equal(second.checked, 1);
  assert.equal(second.ambiguous, 0);
  const afterSecond = await activityStore.get(activity.id);
  assert.equal(afterSecond?.error, afterFirst?.error);
});

test("Reconciler #277: failed + network_error → unchanged, retried later", async () => {
  const activityStore = new InMemoryActivityStore();
  const activity = makeActivity({
    status: "failed",
    txHash: "tx-277-flaky",
    error: "Horizon timeout",
  });
  await activityStore.record(activity);

  let next: "confirmed" | "failed" | "not_found" | "network_error" = "network_error";
  const provider = { getStatus: async () => next };
  const { reconciler } = makeFailedActivityReconciler(activityStore, provider);

  const first = await reconciler.reconcileFailedActivities();
  assert.equal(first.checked, 1);
  assert.equal(first.corrected, 0);
  assert.equal(first.ambiguous, 0);
  assert.equal(first.errors, 0);

  const untouched = await activityStore.get(activity.id);
  assert.equal(untouched?.status, "failed");
  assert.equal(untouched?.error, "Horizon timeout");

  // Horizon recovers: the next pass corrects the record.
  next = "confirmed";
  const second = await reconciler.reconcileFailedActivities();
  assert.equal(second.corrected, 1);
  const corrected = await activityStore.get(activity.id);
  assert.equal(corrected?.status, "submitted");
});

test("Reconciler #277: provider throws → unchanged and counted, retried later", async () => {
  const activityStore = new InMemoryActivityStore();
  const activity = makeActivity({
    status: "failed",
    txHash: "tx-277-throw",
    error: "Horizon timeout",
  });
  await activityStore.record(activity);

  let throwing = true;
  const provider = {
    getStatus: async () => {
      if (throwing) throw new Error("boom");
      return "confirmed" as const;
    },
  };
  const { reconciler } = makeFailedActivityReconciler(activityStore, provider);

  const first = await reconciler.reconcileFailedActivities();
  assert.equal(first.checked, 1);
  assert.equal(first.errors, 1);
  assert.equal(first.corrected, 0);
  const untouched = await activityStore.get(activity.id);
  assert.equal(untouched?.status, "failed");
  assert.equal(untouched?.error, "Horizon timeout");

  throwing = false;
  const second = await reconciler.reconcileFailedActivities();
  assert.equal(second.corrected, 1);
  assert.equal(second.errors, 0);
});

test("Reconciler #277: failed without txHash → skipped", async () => {
  const activityStore = new InMemoryActivityStore();
  const activity = makeActivity({ status: "failed", txHash: null, error: "simulation failed" });
  await activityStore.record(activity);

  const provider = { getStatus: async () => "confirmed" as const };
  const { reconciler } = makeFailedActivityReconciler(activityStore, provider);

  const result = await reconciler.reconcileFailedActivities();
  assert.equal(result.checked, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.corrected, 0);

  const untouched = await activityStore.get(activity.id);
  assert.equal(untouched?.status, "failed");
  assert.equal(untouched?.error, "simulation failed");
});

test("Reconciler #277: already-corrected record is a no-op on re-run", async () => {
  const activityStore = new InMemoryActivityStore();
  const activity = makeActivity({
    status: "failed",
    txHash: "tx-277-done",
    error: "Horizon timeout",
  });
  await activityStore.record(activity);

  const provider = { getStatus: async () => "confirmed" as const };
  const { reconciler } = makeFailedActivityReconciler(activityStore, provider);

  const first = await reconciler.reconcileFailedActivities();
  assert.equal(first.corrected, 1);

  // The record is no longer `failed`, so the next pass has nothing to do.
  const second = await reconciler.reconcileFailedActivities();
  assert.equal(second.checked, 0);
  assert.equal(second.corrected, 0);
  assert.equal(second.ambiguous, 0);
  assert.equal(second.errors, 0);
  const still = await activityStore.get(activity.id);
  assert.equal(still?.status, "submitted");
});

test("Reconciler #277: on-chain failed → error annotated, stays failed, no duplicate annotation", async () => {
  const activityStore = new InMemoryActivityStore();
  const activity = makeActivity({
    status: "failed",
    txHash: "tx-277-onchain-fail",
    error: "Horizon timeout",
  });
  await activityStore.record(activity);

  const provider = { getStatus: async () => "failed" as const };
  const { reconciler } = makeFailedActivityReconciler(activityStore, provider);

  const first = await reconciler.reconcileFailedActivities();
  assert.equal(first.checked, 1);
  assert.equal(first.onChainFailed, 1);
  assert.equal(first.corrected, 0);

  const afterFirst = await activityStore.get(activity.id);
  assert.equal(afterFirst?.status, "failed");
  assert.match(afterFirst?.error ?? "", /Transaction failed on-chain/);

  const second = await reconciler.reconcileFailedActivities();
  assert.equal(second.onChainFailed, 0);
  const afterSecond = await activityStore.get(activity.id);
  assert.equal(afterSecond?.error, afterFirst?.error);
});

test("Reconciler #277: no activityStore → pass is a no-op", async () => {
  const executionStore = new InMemoryExecutionStore();
  const provider = { getStatus: async () => "confirmed" as const };
  const reconciler = new TransactionStatusReconciler(executionStore, provider, {
    intervalMs: 60000,
  });

  const result = await reconciler.reconcileFailedActivities();
  assert.equal(result.checked, 0);
  assert.equal(result.corrected, 0);
  assert.equal(result.ambiguous, 0);
  assert.equal(result.errors, 0);
});

test("Reconciler #277: non-failed activities are ignored", async () => {
  const activityStore = new InMemoryActivityStore();
  const submitted = makeActivity({ status: "submitted", txHash: "tx-277-live" });
  await activityStore.record(submitted);

  const provider = { getStatus: async () => "confirmed" as const };
  const { reconciler } = makeFailedActivityReconciler(activityStore, provider);

  const result = await reconciler.reconcileFailedActivities();
  assert.equal(result.checked, 0);
  assert.equal(result.corrected, 0);
  const untouched = await activityStore.get(submitted.id);
  assert.equal(untouched?.status, "submitted");
  assert.equal(untouched?.error, null);
});
