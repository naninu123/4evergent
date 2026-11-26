import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer, STUCK_EXECUTION_THRESHOLD_MS } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { PolicyRules } from "@4evergent/shared";
import type { AddressInfo } from "node:net";
import {
  InMemoryActivityStore,
  InMemoryAgentStore,
  InMemoryApprovalStore,
  InMemoryExecutionStore,
} from "@4evergent/database";
import type { ApprovalRecord, ExecutionRecord } from "@4evergent/database";

declare const fetch: typeof globalThis.fetch;

const TEST_INTENT = {
  type: "payment" as const,
  asset: "XLM",
  destination: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
  amount: "10",
  reason: "dashboard endpoint test",
};

function makeApproval(ownerId: string, id: string, status: ApprovalRecord["status"] = "pending_approval"): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id,
    activityId: `activity-${id}`,
    agentId: "dashboard-agent",
    ownerId,
    intent: TEST_INTENT,
    policyDecision: { result: "requires_approval", reason: "test", rule: "test", intent: TEST_INTENT },
    status,
    requestedAt: now,
    approvedAt: null,
    rejectedAt: null,
    expiredAt: null,
    approver: null,
    expiresAt: null,
    txHash: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeExecution(
  ownerId: string,
  id: string,
  status: ExecutionRecord["status"],
  overrides: Partial<ExecutionRecord> = {},
): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id,
    ownerId,
    agentId: "dashboard-agent",
    approvalId: null,
    activityId: null,
    intent: TEST_INTENT,
    status,
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function startServer(opts: {
  auth?: boolean;
  policyRules?: Partial<PolicyRules>;
  registerAgent?: boolean;
} = {}) {
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();
  const executionStore = new InMemoryExecutionStore();
  const agentId = `dashboard-agent-${crypto.randomUUID()}`;
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: {
      getAccountId: () => "GTEST",
      getNetworkPassphrase: () => "Test SDF Network ; September 2015",
      sign: async (transaction: any) => transaction,
    },
    activityStore,
    approvalStore,
    executionStore,
    agentStore: new InMemoryAgentStore(),
    authProvider: opts.auth === false
      ? undefined
      : new DevAuthProvider({ defaultOwnerId: "owner-a", apiKeys: { "owner-b-token": "owner-b" } }),
    policyRules: opts.policyRules,
  });

  if (opts.registerAgent !== false) {
    server.registerAgent({
      id: agentId,
      displayName: "Dashboard Test Agent",
      description: "dashboard endpoint fixture",
      ownerId: "owner-a",
      stellarAddress: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
      capabilities: ["payment"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      active: true,
      status: "active",
      metadata: {},
    });
  }

  await server.listen(0);
  const address = server.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => server.close(),
    activityStore,
    approvalStore,
    executionStore,
    agentId,
  };
}

async function request(baseUrl: string, path: string, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    keepalive: false,
  });
  return { status: response.status, body: await response.json() };
}

test("GET /overview/attention returns zero dashboard counters for a fresh owner", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const response = await request(baseUrl, "/overview/attention");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      pendingApprovals: 0,
      failedExecutions: 0,
      deadLetterExecutions: 0,
      retryingExecutions: 0,
      stuckExecutions: 0,
    });
  } finally {
    await close();
  }
});

