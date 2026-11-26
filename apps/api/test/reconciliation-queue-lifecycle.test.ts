/**
 * Integration tests for the ExecutionQueue + TransactionStatusReconciler lifecycle.
 *
 * Transition ownership contract enforced by these tests:
 *   - ExecutionQueue owns:
 *       queued -> executing -> submitted (on successful submission)
 *       queued -> executing -> failed / dead_letter (on submission failure / exhausted retries)
 *       failed -> queued (via manual retry(), subject to maxRetries)
 *   - TransactionStatusReconciler owns:
 *       submitted -> confirmed (when statusProvider returns "confirmed")
 *       submitted -> failed    (when statusProvider returns "failed", or "not_found" past maxAgeMs)
 *       submitted -> submitted (no-op when statusProvider returns "not_found" within maxAgeMs or "network_error")
 *   - Both use atomic conditional updates (updateIfStatus) so a concurrent state
 *     change between read and write cannot be overwritten by a stale update.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { DevAuthProvider } from "@4evergent/shared";
import {
  InMemoryExecutionStore,
  InMemoryActivityStore,
  InMemoryApprovalStore,
  InMemoryScheduleStore,
  InMemoryAgentStore,
} from "@4evergent/database";
import type { ExecutionRecord, ExecutionResult } from "@4evergent/database";
import {
  TransactionStatusReconciler,
  type TransactionStatus,
  type TransactionStatusProvider,
} from "@4evergent/stellar";

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    agentId: "agent-a",
    approvalId: "approval-1",
    activityId: null,
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
      amount: "10",
      reason: "lifecycle test",
    },
    status: "queued",
    policyDecision: null,
    simulationResult: null,
    txHash: null,
    error: null,
    attempt: 0,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface HarnessOptions {
  getStatus: (txHash: string) => Promise<TransactionStatus>;
  execute?: (record: ExecutionRecord) => Promise<ExecutionResult>;
  maxRetries?: number;
}

async function startLifecycleHarness(opts: HarnessOptions) {
  let currentNow = new Date("2026-01-01T00:00:00.000Z");
  const clock = () => currentNow;

  const executionStore = new InMemoryExecutionStore();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();
  const scheduleStore = new InMemoryScheduleStore();
  const agentStore = new InMemoryAgentStore();

  const statusProvider: TransactionStatusProvider = {
    getStatus: opts.getStatus,
  };

  const reconciler = new TransactionStatusReconciler(executionStore, statusProvider, {
    intervalMs: 600_000,
    clock,
    activityStore,
    approvalStore,
  });

  const defaultExecute = async (record: ExecutionRecord): Promise<ExecutionResult> => ({
    record,
    success: true,
    status: "submitted",
    txHash: `tx-${record.id.slice(0, 8)}`,
    error: null,
  });

  const queue = new ExecutionQueue(
    executionStore,
    opts.execute ?? defaultExecute,
    async () => ({
      accountId: () => "GTEST",
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    }),
    {
      intervalMs: 600_000,
      nowFn: clock,
      retryPolicy: {
        maxRetries: opts.maxRetries ?? 2,
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
        jitterFactor: 0,
      },
      statusProvider,
    }
  );

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: {
      getAccountId: () => "GTEST",
      getNetworkPassphrase: () => "Test SDF Network ; September 2015",
      sign: async (tx: any) => tx,
    },
    activityStore,
    approvalStore,
    scheduleStore,
    executionStore,
    agentStore,
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    executionQueue: { enabled: true, instance: queue, intervalMs: 600_000 },
    reconciliation: { enabled: true, instance: reconciler, intervalMs: 600_000 },
  });

  await server.listen(0);

  return {
    executionStore,
    queue,
    reconciler,
    advanceTimeMs: (ms: number) => {
      currentNow = new Date(currentNow.getTime() + ms);
    },
    clock,
    close: () => server.close(),
  };
}

test("LIFECYCLE: queued -> executing -> submitted -> confirmed preserves txHash", async () => {
  const harness = await startLifecycleHarness({
    getStatus: async () => "confirmed",
  });

  try {
    const execution = makeExecution();
    await harness.queue.enqueue(execution);

    await harness.queue.processDue(harness.clock().toISOString());
    const submitted = await harness.executionStore.get(execution.id);
    assert.equal(submitted?.status, "submitted");
    assert.ok(submitted?.txHash, "txHash should be set on submitted record");

    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.confirmed, 1);

    const confirmed = await harness.executionStore.get(execution.id);
    assert.equal(confirmed?.status, "confirmed");
    assert.equal(confirmed?.txHash, submitted.txHash);
  } finally {
    await harness.close();
  }
});

test("LIFECYCLE: submitted + failed -> reconciler marks failed -> queue retry -> dead_letter when exhausted", async () => {
  let attemptCount = 0;
  const harness = await startLifecycleHarness({
    maxRetries: 1,
    getStatus: async () => "failed",
    execute: async (record) => {
      attemptCount++;
      if (attemptCount === 1) {
        return {
          record,
          success: true,
          status: "submitted",
          txHash: `tx-${record.id.slice(0, 8)}`,
          error: null,
        };
      }
      return {
        record,
        success: false,
        status: "failed",
        txHash: null,
        error: "Horizon 500: permanent failure after retry",
      };
    },
  });

  try {
    const execution = makeExecution();
    await harness.queue.enqueue(execution);

    // Attempt 1: queued -> executing -> submitted
    await harness.queue.processDue(harness.clock().toISOString());
    const submitted = await harness.executionStore.get(execution.id);
    assert.equal(submitted?.status, "submitted");
    assert.equal(submitted?.attempt, 0);

    // Reconciler sees on-chain failure -> submitted -> failed
    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.failed, 1);
    const failed = await harness.executionStore.get(execution.id);
    assert.equal(failed?.status, "failed");

    // Queue retries the failed execution -> queued, then attempt 1 exhausts maxRetries -> dead_letter
    const retryRes = await harness.queue.retry(execution.id, 1);
    assert.equal(retryRes.status, "queued");

    harness.advanceTimeMs(5_000);
    await harness.queue.processDue(harness.clock().toISOString());

    const finalRecord = await harness.executionStore.get(execution.id);
    assert.equal(finalRecord?.status, "dead_letter");
    assert.equal(finalRecord?.attempt, 1);
  } finally {
    await harness.close();
  }
});

test("LIFECYCLE: submitted + not_found stays submitted and is never blind-retried", async () => {
  const harness = await startLifecycleHarness({
    getStatus: async () => "not_found",
  });

  try {
    const execution = makeExecution();
    await harness.queue.enqueue(execution);

    await harness.queue.processDue(harness.clock().toISOString());
    const submitted = await harness.executionStore.get(execution.id);
    assert.equal(submitted?.status, "submitted");
    assert.equal(submitted?.attempt, 0);

    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.checked, 1);
    assert.equal(recResult.confirmed, 0);
    assert.equal(recResult.failed, 0);

    // Advance time slightly (well under 6h maxAgeMs) and run processDue again
    harness.advanceTimeMs(10_000);
    await harness.queue.processDue(harness.clock().toISOString());

    const after = await harness.executionStore.get(execution.id);
    assert.equal(after?.status, "submitted");
    assert.equal(after?.attempt, 0);
    assert.equal(after?.txHash, submitted?.txHash);
  } finally {
    await harness.close();
  }
});

test("LIFECYCLE: submitted + network_error stays submitted", async () => {
  const harness = await startLifecycleHarness({
    getStatus: async () => "network_error",
  });

  try {
    const execution = makeExecution();
    await harness.queue.enqueue(execution);

    await harness.queue.processDue(harness.clock().toISOString());
    const submitted = await harness.executionStore.get(execution.id);
    assert.equal(submitted?.status, "submitted");

    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.checked, 1);
    assert.equal(recResult.confirmed, 0);
    assert.equal(recResult.failed, 0);

    const after = await harness.executionStore.get(execution.id);
    assert.equal(after?.status, "submitted");
    assert.equal(after?.attempt, 0);
  } finally {
    await harness.close();
  }
});

/**
 * #379 — Deterministic loop test.
 *
 * Before the fix, retry() on a reconciler-failed record (submittedHash set,
 * on-chain status "failed") collapsed the pre-check to "found" → bounced the
 * record to "submitted" → reconciler re-marked it "failed" → infinite oscillation.
 *
 * After the fix the pre-check carries the FULL status: "failed" on-chain is
 * definitively dead, so retry() re-queues with a cleared hash and the next
 * queue pass executes a NEW transaction.
 *
 * This test seeds a failed record with submittedHash, stubs the status provider
 * to always return "failed", and verifies that after three retry() + reconcile()
 * rounds the record is in "queued" (or further along) rather than oscillating.
 */
