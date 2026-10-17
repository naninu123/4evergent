import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import type { ScheduleRecord } from "@4evergent/database";
import {
  InMemoryScheduleStore,
  InMemoryActivityStore,
  InMemoryApprovalStore,
  createActivity,
} from "@4evergent/database";
import { StellarAdapter } from "@4evergent/agent-core";
import { StellarSimulator, TransactionPipeline, type Signer } from "@4evergent/stellar";
import { AgentScheduler } from "../src/scheduler.js";
import { startServer, waitFor } from "./helpers.js";

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
      destination: Keypair.random().publicKey(),
      amount: "10",
      reason: "scheduled outcome linkage test",
    },
    scheduleExpression: "0 * * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() - 60000).toISOString(),
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class ValidMockSigner implements Signer {
  constructor(private publicKey: string = Keypair.random().publicKey()) {}
  getAccountId(): string {
    return this.publicKey;
  }
  getNetworkPassphrase(): string {
    return "Test SDF Network ; September 2015";
  }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [
      { hint: Buffer.from("mock"), signature: Buffer.from("sig") },
    ];
    return transaction;
  }
}

// ============================================================================
// Acceptance Criterion 1 & 7:
// A schedule whose intent is denied by policy leaves its pre-created activity
// record in rejected with authorizationStatus: "denied_by_policy".
// Each test asserts the activity record count.
// ============================================================================
test("OUTCOME LINKAGE 1: schedule denied by policy leaves activity in rejected with denied_by_policy", async () => {
  const signerKp = Keypair.random();
  const destKp = Keypair.random();
  const origGetAccount = StellarAdapter.prototype.getAccount;

  StellarAdapter.prototype.getAccount = async () => ({
    address: signerKp.publicKey(),
    sequence: "100",
    balances: [{ asset: "XLM", balance: "1000.0000000" }],
    subentryCount: 0,
  } as any);

  // maxTxAmount is 5 XLM, but the scheduled intent amount is 10 XLM -> policy denies
  const { close, activityStore, executionStore, scheduleStore } = await startServer({
    intervalMs: 50,
    schedulerEnabled: true,
    policyRules: { maxTxAmount: { XLM: "5" } },
    signer: new ValidMockSigner(signerKp.publicKey()),
    deferExecution: true,
  });

  try {
    const schedule = makeSchedule({
      intent: {
        type: "payment",
        asset: "XLM",
        destination: destKp.publicKey(),
        amount: "10",
        reason: "policy denial test",
      },
    });
    await scheduleStore.create(schedule);

    // Wait for the pre-created ActivityRecord to transition to "rejected"
    const activity = await waitFor(async () => {
      const recs = await activityStore.listByAgent(schedule.agentId);
      return recs.length > 0 && recs[0]!.status !== "pending" ? recs[0] : undefined;
    }, 3000);

    assert.ok(activity, "ActivityRecord referenced by execution must exist");
    assert.equal(activity!.status, "rejected", "Pre-created activity record must end in rejected status");
    assert.equal(
      activity!.authorizationStatus,
      "denied_by_policy",
      "Pre-created activity record must have authorizationStatus denied_by_policy"
    );
    assert.match(
      activity!.error ?? "",
      /max_tx_amount|exceeds|policy/i,
      "Activity error must document policy denial"
    );

    // Verify linked execution record exists and reflects completion
    const execution = await waitFor(async () => {
      const recs = await executionStore.listByAgent(schedule.agentId);
      return recs.find((r) => r.activityId === activity!.id);
    }, 1000);
    assert.ok(execution, "ExecutionRecord linking to activityId must exist");
    assert.equal(execution!.activityId, activity!.id);

    // AC 7: Assert activity record count (no duplicates on policy denial)
    const allActivities = await activityStore.listByAgent(schedule.agentId);
    assert.equal(
      allActivities.length,
      1,
      "Exactly one ActivityRecord must exist (no duplicate created on policy rejection)"
    );
  } finally {
    StellarAdapter.prototype.getAccount = origGetAccount;
    await close();
  }
});

