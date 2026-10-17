import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import type { Signer } from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";

// NOTE: approval integration tests must not call the live Horizon network.
// We test only the persistence + state-machine + idempotency behavior.
// The async execution after approval uses a local stub account (no network).

// NOTE: approval integration tests use deterministic mocks and in-process
// HTTP servers. They do NOT call the live Stellar testnet.

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string { return this.id; }
  getNetworkPassphrase(): string { return "Test SDF Network ; September 2015"; }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

const TEST_AGENT = {
  id: "test-agent",
  displayName: "Test",
  description: "test agent",
  ownerId: "test",
  stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  capabilities: [],
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

async function startServer(opts?: { policyRules?: Partial<PolicyRules>; signer?: Signer; deferExecution?: boolean }) {
  const signer = opts?.signer ?? new MockSigner("test-agent");
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer,
    policyRules: opts?.policyRules,
    deferExecution: opts?.deferExecution,
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
  });
  server.registerAgent(TEST_AGENT);

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    store: typeof server.store;
    approvals: typeof server.approvals;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        store: server.store,
        approvals: server.approvals,
      });
    });
  });
}

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ===== Approval flow lifecycle =====

test("approval: submit intent requiring approval → 202 pending_approval", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, store, approvals } = await startServer({ policyRules: rules });
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "approval flow test",
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.status, "requires_approval");
    assert.ok(res.body.approvalId, "approvalId must be returned");
    assert.ok(res.body.activityId, "activityId must be returned");

    // Activity persisted with requires_approval status
    const activity = await store.get(res.body.activityId);
    assert.ok(activity);
    assert.equal(activity!.status, "requires_approval");
    assert.equal(activity!.authorizationStatus, "pending_approval");

    // Approval persisted
    const approval = await approvals.get(res.body.approvalId);
    assert.ok(approval);
    assert.equal(approval!.status, "pending_approval");
  } finally {
    await close();
  }
});

test("approval: approve valid approval → 200 approved (async execution)", async () => {
  // NOTE: approve endpoint marks the approval as "approved" and kicks off
  // execution asynchronously. The HTTP response returns "approved" immediately.
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "approval approve test",
    });
    assert.equal(intentRes.status, 202);

    // Approve
    const approveRes = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester" });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.status, "approved");
    assert.ok(approveRes.body.message.includes("queued"));

    // Verify approval persisted as approved
    const approval = await approvals.get(intentRes.body.approvalId);
    assert.ok(approval);
    assert.equal(approval!.status, "approved");
    // Phase 28K-2: approver comes from authenticated identity (no client spoofing).
    // DevAuthProvider returns subject="dev-user", so approver is "dev-user".
    assert.equal(approval!.approver, "dev-user");
    assert.ok(approval!.approvedAt);
  } finally {
    await close();
  }
});

test("approval: second approve is rejected (idempotent — no double submission)", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "double approve test",
    });

    // First approve → 200
    const firstApprove = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester1" });
    assert.equal(firstApprove.status, 200);

    // Second approve → 409 conflict (already approved, cannot approve again)
    const secondApprove = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester2" });
    assert.equal(secondApprove.status, 409);
    assert.match(secondApprove.body.message, /cannot approve/);

    // Verify still approved (not double-executed)
    const approval = await approvals.get(intentRes.body.approvalId);
    assert.equal(approval!.status, "approved");
  } finally {
    await close();
  }
});

test("approval: reject nonexistent approval → 404", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await post(baseUrl, "/approvals/nonexistent-id/approve", {});
    assert.equal(res.status, 404);
    assert.equal(res.body.status, "rejected");
    assert.match(res.body.message, /not found/);
  } finally {
    await close();
  }
});

test("approval: reject already-approved approval → 409", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "approve then reject test",
    });

    // Approve first
    const approve = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester" });
    assert.equal(approve.status, 200);

    // Now try to reject → must fail (409 conflict)
    const reject = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/reject`, {});
    assert.equal(reject.status, 409);
    assert.match(reject.body.message, /cannot reject/);
  } finally {
    await close();
  }
});

test("approval: reject valid pending approval → 200 rejected", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "reject flow test",
    });
    assert.equal(intentRes.status, 202);

    const reject = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/reject`, {});
    assert.equal(reject.status, 200);
    assert.equal(reject.body.status, "rejected");

    const approval = await approvals.get(intentRes.body.approvalId);
    assert.ok(approval);
    assert.equal(approval!.status, "rejected");
    assert.ok(approval!.rejectedAt);
  } finally {
    await close();
  }
});

