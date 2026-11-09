import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createActivity,
  createApproval,
  InMemoryActivityStore,
  InMemoryApprovalStore,
  type ApprovalRecord,
} from "@4evergent/database";
import type { AgentIntent, PolicyDecision } from "@4evergent/shared";
import { StellarAdapter } from "@4evergent/agent-core";
import { TransactionPipeline } from "../src/pipeline.js";
import type { Signer } from "../src/signer.js";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const TX_HASH = "submitted-transaction-hash";

const intent: AgentIntent = {
  type: "payment",
  asset: "XLM",
  destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  amount: "10",
  reason: "approved lifecycle test",
};

class TestSigner implements Signer {
  calls = 0;

  getAccountId(): string {
    return intent.destination;
  }

  getNetworkPassphrase(): string {
    return PASSPHRASE;
  }

  async sign(): Promise<any> {
    this.calls++;
    return { hash: () => Buffer.from("pre-submit-hash") };
  }
}

async function createFixture(options: {
  status?: ApprovalRecord["status"];
  expiresAt?: string | null;
  maxTxAmount?: string;
  submit?: () => Promise<{ hash: string; ledger: number }>;
} = {}) {
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();
  const decision: PolicyDecision = {
    result: "requires_approval",
    reason: "Requires human approval",
    rule: "approvalThreshold",
    intent,
  };
  const activity = createActivity("agent-1", "owner-1", intent, decision);
  activity.status = "requires_approval";
  activity.authorizationStatus = "pending_approval";
  await activityStore.record(activity);

  const approval = createApproval(
    activity.id,
    "agent-1",
    "owner-1",
    intent,
    decision,
    options.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
  );
  approval.status = options.status ?? "approved";
  await approvalStore.record(approval);

  const signer = new TestSigner();
  const pipeline = new TransactionPipeline({
    horizonUrl: HORIZON_URL,
    networkPassphrase: PASSPHRASE,
    signer,
    activityStore,
    approvalStore,
    policyRules: {
      maxTxAmount: { XLM: options.maxTxAmount ?? "100" },
      dailySpendingLimit: { XLM: "500" },
      allowedAssets: ["XLM"],
      requireHumanApprovalForAmountAbove: "100",
      approvalThreshold: "100",
      txTypeRestrictions: { payment: true },
    },
  });

  const internals = pipeline as unknown as {
    builder: { buildPayment: () => Promise<object> };
    simulator: { simulate: () => Promise<object> };
    submitter: { submit: () => Promise<{ hash: string; ledger: number }> };
  };
  internals.builder = { buildPayment: async () => ({ fakeTransaction: true }) };
  internals.simulator = {
    simulate: async () => ({ success: true, fee: "100", operations: 1, warnings: [] }),
  };
  internals.submitter = {
    submit: options.submit ?? (async () => ({ hash: TX_HASH, ledger: 123 })),
  };

  return { pipeline, activityStore, approvalStore, approval, activity, signer };
}

async function withOfflineAccount<T>(run: () => Promise<T>): Promise<T> {
  const originalGetAccount = StellarAdapter.prototype.getAccount;
  StellarAdapter.prototype.getAccount = async () => ({
    address: intent.destination,
    sequence: "1",
    balances: [],
    subentryCount: 0,
  });
  try {
    return await run();
  } finally {
    StellarAdapter.prototype.getAccount = originalGetAccount;
  }
}