test("GET /overview/attention counts statuses for the authenticated owner only", async () => {
  const { baseUrl, close, approvalStore, executionStore } = await startServer();
  try {
    await approvalStore.record(makeApproval("owner-a", "pending-a"));
    await approvalStore.record(makeApproval("owner-a", "approved-a", "approved"));
    await approvalStore.record(makeApproval("owner-b", "pending-b"));
    for (const [id, status] of [
      ["queued-a", "queued"],
      ["executing-a", "executing"],
      ["failed-a", "failed"],
      ["dead-letter-a", "dead_letter"],
      ["cancelled-a", "cancelled"],
      ["submitted-a", "submitted"],
      ["confirmed-a", "confirmed"],
      ["failed-b", "failed"],
    ] as const) {
      await executionStore.record(makeExecution(id === "failed-b" ? "owner-b" : "owner-a", id, status));
    }

    const response = await request(baseUrl, "/overview/attention");
    assert.equal(response.status, 200);
    // #359: retrying and stuck are definitional, not status-derived. The
    // fixture is intentionally unchanged from before the fix, so a regression
    // that reinstates the old mislabel will turn this test red:
    //   - queued-a is healthy (never failed) → not retrying
    //   - executing-a has startedAt = null → not stuck (age unknown)
    assert.deepEqual(response.body, {
      pendingApprovals: 1,
      failedExecutions: 1,
      deadLetterExecutions: 1,
      retryingExecutions: 0,
      stuckExecutions: 0,
    });
  } finally {
    await close();
  }
});

test("#359: healthy queued executions do NOT count as retrying or stuck", async () => {
  // Acceptance: with only healthy queued executions, retryingExecutions is 0
  // and the Needs Attention section does not list them.
  const { baseUrl, close, executionStore } = await startServer();
  try {
    for (let i = 0; i < 5; i++) {
      await executionStore.record(makeExecution("owner-a", `queued-${i}`, "queued"));
    }
    const response = await request(baseUrl, "/overview/attention");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      pendingApprovals: 0,
      failedExecutions: 0,
      deadLetterExecutions: 0,
      retryingExecutions: 0,
      stuckExecutions: 0,
    });
  } finally {
    await close();
  }
});

test("#359: mixed attention fixture — retrying and stuck use the documented definitions", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const justYoung = new Date(now - 1_000).toISOString();
    const justOld = new Date(now - STUCK_EXECUTION_THRESHOLD_MS - 1_000).toISOString();

    // healthy queued — neither retrying nor stuck
    await executionStore.record(makeExecution("owner-a", "queued-1", "queued"));

    // failed + scheduled retry + transient → retrying
    await executionStore.record(makeExecution("owner-a", "failed-retry-transient", "failed", {
      nextRetryAt: nowIso, errorClass: "transient", attempt: 1,
    }));

    // failed + scheduled retry + permanent → NOT retrying (won't actually retry)
    await executionStore.record(makeExecution("owner-a", "failed-retry-permanent", "failed", {
      nextRetryAt: nowIso, errorClass: "permanent", attempt: 1,
    }));

    // failed + transient but NO scheduled retry → NOT retrying
    await executionStore.record(makeExecution("owner-a", "failed-no-schedule", "failed", {
      nextRetryAt: null, errorClass: "transient", attempt: 1,
    }));

    // failed + scheduled retry but null errorClass → NOT retrying
    await executionStore.record(makeExecution("owner-a", "failed-no-class", "failed", {
      nextRetryAt: nowIso, errorClass: null, attempt: 1,
    }));

    // young executing → NOT stuck
    await executionStore.record(makeExecution("owner-a", "executing-young", "executing", {
      startedAt: justYoung,
    }));

    // old executing → stuck
    await executionStore.record(makeExecution("owner-a", "executing-old", "executing", {
      startedAt: justOld,
    }));

    // executing with null startedAt → age unknown, NOT stuck
    await executionStore.record(makeExecution("owner-a", "executing-null", "executing"));

    // plain failed — failedExecutions only, not retrying
    await executionStore.record(makeExecution("owner-a", "failed-plain", "failed"));

    // dead_letter — deadLetterExecutions only
    await executionStore.record(makeExecution("owner-a", "dead-letter-1", "dead_letter"));

    // Other owner's records — must not leak into owner-a's counts.
    await executionStore.record(makeExecution("owner-b", "failed-retry-other", "failed", {
      nextRetryAt: nowIso, errorClass: "transient", attempt: 1,
    }));
    await executionStore.record(makeExecution("owner-b", "executing-old-other", "executing", {
      startedAt: justOld,
    }));

    const response = await request(baseUrl, "/overview/attention");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      pendingApprovals: 0,
      // failed for owner-a: retry-transient, retry-permanent, no-schedule,
      // no-class, plain → 5. (failed-retry-other is owner-b, excluded.)
      failedExecutions: 5,
      deadLetterExecutions: 1,
      // Only failed-retry-transient (failed + nextRetryAt + transient).
      retryingExecutions: 1,
      // Only executing-old. executing-young is 1s old (well inside the
      // threshold); executing-null has no startedAt (age unknown). The strict
      // `<` (exactly-at-cutoff-is-not-stuck) contract is NOT asserted here:
      // the fixture's `now` and the handler's `Date.now()` are separate calls
      // separated by the HTTP round-trip, so a startedAt built from the
      // fixture's cutoff is already strictly older than the handler's cutoff
      // by the time the request is processed. That makes any "exactly at the
      // boundary" fixture nondeterministic regardless of OS. The strict-<
      // contract is documented on countAttentionByOwner and would be pinned
      // by a store unit test with an injected clock if needed.
      stuckExecutions: 1,
    });
  } finally {
    await close();
  }
});

