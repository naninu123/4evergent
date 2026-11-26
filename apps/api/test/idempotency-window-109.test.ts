/**
 * #109: Idempotency-Key replay window through the HTTP API, on both stores.
 * The window is overridden to 400 ms so the after-window case is fast.
 */
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
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
    stellarAddress: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
    capabilities: [],
    status: "active" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    active: true,
    metadata: {},
  };
}

async function startServer(opts?: { policyRules?: Partial<PolicyRules>; signer?: Signer; ownerId?: string; agentId?: string; idempotencyKeyWindowMs?: number; dbPath?: string }) {
  const signer = opts?.signer ?? new MockSigner("test-agent");
  const ownerId = opts?.ownerId ?? "test";
  const agentId = opts?.agentId ?? "test-agent";
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer,
    policyRules: opts?.policyRules,
    authProvider: new DevAuthProvider({ defaultOwnerId: ownerId }),
    idempotencyKeyWindowMs: opts?.idempotencyKeyWindowMs,
    dbPath: opts?.dbPath,
    retention: { enabled: false },
  });
  server.registerAgent(makeAgent(agentId, ownerId));

  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;
  return { baseUrl, close: () => server.close(), store: server.store, agentId };
}

const INTENT_BODY = {
  type: "payment",
  asset: "XLM",
  destination: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
  amount: "100",
  reason: "test payment",
};

const WINDOW_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function post(baseUrl: string, key: string, body: unknown) {
  return fetch(`${baseUrl}/agents/test-agent/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

const backends: Array<{ name: string; dbPath: () => { path?: string; cleanup: () => void } }> = [
  { name: "in-memory", dbPath: () => ({ path: undefined, cleanup: () => {} }) },
  {
    name: "sqlite",
    dbPath: () => {
      const dir = mkdtempSync(join(tmpdir(), "idem-api-109-"));
      return { path: join(dir, "api.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    },
  },
];

for (const backend of backends) {
  test(`#109 ${backend.name}: same key inside the window returns the original activity`, async () => {
    const db = backend.dbPath();
    const { baseUrl, close, store } = await startServer({ idempotencyKeyWindowMs: 60_000, dbPath: db.path });
    try {
      const res1 = await post(baseUrl, "win-in", INTENT_BODY);
      assert.equal(res1.status, 202);
      const res2 = await post(baseUrl, "win-in", INTENT_BODY);
      assert.equal(res2.status, 200);
      assert.equal((await res1.json()).activityId, (await res2.json()).activityId);
      assert.equal((await store.listByAgent("test-agent")).length, 1);
    } finally {
      await close();
      db.cleanup();
    }
  });

  test(`#109 ${backend.name}: same key with a different intent inside the window is still 409`, async () => {
    const db = backend.dbPath();
    const { baseUrl, close, store } = await startServer({ idempotencyKeyWindowMs: 60_000, dbPath: db.path });
    try {
      assert.equal((await post(baseUrl, "win-409", INTENT_BODY)).status, 202);
      assert.equal((await post(baseUrl, "win-409", { ...INTENT_BODY, amount: "999" })).status, 409);
      assert.equal((await store.listByAgent("test-agent")).length, 1);
    } finally {
      await close();
      db.cleanup();
    }
  });

  test(`#109 ${backend.name}: same key after the window creates a new activity; the old one is kept`, async () => {
    const db = backend.dbPath();
    const { baseUrl, close, store } = await startServer({ idempotencyKeyWindowMs: WINDOW_MS, dbPath: db.path });
    try {
      const res1 = await post(baseUrl, "win-out", INTENT_BODY);
      assert.equal(res1.status, 202);
      const first = (await res1.json()).activityId;
      await sleep(WINDOW_MS + 150);
      const res2 = await post(baseUrl, "win-out", INTENT_BODY);
      assert.equal(res2.status, 202);
      const second = (await res2.json()).activityId;
      assert.notEqual(second, first);
      assert.ok(await store.get(first), "expired activity must not be deleted");
      assert.equal((await store.listByAgent("test-agent")).length, 2);
      assert.equal((await store.getByIdempotencyKey("test", "test-agent", "win-out"))?.id, second);
    } finally {
      await close();
      db.cleanup();
    }
  });
}
