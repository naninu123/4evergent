import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import type { Signer } from "@4evergent/stellar";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import { EXECUTION_STATUSES, InMemoryExecutionStore } from "@4evergent/database";
import type { ExecutionRecord, ExecutionStatus } from "@4evergent/database";

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string {
    return this.id;
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

class RecordingExecutionStore extends InMemoryExecutionStore {
  listByAgentCalls: Array<{ agentId: string; limit: number; offset: number; status?: ExecutionStatus }> = [];
  listByOwnerCalls: Array<{ ownerId: string; limit: number; offset: number; status?: ExecutionStatus }> = [];

  async listByAgent(agentId: string, limit = 50, offset = 0, status?: ExecutionStatus): Promise<ExecutionRecord[]> {
    this.listByAgentCalls.push({ agentId, limit, offset, status });
    return super.listByAgent(agentId, limit, offset, status);
  }

  async listByOwner(ownerId: string, limit = 50, offset = 0, status?: ExecutionStatus): Promise<ExecutionRecord[]> {
    this.listByOwnerCalls.push({ ownerId, limit, offset, status });
    return super.listByOwner(ownerId, limit, offset, status);
  }
}

const intent = {
  type: "payment" as const,
  asset: "XLM",
  destination: Keypair.random().publicKey(),
  amount: "1",
  reason: "execution status filter test",
};

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "test",
    agentId: "test-agent",
    approvalId: null,
    activityId: null,
    intent,
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seedExecutions(
  store: InMemoryExecutionStore,
  opts: {
    ownerId: string;
    agentId: string;
    status: ExecutionStatus;
    count: number;
    baseMs: number;
  }
) {
  for (let i = 0; i < opts.count; i++) {
    const ts = new Date(opts.baseMs + i).toISOString();
    await store.record(
      makeExecution({
        ownerId: opts.ownerId,
        agentId: opts.agentId,
        status: opts.status,
        createdAt: ts,
        updatedAt: ts,
      })
    );
  }
}

async function startServer(executionStore: RecordingExecutionStore) {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    executionStore,
  });
  server.registerAgent({
    id: "test-agent",
    displayName: "Test Agent",
    description: "test agent",
    ownerId: "test",
    stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    capabilities: ["payment"],
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    active: true,
    metadata: {},
  });

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

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { keepalive: false });
  return { status: res.status, body: await res.json() };
}

test("GET /agents/:id/executions?status= and GET /executions?status= pass status to store-level queries", async () => {
  const store = new RecordingExecutionStore();
  const { baseUrl, close } = await startServer(store);
  try {
    const base = Date.now();
    await seedExecutions(store, { ownerId: "test", agentId: "test-agent", status: "failed", count: 3, baseMs: base });
    await seedExecutions(store, { ownerId: "test", agentId: "test-agent", status: "confirmed", count: 2, baseMs: base + 1000 });

    const agentFiltered = await get(baseUrl, "/agents/test-agent/executions?status=failed&limit=50&offset=0");
    assert.equal(agentFiltered.status, 200);
    assert.equal(agentFiltered.body.executions.length, 3);
    for (const e of agentFiltered.body.executions) assert.equal(e.status, "failed");
    assert.deepEqual(store.listByAgentCalls, [
      { agentId: "test-agent", limit: 51, offset: 0, status: "failed" },
    ]);

    const ownerFiltered = await get(baseUrl, "/executions?status=confirmed&limit=50&offset=0");
    assert.equal(ownerFiltered.status, 200);
    assert.equal(ownerFiltered.body.executions.length, 2);
    for (const e of ownerFiltered.body.executions) assert.equal(e.status, "confirmed");
    assert.deepEqual(store.listByOwnerCalls, [
      { ownerId: "test", limit: 51, offset: 0, status: "confirmed" },
    ]);

    const unfiltered = await get(baseUrl, "/executions");
    assert.equal(unfiltered.status, 200);
    assert.equal(unfiltered.body.executions.length, 5);
    assert.deepEqual(store.listByOwnerCalls[1], {
      ownerId: "test",
      limit: 51,
      offset: 0,
      status: undefined,
    });
  } finally {
    await close();
  }
});

