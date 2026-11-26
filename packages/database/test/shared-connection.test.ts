import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  getSharedConnection,
  getSharedConnectionRefCount,
  getSchemaVersion,
  setSchemaVersion,
  closeSharedConnection,
  closeAllSharedConnections,
  EXPECTED_SCHEMA_VERSION,
} from "../src/shared-connection.js";
import { SQLiteActivityStore } from "../src/sqlite-store.js";
import { SQLiteAgentStore } from "../src/agent-store.js";

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "shared-conn-test-"));
  tmpDirs.push(d);
  return d;
}

function cleanup() {
  closeAllSharedConnections();
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
}

test("returns same DatabaseSync instance for same dbPath", () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "test.db");
  const db1 = getSharedConnection(dbPath);
  const db2 = getSharedConnection(dbPath);
  assert.equal(db1, db2);
  cleanup();
});

test("configures WAL, busy_timeout, and synchronous mode on every shared connection", () => {
  const dir = makeTmpDir();
  const db = getSharedConnection(join(dir, "pragmas.db"));
  assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
  assert.equal((db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 1);
  cleanup();
});

test("returns different instances for different dbPaths", () => {
  const dir = makeTmpDir();
  const db1 = getSharedConnection(join(dir, "a.db"));
  const db2 = getSharedConnection(join(dir, "b.db"));
  assert.notEqual(db1, db2);
  cleanup();
});

test("getSchemaVersion returns the single expected version on creation", () => {
  const dir = makeTmpDir();
  const db = getSharedConnection(join(dir, "test.db"));
  assert.equal(getSchemaVersion(db), EXPECTED_SCHEMA_VERSION);
  cleanup();
});

test("refuses an older schema instead of silently stamping it as current", () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "old.db");
  const first = getSharedConnection(dbPath);
  setSchemaVersion(first, EXPECTED_SCHEMA_VERSION - 1);
  closeSharedConnection(dbPath);
  assert.throws(() => getSharedConnection(dbPath), /expected 5, actual 4/);
  cleanup();
});

test("refuses a newer schema before a store can use it", () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "new.db");
  const first = getSharedConnection(dbPath);
  setSchemaVersion(first, EXPECTED_SCHEMA_VERSION + 1);
  closeSharedConnection(dbPath);
  assert.throws(() => getSharedConnection(dbPath), /expected 5, actual 6/);
  cleanup();
});

test("setSchemaVersion overwrites and getSchemaVersion reads back", () => {
  const dir = makeTmpDir();
  const db = getSharedConnection(join(dir, "test.db"));
  setSchemaVersion(db, 42);
  assert.equal(getSchemaVersion(db), 42);
  cleanup();
});

test("closeSharedConnection removes instance from registry", () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "test.db");
  const db1 = getSharedConnection(dbPath);
  closeSharedConnection(dbPath);
  const db2 = getSharedConnection(dbPath);
  assert.notEqual(db1, db2);
  cleanup();
});

test("stores sharing same dbPath use same underlying connection", () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "test.db");
  const store1 = new SQLiteActivityStore(dbPath);
  const store2 = new SQLiteAgentStore(dbPath);
  store1.close();
  store2.close();

  const db = getSharedConnection(dbPath);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const tableNames = tables.map((t) => t.name);
  assert.ok(tableNames.includes("activities"), "activities table should exist");
  assert.ok(tableNames.includes("agents"), "agents table should exist");
  cleanup();
});

test("concurrent writes through shared connection do not deadlock", async () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "test.db");
  const db = getSharedConnection(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS test_concurrent (id INTEGER PRIMARY KEY, val TEXT);");

  const promises: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    promises.push(
      (async () => {
        db.prepare("INSERT INTO test_concurrent (val) VALUES (?)").run(`val-${i}`);
      })(),
    );
  }

  await Promise.all(promises);

  const result = db.prepare("SELECT COUNT(*) as c FROM test_concurrent").get() as { c: number };
  assert.equal(result.c, 20);
  cleanup();
});