test("GET /overview/attention returns the exact pendingApprovals count above 200 approvals", async () => {
  const { baseUrl, close, approvalStore } = await startServer();
  try {
    for (let index = 0; index < 205; index++) {
      await approvalStore.record(makeApproval("owner-a", `pending-${index}`));
    }
    for (let index = 0; index < 3; index++) {
      await approvalStore.record(makeApproval("owner-a", `approved-${index}`, "approved"));
    }
    for (let index = 0; index < 2; index++) {
      await approvalStore.record(makeApproval("owner-b", `other-pending-${index}`));
    }

    const response = await request(baseUrl, "/overview/attention");
    assert.equal(response.status, 200);
    assert.equal(response.body.pendingApprovals, 205);
  } finally {
    await close();
  }
});

test("GET /agents/:id/spending returns dashboard budget values for configured assets", async () => {
  const { baseUrl, close, activityStore, agentId } = await startServer({
    policyRules: { dailySpendingLimit: { XLM: "100", USDC: "200", EXACT: "25", INVALID: "not-a-number" } },
  });
  try {
    await activityStore.reserveDailySpending(agentId, "USDC", "75", "200");
    await activityStore.reserveDailySpending(agentId, "EXACT", "25", "25");

    const response = await request(baseUrl, `/agents/${agentId}/spending`);
    assert.equal(response.status, 200);
    assert.equal(response.body.agentId, agentId);
    assert.deepEqual(response.body.spending, {
      XLM: { used: 0, limit: "100", remaining: 100 },
      USDC: { used: 75, limit: "200", remaining: 125 },
      EXACT: { used: 25, limit: "25", remaining: 0 },
    });
    assert.equal(Object.hasOwn(response.body.spending, "INVALID"), false);
    assert.ok(Object.values(response.body.spending).every((entry: any) => entry.remaining >= 0));
  } finally {
    await close();
  }
});

test("GET /overview/attention and GET /agents/:id/spending require authentication", async () => {
  const { baseUrl, close, agentId } = await startServer({ auth: false });
  try {
    const attention = await request(baseUrl, "/overview/attention");
    const spending = await request(baseUrl, `/agents/${agentId}/spending`);
    assert.equal(attention.status, 401);
    assert.equal(spending.status, 401);
  } finally {
    await close();
  }
});

test("GET /agents/:id/spending returns 404 when the agent belongs to another owner", async () => {
  const { baseUrl, close, agentId } = await startServer();
  try {
    const response = await request(baseUrl, `/agents/${agentId}/spending`, "owner-b-token");
    assert.equal(response.status, 404);
  } finally {
    await close();
  }
});