test("unknown execution status returns 400 naming all valid ExecutionStatus values", async () => {
  const store = new RecordingExecutionStore();
  const { baseUrl, close } = await startServer(store);
  try {
    for (const path of [
      "/agents/test-agent/executions?status=not_a_real_status",
      "/executions?status=not_a_real_status",
    ]) {
      const res = await get(baseUrl, path);
      assert.equal(res.status, 400, `${path} must reject unknown statuses`);
      assert.match(res.body.error, /invalid status 'not_a_real_status'/);
      for (const valid of EXECUTION_STATUSES) {
        assert.ok(res.body.error.includes(valid), `${path} error must name valid value ${valid}`);
      }
      assert.equal(res.body.executions, undefined, `${path} must not return a list`);
    }

    for (const path of [
      "/agents/test-agent/executions?status=",
      "/executions?status=",
    ]) {
      const empty = await get(baseUrl, path);
      assert.equal(empty.status, 400, `${path}: an explicitly empty status must not be treated as absent`);
    }

    const noMatches = await get(baseUrl, "/executions?status=dead_letter");
    assert.equal(noMatches.status, 200);
    assert.deepEqual(noMatches.body.executions, []);
    assert.equal(noMatches.body.hasMore, false);
  } finally {
    await close();
  }
});

test("status filtering applies at the store level before limit/offset pagination", async () => {
  const store = new RecordingExecutionStore();
  const { baseUrl, close } = await startServer(store);
  try {
    const base = Date.now();
    // 3 older dead_letter records and 10 newer confirmed records
    await seedExecutions(store, { ownerId: "test", agentId: "test-agent", status: "dead_letter", count: 3, baseMs: base });
    await seedExecutions(store, { ownerId: "test", agentId: "test-agent", status: "confirmed", count: 10, baseMs: base + 10_000 });

    const ownerPage1 = await get(baseUrl, "/executions?status=dead_letter&limit=2&offset=0");
    assert.equal(ownerPage1.status, 200);
    assert.equal(ownerPage1.body.executions.length, 2);
    assert.equal(ownerPage1.body.hasMore, true);
    for (const e of ownerPage1.body.executions) assert.equal(e.status, "dead_letter");

    const ownerPage2 = await get(baseUrl, "/executions?status=dead_letter&limit=2&offset=2");
    assert.equal(ownerPage2.status, 200);
    assert.equal(ownerPage2.body.executions.length, 1);
    assert.equal(ownerPage2.body.hasMore, false);
    for (const e of ownerPage2.body.executions) assert.equal(e.status, "dead_letter");

    const agentPage1 = await get(baseUrl, "/agents/test-agent/executions?status=dead_letter&limit=2&offset=0");
    assert.equal(agentPage1.status, 200);
    assert.equal(agentPage1.body.executions.length, 2);
    assert.equal(agentPage1.body.hasMore, true);

    const agentPage2 = await get(baseUrl, "/agents/test-agent/executions?status=dead_letter&limit=2&offset=2");
    assert.equal(agentPage2.status, 200);
    assert.equal(agentPage2.body.executions.length, 1);
    assert.equal(agentPage2.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /executions?status= preserves owner isolation", async () => {
  const store = new RecordingExecutionStore();
  const { baseUrl, close } = await startServer(store);
  try {
    const base = Date.now();
    await seedExecutions(store, { ownerId: "test", agentId: "test-agent", status: "failed", count: 2, baseMs: base });
    await seedExecutions(store, { ownerId: "other-owner", agentId: "other-agent", status: "failed", count: 5, baseMs: base + 1000 });

    const res = await get(baseUrl, "/executions?status=failed");
    assert.equal(res.status, 200);
    assert.equal(res.body.executions.length, 2);
    for (const e of res.body.executions) assert.equal(e.ownerId, "test");
  } finally {
    await close();
  }
});