// ============================================================================
// Acceptance Criterion 2 & 7:
// A schedule whose intent requires approval creates an approval record linked
// to the same activity id (no duplicate activity).
// Each test asserts the activity record count.
// ============================================================================
test("OUTCOME LINKAGE 2: schedule requiring approval creates approval record linked to same activity id", async () => {
  const signerKp = Keypair.random();
  const destKp = Keypair.random();
  const origGetAccount = StellarAdapter.prototype.getAccount;

  StellarAdapter.prototype.getAccount = async () => ({
    address: signerKp.publicKey(),
    sequence: "100",
    balances: [{ asset: "XLM", balance: "1000.0000000" }],
    subentryCount: 0,
  } as any);

  // requireHumanApprovalForAmountAbove is 5 XLM; scheduled intent is 10 XLM -> requires approval
  const { close, activityStore, scheduleStore, approvalStore } = await startServer({
    intervalMs: 50,
    schedulerEnabled: true,
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "5" },
    signer: new ValidMockSigner(signerKp.publicKey()),
    deferExecution: true,
  });

  try {
    const schedule = makeSchedule({
      intent: {
        type: "payment",
        asset: "XLM",
        destination: destKp.publicKey(),
        amount: "10",
        reason: "approval requirement test",
      },
    });
    await scheduleStore.create(schedule);

    // Wait for the pre-created ActivityRecord to transition to "requires_approval"
    const activity = await waitFor(async () => {
      const recs = await activityStore.listByAgent(schedule.agentId);
      return recs.length > 0 && recs[0]!.status === "requires_approval" ? recs[0] : undefined;
    }, 3000);

    assert.ok(activity, "ActivityRecord must transition to requires_approval");
    assert.equal(activity!.status, "requires_approval");
    assert.equal(
      activity!.authorizationStatus,
      "pending_approval",
      "Activity authorizationStatus must be pending_approval"
    );

    // Wait for the ApprovalRecord to appear in approvalStore
    const approvals = await waitFor(async () => {
      const all = await approvalStore.listAll();
      return all.length > 0 ? all : undefined;
    }, 3000);

    assert.ok(approvals, "ApprovalRecord must be created");
    assert.equal(approvals!.length, 1, "Exactly one approval record must be created");
    assert.equal(
      approvals![0]!.activityId,
      activity!.id,
      "Approval record must link to the pre-created activity id"
    );

    // AC 7: Assert activity record count (no duplicate activity created)
    const allActivities = await activityStore.listByAgent(schedule.agentId);
    assert.equal(
      allActivities.length,
      1,
      "Exactly one ActivityRecord must exist (no duplicate created when approval is required)"
    );
  } finally {
    StellarAdapter.prototype.getAccount = origGetAccount;
    await close();
  }
});

// ============================================================================
// Acceptance Criterion 3 & 7:
// A schedule whose intent fails simulation leaves its activity record in failed
// with authorizationStatus: "denied_by_simulation".
// Each test asserts the activity record count.
// ============================================================================
test("OUTCOME LINKAGE 3: schedule failing simulation leaves activity in failed with denied_by_simulation", async () => {
  const signerKp = Keypair.random();
  const destKp = Keypair.random();
  const origGetAccount = StellarAdapter.prototype.getAccount;
  const origSimulate = StellarSimulator.prototype.simulate;

  StellarAdapter.prototype.getAccount = async () => ({
    address: signerKp.publicKey(),
    sequence: "100",
    balances: [{ asset: "XLM", balance: "1000.0000000" }],
    subentryCount: 0,
  } as any);

  // Force simulation failure (e.g. simulated insufficient balance or condition failure)
  StellarSimulator.prototype.simulate = async () => ({
    success: false,
    fee: "100",
    operations: 1,
    warnings: [],
    error: "Simulation failed: Insufficient balance for fee + amount",
  });

  const { close, activityStore, scheduleStore } = await startServer({
    intervalMs: 50,
    schedulerEnabled: true,
    policyRules: { maxTxAmount: { XLM: "1000" } },
    signer: new ValidMockSigner(signerKp.publicKey()),
    deferExecution: true,
  });

  try {
    const schedule = makeSchedule({
      intent: {
        type: "payment",
        asset: "XLM",
        destination: destKp.publicKey(),
        amount: "10",
        reason: "simulation failure test",
      },
    });
    await scheduleStore.create(schedule);

    // Wait for the ActivityRecord to transition to "failed" with "denied_by_simulation"
    const activity = await waitFor(async () => {
      const recs = await activityStore.listByAgent(schedule.agentId);
      return recs.length > 0 && recs[0]!.status === "failed" ? recs[0] : undefined;
    }, 3000);

    assert.ok(activity, "ActivityRecord must exist");
    assert.equal(activity!.status, "failed", "Activity record must end in failed status");
    assert.equal(
      activity!.authorizationStatus,
      "denied_by_simulation",
      "Activity authorizationStatus must be denied_by_simulation"
    );
    assert.match(
      activity!.error ?? "",
      /Simulation failed/i,
      "Activity error must reflect simulation failure reason"
    );

    // AC 7: Assert activity record count (no duplicates)
    const allActivities = await activityStore.listByAgent(schedule.agentId);
    assert.equal(
      allActivities.length,
      1,
      "Exactly one ActivityRecord must exist (no duplicate created on simulation failure)"
    );
  } finally {
    StellarAdapter.prototype.getAccount = origGetAccount;
    StellarSimulator.prototype.simulate = origSimulate;
    await close();
  }
});