test("LIFECYCLE #379: on-chain-failed retry does NOT oscillate failed↔submitted over three rounds", async () => {
  const executionStore = new InMemoryExecutionStore();
  const activityStore = new InMemoryActivityStore();

  // Stub provider always returns "failed" (the transaction failed on-chain).
  const statusProvider: TransactionStatusProvider = {
    getStatus: async () => "failed",
  };

  const reconciler = new TransactionStatusReconciler(executionStore, statusProvider, {
    intervalMs: 600_000,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    activityStore,
  });

  // The queue shares the same preCheck mapping as the status provider so the
  // "failed" on-chain outcome is never collapsed to the old "found" verdict.
  const preCheck = (txHash: string) => statusProvider.getStatus(txHash);

  let executeCount = 0;
  const queue = new ExecutionQueue(
    executionStore,
    async (record): Promise<ExecutionResult> => {
      executeCount++;
      return {
        record,
        success: false,
        status: "failed",
        error: "simulated on-chain failure",
        errorClass: "transient",
        txHash: `tx-fresh-${executeCount}`,
        submittedHash: `tx-fresh-${executeCount}`,
      };
    },
    async () => ({
      accountId: () => "GTEST",
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    }),
    {
      intervalMs: 600_000,
      retryPolicy: { maxRetries: 5, baseDelayMs: 10, maxDelayMs: 50 },
      preCheck,
    }
  );

  // Seed: a failed execution whose previous transaction failed on-chain.
  const execution = makeExecution({
    status: "failed",
    submittedHash: "tx-original-failed",
    txHash: "tx-original-failed",
    error: "Transaction failed on-chain",
    attempt: 1,
    errorClass: "transient",
    nextRetryAt: null,
  });
  await executionStore.record(execution);

  // Three consecutive retry() → reconcile() rounds must all leave the record
  // in "queued" (or in a later execution-phase state), never bouncing back to
  // "submitted" for reconciliation.
  for (let round = 1; round <= 3; round++) {
    // Fetch current status to call retry on the right state.
    const before = await executionStore.get(execution.id);
    // The record should be in "failed" at the start of each round.
    assert.equal(before?.status, "failed", `round ${round}: expected failed before retry`);

    const retryResult = await queue.retry(execution.id, 5);
    // Core assertion of #379: retry() must re-queue (not bounce to submitted).
    assert.equal(retryResult.status, "queued", `round ${round}: retry() must re-queue an on-chain-failed execution`);

    const afterRetry = await executionStore.get(execution.id);
    // submittedHash must be cleared so the next attempt builds a fresh transaction.
    assert.equal(afterRetry?.submittedHash, null, `round ${round}: submittedHash must be cleared after re-queue`);
    assert.equal(afterRetry?.txHash, null, `round ${round}: txHash must be cleared after re-queue`);

    // Run the queue to execute the re-queued record (it fails again, as the
    // stub pipeline always returns a failed result — this simulates repeated
    // on-chain failures, verifying the loop is fully broken every round).
    await queue.processDue(new Date("2026-01-01T00:01:00.000Z").toISOString());

    // The reconciler must NOT be able to re-mark it failed by routing it
    // through "submitted" (the old oscillation path). The queue already set
    // the final status (failed, with a new hash).
    const afterExecute = await executionStore.get(execution.id);
    // After processDue the record is in "failed" (the pipeline failed again).
    // It must NOT be in "submitted" — that was the old oscillation state.
    assert.notEqual(afterExecute?.status, "submitted", `round ${round}: record must NOT enter submitted (would restart oscillation loop)`);
    assert.equal(afterExecute?.status, "failed", `round ${round}: record must be failed after pipeline failure`);

    // Confirm reconciler has nothing to do (no submitted records).
    const recResult = await reconciler.reconcile();
    assert.equal(recResult.checked, 0, `round ${round}: reconciler must have nothing to reconcile (no submitted records)`);
  }

  // Three full rounds completed — the loop never formed.
  assert.ok(executeCount >= 3, "pipeline must have been called at least once per round");
});

