import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/index.js";
import {
  InMemoryActivityStore,
  SQLiteActivityStore,
  closeSharedConnection,
  createActivity,
} from "@4evergent/database";
import { DevAuthProvider } from "@4evergent/shared";
import type { Signer } from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";

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

function makeAgent(id: string, ownerId: string) {
  return {
    id,
    displayName: "Test",
    description: "test agent",
    ownerId,
    stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    capabilities: [],
    status: "active" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    active: true,
    metadata: {},
  };
}

async function startServer(opts?: { policyRules?: Partial<PolicyRules>; signer?: Signer; ownerId?: string; agentId?: string }) {
  const signer = opts?.signer ?? new MockSigner("test-agent");
  const ownerId = opts?.ownerId ?? "test";
  const agentId = opts?.agentId ?? "test-agent";
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer,
    policyRules: opts?.policyRules,
    authProvider: new DevAuthProvider({ defaultOwnerId: ownerId }),
  });
  server.registerAgent(makeAgent(agentId, ownerId));

  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  return { baseUrl, close: () => server.close(), store: server.store, agentId };
}

const INTENT_BODY = {
  type: "payment",
  asset: "XLM",
  destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  amount: "100",
  reason: "test payment",
};

test("TEST A: same owner+agent+key → exactly 1 activity record", async () => {
  const { baseUrl, close, store } = await startServer();
  try {
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "idem-key-a" };
    const res1 = await fetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(INTENT_BODY),
    });
    assert.equal(res1.status, 202);
    const res2 = await fetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(INTENT_BODY),
    });
    assert.equal(res2.status, 200);

    const body1 = await res1.json();
    const body2 = await res2.json();
    assert.equal(body1.activityId, body2.activityId);

    const existing = await store.getByIdempotencyKey("test", "test-agent", "idem-key-a");
    assert.ok(existing);
    assert.equal(existing?.id, body1.activityId);
  } finally {
    await close();
  }
});

test("TEST B: duplicate returns consistent activity identity", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "idem-key-b" };
    const responses = await Promise.all([
      fetch(`${baseUrl}/agents/test-agent/intents`, { method: "POST", headers, body: JSON.stringify(INTENT_BODY) }),
      fetch(`${baseUrl}/agents/test-agent/intents`, { method: "POST", headers, body: JSON.stringify(INTENT_BODY) }),
    ]);
    assert.equal(responses[0].status, 202);
    assert.equal(responses[1].status, 200);

    const bodies = await Promise.all(responses.map(r => r.json()));
    assert.equal(bodies[0].activityId, bodies[1].activityId);
  } finally {
    await close();
  }
});

test("TEST C: same key + different intent → second rejected as conflict", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "idem-key-c" };
    const res1 = await fetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(INTENT_BODY),
    });
    assert.equal(res1.status, 202);

    const differentIntent = { ...INTENT_BODY, amount: "999" };
    const res2 = await fetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(differentIntent),
    });
    assert.equal(res2.status, 409);
  } finally {
    await close();
  }
});

test("TEST D: same key + different owner → isolation preserved", async () => {
  const serverA = await startServer({ ownerId: "owner-a", agentId: "agent-a" });
  const serverB = await startServer({ ownerId: "owner-b", agentId: "agent-b" });

  try {
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "idem-key-d" };
    const resA = await fetch(`${serverA.baseUrl}/agents/agent-a/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(INTENT_BODY),
    });
    const resB = await fetch(`${serverB.baseUrl}/agents/agent-b/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(INTENT_BODY),
    });
    assert.equal(resA.status, 202);
    assert.equal(resB.status, 202);

    const bodyA = await resA.json();
    const bodyB = await resB.json();
    assert.notEqual(bodyA.activityId, bodyB.activityId);
  } finally {
    await serverA.close();
    await serverB.close();
  }
});

test("TEST E: same owner+agent + different keys → multiple activities allowed", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res1 = await fetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "idem-key-e1" },
      body: JSON.stringify(INTENT_BODY),
    });
    const res2 = await fetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "idem-key-e2" },
      body: JSON.stringify(INTENT_BODY),
    });
    assert.equal(res1.status, 202);
    assert.equal(res2.status, 202);

    const body1 = await res1.json();
    const body2 = await res2.json();
    assert.notEqual(body1.activityId, body2.activityId);
  } finally {
    await close();
  }
});