// ============================================================================
// Acceptance Criterion 4 & 7:
// A schedule firing twice within the same minute is suppressed by the lastRunAt
// guard, and the activity count does not increase.
// Each test asserts the activity record count.
// ============================================================================
test("OUTCOME LINKAGE 4: schedule firing twice within same minute is suppressed by lastRunAt guard", async () => {
  const scheduleStore = new InMemoryScheduleStore();
  const activityStore = new InMemoryActivityStore();
  const now = new Date().toISOString();

  const schedule = makeSchedule({
    nextRunAt: new Date(Date.now() - 60000).toISOString(),
    lastRunAt: null,
  });
  await scheduleStore.create(schedule);

  const agentStore = {
    get: async (id: string) => ({ id, status: "active", ownerId: "test" }),
  };

  let executionCallbackCount = 0;
  const scheduler = new AgentScheduler(
    scheduleStore,
    agentStore,
    async (sched) => {
      executionCallbackCount++;
      const activity = createActivity(
        sched.agentId,
        sched.ownerId,
        sched.intent,
        { result: "allow", reason: "schedule enqueued", rule: "scheduler", intent: sched.intent }
      );
      activity.status = "pending";
      activity.authorizationStatus = "not_required";
      await activityStore.record(activity);
      return { status: "submitted" } as any;
    }
  );

  // First run at timestamp `now`
  const run1Count = await scheduler.runDue(now);
  assert.equal(run1Count, 1, "First run should execute due schedule");
  assert.equal(executionCallbackCount, 1, "Callback should be invoked on first run");

  const activitiesAfterRun1 = await activityStore.listByAgent(schedule.agentId);
  assert.equal(activitiesAfterRun1.length, 1, "Exactly one ActivityRecord must exist after first run");

  const updatedSchedule = await scheduleStore.get(schedule.id);
  assert.equal(updatedSchedule!.lastRunAt, now, "Schedule lastRunAt must be updated to current timestamp");

  // Second run at the EXACT same timestamp `now` within the minute
  const run2Count = await scheduler.runDue(now);
  assert.equal(run2Count, 0, "Second run at the same timestamp must be suppressed by lastRunAt guard");
  assert.equal(executionCallbackCount, 1, "Callback must NOT be invoked on second duplicate run");

  // AC 7: Assert activity record count does not increase
  const activitiesAfterRun2 = await activityStore.listByAgent(schedule.agentId);
  assert.equal(
    activitiesAfterRun2.length,
    1,
    "Activity count must not increase after suppressed second run (dedup guard protects activity linkage)"
  );
});