/**
 * #379 — Re-queued on-chain-failed execution is re-executed by the next queue
 * pass and builds a NEW transaction (submittedHash is cleared, not reused).
 */
test("LIFECYCLE #379: re-queued on-chain-failed execution is re-executed with a fresh transaction", async () => {
  const executionStore = new InMemoryExecutionStore();
  const activityStore = new InMemoryActivityStore();

  const statusProvider: TransactionStatusProvider = {
    getStatus: async () => "failed",
  };

  const reconciler = new TransactionStatusReconciler(executionStore, statusProvider, {
    intervalMs: 600_000,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    activityStore,
  });

  const preCheck = (txHash: string) => statusProvider.getStatus(txHash);

  const submittedHashes: string[] = [];
  const queue = new ExecutionQueue(
    executionStore,
    async (record): Promise<ExecutionResult> => {
      const hash = `tx-fresh-${submittedHashes.length + 1}`;
      submittedHashes.push(hash);
      return {
        record,
        success: true,
        status: "submitted",
        txHash: hash,
        submittedHash: hash,
        error: null,
      };
    },
    async () => ({
      accountId: () => "GTEST",
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    }),
    {
      intervalMs: 600_000,
      retryPolicy: { maxRetries: 5, baseDelayMs: 10, maxDelayMs: 50 },
      preCheck,
    }
  );

  // Seed a failed record with the original (on-chain-failed) hash.
  const originalHash = "tx-original-failed-hash";
  const execution = makeExecution({
    status: "failed",
    submittedHash: originalHash,
    txHash: originalHash,
    error: "Transaction failed on-chain",
    attempt: 1,
    errorClass: "transient",
    nextRetryAt: null,
  });
  await executionStore.record(execution);

  // Retry → must re-queue, not bounce to submitted.
  const retryResult = await queue.retry(execution.id, 5);
  assert.equal(retryResult.status, "queued");

  const afterRetry = await executionStore.get(execution.id);
  assert.equal(afterRetry?.submittedHash, null, "submittedHash must be cleared before re-execution");
  assert.equal(afterRetry?.txHash, null, "txHash must be cleared before re-execution");

  // The next queue pass must actually execute it (not skip it).
  const started = await queue.processDue(new Date("2026-01-01T00:01:00.000Z").toISOString());
  assert.equal(started, 1, "queue must pick up the re-queued execution");
  assert.equal(submittedHashes.length, 1, "pipeline must be called exactly once");

  // The new transaction hash must be different from the original failed one.
  const newHash = submittedHashes[0];
  assert.notEqual(newHash, originalHash, "new attempt must use a fresh transaction hash");

  // After execution, the record must be in submitted state with the NEW hash.
  const afterExecution = await executionStore.get(execution.id);
  assert.equal(afterExecution?.status, "submitted");
  assert.equal(afterExecution?.txHash, newHash);
  assert.equal(afterExecution?.submittedHash, newHash);

  // Reconciler now sees "submitted" and processes the new transaction.
  // Because getStatus returns "failed", the reconciler marks it failed again.
  const recResult = await reconciler.reconcile();
  assert.equal(recResult.checked, 1);
  assert.equal(recResult.failed, 1);

  const final = await executionStore.get(execution.id);
  assert.equal(final?.status, "failed");
  // The old hash must NOT appear anywhere on the record.
  assert.notEqual(final?.txHash, originalHash);
  assert.notEqual(final?.submittedHash, originalHash);
});

