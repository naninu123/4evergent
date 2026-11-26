import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createActivity,
  InMemoryActivityStore,
  InMemoryApprovalStore,
  SQLiteActivityStore,
  SQLiteApprovalStore,
  type ActivityStore,
  type ApprovalStore,
} from "@4evergent/database";
import type { AgentIntent, PolicyRules } from "@4evergent/shared";
import { TransactionPipeline } from "../src/pipeline.js";
import type { Signer } from "../src/signer.js";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const DEST = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

class TestSigner implements Signer {
  getAccountId(): string {
    return DEST;
  }
  getNetworkPassphrase(): string {
    return PASSPHRASE;
  }
  async sign(): Promise<any> {
    return { hash: () => Buffer.from("pre-submit-hash") };
  }
}

function makeStores(backend: "InMemory" | "SQLite"): {
  activityStore: ActivityStore;
  approvalStore: ApprovalStore;
  cleanup: () => void;
} {
  if (backend === "InMemory") {
    return {
      activityStore: new InMemoryActivityStore(),
      approvalStore: new InMemoryApprovalStore(),
      cleanup: () => {},
    };
  }
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-370-"));
  const dbPath = join(tmp, "test.db");
  const activityStore = new SQLiteActivityStore(dbPath);
  const approvalStore = new SQLiteApprovalStore(dbPath);
  return {
    activityStore,
    approvalStore,
    cleanup: () => {
      activityStore.close();
      approvalStore.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function sourceAccount() {
  return {
    accountId: () => DEST,
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
    agentId: "agent-1",
    ownerId: "owner-1",
  } as any;
}

function mockPipelineInternals(pipeline: TransactionPipeline) {
  const internals = pipeline as unknown as {
    builder: { buildPayment: () => Promise<object>; buildAccountSettings: () => Promise<object> };
    simulator: { simulate: () => Promise<object> };
    submitter: { submit: () => Promise<{ hash: string; ledger: number }> };
  };
  internals.builder = {
    buildPayment: async () => ({ fakeTransaction: true }),
    buildAccountSettings: async () => ({ fakeTransaction: true }),
  };
  internals.simulator = {
    simulate: async () => ({ success: true, fee: "100", operations: 1, warnings: [] }),
  };
  internals.submitter = {
    submit: async () => ({ hash: "tx-hash-370", ledger: 100 }),
  };
}

for (const backend of ["InMemory", "SQLite"] as const) {
  test(`[#370] ${backend}: pipeline updates pre-existing activity record with real deny policyDecision`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      const policyRules: PolicyRules = {
        maxTxAmount: { XLM: "50" },
      };
      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        signer: new TestSigner(),
        policyRules,
        activityStore,
        approvalStore,
      });
      mockPipelineInternals(pipeline);

      const intent: AgentIntent = {
        type: "payment",
        asset: "XLM",
        destination: DEST,
        amount: "100", // exceeds maxTxAmount (50)
        reason: "test deny update",
      };

      // Pre-create activity with policyDecision: null (as scheduler now does)
      const preActivity = createActivity("agent-1", "owner-1", intent, null);
      await activityStore.record(preActivity);

      const before = await activityStore.get(preActivity.id);
      assert.equal(before?.policyDecision, null);

      const outcome = await pipeline.execute({
        intent,
        sourceAccount: sourceAccount(),
        activityId: preActivity.id,
      });

      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.policyDecision.result, "deny");
      assert.equal(outcome.policyDecision.rule, "maxTxAmount");

      const after = await activityStore.get(preActivity.id);
      assert.ok(after);
      assert.equal(after!.id, preActivity.id);
      assert.equal(after!.status, "rejected");
      assert.equal(after!.authorizationStatus, "denied_by_policy");
      assert.ok(after!.policyDecision);
      assert.equal(after!.policyDecision!.result, "deny");
      assert.equal(after!.policyDecision!.rule, "maxTxAmount");
      assert.notEqual(after!.policyDecision!.rule, "scheduler");
    } finally {
      cleanup();
    }
  });

  test(`[#370] ${backend}: pipeline updates pre-existing activity record with real requires_approval policyDecision`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      const policyRules: PolicyRules = {
        requireHumanApprovalForAmountAbove: "20",
        approvalThreshold: "20",
      };
      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        signer: new TestSigner(),
        policyRules,
        activityStore,
        approvalStore,
      });
      mockPipelineInternals(pipeline);

      const intent: AgentIntent = {
        type: "payment",
        asset: "XLM",
        destination: DEST,
        amount: "50",
        reason: "test requires_approval update",
      };

      const preActivity = createActivity("agent-1", "owner-1", intent, null);
      await activityStore.record(preActivity);

      const outcome = await pipeline.execute({
        intent,
        sourceAccount: sourceAccount(),
        activityId: preActivity.id,
      });

      assert.equal(outcome.status, "requires_approval");
      assert.equal(outcome.policyDecision.result, "requires_approval");

      const after = await activityStore.get(preActivity.id);
      assert.ok(after);
      assert.equal(after!.status, "requires_approval");
      assert.equal(after!.authorizationStatus, "pending_approval");
      assert.ok(after!.policyDecision);
      assert.equal(after!.policyDecision!.result, "requires_approval");
      assert.notEqual(after!.policyDecision!.rule, "scheduler");
    } finally {
      cleanup();
    }
  });

  test(`[#370] ${backend}: pipeline updates pre-existing activity record with real allow policyDecision on submit`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      const policyRules: PolicyRules = {
        maxTxAmount: { XLM: "100" },
      };
      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        signer: new TestSigner(),
        policyRules,
        activityStore,
        approvalStore,
      });
      mockPipelineInternals(pipeline);

      const intent: AgentIntent = {
        type: "payment",
        asset: "XLM",
        destination: DEST,
        amount: "10",
        reason: "test allow update",
      };

      const preActivity = createActivity("agent-1", "owner-1", intent, null);
      await activityStore.record(preActivity);

      const outcome = await pipeline.execute({
        intent,
        sourceAccount: sourceAccount(),
        activityId: preActivity.id,
      });

      assert.equal(outcome.status, "submitted");
      assert.equal(outcome.policyDecision.result, "allow");

      const after = await activityStore.get(preActivity.id);
      assert.ok(after);
      assert.equal(after!.status, "submitted");
      assert.equal(after!.authorizationStatus, "approved");
      assert.ok(after!.policyDecision);
      assert.equal(after!.policyDecision!.result, "allow");
      assert.notEqual(after!.policyDecision!.rule, "scheduler");
    } finally {
      cleanup();
    }
  });
}
