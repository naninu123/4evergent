import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import type { Signer } from "@4evergent/stellar";
import type { AddressInfo } from "node:net";
import {
  InMemoryAgentStore,
  InMemoryExecutionStore,
  type AgentStore,
  type ExecutionStore,
} from "@4evergent/database";
import { DevAuthProvider } from "@4evergent/shared";
import { createApiServer, type ServerOptions } from "../src/index.js";

// Regression tests for issue #285:
// (a) Unexpected throws in routed handlers return HTTP 500 INTERNAL_ERROR with
//     X-Request-Id, log the error server-side with requestId, and leak no
//     internal details or stack traces to the client.
// (b) Approve where executionQueue.enqueue() fails returns HTTP 500
//     INTERNAL_ERROR instead of claiming the transaction was queued.

class MockSigner implements Signer {
  constructor(private readonly shouldThrow = false) {}
  getAccountId(): string {
    if (this.shouldThrow) {
      throw new Error("SECRET_SIGNER_FAILURE at /srv/keys/master.seed");
    }
    return `G${"A".repeat(55)}`;
  }
  getNetworkPassphrase(): string {
    return "Test SDF Network ; September 2015";
  }
  async sign(transaction: any): Promise<any> {
    return transaction;
  }
}

const TEST_AGENT = {
  id: "boundary-agent",
  displayName: "Boundary Test Agent",
  description: "agent for error boundary tests",
  ownerId: "test",
  stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  capabilities: ["payment"],
  status: "active" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

function captureStdoutJsonLines(): { entries: Record<string, unknown>[]; restore: () => void } {
  const original = console.log;
  const entries: Record<string, unknown>[] = [];
  console.log = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ").trim();
    if (line.startsWith("{")) {
      try {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // ignore non-JSON lines
      }
    }
  };
  return {
    entries,
    restore: () => {
      console.log = original;
    },
  };
}

async function startServer(overrides: Partial<ServerOptions> = {}) {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner(false),
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
    deferExecution: true,
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    ...overrides,
  });
  server.registerAgent(TEST_AGENT);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

test("async throw in routed handler returns 500 INTERNAL_ERROR with X-Request-Id, logs with requestId, and leaks no internal details", async () => {
  const baseStore = new InMemoryAgentStore();
  const failingAgentStore: AgentStore = {
    create: (r) => baseStore.create(r),
    get: (id) => baseStore.get(id),
    getForOwner: (id, ownerId) => baseStore.getForOwner(id, ownerId),
    listByOwner: async () => {
      throw new Error("SQLITE_CORRUPT: SELECT * FROM agents WHERE secret_token='top-secret'");
    },
    listByCapability: (ownerId, cap, limit) => baseStore.listByCapability(ownerId, cap, limit),
    update: (id, patch) => baseStore.update(id, patch),
    delete: (id) => baseStore.delete(id),
  };

  const { baseUrl, close } = await startServer({ agentStore: failingAgentStore });
  const logs = captureStdoutJsonLines();
  try {
    const suppliedReqId = "req-forced-throw-500";
    const res = await fetch(`${baseUrl}/agents`, {
      headers: { "X-Request-Id": suppliedReqId },
    });
    const rawText = await res.text();
    const body = JSON.parse(rawText) as Record<string, unknown>;

    assert.equal(res.status, 500);
    assert.equal(res.headers.get("x-request-id"), suppliedReqId);
    assert.deepEqual(body, {
      code: "INTERNAL_ERROR",
      error: "internal_error",
    });

    // Must not leak SQL, internal error messages, or stack traces to the client
    assert.ok(!rawText.includes("SQLITE_CORRUPT"), "internal error string must not leak");
    assert.ok(!rawText.includes("top-secret"), "sensitive details must not leak");
    assert.ok(!rawText.includes("at "), "stack trace must not leak");

    // Must log the caught throw server-side with its requestId
    const errLog = logs.entries.find(
      (e) => e.level === "error" && e.msg === "unhandled request error" && e.requestId === suppliedReqId,
    );
    assert.ok(errLog, "expected structured error log with requestId");
    assert.match(String(errLog.error ?? ""), /SQLITE_CORRUPT/);
  } finally {
    logs.restore();
    await close();
  }
});

