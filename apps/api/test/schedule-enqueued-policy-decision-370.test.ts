import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarAdapter } from "@4evergent/agent-core";
import { StellarSimulator, StellarSubmitter, type Signer } from "@4evergent/stellar";
import type { ScheduleRecord } from "@4evergent/database";
import { clearAgents } from "../src/index.js";
import { startServer, MockSigner } from "./helpers.js";

const SOURCE_PUBLIC_KEY = Keypair.random().publicKey();
const DEST_PUBLIC_KEY = Keypair.random().publicKey();

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
      amount: "10",
      reason: "issue 370 schedule test",
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

async function withOfflinePipeline<T>(fn: () => Promise<T>): Promise<T> {
  const originalGetAccount = StellarAdapter.prototype.getAccount;
  const originalSimulate = StellarSimulator.prototype.simulate;
  const originalSubmit = StellarSubmitter.prototype.submit;

  StellarAdapter.prototype.getAccount = async (address: string) => ({
    address,
    sequence: "100",
    balances: [{ asset: "XLM", balance: "1000.0000000" }],
    subentryCount: 0,
  });

  StellarSimulator.prototype.simulate = async () => ({
    success: true,
    fee: "100",
    operations: 1,
    warnings: [],
  });

  StellarSubmitter.prototype.submit = async () => ({
    hash: "tx-submitted-hash-370",
    ledger: 100,
  });

  try {
    return await fn();
  } finally {
    StellarAdapter.prototype.getAccount = originalGetAccount;
    StellarSimulator.prototype.simulate = originalSimulate;
    StellarSubmitter.prototype.submit = originalSubmit;
  }
}

beforeEach(() => {
  clearAgents();
});