test("approval: reject reflects on linked activity and blocks re-approval", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, store, approvals } = await startServer({ policyRules: rules });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "reject activity reflection test",
    });
    assert.equal(intentRes.status, 202);

    const reject = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/reject`, {});
    assert.equal(reject.status, 200);
    assert.equal(reject.body.status, "rejected");

    // Approval persisted as rejected
    const approval = await approvals.get(intentRes.body.approvalId);
    assert.ok(approval);
    assert.equal(approval!.status, "rejected");

    // Linked activity reflects the rejection
    const activity = await store.get(intentRes.body.activityId);
    assert.ok(activity);
    assert.equal(activity!.status, "rejected");
    assert.equal(activity!.authorizationStatus, "denied_by_policy");

    // Subsequent approve attempt must fail (invalid transition)
    const reApprove = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, {});
    assert.equal(reApprove.status, 409);
    assert.match(reApprove.body.message, /cannot approve/);

    // Approval remains rejected after failed re-approval
    const after = await approvals.get(intentRes.body.approvalId);
    assert.equal(after!.status, "rejected");
  } finally {
    await close();
  }
});

test("approval: reject endpoint records authenticated actor, not client-supplied value", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "reject actor attribution test",
    });
    assert.equal(intentRes.status, 202);

    // Client attempts to spoof the rejecting actor
    const reject = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/reject`, {
      rejector: "spoofed-actor",
      approver: "spoofed-actor",
    });
    assert.equal(reject.status, 200);
    assert.equal(reject.body.status, "rejected");

    const approval = await approvals.get(intentRes.body.approvalId);
    assert.ok(approval);
    assert.equal(approval!.status, "rejected");
    // DevAuthProvider returns subject="dev-user"; the client-supplied value must be ignored.
    assert.equal(approval!.rejector, "dev-user");
    assert.notEqual(approval!.rejector, "spoofed-actor");
  } finally {
    await close();
  }
});

test("approval: approve expired approval → 410 and status becomes expired", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "expiry approve test",
    });
    assert.equal(intentRes.status, 202);

    // Force the approval to be expired by rewriting its expiresAt into the past.
    const approval = await approvals.get(intentRes.body.approvalId);
    assert.ok(approval);
    const past = new Date(Date.now() - 60_000).toISOString();
    await approvals.update(intentRes.body.approvalId, { expiresAt: past });

    const approve = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, {});
    assert.equal(approve.status, 410);

    const after = await approvals.get(intentRes.body.approvalId);
    assert.ok(after);
    assert.equal(after!.status, "expired");
  } finally {
    await close();
  }
});

test("approval: executeApproved on expired approval returns rejected with expiry reason", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, approvals } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "executeApproved expiry test",
    });
    assert.equal(intentRes.status, 202);

    // Force expiry in the past.
    const past = new Date(Date.now() - 60_000).toISOString();
    await approvals.update(intentRes.body.approvalId, { expiresAt: past });

    const { executeApproved } = await import("@4evergent/stellar");
    const result = await executeApproved({
      approvalId: intentRes.body.approvalId,
      approvals,
      signer: new MockSigner("test-agent"),
      horizonUrl: "https://horizon-testnet.stellar.org",
    } as any);

    assert.equal(result.status, "rejected");
    assert.match(String(result.reason ?? ""), /expir/i);

    const after = await approvals.get(intentRes.body.approvalId);
    assert.ok(after);
    assert.equal(after!.status, "expired");
  } finally {
    await close();
  }
});

test("approval: approve endpoint rejects raw XDR injection", async () => {
  const rules: Partial<PolicyRules> = {
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "xdr injection test",
    });
    assert.equal(intentRes.status, 202);

    const res = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, {
      xdr: "AAAAAgAAAAA=",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /raw XDR/);
  } finally {
    await close();
  }
});

test("approval: reject endpoint rejects raw XDR injection", async () => {
  const rules: Partial<PolicyRules> = {
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "xdr reject injection test",
    });
    assert.equal(intentRes.status, 202);

    const res = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/reject`, {
      xdr: "AAAAAgAAAAA=",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /raw XDR/);
  } finally {
    await close();
  }
});

test("approval: approve approval belonging to other agent — current impl allows (no cross-agent guard yet)", async () => {
  // LIMITATION: Phase 3 does not enforce cross-agent approval ownership.
  // A future phase will add agent-scoped approval access control.
  // This test documents the current behavior.
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "cross-agent test",
    });
    assert.equal(intentRes.status, 202);

    // Anyone with the approvalId can approve — this is a known limitation
    const approve = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "anonymous" });
    assert.equal(approve.status, 200);
  } finally {
    await close();
  }
});

test("approval does not leak secrets in response", async () => {
  const rules: Partial<PolicyRules> = {
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close } = await startServer({ policyRules: rules, deferExecution: true });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: Keypair.random().publicKey(),
      amount: "50",
      reason: "check privacy",
    });
    const approveRes = await post(baseUrl, `/approvals/${intentRes.body.approvalId}/approve`, { approver: "tester" });
    const json = JSON.stringify(intentRes) + JSON.stringify(approveRes);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});