/**
 * #379 — Retrying a CONFIRMED execution still refuses to re-submit.
 * The pre-check detects the confirmed on-chain state and routes the record
 * to "submitted" for reconciliation (not "queued" for a new transaction).
 */
test("LIFECYCLE #379: retrying a confirmed execution routes to submitted, not queued", async () => {
  const executionStore = new InMemoryExecutionStore();

  // Stub: transaction is confirmed on-chain.
  const preCheck = async (_txHash: string): Promise<"confirmed" | "failed" | "not_found" | "network_error"> =>
    "confirmed";

  let pipelineCalled = false;
  const queue = new ExecutionQueue(
    executionStore,
    async (record): Promise<ExecutionResult> => {
      pipelineCalled = true;
      return {
        record,
        success: true,
        status: "submitted",
        txHash: "tx-duplicate-should-never-happen",
        error: null,
      };
    },
    async () => ({
      accountId: () => "GTEST",
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    }),
    {
      intervalMs: 600_000,
      preCheck,
    }
  );

  const confirmedHash = "tx-already-confirmed";
  const execution = makeExecution({
    status: "failed",
    submittedHash: confirmedHash,
    txHash: confirmedHash,
    error: "reconciler marked failed (should not happen for confirmed, but test scenario)",
    attempt: 1,
    errorClass: "transient",
    nextRetryAt: null,
  });
  await executionStore.record(execution);

  // retry() must NOT re-queue — it must move to submitted for reconciliation.
  const retryResult = await queue.retry(execution.id, 5);
  assert.equal(retryResult.status, "submitted", "confirmed transaction must route to submitted, not queued");

  // Pipeline must never be called (no re-submission allowed).
  assert.equal(pipelineCalled, false, "pipeline must not be invoked for a confirmed transaction");

  const afterRetry = await executionStore.get(execution.id);
  assert.equal(afterRetry?.status, "submitted");
  // The confirmed hash must be preserved as the txHash.
  assert.equal(afterRetry?.txHash, confirmedHash);
});

