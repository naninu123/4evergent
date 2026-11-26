import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarAdapter } from "@4evergent/agent-core";
import {
  StellarTransactionBuilder,
  StellarSimulator,
  StellarSubmitter,
  type Signer,
} from "@4evergent/stellar";
import type { ScheduleRecord } from "@4evergent/database";
import type { PolicyRules } from "@4evergent/shared";
import { clearAgents } from "../src/index.js";
import { startServer, apiFetch, waitFor } from "./helpers.js";

// Issue #351: Scheduled above-threshold intents spawned duplicate approvals
// and ended dead_letter on the default queue path.
// The queue must treat requires_approval as a waiting state, not a failure:
// exactly one approval must exist, the execution record must carry approvalId,
// and it must not be retried or dead-lettered.

const SOURCE_PUBLIC_KEY = Keypair.random().publicKey();
const DEST_PUBLIC_KEY = Keypair.random().publicKey();
const TX_HASH = "mock-tx-hash-351";

class PipelineSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id;
  }
  getAccountId(): string {
    return this.id;
  }
  getNetworkPassphrase(): string {
    return "Test SDF Network ; September 2015";
  }
  async sign(): Promise<any> {
    return { hash: () => Buffer.from("mock-pre-submit-hash") };
  }
}

function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: "test-agent",
    ownerId: "test",
    status: "active",
    intent: {
      type: "payment",
      asset: "XLM",
      destination: DEST_PUBLIC_KEY,
      amount: "50", // above threshold of 10
      reason: "issue 351 schedule test",
    },
    scheduleExpression: "0 * * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function stubNetwork() {
  const originals = {
    getAccount: StellarAdapter.prototype.getAccount,
    buildPayment: StellarTransactionBuilder.prototype.buildPayment,
    simulate: StellarSimulator.prototype.simulate,
    submit: StellarSubmitter.prototype.submit,
  };

  StellarAdapter.prototype.getAccount = (async (address: string) => ({
    address,
    sequence: "1",
    balances: [{ asset_type: "native", balance: "10000.0000000" }],
    subentryCount: 0,
  })) as typeof originals.getAccount;

  StellarTransactionBuilder.prototype.buildPayment = (async () => ({
    hash: () => Buffer.from("pre-submit-hash"),
  })) as typeof originals.buildPayment;

  StellarSimulator.prototype.simulate = (async () => ({
    success: true,
    fee: "100",
    operations: 1,
    warnings: [],
  })) as typeof originals.simulate;

  StellarSubmitter.prototype.submit = (async () => ({
    hash: TX_HASH,
    ledger: 123,
  })) as typeof originals.submit;

  return () => {
    StellarAdapter.prototype.getAccount = originals.getAccount;
    StellarTransactionBuilder.prototype.buildPayment = originals.buildPayment;
    StellarSimulator.prototype.simulate = originals.simulate;
    StellarSubmitter.prototype.submit = originals.submit;
  };
}

const RULES: Partial<PolicyRules> = {
  maxTxAmount: { XLM: "1000" },
  requireHumanApprovalForAmountAbove: "10",
};

test("Issue #351: scheduled above-threshold intent creates exactly one approval and sets execution status to requires_approval", async () => {
  clearAgents();
  const restore = stubNetwork();

  const server = await startServer({
    policyRules: RULES,
    schedulerEnabled: true,
    intervalMs: 50,
    signer: new PipelineSigner(SOURCE_PUBLIC_KEY),
  });

  try {
    const schedule = makeSchedule();
    await server.scheduleStore.create(schedule);

    // Wait for scheduler to trigger and queue worker to process
    await waitFor(async () => {
      const execs = await server.executionStore.listByOwner("test", 10);
      return execs.length > 0 && execs[0].status === "requires_approval";
    }, 5000);

    const execs = await server.executionStore.listByOwner("test", 10);
    assert.equal(execs.length, 1);
    const exec = execs[0];
    assert.equal(exec.status, "requires_approval");
    assert.ok(exec.approvalId, "ExecutionRecord must have linked approvalId");
    assert.equal(exec.attempt, 0);
    assert.equal(exec.nextRetryAt, null);

    // Verify GET /executions/:id surfaces approvalId and status
    const getRes = await apiFetch(`${server.baseUrl}/executions/${exec.id}`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.execution.status, "requires_approval");
    assert.equal(getBody.execution.approvalId, exec.approvalId);

    // Verify exactly one approval exists
    const approvals = await server.approvalStore.listByAgent("test-agent", 10);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].id, exec.approvalId);
    assert.equal(approvals[0].status, "pending_approval");

    // Re-process queue multiple times: must not duplicate approval or fail/dead_letter record
    if (server.executionQueue) {
      await server.executionQueue.processDue();
      await server.executionQueue.processDue();
    }

    const approvalsAfter = await server.approvalStore.listByAgent("test-agent", 10);
    assert.equal(approvalsAfter.length, 1, "Must not create duplicate approvals on queue re-runs");

    const execAfter = await server.executionStore.get(exec.id);
    assert.equal(execAfter?.status, "requires_approval");
    assert.equal(execAfter?.approvalId, exec.approvalId);
  } finally {
    restore();
    await server.close();
  }
});