test("executeApproved submits an approved intent and links the activity", async () => {
  await withOfflineAccount(async () => {
    const fixture = await createFixture();
    const result = await fixture.pipeline.executeApproved(fixture.approval.id, "reviewer-1");

    assert.equal(result.status, "submitted");
    assert.equal(result.txHash, TX_HASH);
    assert.equal(result.activityId, fixture.activity.id);

    const savedApproval = await fixture.approvalStore.get(fixture.approval.id);
    assert.equal(savedApproval?.status, "submitted");
    assert.equal(savedApproval?.txHash, TX_HASH);
    assert.equal(savedApproval?.approver, "reviewer-1");

    const savedActivity = await fixture.activityStore.get(fixture.activity.id);
    assert.equal(savedActivity?.status, "submitted");
    assert.equal(savedActivity?.txHash, TX_HASH);
    assert.equal(savedActivity?.authorizationStatus, "approved");

    const repeated = await fixture.pipeline.executeApproved(fixture.approval.id, "reviewer-1");
    assert.equal(repeated.status, "rejected");
    assert.match(repeated.message, /already executed/);
    assert.equal(fixture.signer.calls, 1);
  });
});

test("executeApproved rejects records that are not approved", async () => {
  for (const status of ["pending_approval", "rejected"] as const) {
    const fixture = await createFixture({ status });
    const result = await fixture.pipeline.executeApproved(fixture.approval.id);

    assert.equal(result.status, "rejected");
    assert.match(result.message, new RegExp(`is ${status}, not approved`));
    assert.equal(fixture.signer.calls, 0);
  }
});

test("executeApproved expires an outdated approval without signing", async () => {
  const fixture = await createFixture({ expiresAt: "2000-01-01T00:00:00.000Z" });
  const result = await fixture.pipeline.executeApproved(fixture.approval.id);

  assert.equal(result.status, "rejected");
  assert.equal(result.message, "Approval has expired");
  const savedApproval = await fixture.approvalStore.get(fixture.approval.id);
  assert.equal(savedApproval?.status, "expired");
  assert.ok(savedApproval?.expiredAt);
  assert.equal(fixture.signer.calls, 0);
});

test("executeApproved re-evaluates policy tightened after approval", async () => {
  const fixture = await createFixture({ maxTxAmount: "5" });
  const result = await fixture.pipeline.executeApproved(fixture.approval.id);

  assert.equal(result.status, "rejected");
  assert.match(result.message, /Policy re-evaluation denied/);
  assert.equal(result.policyDecision.result, "deny");
  assert.equal(result.policyDecision.rule, "maxTxAmount");
  const savedApproval = await fixture.approvalStore.get(fixture.approval.id);
  assert.equal(savedApproval?.status, "failed");
  assert.equal(fixture.signer.calls, 0);
});

test("executeApproved records the signed hash when submission fails", async () => {
  await withOfflineAccount(async () => {
    const fixture = await createFixture({
      submit: async () => {
        throw new Error("mock submit failure");
      },
    });
    const result = await fixture.pipeline.executeApproved(fixture.approval.id);

    assert.equal(result.status, "rejected");
    assert.match(result.message, /Submission failed: mock submit failure/);
    assert.equal(result.txHash, Buffer.from("pre-submit-hash").toString("hex"));
    const savedApproval = await fixture.approvalStore.get(fixture.approval.id);
    assert.equal(savedApproval?.status, "failed");
    assert.equal(fixture.signer.calls, 1);
  });
});

