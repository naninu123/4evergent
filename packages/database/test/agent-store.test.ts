import { test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAgentStore, SQLiteAgentStore } from "../src/agent-store.js";
import { closeSharedConnection } from "../src/shared-connection.js";
import type { CreateAgentInput } from "../src/agent-types.js";

function temporaryDatabasePath(): string {
  return join(tmpdir(), `4evergent-agent-store-${crypto.randomUUID()}.db`);
}

function removeTemporaryDatabase(dbPath: string): void {
  closeSharedConnection(dbPath);
  try {
    unlinkSync(dbPath);
  } catch {
    // The database file may not have been created if setup failed.
  }
}

function testStores(name: string, makeStore: () => InMemoryAgentStore | SQLiteAgentStore) {
  test(`${name}: create and get`, async () => {
    const store = makeStore();
    const input: CreateAgentInput = { displayName: "Agent A", ownerId: "owner-a" };
    const agent = await store.create(input);
    assert.equal(agent.displayName, "Agent A");
    assert.equal(agent.status, "active");
    assert.equal(agent.active, true);
    assert.deepEqual(agent.capabilities, []);
    assert.equal(agent.description, "");
    assert.equal(agent.stellarAddress, "");
    assert.ok(agent.id);

    const fetched = await store.get(agent.id);
    assert.equal(fetched?.id, agent.id);
    assert.equal(fetched?.ownerId, "owner-a");
    assert.equal(fetched?.metadata !== undefined, true);
  });

  test(`${name}: create with full fields`, async () => {
    const store = makeStore();
    const agent = await store.create({
      displayName: "Full",
      description: "desc",
      capabilities: ["payment"],
      ownerId: "owner-b",
      stellarAddress: "GADDR",
      status: "paused",
    });
    assert.equal(agent.status, "paused");
    assert.equal(agent.active, false);
    assert.deepEqual(agent.capabilities, ["payment"]);
    assert.equal(agent.stellarAddress, "GADDR");
  });

  test(`${name}: create preserves explicit id`, async () => {
    const store = makeStore();
    const agent = await store.create({ id: "fixed-id", displayName: "Fixed", ownerId: "owner-a" });
    assert.equal(agent.id, "fixed-id");
    const fetched = await store.get("fixed-id");
    assert.equal(fetched?.displayName, "Fixed");
  });

  test(`${name}: getForOwner enforces owner`, async () => {
    const store = makeStore();
    const agent = await store.create({ displayName: "X", ownerId: "owner-a" });
    assert.ok(await store.getForOwner(agent.id, "owner-a"));
    assert.equal(await store.getForOwner(agent.id, "owner-b"), null);
  });

  test(`${name}: listByOwner only returns owner records`, async () => {
    const store = makeStore();
    await store.create({ displayName: "A", ownerId: "owner-a" });
    await store.create({ displayName: "B", ownerId: "owner-b" });
    const list = await store.listByOwner("owner-a");
    assert.equal(list.length, 1);
    assert.equal(list[0]?.displayName, "A");
  });

  test(`${name}: update status`, async () => {
    const store = makeStore();
    const agent = await store.create({ displayName: "A", ownerId: "owner-a" });
    const updated = await store.update(agent.id, { status: "paused" });
    assert.equal(updated?.status, "paused");
    assert.equal(updated?.active, false);
  });

  test(`${name}: concurrent status transitions use the current stored status`, async () => {
    const store = makeStore();
    const agent = await store.create({ displayName: "A", ownerId: "owner-a" });

    const [disabled, pause] = await Promise.all([
      store.transitionStatus(agent.id, "disabled"),
      store.transitionStatus(agent.id, "paused"),
    ]);

    assert.equal(disabled.updated, true);
    assert.deepEqual(pause, {
      updated: false,
      reason: "invalid_transition",
      currentStatus: "disabled",
    });
    assert.equal((await store.get(agent.id))?.status, "disabled");
  });

  test(`${name}: disabled agents cannot transition back to active`, async () => {
    const store = makeStore();
    const agent = await store.create({ displayName: "A", ownerId: "owner-a" });
    await store.transitionStatus(agent.id, "disabled");

    const result = await store.transitionStatus(agent.id, "active");
    assert.deepEqual(result, {
      updated: false,
      reason: "invalid_transition",
      currentStatus: "disabled",
    });
    assert.equal((await store.get(agent.id))?.status, "disabled");
  });

  test(`${name}: delete removes record`, async () => {
    const store = makeStore();
    const agent = await store.create({ displayName: "A", ownerId: "owner-a" });
    assert.equal(await store.delete(agent.id), true);
    assert.equal(await store.get(agent.id), null);
  });
}

testStores("InMemoryAgentStore", () => new InMemoryAgentStore());

test("SQLiteAgentStore: persistence across instances", async () => {
  const dbPath = temporaryDatabasePath();
  try {
    const store1 = new SQLiteAgentStore(dbPath);
    const created = await store1.create({ displayName: "Persisted", ownerId: "owner-a" });
    closeSharedConnection(dbPath);

    const store2 = new SQLiteAgentStore(dbPath);
    const fetched = await store2.get(created.id);
    assert.ok(fetched);
    assert.equal(fetched.displayName, "Persisted");
    assert.equal(fetched.ownerId, "owner-a");
    assert.equal(fetched.status, "active");
    store2.close();
  } finally {
    removeTemporaryDatabase(dbPath);
  }
});

test("SQLiteAgentStore: concurrent status transitions use the current stored status", async () => {
  const dbPath = temporaryDatabasePath();
  try {
    const store = new SQLiteAgentStore(dbPath);
    const agent = await store.create({ displayName: "Concurrent", ownerId: "owner-a" });

    const [disabled, pause] = await Promise.all([
      store.transitionStatus(agent.id, "disabled"),
      store.transitionStatus(agent.id, "paused"),
    ]);

    assert.equal(disabled.updated, true);
    assert.deepEqual(pause, {
      updated: false,
      reason: "invalid_transition",
      currentStatus: "disabled",
    });
    assert.equal((await store.get(agent.id))?.status, "disabled");
  } finally {
    removeTemporaryDatabase(dbPath);
  }
});