test("synchronous throw in routed handler returns 500 INTERNAL_ERROR with generated X-Request-Id", async () => {
  const { baseUrl, close } = await startServer({ signer: new MockSigner(true) });
  const logs = captureStdoutJsonLines();
  try {
    const res = await fetch(`${baseUrl}/health`);
    const rawText = await res.text();
    const body = JSON.parse(rawText) as Record<string, unknown>;
    const requestId = res.headers.get("x-request-id");

    assert.equal(res.status, 500);
    assert.ok(requestId && requestId.length > 0, "X-Request-Id must be present on 500 response");
    assert.deepEqual(body, {
      code: "INTERNAL_ERROR",
      error: "internal_error",
    });
    assert.ok(!rawText.includes("SECRET_SIGNER_FAILURE"));
    assert.ok(!rawText.includes("/srv/keys/master.seed"));

    const errLog = logs.entries.find(
      (e) => e.level === "error" && e.msg === "unhandled request error" && e.requestId === requestId,
    );
    assert.ok(errLog, "expected structured error log carrying generated requestId");
  } finally {
    logs.restore();
    await close();
  }
});

test("POST /approvals/:id/approve returns 500 INTERNAL_ERROR when executionQueue.enqueue fails and does not claim execution was queued", async () => {
  const baseExecStore = new InMemoryExecutionStore();
  const failingExecStore: ExecutionStore = {
    record: async () => {
      throw new Error("SQLITE_IOERR: disk write failed while enqueueing execution");
    },
    get: (id) => baseExecStore.get(id),
    getForOwner: (id, ownerId) => baseExecStore.getForOwner(id, ownerId),
    listByAgent: (agentId, ownerId, limit, offset) => baseExecStore.listByAgent(agentId, ownerId, limit, offset),
    listByOwner: (ownerId, limit, offset) => baseExecStore.listByOwner(ownerId, limit, offset),
    listByActivity: (activityId, ownerId) => baseExecStore.listByActivity(activityId, ownerId),
    listDue: (nowIso, limit) => baseExecStore.listDue(nowIso, limit),
    listExecutingBefore: (cutoffIso) => baseExecStore.listExecutingBefore(cutoffIso),
    listConfirmingSubmitted: (limit) => baseExecStore.listConfirmingSubmitted(limit),
    claimExecution: (id, nowIso) => baseExecStore.claimExecution(id, nowIso),
    update: (id, patch) => baseExecStore.update(id, patch),
    updateIfStatus: (id, expected, patch) => baseExecStore.updateIfStatus(id, expected, patch),
    countByStatus: (ownerId) => baseExecStore.countByStatus(ownerId),
  };

  const { baseUrl, close } = await startServer({
    deferExecution: false,
    executionStore: failingExecStore,
    executionQueue: { enabled: true, intervalMs: 60_000 },
  });

  const logs = captureStdoutJsonLines();
  try {
    // 1. Submit an intent above the approval threshold to create a pending approval
    const submitRes = await fetch(`${baseUrl}/agents/boundary-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: Keypair.random().publicKey(),
        amount: "50",
        reason: "Approve enqueue failure test",
      }),
    });
    assert.equal(submitRes.status, 202);
    const submitBody = (await submitRes.json()) as { approvalId: string };
    assert.ok(submitBody.approvalId);

    // 2. Approve — enqueue throws; server must return 500 INTERNAL_ERROR, NOT 200 "queued for execution"
    const approveRes = await fetch(`${baseUrl}/approvals/${submitBody.approvalId}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "req-approve-enqueue-fail",
      },
      body: JSON.stringify({}),
    });
    const rawApprove = await approveRes.text();
    const approveBody = JSON.parse(rawApprove) as Record<string, unknown>;

    assert.equal(approveRes.status, 500);
    assert.equal(approveRes.headers.get("x-request-id"), "req-approve-enqueue-fail");
    assert.deepEqual(approveBody, {
      code: "INTERNAL_ERROR",
      error: "internal_error",
    });
    assert.ok(!rawApprove.includes("queued for execution"), "must not claim execution was queued");
    assert.ok(!rawApprove.includes("SQLITE_IOERR"), "must not leak internal store failure");

    const errLog = logs.entries.find(
      (e) =>
        e.level === "error" &&
        e.msg === "unhandled request error" &&
        e.requestId === "req-approve-enqueue-fail",
    );
    assert.ok(errLog, "expected structured error log for failed approve enqueue");
  } finally {
    logs.restore();
    await close();
  }
});