test("executeApproved builds a real trustline transaction and reaches simulation instead of failing construction", async () => {
  await withOfflineAccount(async () => {
    const activityStore = new InMemoryActivityStore();
    const approvalStore = new InMemoryApprovalStore();
    const trustlineIntent: AgentIntent = {
      type: "trustline",
      assetCode: "USDC",
      issuer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      limit: "1000",
      reason: "approved trustline test",
    };
    const decision: PolicyDecision = {
      result: "requires_approval",
      reason: "Requires human approval",
      rule: "approvalThreshold",
      intent: trustlineIntent,
    };
    const activity = createActivity("agent-1", "owner-1", trustlineIntent, decision);
    activity.status = "requires_approval";
    activity.authorizationStatus = "pending_approval";
    await activityStore.record(activity);

    const approval = createApproval(
      activity.id,
      "agent-1",
      "owner-1",
      trustlineIntent,
      decision,
      new Date(Date.now() + 60_000).toISOString(),
    );
    approval.status = "approved";
    await approvalStore.record(approval);

    const signer = new TestSigner();
    const pipeline = new TransactionPipeline({
      horizonUrl: HORIZON_URL,
      networkPassphrase: PASSPHRASE,
      signer,
      activityStore,
      approvalStore,
      policyRules: {
        maxTxAmount: { native: "1000000" },
        dailySpendingLimit: { native: "5000000" },
        allowedAssets: ["XLM", "USDC:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"],
        requireHumanApprovalForAmountAbove: "100",
        approvalThreshold: "100",
        txTypeRestrictions: { payment: true, trustline: true },
      },
    });

    // Keep the real StellarTransactionBuilder intact; stub only simulator to simulate a mock-network rejection
    const internals = pipeline as unknown as {
      simulator: { simulate: (tx: unknown) => Promise<object> };
    };
    let simulatedTx: unknown = null;
    internals.simulator = {
      simulate: async (tx: unknown) => {
        simulatedTx = tx;
        return { success: false, error: "Account not found on mock network", fee: "0", operations: 1, warnings: [] };
      },
    };

    const result = await pipeline.executeApproved(approval.id, "reviewer-1");

    assert.ok(simulatedTx !== null, "real buildTrustline output must reach simulator");
    assert.equal(result.status, "simulation_failed");
    assert.doesNotMatch(result.message, /expected payment intent/i);
    assert.match(result.message, /Account not found on mock network/);
    assert.equal(signer.calls, 0);
  });
});

test("executeApproved dispatches to the matching builder method for payment and trustline intents", async () => {
  await withOfflineAccount(async () => {
    const calls: string[] = [];

    for (const currentIntent of [
      intent,
      {
        type: "trustline" as const,
        assetCode: "USDC",
        issuer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        limit: "500",
        reason: "builder dispatch spy test",
      },
    ]) {
      const activityStore = new InMemoryActivityStore();
      const approvalStore = new InMemoryApprovalStore();
      const decision: PolicyDecision = {
        result: "requires_approval",
        reason: "Requires human approval",
        rule: "approvalThreshold",
        intent: currentIntent,
      };
      const activity = createActivity("agent-1", "owner-1", currentIntent, decision);
      activity.status = "requires_approval";
      activity.authorizationStatus = "pending_approval";
      await activityStore.record(activity);

      const approval = createApproval(
        activity.id,
        "agent-1",
        "owner-1",
        currentIntent,
        decision,
        new Date(Date.now() + 60_000).toISOString(),
      );
      approval.status = "approved";
      await approvalStore.record(approval);

      const signer = new TestSigner();
      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        networkPassphrase: PASSPHRASE,
        signer,
        activityStore,
        approvalStore,
        policyRules: {
          maxTxAmount: { XLM: "100", native: "1000" },
          dailySpendingLimit: { XLM: "500", native: "5000" },
          allowedAssets: ["XLM", "USDC:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"],
          requireHumanApprovalForAmountAbove: "100",
          approvalThreshold: "100",
          txTypeRestrictions: { payment: true, trustline: true },
        },
      });

      const internals = pipeline as unknown as {
        builder: {
          buildPayment: () => Promise<object>;
          buildTrustline: () => Promise<object>;
        };
        simulator: { simulate: () => Promise<object> };
        submitter: { submit: () => Promise<{ hash: string; ledger: number }> };
      };
      internals.builder = {
        buildPayment: async () => {
          calls.push("buildPayment");
          return { fakePaymentTx: true };
        },
        buildTrustline: async () => {
          calls.push("buildTrustline");
          return { fakeTrustlineTx: true };
        },
      };
      internals.simulator = {
        simulate: async () => ({ success: true, fee: "100", operations: 1, warnings: [] }),
      };
      internals.submitter = {
        submit: async () => ({ hash: TX_HASH, ledger: 123 }),
      };

      const res = await pipeline.executeApproved(approval.id, "reviewer-1");
      assert.equal(res.status, "submitted");
    }

    assert.deepEqual(calls, ["buildPayment", "buildTrustline"]);
  });
});