test("Issue #351: approving the linked approval executes the intent cleanly on the queue path", async () => {
  clearAgents();
  const restore = stubNetwork();

  const server = await startServer({
    policyRules: RULES,
    schedulerEnabled: true,
    intervalMs: 50,
    signer: new PipelineSigner(SOURCE_PUBLIC_KEY),
  });

  try {
    const schedule = makeSchedule();
    await server.scheduleStore.create(schedule);

    // Wait until execution record enters requires_approval
    await waitFor(async () => {
      const execs = await server.executionStore.listByOwner("test", 10);
      return execs.length > 0 && execs[0].status === "requires_approval";
    }, 5000);

    const execs = await server.executionStore.listByOwner("test", 10);
    const exec = execs[0];
    const approvalId = exec.approvalId!;
    assert.ok(approvalId);

    // Approve the approval
    const approveRes = await apiFetch(`${server.baseUrl}/approvals/${approvalId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approver: "operator" }),
    });
    assert.equal(approveRes.status, 200);

    // Execution should transition from queued to executing to submitted
    await waitFor(async () => {
      const updated = await server.executionStore.get(exec.id);
      return updated?.status === "submitted";
    }, 5000);

    const finalExec = await server.executionStore.get(exec.id);
    assert.equal(finalExec?.status, "submitted");
    assert.equal(finalExec?.txHash, TX_HASH);

    // Verify no second execution record was created
    const allExecs = await server.executionStore.listByOwner("test", 10);
    assert.equal(allExecs.length, 1, "Should reuse the existing execution record rather than creating a duplicate");

    // Verify approval is submitted
    const app = await server.approvalStore.get(approvalId);
    assert.equal(app?.status, "submitted");
  } finally {
    restore();
    await server.close();
  }
});

test("Issue #351: rejecting the linked approval marks the execution record failed", async () => {
  clearAgents();
  const restore = stubNetwork();

  const server = await startServer({
    policyRules: RULES,
    schedulerEnabled: true,
    intervalMs: 50,
    signer: new PipelineSigner(SOURCE_PUBLIC_KEY),
  });

  try {
    const schedule = makeSchedule();
    await server.scheduleStore.create(schedule);

    await waitFor(async () => {
      const execs = await server.executionStore.listByOwner("test", 10);
      return execs.length > 0 && execs[0].status === "requires_approval";
    }, 5000);

    const execs = await server.executionStore.listByOwner("test", 10);
    const exec = execs[0];
    const approvalId = exec.approvalId!;

    const rejectRes = await apiFetch(`${server.baseUrl}/approvals/${approvalId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(rejectRes.status, 200);

    const finalExec = await server.executionStore.get(exec.id);
    assert.equal(finalExec?.status, "failed");
    assert.equal(finalExec?.error, "approval rejected by human");
  } finally {
    restore();
    await server.close();
  }
});

test("Issue #351: if approval expires, execution record reflects occurrence died awaiting approval", async () => {
  clearAgents();
  const restore = stubNetwork();

  const server = await startServer({
    policyRules: RULES,
    schedulerEnabled: true,
    intervalMs: 50,
    signer: new PipelineSigner(SOURCE_PUBLIC_KEY),
  });

  try {
    const schedule = makeSchedule();
    await server.scheduleStore.create(schedule);

    await waitFor(async () => {
      const execs = await server.executionStore.listByOwner("test", 10);
      return execs.length > 0 && execs[0].status === "requires_approval";
    }, 5000);

    const execs = await server.executionStore.listByOwner("test", 10);
    const exec = execs[0];
    const approvalId = exec.approvalId!;

    // Simulate approval expiry in the past
    await server.approvalStore.update(approvalId, {
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    });

    // Fetch execution detail via GET /executions/:id
    const detailRes = await apiFetch(`${server.baseUrl}/executions/${exec.id}`);
    assert.equal(detailRes.status, 200);
    const detailBody = await detailRes.json();
    assert.equal(detailBody.execution.status, "failed");
    assert.equal(detailBody.execution.error, "approval expired without decision");

    // Also check store directly
    const updatedInStore = await server.executionStore.get(exec.id);
    assert.equal(updatedInStore?.status, "failed");
    assert.equal(updatedInStore?.error, "approval expired without decision");
  } finally {
    restore();
    await server.close();
  }
});