test("concurrent writes from two stores on the same path complete without SQLITE_BUSY", async () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "two-stores.db");
  const first = new SQLiteAgentStore(dbPath);
  const second = new SQLiteAgentStore(dbPath);
  const writes = Array.from({ length: 20 }, (_, index) =>
    (index % 2 === 0 ? first : second).create({
      id: `agent-${index}`,
      displayName: `Agent ${index}`,
      ownerId: "owner-a",
    }),
  );
  const created = await Promise.all(writes);
  assert.equal(created.length, 20);
  assert.equal((await first.listByOwner("owner-a")).length, 20);
  cleanup();
});

test("reference counting: connection stays open until refCount drops to 0", () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "refcount.db");

  const db1 = getSharedConnection(dbPath);
  assert.equal(getSharedConnectionRefCount(dbPath), 1);

  const db2 = getSharedConnection(dbPath);
  assert.equal(db1, db2);
  assert.equal(getSharedConnectionRefCount(dbPath), 2);

  // Closing once decrements refCount to 1; connection is still open and usable
  closeSharedConnection(dbPath);
  assert.equal(getSharedConnectionRefCount(dbPath), 1);
  assert.doesNotThrow(() => db1.prepare("SELECT 1").get());

  // Closing second time drops refCount to 0; closes connection and removes from map
  closeSharedConnection(dbPath);
  assert.equal(getSharedConnectionRefCount(dbPath), 0);

  // Re-requesting opens a new connection
  const db3 = getSharedConnection(dbPath);
  assert.equal(getSharedConnectionRefCount(dbPath), 1);
  assert.notEqual(db1, db3);
  cleanup();
});

test("reference counting: force close terminates connection immediately regardless of refCount", () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "force-close.db");

  getSharedConnection(dbPath);
  getSharedConnection(dbPath);
  getSharedConnection(dbPath);
  assert.equal(getSharedConnectionRefCount(dbPath), 3);

  closeSharedConnection(dbPath, true);
  assert.equal(getSharedConnectionRefCount(dbPath), 0);
  cleanup();
});

test("store close is idempotent and does not double-decrement refCount", () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "idempotent.db");

  const store1 = new SQLiteActivityStore(dbPath);
  const store2 = new SQLiteAgentStore(dbPath);
  assert.equal(getSharedConnectionRefCount(dbPath), 2);

  store1.close();
  assert.equal(getSharedConnectionRefCount(dbPath), 1);
  store1.close(); // idempotent
  assert.equal(getSharedConnectionRefCount(dbPath), 1);

  store2.close();
  assert.equal(getSharedConnectionRefCount(dbPath), 0);
  store2.close(); // idempotent
  assert.equal(getSharedConnectionRefCount(dbPath), 0);
  cleanup();
});

test("checkpoint on close: single .db file copy after clean close contains all committed rows", async () => {
  const dir = makeTmpDir();
  const dbPath = join(dir, "checkpoint.db");

  const store = new SQLiteAgentStore(dbPath);
  await store.create({
    id: "agent-chk-1",
    displayName: "Checkpoint Agent 1",
    ownerId: "owner-chk",
  });
  await store.create({
    id: "agent-chk-2",
    displayName: "Checkpoint Agent 2",
    ownerId: "owner-chk",
  });

  // Close the store (which triggers checkpoint and closes connection)
  store.close();
  assert.equal(getSharedConnectionRefCount(dbPath), 0);

  // Copy ONLY the .db file (ignoring -wal and -shm files) to an isolated folder
  const copyDir = makeTmpDir();
  const copyPath = join(copyDir, "checkpoint-copy.db");
  copyFileSync(dbPath, copyPath);

  // The copy must open cleanly and contain all committed records
  const copyDb = new DatabaseSync(copyPath);
  try {
    const rows = copyDb.prepare("SELECT id, display_name FROM agents ORDER BY id ASC").all() as {
      id: string;
      display_name: string;
    }[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.id, "agent-chk-1");
    assert.equal(rows[1]!.id, "agent-chk-2");
  } finally {
    copyDb.close();
  }

  // Also assert that if a -wal file exists at all, it is empty (0 bytes) after checkpoint(TRUNCATE)
  const walPath = `${dbPath}-wal`;
  if (existsSync(walPath)) {
    assert.equal(statSync(walPath).size, 0, "WAL file should be truncated to 0 bytes");
  }

  cleanup();
});
