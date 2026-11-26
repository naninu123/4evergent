import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, apiFetch } from "./helpers.js";
import { StellarAdapter } from "@4evergent/agent-core";
import {
  StellarTransactionBuilder,
  StellarSimulator,
  StellarSubmitter,
} from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";

const TX_HASH = "stub-tx-hash-agent-status";
const ADDRESS = "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U";
const DESTINATION = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

let submitCallCount = 0;

function stubNetwork() {
  submitCallCount = 0;
  const originals = {
    getAccount: StellarAdapter.prototype.getAccount,
    buildPayment: StellarTransactionBuilder.prototype.buildPayment,
    simulate: StellarSimulator.prototype.simulate,
    submit: StellarSubmitter.prototype.submit,
  };
  StellarAdapter.prototype.getAccount = (async () => ({
    address: ADDRESS,
    sequence: "1",
    balances: [],
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
  StellarSubmitter.prototype.submit = (async () => {
    submitCallCount++;
    return {
      hash: TX_HASH,
      ledger: 123,
    };
  }) as typeof originals.submit;
  return () => {
    StellarAdapter.prototype.getAccount = originals.getAccount;
    StellarTransactionBuilder.prototype.buildPayment = originals.buildPayment;
    StellarSimulator.prototype.simulate = originals.simulate;
    StellarSubmitter.prototype.submit = originals.submit;
  };
}

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await apiFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function patch(baseUrl: string, path: string, body: unknown) {
  const res = await apiFetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const RULES: Partial<PolicyRules> = {
  maxTxAmount: { XLM: "1000" },
  requireHumanApprovalForAmountAbove: "10",
};

test("approve for a paused agent is rejected and no execution is enqueued; agent status transition succeeds", async () => {
  const restore = stubNetwork();
  const { baseUrl, close, approvalStore: approvals, executionStore } = await startServer({
    policyRules: RULES,
    deferExecution: true,
  });

  try {
    // 1. Submit intent while agent is active -> creates pending approval
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: DESTINATION,
      amount: "50",
      reason: "high value transfer",
    });
    assert.equal(intentRes.status, 202);
    const approvalId = intentRes.body.approvalId as string;
    assert.ok(approvalId);

    // 2. Operator pauses the agent -> status transition succeeds
    const patchRes = await patch(baseUrl, "/agents/test-agent/status", { status: "paused" });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.status, "paused");

    // 3. Attempting to approve rejected with 409 AGENT_NOT_ACTIVE naming paused status
    const approveRes = await post(baseUrl, `/approvals/${approvalId}/approve`, {});
    assert.equal(approveRes.status, 409);
    assert.equal(approveRes.body.code, "AGENT_NOT_ACTIVE");
    assert.match(approveRes.body.error, /agent is paused/);
    assert.match(approveRes.body.message, /agent is paused/);

    // 4. Approval remains in pending_approval
    const approval = await approvals.get(approvalId);
    assert.equal(approval?.status, "pending_approval");

    // 5. No execution enqueued or submitted
    const executions = await executionStore.listByOwner("test", 10);
    assert.equal(executions.length, 0);
    assert.equal(submitCallCount, 0);
  } finally {
    restore();
    await close();
  }
});

test("approve for a disabled agent is rejected and no execution is enqueued", async () => {
  const restore = stubNetwork();
  const { baseUrl, close, approvalStore: approvals, executionStore } = await startServer({
    policyRules: RULES,
    deferExecution: true,
  });

  try {
    // 1. Submit intent while agent is active -> creates pending approval
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: DESTINATION,
      amount: "50",
      reason: "high value transfer",
    });
    assert.equal(intentRes.status, 202);
    const approvalId = intentRes.body.approvalId as string;
    assert.ok(approvalId);

    // 2. Operator disables the agent -> status transition succeeds
    const patchRes = await patch(baseUrl, "/agents/test-agent/status", { status: "disabled" });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.status, "disabled");

    // 3. Attempting to approve rejected with 409 AGENT_NOT_ACTIVE naming disabled status
    const approveRes = await post(baseUrl, `/approvals/${approvalId}/approve`, {});
    assert.equal(approveRes.status, 409);
    assert.equal(approveRes.body.code, "AGENT_NOT_ACTIVE");
    assert.match(approveRes.body.error, /agent is disabled/);
    assert.match(approveRes.body.message, /agent is disabled/);

    // 4. Approval remains in pending_approval
    const approval = await approvals.get(approvalId);
    assert.equal(approval?.status, "pending_approval");

    // 5. No execution enqueued or submitted
    const executions = await executionStore.listByOwner("test", 10);
    assert.equal(executions.length, 0);
    assert.equal(submitCallCount, 0);
  } finally {
    restore();
    await close();
  }
});