test("[#370] scheduler pre-creates activity without fabricated decision and pipeline updates with real deny decision", async () => {
  await withOfflinePipeline(async () => {
    const { close, activityStore, scheduleStore, server, baseUrl } = await startServer({
      schedulerEnabled: true,
      intervalMs: 60_000,
      signer: new MockSigner(SOURCE_PUBLIC_KEY),
      policyRules: {
        maxTxAmount: { XLM: "5" }, // limit is 5
      },
      deferExecution: true,
    });

    try {
      server.scheduler?.stop();
      server.executionQueue?.stop();

      const schedule = makeSchedule({
        intent: {
          type: "payment",
          asset: "XLM",
          destination: DEST_PUBLIC_KEY,
          amount: "10", // exceeds maxTxAmount
          reason: "exceeds limit",
        },
      });
      await scheduleStore.create(schedule);

      const nowIso = new Date().toISOString();
      const dueCount = await server.scheduler!.runDue(nowIso);
      assert.equal(dueCount, 1);

      // Verify the pre-created activity record does NOT carry a fabricated decision
      const preActivities = await activityStore.listByAgent(schedule.agentId);
      assert.equal(preActivities.length, 1);
      const preActivity = preActivities[0]!;
      assert.equal(preActivity.status, "pending");
      assert.equal(preActivity.policyDecision, null, "pre-created activity must have null policyDecision, not fabricated allow");
      assert.notEqual(preActivity.policyDecision?.rule, "scheduler");

      // Now process the queue through the pipeline
      const started = await server.executionQueue!.processDue(nowIso);
      assert.equal(started, 1);

      // Verify the activity record was updated in-place with the REAL deny decision
      const activities = await activityStore.listByAgent(schedule.agentId);
      assert.equal(activities.length, 1);
      const updatedActivity = activities[0]!;
      assert.equal(updatedActivity.id, preActivity.id);
      assert.equal(updatedActivity.status, "rejected");
      assert.equal(updatedActivity.authorizationStatus, "denied_by_policy");
      assert.ok(updatedActivity.policyDecision);
      assert.equal(updatedActivity.policyDecision!.result, "deny");
      assert.equal(updatedActivity.policyDecision!.rule, "maxTxAmount");
      assert.notEqual(updatedActivity.policyDecision!.rule, "scheduler");

      // Verify GET /agents/:agentId/activity/:id returns the real deny decision via the API
      const res = await fetch(`${baseUrl}/agents/${schedule.agentId}/activity/${preActivity.id}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.activity.policyDecision.result, "deny");
      assert.equal(body.activity.policyDecision.rule, "maxTxAmount");
      assert.notEqual(body.activity.policyDecision.rule, "scheduler");
    } finally {
      await close();
    }
  });
});

test("[#370] scheduler pre-creates activity and pipeline updates with real requires_approval decision", async () => {
  await withOfflinePipeline(async () => {
    const { close, activityStore, approvalStore, scheduleStore, server } = await startServer({
      schedulerEnabled: true,
      intervalMs: 60_000,
      signer: new MockSigner(SOURCE_PUBLIC_KEY),
      policyRules: {
        maxTxAmount: { XLM: "100" },
        requireHumanApprovalForAmountAbove: "10",
        approvalThreshold: "10",
      },
      deferExecution: true,
    });

    try {
      server.scheduler?.stop();
      server.executionQueue?.stop();

      const schedule = makeSchedule({
        intent: {
          type: "payment",
          asset: "XLM",
          destination: DEST_PUBLIC_KEY,
          amount: "50",
          reason: "requires approval",
        },
      });
      await scheduleStore.create(schedule);

      const nowIso = new Date().toISOString();
      await server.scheduler!.runDue(nowIso);

      const preActivities = await activityStore.listByAgent(schedule.agentId);
      assert.equal(preActivities[0]!.policyDecision, null);

      await server.executionQueue!.processDue(nowIso);

      const activities = await activityStore.listByAgent(schedule.agentId);
      assert.equal(activities.length, 1);
      const updatedActivity = activities[0]!;
      assert.equal(updatedActivity.status, "requires_approval");
      assert.equal(updatedActivity.authorizationStatus, "pending_approval");
      assert.ok(updatedActivity.policyDecision);
      assert.equal(updatedActivity.policyDecision!.result, "requires_approval");
      assert.notEqual(updatedActivity.policyDecision!.rule, "scheduler");

      const approvals = await approvalStore.listAll();
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0]!.activityId, updatedActivity.id);
    } finally {
      await close();
    }
  });
});

test("[#370] scheduler pre-creates activity and pipeline updates with real allow decision", async () => {
  await withOfflinePipeline(async () => {
    const { close, activityStore, scheduleStore, server } = await startServer({
      schedulerEnabled: true,
      intervalMs: 60_000,
      signer: new PipelineSigner(SOURCE_PUBLIC_KEY),
      policyRules: {
        maxTxAmount: { XLM: "100" },
      },
      deferExecution: true,
    });

    try {
      server.scheduler?.stop();
      server.executionQueue?.stop();

      const schedule = makeSchedule({
        intent: {
          type: "payment",
          asset: "XLM",
          destination: DEST_PUBLIC_KEY,
          amount: "10",
          reason: "allowed payment",
        },
      });
      await scheduleStore.create(schedule);

      const nowIso = new Date().toISOString();
      await server.scheduler!.runDue(nowIso);

      const preActivities = await activityStore.listByAgent(schedule.agentId);
      assert.equal(preActivities[0]!.policyDecision, null);

      await server.executionQueue!.processDue(nowIso);

      const activities = await activityStore.listByAgent(schedule.agentId);
      assert.equal(activities.length, 1);
      const updatedActivity = activities[0]!;
      assert.equal(updatedActivity.status, "submitted");
      assert.equal(updatedActivity.authorizationStatus, "approved");
      assert.ok(updatedActivity.policyDecision);
      assert.equal(updatedActivity.policyDecision!.result, "allow");
      assert.notEqual(updatedActivity.policyDecision!.rule, "scheduler");
    } finally {
      await close();
    }
  });
});