test("TEST F: InMemoryActivityStore and SQLiteActivityStore expire Idempotency-Key after TTL while preserving ActivityRecord audit rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "4eg-idem-ttl-"));
  const dbPath = join(dir, "test.db");
  try {
    const ttlMs = 60_000; // 60s window
    const memStore = new InMemoryActivityStore({ idempotencyTtlMs: ttlMs });
    const sqlStore = new SQLiteActivityStore(dbPath, { idempotencyTtlMs: ttlMs });

    for (const store of [memStore, sqlStore]) {
      const t0 = new Date("2026-01-01T00:00:00.000Z");
      const withinWindow = new Date("2026-01-01T00:00:30.000Z");
      const afterWindow = new Date("2026-01-01T00:01:01.000Z");

      const first = createActivity(
        "agent-1",
        "owner-1",
        INTENT_BODY as any,
        { result: "allow", reason: "ok", rule: "default", intent: INTENT_BODY as any },
        "key-ttl-1"
      );
      first.createdAt = t0.toISOString();
      first.updatedAt = t0.toISOString();

      const res1 = await store.recordIdempotent("key-ttl-1", first, t0);
      assert.equal(res1.created, true);

      // Within window: returns existing activity
      const hitWithin = await store.getByIdempotencyKey("owner-1", "agent-1", "key-ttl-1", withinWindow);
      assert.ok(hitWithin);
      assert.equal(hitWithin?.id, first.id);

      // After window: key expires, returns null, and allows reuse for a new activity
      const hitExpired = await store.getByIdempotencyKey("owner-1", "agent-1", "key-ttl-1", afterWindow);
      assert.equal(hitExpired, null);

      const second = createActivity(
        "agent-1",
        "owner-1",
        { ...INTENT_BODY, amount: "250" } as any,
        { result: "allow", reason: "ok", rule: "default", intent: INTENT_BODY as any },
        "key-ttl-1"
      );
      second.createdAt = afterWindow.toISOString();
      second.updatedAt = afterWindow.toISOString();

      const res2 = await store.recordIdempotent("key-ttl-1", second, afterWindow);
      assert.equal(res2.created, true);
      assert.equal(res2.record.id, second.id);
      assert.notEqual(second.id, first.id);

      // Both ActivityRecord entries remain intact in the append-only audit log
      const preservedFirst = await store.get(first.id);
      const preservedSecond = await store.get(second.id);
      assert.ok(preservedFirst, "Original expired activity record must remain in audit log");
      assert.equal(preservedFirst?.idempotencyKey ?? null, null);
      assert.ok(preservedSecond);
      assert.equal(preservedSecond?.idempotencyKey, "key-ttl-1");
    }
  } finally {
    closeSharedConnection(dbPath);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TEST G: sweepExpiredIdempotencyKeys clears expired keys in bounded batches while preserving activities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "4eg-idem-sweep-"));
  const dbPath = join(dir, "sweep.db");
  try {
    const memStore = new InMemoryActivityStore();
    const sqlStore = new SQLiteActivityStore(dbPath);

    for (const store of [memStore, sqlStore]) {
      for (let i = 0; i < 3; i++) {
        const rec = createActivity(
          "agent-1",
          "owner-1",
          INTENT_BODY as any,
          { result: "allow", reason: "ok", rule: "default", intent: INTENT_BODY as any },
          `sweep-key-${i}`
        );
        rec.createdAt = `2026-01-0${i + 1}T00:00:00.000Z`;
        rec.updatedAt = rec.createdAt;
        await store.record(rec);
      }

      // Sweep records created on or before 2026-01-02 with limit=1 (bounded batch)
      const cleared1 = await store.sweepExpiredIdempotencyKeys!("2026-01-02T00:00:00.000Z", 1);
      assert.equal(cleared1, 1);

      // Sweep remaining expired record
      const cleared2 = await store.sweepExpiredIdempotencyKeys!("2026-01-02T00:00:00.000Z", 10);
      assert.equal(cleared2, 1);

      // Third record (2026-01-03) is still within window
      const all = await store.listByAgent("agent-1", 10);
      assert.equal(all.length, 3, "All 3 activity audit records must be preserved");
      const activeKeys = all.map((r) => r.idempotencyKey).filter(Boolean);
      assert.deepEqual(activeKeys, ["sweep-key-2"]);
    }
  } finally {
    closeSharedConnection(dbPath);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TEST H: API POST /agents/:id/intents allows Idempotency-Key reuse after configured TTL expires", async () => {
  const signer = new MockSigner("test-agent");
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer,
    idempotencyTtlSeconds: 0.05, // 50ms TTL for fast test
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
  });
  server.registerAgent(makeAgent("test-agent", "test"));
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

  try {
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "idem-key-http-ttl" };
    const res1 = await fetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(INTENT_BODY),
    });
    assert.equal(res1.status, 202);
    const body1 = await res1.json();

    // Wait for 50ms TTL to elapse
    await new Promise((r) => setTimeout(r, 80));

    // Reusing the same key now creates a new activity (even with a different amount within policy limits)
    const res2 = await fetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...INTENT_BODY, amount: "80" }),
    });
    assert.equal(res2.status, 202);
    const body2 = await res2.json();
    assert.notEqual(body1.activityId, body2.activityId);

    // Original activity record is still preserved in GET /agents/:id/activity/:activityId
    const detailRes = await fetch(`${baseUrl}/agents/test-agent/activity/${body1.activityId}`);
    assert.equal(detailRes.status, 200);
  } finally {
    await server.close();
  }
});