// ============================================================================
// Acceptance Criterion 5 & 7:
// A schedule whose agent is paused at fire time is skipped, and the test
// asserts what happens to nextRunAt (advanced or unchanged — the PR documents
// the current behavior).
// Each test asserts the activity record count.
// ============================================================================
test("OUTCOME LINKAGE 5: schedule whose agent is paused at fire time is skipped and nextRunAt is unchanged", async () => {
  const scheduleStore = new InMemoryScheduleStore();
  const activityStore = new InMemoryActivityStore();
  const initialNextRunAt = new Date(Date.now() - 60000).toISOString();

  const schedule = makeSchedule({
    agentId: "agent-paused",
    nextRunAt: initialNextRunAt,
    lastRunAt: null,
  });
  await scheduleStore.create(schedule);

  const agentStore = {
    get: async (id: string) => ({ id, status: "paused", ownerId: "test" }),
  };

  let executionCallbackCount = 0;
  const scheduler = new AgentScheduler(
    scheduleStore,
    agentStore,
    async (sched) => {
      executionCallbackCount++;
      const activity = createActivity(sched.agentId, sched.ownerId, sched.intent, {
        result: "allow",
        reason: "enqueued",
        rule: "scheduler",
        intent: sched.intent,
      });
      await activityStore.record(activity);
      return { status: "submitted" } as any;
    }
  );

  const count = await scheduler.runDue(new Date().toISOString());
  assert.equal(count, 0, "Scheduler must skip schedules when agent status is paused");
  assert.equal(executionCallbackCount, 0, "Execution callback must not be called for paused agent");

  // Current behavior assertion: nextRunAt is left UNCHANGED when the agent is paused
  const scheduleAfter = await scheduleStore.get(schedule.id);
  assert.equal(
    scheduleAfter!.nextRunAt,
    initialNextRunAt,
    "nextRunAt must remain unchanged when schedule is skipped because agent is paused"
  );
  assert.equal(scheduleAfter!.lastRunAt, null, "lastRunAt must remain unchanged (null)");

  // AC 7: Assert activity record count
  const activities = await activityStore.listByAgent("agent-paused");
  assert.equal(activities.length, 0, "No ActivityRecord should be created for paused agent");
});

// ============================================================================
// Acceptance Criterion 6 & 7:
// A schedule whose agent is disabled at fire time is skipped.
// Each test asserts the activity record count.
// ============================================================================
test("OUTCOME LINKAGE 6: schedule whose agent is disabled at fire time is skipped and nextRunAt is unchanged", async () => {
  const scheduleStore = new InMemoryScheduleStore();
  const activityStore = new InMemoryActivityStore();
  const initialNextRunAt = new Date(Date.now() - 60000).toISOString();

  const schedule = makeSchedule({
    agentId: "agent-disabled",
    nextRunAt: initialNextRunAt,
    lastRunAt: null,
  });
  await scheduleStore.create(schedule);

  const agentStore = {
    get: async (id: string) => ({ id, status: "disabled", ownerId: "test" }),
  };

  let executionCallbackCount = 0;
  const scheduler = new AgentScheduler(
    scheduleStore,
    agentStore,
    async (sched) => {
      executionCallbackCount++;
      const activity = createActivity(sched.agentId, sched.ownerId, sched.intent, {
        result: "allow",
        reason: "enqueued",
        rule: "scheduler",
        intent: sched.intent,
      });
      await activityStore.record(activity);
      return { status: "submitted" } as any;
    }
  );

  const count = await scheduler.runDue(new Date().toISOString());
  assert.equal(count, 0, "Scheduler must skip schedules when agent status is disabled");
  assert.equal(executionCallbackCount, 0, "Execution callback must not be called for disabled agent");

  // Current behavior assertion: nextRunAt is left UNCHANGED when the agent is disabled
  const scheduleAfter = await scheduleStore.get(schedule.id);
  assert.equal(
    scheduleAfter!.nextRunAt,
    initialNextRunAt,
    "nextRunAt must remain unchanged when schedule is skipped because agent is disabled"
  );
  assert.equal(scheduleAfter!.lastRunAt, null, "lastRunAt must remain unchanged (null)");

  // AC 7: Assert activity record count
  const activities = await activityStore.listByAgent("agent-disabled");
  assert.equal(activities.length, 0, "No ActivityRecord should be created for disabled agent");
});