test("LIFECYCLE: concurrent update between reconciler read and write prevents stale overwrite", async () => {
  let storeRef: InMemoryExecutionStore | null = null;
  let targetId: string | null = null;

  const harness = await startLifecycleHarness({
    getStatus: async () => {
      // Simulate a concurrent writer confirming the record after reconciler read it
      if (storeRef && targetId) {
        await storeRef.updateIfStatus(targetId, "submitted", {
          status: "confirmed",
          completedAt: new Date("2026-01-01T00:00:05.000Z").toISOString(),
          updatedAt: new Date("2026-01-01T00:00:05.000Z").toISOString(),
          nextRetryAt: null,
        });
      }
      return "failed";
    },
  });

  storeRef = harness.executionStore;

  try {
    const execution = makeExecution();
    targetId = execution.id;
    await harness.queue.enqueue(execution);

    await harness.queue.processDue(harness.clock().toISOString());
    const submitted = await harness.executionStore.get(execution.id);
    assert.equal(submitted?.status, "submitted");

    // Reconciler reads "submitted", gets "failed" from provider, but concurrent update already
    // moved it to "confirmed". Reconciler's updateIfStatus(..., "submitted", ...) must be a no-op.
    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.failed, 0);

    const finalRecord = await harness.executionStore.get(execution.id);
    assert.equal(finalRecord?.status, "confirmed");
  } finally {
    await harness.close();
  }
});
