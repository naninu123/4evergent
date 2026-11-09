/**
 * Reconciliation & Execution Queue Lifecycle Integration Tests
 *
 * State-Transition Ownership Contract:
 * ----------------------------------------------------------------------------
 * Transition                        | Owning Mechanism              | Guard / Trigger
 * ----------------------------------|-------------------------------|---------------------------------------------
 * queued -> executing               | ExecutionQueue                | updateIfStatus(id, "queued", { status: "executing" }) during processDue()
 * failed -> executing               | ExecutionQueue                | updateIfStatus(id, "failed", { status: "executing" }) when nextRetryAt <= now
 * executing -> submitted            | ExecutionQueue                | updateIfStatus(id, "executing", { status: "submitted", txHash }) on pipeline submit
 * executing -> failed (with backoff)| ExecutionQueue                | updateIfStatus(id, "executing", { status: "failed", attempt, nextRetryAt }) when attempt < maxRetries
 * executing -> dead_letter          | ExecutionQueue                | updateIfStatus(id, "executing", { status: "dead_letter", completedAt }) when attempt >= maxRetries or permanent error
 * submitted -> confirmed            | TransactionStatusReconciler   | updateIfStatus(id, "submitted", { status: "confirmed", completedAt }) on provider "confirmed"
 * submitted -> failed               | TransactionStatusReconciler   | updateIfStatus(id, "submitted", { status: "failed", error }) on provider "failed"
 * submitted -> submitted (no-op)    | TransactionStatusReconciler   | Provider "not_found" or "network_error" leaves record in "submitted" (never blind-retried)
 * ----------------------------------------------------------------------------
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { ExecutionQueue, type ExecutionResult, type PipelineExecutor } from "../src/execution-queue.js";
import {
  TransactionStatusReconciler,
  type TransactionStatus,
  type TransactionStatusProvider,
} from "@4evergent/stellar";
import { DevAuthProvider, type AgentIntent } from "@4evergent/shared";
import {
  InMemoryActivityStore,
  InMemoryAgentStore,
  InMemoryApprovalStore,
  InMemoryExecutionStore,
  InMemoryScheduleStore,
  type ExecutionRecord,
  type ExecutionStatus,
  type RetryPolicy,
} from "@4evergent/database";

function makeIntent(): AgentIntent {
  return {
    type: "payment",
    asset: "XLM",
    destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount: "10",
    reason: "reconciliation-queue lifecycle test",
  };
}

function makeExecution(overrides: Partial<ExecutionRecord> = {}, nowIso = "2026-01-01T00:00:00.000Z"): ExecutionRecord {
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    agentId: "agent-a",
    approvalId: "approval-1",
    activityId: "activity-1",
    intent: makeIntent(),
    status: "queued",
    policyDecision: null,
    simulationResult: null,
    txHash: null,
    submittedHash: null,
    error: null,
    attempt: 0,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

interface HarnessOptions {
  pipelineExecutor: PipelineExecutor;
  statusProvider: TransactionStatusProvider;
  retryPolicy?: RetryPolicy;
  initialTimeMs?: number;
}

async function startLifecycleHarness(opts: HarnessOptions) {
  let currentTimeMs = opts.initialTimeMs ?? Date.parse("2026-01-01T00:00:00.000Z");
  const clock = () => new Date(currentTimeMs);
  const advanceTimeMs = (deltaMs: number): string => {
    currentTimeMs += deltaMs;
    return clock().toISOString();
  };

  const executionStore = new InMemoryExecutionStore();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();
  const scheduleStore = new InMemoryScheduleStore();
  const agentStore = new InMemoryAgentStore();

  const executionQueue = new ExecutionQueue(
    executionStore,
    opts.pipelineExecutor,
    async () => ({
      accountId: () => "GTEST",
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    }),
    {
      intervalMs: 60_000,
      clock,
      now: clock,
      retryPolicy: opts.retryPolicy ?? {
        maxRetries: 2,
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
      },
    }
  );

  const reconciler = new TransactionStatusReconciler(executionStore, opts.statusProvider, {
    intervalMs: 60_000,
    clock,
  });

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: {
      getAccountId: () => "GTEST",
      getNetworkPassphrase: () => "Test SDF Network ; September 2015",
      sign: async (tx: unknown) => tx,
    },
    activityStore,
    approvalStore,
    scheduleStore,
    executionStore,
    agentStore,
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    executionQueue: {
      enabled: true,
      intervalMs: 60_000,
      instance: executionQueue,
    },
    reconciliation: {
      enabled: true,
      intervalMs: 60_000,
      instance: reconciler,
    },
  });

  await server.listen(0);
  const port = (server.server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    executionStore,
    executionQueue,
    reconciler,
    clock,
    advanceTimeMs,
    close: () => server.close(),
  };
}

test("LIFECYCLE 1: queued -> executing -> submitted via queue, then submitted -> confirmed via reconciler", async () => {
  const observedTransitions: ExecutionStatus[] = [];
  let executionStoreRef!: InMemoryExecutionStore;

  const harness = await startLifecycleHarness({
    pipelineExecutor: async (record): Promise<ExecutionResult> => {
      const inFlight = await executionStoreRef.get(record.id);
      assert.equal(inFlight?.status, "executing");
      observedTransitions.push(inFlight!.status);
      return {
        record,
        success: true,
        status: "submitted",
        txHash: "tx-confirmed-lifecycle-1",
        submittedHash: "tx-confirmed-lifecycle-1",
      };
    },
    statusProvider: {
      getStatus: async (txHash: string): Promise<TransactionStatus> => {
        assert.equal(txHash, "tx-confirmed-lifecycle-1");
        return "confirmed";
      },
    },
  });
  executionStoreRef = harness.executionStore;

  try {
    assert.equal(harness.executionQueue.isRunning(), true);
    assert.equal(harness.reconciler.isRunning(), true);

    const initial = makeExecution({ status: "queued" }, harness.clock().toISOString());
    await harness.executionQueue.enqueue(initial);
    observedTransitions.push((await harness.executionStore.get(initial.id))!.status);

    // Step 1: ExecutionQueue processes due record (queued -> executing -> submitted)
    const started = await harness.executionQueue.processDue(harness.clock().toISOString());
    assert.equal(started, 1);

    const afterSubmit = await harness.executionStore.get(initial.id);
    assert.equal(afterSubmit?.status, "submitted");
    assert.equal(afterSubmit?.txHash, "tx-confirmed-lifecycle-1");
    observedTransitions.push(afterSubmit!.status);

    // Step 2: TransactionStatusReconciler polls statusProvider and confirms (submitted -> confirmed)
    harness.advanceTimeMs(5_000);
    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.checked, 1);
    assert.equal(recResult.confirmed, 1);
    assert.equal(recResult.failed, 0);

    const afterConfirm = await harness.executionStore.get(initial.id);
    assert.equal(afterConfirm?.status, "confirmed");
    assert.equal(afterConfirm?.txHash, "tx-confirmed-lifecycle-1");
    assert.ok(afterConfirm?.completedAt);
    observedTransitions.push(afterConfirm!.status);

    assert.deepEqual(observedTransitions, ["queued", "executing", "submitted", "confirmed"]);

    // Verify neither the queue nor the reconciler reprocesses a confirmed execution
    const startedAfterConfirm = await harness.executionQueue.processDue(harness.advanceTimeMs(60_000));
    assert.equal(startedAfterConfirm, 0);
    const secondRec = await harness.reconciler.reconcile();
    assert.equal(secondRec.checked, 0);

    // Verify via API endpoint GET /executions/:id
    const res = await fetch(`${harness.baseUrl}/executions/${initial.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.execution.status, "confirmed");
    assert.equal(body.execution.txHash, "tx-confirmed-lifecycle-1");
  } finally {
    await harness.close();
  }
});

test("LIFECYCLE 2: submitted + provider failed -> reconciler marks failed, queue retries with backoff, and reaches dead_letter when attempts exhausted", async () => {
  const observedTransitions: ExecutionStatus[] = [];
  let executionStoreRef!: InMemoryExecutionStore;
  let pipelineCalls = 0;

  const harness = await startLifecycleHarness({
    retryPolicy: {
      maxRetries: 2,
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
    },
    pipelineExecutor: async (record): Promise<ExecutionResult> => {
      pipelineCalls++;
      const inFlight = await executionStoreRef.get(record.id);
      assert.equal(inFlight?.status, "executing");
      observedTransitions.push(inFlight!.status);

      if (pipelineCalls === 1) {
        // Initial submission succeeds and reaches Horizon
        return {
          record,
          success: true,
          status: "submitted",
          txHash: "tx-onchain-fail-1",
        };
      }

      // Subsequent retry attempts encounter transient execution failures until maxRetries is exhausted
      return {
        record,
        success: false,
        status: "failed",
        error: `Horizon submission transient failure on retry #${pipelineCalls - 1}`,
        errorClass: "transient",
      };
    },
    statusProvider: {
      getStatus: async (txHash: string): Promise<TransactionStatus> => {
        assert.equal(txHash, "tx-onchain-fail-1");
        return "failed";
      },
    },
  });
  executionStoreRef = harness.executionStore;

  try {
    const initial = makeExecution({ status: "queued", attempt: 0 }, harness.clock().toISOString());
    await harness.executionQueue.enqueue(initial);
    observedTransitions.push((await harness.executionStore.get(initial.id))!.status);

    // Step 1: Queue claims and submits initial execution (queued -> executing -> submitted)
    const started1 = await harness.executionQueue.processDue(harness.clock().toISOString());
    assert.equal(started1, 1);
    const afterSubmit = await harness.executionStore.get(initial.id);
    assert.equal(afterSubmit?.status, "submitted");
    assert.equal(afterSubmit?.txHash, "tx-onchain-fail-1");
    observedTransitions.push(afterSubmit!.status);

    // Step 2: Reconciler observes on-chain failure and marks execution "failed" (submitted -> failed)
    harness.advanceTimeMs(1_000);
    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.checked, 1);
    assert.equal(recResult.failed, 1);

    const afterReconcileFail = await harness.executionStore.get(initial.id);
    assert.equal(afterReconcileFail?.status, "failed");
    assert.equal(afterReconcileFail?.error, "Transaction failed on-chain");
    observedTransitions.push(afterReconcileFail!.status);

    // Step 3: Queue picks up failed execution for retry attempt 1 (failed -> executing -> failed with backoff)
    const startedRetry1 = await harness.executionQueue.processDue(harness.clock().toISOString());
    assert.equal(startedRetry1, 1);

    const afterRetry1 = await harness.executionStore.get(initial.id);
    assert.equal(afterRetry1?.status, "failed");
    assert.equal(afterRetry1?.attempt, 1);
    assert.ok(afterRetry1?.nextRetryAt, "nextRetryAt backoff timestamp must be scheduled");
    observedTransitions.push(afterRetry1!.status);

    // Before backoff elapses, processDue must NOT claim the execution
    const startedTooEarly = await harness.executionQueue.processDue(harness.advanceTimeMs(500));
    assert.equal(startedTooEarly, 0);
    assert.equal(pipelineCalls, 2);

    // Step 4: Advance clock past nextRetryAt (baseDelayMs * 2^1 = 2000ms); queue runs retry attempt 2, exhausting maxRetries=2 -> dead_letter
    const startedRetry2 = await harness.executionQueue.processDue(harness.advanceTimeMs(2_000));
    assert.equal(startedRetry2, 1);
    assert.equal(pipelineCalls, 3);

    const afterExhausted = await harness.executionStore.get(initial.id);
    assert.equal(afterExhausted?.status, "dead_letter");
    assert.equal(afterExhausted?.attempt, 2);
    assert.equal(afterExhausted?.nextRetryAt, null);
    assert.ok(afterExhausted?.completedAt);
    observedTransitions.push(afterExhausted!.status);

    assert.deepEqual(observedTransitions, [
      "queued",
      "executing",
      "submitted",
      "failed",
      "executing",
      "failed",
      "executing",
      "dead_letter",
    ]);

    // Step 5: Neither queue nor reconciler touches a dead_letter record
    assert.equal(await harness.executionQueue.processDue(harness.advanceTimeMs(60_000)), 0);
    const finalRec = await harness.reconciler.reconcile();
    assert.equal(finalRec.checked, 0);

    const res = await fetch(`${harness.baseUrl}/executions/${initial.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.execution.status, "dead_letter");
    assert.equal(body.execution.attempt, 2);
  } finally {
    await harness.close();
  }
});

test("LIFECYCLE 3: submitted + provider not_found -> record stays submitted and is never blind-retried", async () => {
  let pipelineCalls = 0;
  let providerCalls = 0;

  const harness = await startLifecycleHarness({
    pipelineExecutor: async (record): Promise<ExecutionResult> => {
      pipelineCalls++;
      return {
        record,
        success: true,
        status: "submitted",
        txHash: "tx-not-found-1",
        submittedHash: "tx-not-found-1",
      };
    },
    statusProvider: {
      getStatus: async (txHash: string): Promise<TransactionStatus> => {
        providerCalls++;
        assert.equal(txHash, "tx-not-found-1");
        return "not_found";
      },
    },
  });

  try {
    const initial = makeExecution({ status: "queued" }, harness.clock().toISOString());
    await harness.executionQueue.enqueue(initial);

    // Queue submits execution once
    const started = await harness.executionQueue.processDue(harness.clock().toISOString());
    assert.equal(started, 1);
    assert.equal(pipelineCalls, 1);

    // Multiple reconciliation and queue passes while provider returns not_found
    for (let pass = 0; pass < 3; pass++) {
      const recResult = await harness.reconciler.reconcile();
      assert.equal(recResult.checked, 1);
      assert.equal(recResult.confirmed, 0);
      assert.equal(recResult.failed, 0);

      const dueStarted = await harness.executionQueue.processDue(harness.advanceTimeMs(10_000));
      assert.equal(dueStarted, 0);
    }

    assert.equal(providerCalls, 3);
    assert.equal(pipelineCalls, 1, "queue must never blind-retry a submitted execution on not_found");

    const stored = await harness.executionStore.get(initial.id);
    assert.equal(stored?.status, "submitted");
    assert.equal(stored?.txHash, "tx-not-found-1");
    assert.equal(stored?.attempt, 0);

    const res = await fetch(`${harness.baseUrl}/executions/${initial.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.execution.status, "submitted");
    assert.equal(body.execution.txHash, "tx-not-found-1");
  } finally {
    await harness.close();
  }
});

test("LIFECYCLE 4: submitted + provider network_error -> record stays submitted", async () => {
  let pipelineCalls = 0;
  let providerCalls = 0;

  const harness = await startLifecycleHarness({
    pipelineExecutor: async (record): Promise<ExecutionResult> => {
      pipelineCalls++;
      return {
        record,
        success: true,
        status: "submitted",
        txHash: "tx-network-error-1",
        submittedHash: "tx-network-error-1",
      };
    },
    statusProvider: {
      getStatus: async (txHash: string): Promise<TransactionStatus> => {
        providerCalls++;
        assert.equal(txHash, "tx-network-error-1");
        return "network_error";
      },
    },
  });

  try {
    const initial = makeExecution({ status: "queued" }, harness.clock().toISOString());
    await harness.executionQueue.enqueue(initial);

    // Queue submits execution
    const started = await harness.executionQueue.processDue(harness.clock().toISOString());
    assert.equal(started, 1);
    assert.equal(pipelineCalls, 1);

    // Reconciler encounters network_error across multiple ticks
    for (let pass = 0; pass < 3; pass++) {
      const recResult = await harness.reconciler.reconcile();
      assert.equal(recResult.checked, 1);
      assert.equal(recResult.confirmed, 0);
      assert.equal(recResult.failed, 0);

      const dueStarted = await harness.executionQueue.processDue(harness.advanceTimeMs(10_000));
      assert.equal(dueStarted, 0);
    }

    assert.equal(providerCalls, 3);
    assert.equal(pipelineCalls, 1);

    const stored = await harness.executionStore.get(initial.id);
    assert.equal(stored?.status, "submitted");
    assert.equal(stored?.txHash, "tx-network-error-1");
    assert.equal(stored?.error, null);

    const res = await fetch(`${harness.baseUrl}/executions/${initial.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.execution.status, "submitted");
    assert.equal(body.execution.txHash, "tx-network-error-1");
  } finally {
    await harness.close();
  }
});

test("LIFECYCLE 5: concurrent update between reconciler's read and write -> conditional update prevents stale overwrite", async () => {
  let executionStoreRef!: InMemoryExecutionStore;
  let executionId!: string;

  const harness = await startLifecycleHarness({
    pipelineExecutor: async (record): Promise<ExecutionResult> => ({
      record,
      success: true,
      status: "submitted",
      txHash: "tx-concurrent-race-1",
      submittedHash: "tx-concurrent-race-1",
    }),
    statusProvider: {
      getStatus: async (txHash: string): Promise<TransactionStatus> => {
        assert.equal(txHash, "tx-concurrent-race-1");
        // At this exact point, reconciler.reconcile() has ALREADY read the record
        // via executionStore.listSubmitted() as status === "submitted".
        // Mutate the record concurrently BEFORE getStatus() returns "confirmed"
        // so reconciler's subsequent updateIfStatus(id, "submitted", ...) races
        // against the newer state.
        const current = await executionStoreRef.get(executionId);
        assert.equal(current?.status, "submitted");

        await executionStoreRef.update(executionId, {
          status: "dead_letter",
          error: "Concurrent terminal override during reconciliation lookup",
          completedAt: "2026-01-01T00:05:00.000Z",
          updatedAt: "2026-01-01T00:05:00.000Z",
        });

        return "confirmed";
      },
    },
  });
  executionStoreRef = harness.executionStore;

  try {
    const initial = makeExecution({ status: "queued" }, harness.clock().toISOString());
    executionId = initial.id;
    await harness.executionQueue.enqueue(initial);

    // Step 1: Queue transitions queued -> executing -> submitted
    const started = await harness.executionQueue.processDue(harness.clock().toISOString());
    assert.equal(started, 1);

    const submitted = await harness.executionStore.get(initial.id);
    assert.equal(submitted?.status, "submitted");

    // Step 2: Reconciler reads listSubmitted() (checked === 1), concurrent update happens
    // inside statusProvider.getStatus(), and updateIfStatus(id, "submitted", { status: "confirmed" })
    // must be rejected (confirmed === 0).
    const recResult = await harness.reconciler.reconcile();
    assert.equal(recResult.checked, 1, "reconciler must have read the submitted record before the concurrent write");
    assert.equal(recResult.confirmed, 0, "conditional update must reject stale overwrite");
    assert.equal(recResult.failed, 0);

    const finalRecord = await harness.executionStore.get(initial.id);
    assert.equal(finalRecord?.status, "dead_letter");
    assert.equal(finalRecord?.error, "Concurrent terminal override during reconciliation lookup");

    const res = await fetch(`${harness.baseUrl}/executions/${initial.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.execution.status, "dead_letter");
    assert.equal(body.execution.error, "Concurrent terminal override during reconciliation lookup");
  } finally {
    await harness.close();
  }
});