// ============================================================================
// Acceptance Criterion 1 & 7 (Direct Pipeline Linkage):
// Verify direct execution linkage when pre-created activityId is passed
// into TransactionPipeline on policy deny.
// ============================================================================
test("OUTCOME LINKAGE 7: direct pipeline execution with pre-created activityId updates record on policy deny", async () => {
  const signerKp = Keypair.random();
  const destKp = Keypair.random();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();

  const preCreatedActivity = createActivity(
    "agent-direct",
    "owner-direct",
    {
      type: "payment",
      asset: "XLM",
      destination: destKp.publicKey(),
      amount: "100",
      reason: "direct test",
    },
    { result: "allow", reason: "pre-created by scheduler", rule: "scheduler", intent: {} as any }
  );
  preCreatedActivity.status = "pending";
  preCreatedActivity.authorizationStatus = "not_required";
  await activityStore.record(preCreatedActivity);

  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    signer: new ValidMockSigner(signerKp.publicKey()),
    activityStore,
    approvalStore,
    policyRules: { maxTxAmount: { XLM: "50" } }, // Deny amount 100
  });

  const sourceAccount = {
    agentId: "agent-direct",
    ownerId: "owner-direct",
    accountId: () => signerKp.publicKey(),
    sequenceNumber: () => "100",
    incrementSequenceNumber: () => {},
  };

  const outcome = await pipeline.execute({
    intent: preCreatedActivity.intent,
    sourceAccount,
    activityId: preCreatedActivity.id,
  });

  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.activityId, preCreatedActivity.id);

  const updated = await activityStore.get(preCreatedActivity.id);
  assert.ok(updated);
  assert.equal(updated!.status, "rejected");
  assert.equal(updated!.authorizationStatus, "denied_by_policy");

  // AC 7: Record count must remain 1 (no duplicate activity created)
  const allActivities = await activityStore.listByAgent("agent-direct");
  assert.equal(allActivities.length, 1, "Exactly one ActivityRecord must exist in store");
});

// ============================================================================
// Acceptance Criterion 3 & 7 (Direct Pipeline Linkage):
// Verify direct execution linkage when pre-created activityId is passed
// into TransactionPipeline on simulation failure.
// ============================================================================
test("OUTCOME LINKAGE 8: direct pipeline execution with pre-created activityId updates record on simulation failure", async () => {
  const signerKp = Keypair.random();
  const destKp = Keypair.random();

  const origSimulate = StellarSimulator.prototype.simulate;
  StellarSimulator.prototype.simulate = async () => ({
    success: false,
    fee: "100",
    operations: 1,
    warnings: [],
    error: "Simulation failed: Insufficient balance",
  });

  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();

  const preCreatedActivity = createActivity(
    "agent-sim-fail",
    "owner-sim-fail",
    {
      type: "payment",
      asset: "XLM",
      destination: destKp.publicKey(),
      amount: "10",
      reason: "sim fail test",
    },
    { result: "allow", reason: "pre-created by scheduler", rule: "scheduler", intent: {} as any }
  );
  preCreatedActivity.status = "pending";
  preCreatedActivity.authorizationStatus = "not_required";
  await activityStore.record(preCreatedActivity);

  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    signer: new ValidMockSigner(signerKp.publicKey()),
    activityStore,
    approvalStore,
    policyRules: { maxTxAmount: { XLM: "500" } }, // Allow amount 10
  });

  const sourceAccount = {
    agentId: "agent-sim-fail",
    ownerId: "owner-sim-fail",
    accountId: () => signerKp.publicKey(),
    sequenceNumber: () => "100",
    incrementSequenceNumber: () => {},
  };

  try {
    const outcome = await pipeline.execute({
      intent: preCreatedActivity.intent,
      sourceAccount,
      activityId: preCreatedActivity.id,
    });

    assert.equal(outcome.status, "simulation_failed");
    assert.equal(outcome.activityId, preCreatedActivity.id);

    const updated = await activityStore.get(preCreatedActivity.id);
    assert.ok(updated);
    assert.equal(updated!.status, "failed");
    assert.equal(updated!.authorizationStatus, "denied_by_simulation");
    assert.match(updated!.error ?? "", /Simulation failed/i);

    // AC 7: Record count must remain 1 (no duplicate activity created)
    const allActivities = await activityStore.listByAgent("agent-sim-fail");
    assert.equal(allActivities.length, 1, "Exactly one ActivityRecord must exist in store");
  } finally {
    StellarSimulator.prototype.simulate = origSimulate;
  }
});