test("an already-approved intent whose agent is paused/disabled before the queue runs it is not executed", async () => {
  const restore = stubNetwork();
  // Queue enabled with high interval so it doesn't tick automatically before we pause the agent
  const { baseUrl, close, approvalStore: approvals, executionStore, server } = await startServer({
    policyRules: RULES,
    schedulerEnabled: true,
    intervalMs: 60000,
  });

  try {
    // 1. Submit intent when active
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: DESTINATION,
      amount: "50",
      reason: "pre-queue pause test",
    });
    assert.equal(intentRes.status, 202);
    const approvalId = intentRes.body.approvalId as string;

    // 2. Approve intent -> queued for execution
    const approveRes = await post(baseUrl, `/approvals/${approvalId}/approve`, {});
    assert.equal(approveRes.status, 200);

    const queuedExecutions = await executionStore.listByOwner("test", 10);
    assert.equal(queuedExecutions.length, 1);
    assert.equal(queuedExecutions[0]?.status, "queued");

    // 3. Operator pauses the agent before the queue runs it
    const patchRes = await patch(baseUrl, "/agents/test-agent/status", { status: "paused" });
    assert.equal(patchRes.status, 200);

    // 4. Queue worker processes due executions
    await server.executionQueue!.processDue();

    // 5. Execution was NOT submitted to Horizon
    assert.equal(submitCallCount, 0, "must not submit transaction to network for paused agent");

    // 6. Execution transitioned to terminal failed / dead_letter, and approval is marked failed
    const updatedExecution = await executionStore.get(queuedExecutions[0]!.id);
    assert.ok(updatedExecution?.status === "dead_letter" || updatedExecution?.status === "failed");
    assert.match(updatedExecution?.error ?? "", /agent is paused/);

    const updatedApproval = await approvals.get(approvalId);
    assert.equal(updatedApproval?.status, "failed");
    assert.match(updatedApproval?.error ?? "", /agent is paused/i);
  } finally {
    restore();
    await close();
  }
});

test("a retry of a failed execution for a paused/disabled agent does not submit either", async () => {
  const restore = stubNetwork();
  const { baseUrl, close, executionStore, server } = await startServer({
    policyRules: RULES,
    schedulerEnabled: true,
    intervalMs: 60000,
  });

  try {
    // 1. Pause agent
    const patchRes = await patch(baseUrl, "/agents/test-agent/status", { status: "paused" });
    assert.equal(patchRes.status, 200);

    // 2. Existing failed execution for this agent
    const failedExecution = {
      id: crypto.randomUUID(),
      ownerId: "test",
      agentId: "test-agent",
      approvalId: null,
      activityId: null,
      intent: { type: "payment" as const, asset: "XLM", destination: DESTINATION, amount: "10", reason: "retry test" },
      status: "failed" as const,
      policyDecision: null,
      simulationResult: null,
      txHash: null,
      submittedHash: null,
      error: "initial failure",
      attempt: 1,
      nextRetryAt: null,
      startedAt: null,
      completedAt: null,
      errorClass: "transient" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await executionStore.record(failedExecution);

    // 3. Retry the execution
    const retryRes = await post(baseUrl, `/executions/${failedExecution.id}/retry`, {});
    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.body.execution.status, "queued");

    // 4. Queue processes due
    await server.executionQueue!.processDue();

    // 5. Transaction is NOT submitted
    assert.equal(submitCallCount, 0, "retry must not submit to Horizon for paused agent");

    const execAfter = await executionStore.get(failedExecution.id);
    assert.ok(execAfter?.status === "dead_letter" || execAfter?.status === "failed");
    assert.match(execAfter?.error ?? "", /agent is paused/);
  } finally {
    restore();
    await close();
  }
});

test("approving for an active agent is unchanged", async () => {
  const restore = stubNetwork();
  const { baseUrl, close, approvalStore: approvals } = await startServer({
    policyRules: RULES,
    deferExecution: true,
  });

  try {
    // 1. Submit intent when active
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: DESTINATION,
      amount: "50",
      reason: "active agent test",
    });
    assert.equal(intentRes.status, 202);
    const approvalId = intentRes.body.approvalId as string;

    // 2. Approve intent while active -> 200 approved
    const approveRes = await post(baseUrl, `/approvals/${approvalId}/approve`, {});
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.status, "approved");

    const approval = await approvals.get(approvalId);
    assert.equal(approval?.status, "approved");
  } finally {
    restore();
    await close();
  }
});
