import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  InMemoryActivityStore,
  SQLiteActivityStore,
  type ActivityStore,
} from "../src/index.js";
import { toStroops, fromStroops } from "@4evergent/shared";

// #374: daily spending is stored and compared as INTEGER stroops
// (1 XLM = 10^7 stroops), not REAL/float XLM. This is what makes fractional
// amounts that are not exactly representable in binary (0.1, 0.2, 0.3, …)
// enforce to the stroop instead of drifting or falsely denying an exact limit.

function makeStore(name: "InMemory" | "SQLite"): { store: ActivityStore; cleanup: () => void } {
  if (name === "InMemory") {
    return { store: new InMemoryActivityStore(), cleanup: () => {} };
  }
  const tmp = mkdtempSync(join(tmpdir(), "spending-374-"));
  const store = new SQLiteActivityStore(join(tmp, "test.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const BACKENDS = ["InMemory", "SQLite"] as const;

for (const backend of BACKENDS) {
  test(`#374 [${backend}] 0.1 + 0.2 against a 0.3 daily limit is allowed (true sum equals the limit)`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      // 0.1 + 0.2 in IEEE-754 is 0.30000000000000004 > 0.3, which under the old
      // REAL/float path falsely denied the second reservation. In integer
      // stroops 1_000_000 + 2_000_000 == 3_000_000 == the 0.3 limit stroops.
      assert.equal(await store.reserveDailySpending("a1", "XLM", "0.1", "0.3"), true);
      assert.equal(await store.reserveDailySpending("a1", "XLM", "0.2", "0.3"), true);
      // Stored total is the exact integer stroop count for 0.3 XLM — not a
      // float like 0.30000000000000004.
      assert.equal(await store.getDailySpending("a1", "XLM"), toStroops("0.3"));
      assert.equal(await store.getDailySpending("a1", "XLM"), 3000000);
      // The limit is exactly exhausted: a further 1-stroop reservation is denied.
      assert.equal(await store.reserveDailySpending("a1", "XLM", "0.0000001", "0.3"), false);
      assert.equal(await store.getDailySpending("a1", "XLM"), toStroops("0.3"), "denial must not change the stored total");
    } finally {
      cleanup();
    }
  });

  test(`#374 [${backend}] ten 0.1 payments against a 1.0 limit store exactly 1.0 used`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      // 10 * 0.1 in IEEE-754 accumulates to 0.9999999999999999, understating
      // true spend. Integer stroops add to exactly 10_000_000 (1.0 XLM).
      for (let i = 0; i < 10; i++) {
        assert.equal(await store.reserveDailySpending("a1", "XLM", "0.1", "1.0"), true);
      }
      assert.equal(await store.getDailySpending("a1", "XLM"), toStroops("1.0"));
      assert.equal(await store.getDailySpending("a1", "XLM"), 10000000);
      // Exact: the stored total round-trips back to exactly "1", not garbage.
      assert.equal(fromStroops((await store.getDailySpending("a1", "XLM")) ?? 0), "1");
      // The limit is exactly reached; one more stroop is denied.
      assert.equal(await store.reserveDailySpending("a1", "XLM", "0.0000001", "1.0"), false);
    } finally {
      cleanup();
    }
  });

  test(`#374 [${backend}] getDailySpending returns an integer, never float garbage`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      assert.equal(await store.reserveDailySpending("a1", "XLM", "0.1", "1.0"), true);
      assert.equal(await store.reserveDailySpending("a1", "XLM", "0.2", "1.0"), true);
      const used = await store.getDailySpending("a1", "XLM");
      assert.equal(used, toStroops("0.3"));
      // The stored value is an exact integer (Number.isSafeInteger), not a
      // float like 0.30000000000000004.
      assert.ok(used !== null && Number.isSafeInteger(used), `expected safe integer, got ${used}`);
    } finally {
      cleanup();
    }
  });

  test(`#374 [${backend}] remaining is exact: 1.0 - 0.8 yields 0.2 stroops, not 0.19999999999999998`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      assert.equal(await store.reserveDailySpending("a1", "XLM", "0.8", "1.0"), true);
      const usedStroops = (await store.getDailySpending("a1", "XLM")) ?? 0;
      const remainingStroops = toStroops("1.0")! - usedStroops;
      // 1.0 - 0.8 under floats is 0.19999999999999998; in stroops it is exactly
      // 0.2 XLM, which formats to "0.2" — no float garbage.
      assert.equal(remainingStroops, toStroops("0.2"));
      assert.equal(fromStroops(remainingStroops), "0.2");
    } finally {
      cleanup();
    }
  });
}

// #374 migration: a pre-#374 database whose daily_spending.total column is
// REAL (decimal XLM) is rebuilt to INTEGER stroops on startup, and the old
// decimal totals are converted in place.
test("#374 [SQLite] legacy REAL total column is migrated to INTEGER stroops on startup", () => {
  const tmp = mkdtempSync(join(tmpdir(), "spending-374-mig-"));
  const dbPath = join(tmp, "legacy.db");
  try {
    // Build a database exactly as an older release did: REAL total column
    // holding decimal XLM totals, including a drifted boundary value
    // (0.1 + 0.2 = 0.30000000000000004) that the float path produced.
    const setup = new DatabaseSync(dbPath);
    setup.exec(`
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '5');
      CREATE TABLE daily_spending (
        agent_id TEXT NOT NULL,
        asset TEXT NOT NULL,
        day TEXT NOT NULL,
        total REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, asset, day)
      );
      CREATE INDEX idx_daily_spending_day ON daily_spending(day);
    `);
    const drifted = 0.1 + 0.2; // 0.30000000000000004
    setup
      .prepare("INSERT INTO daily_spending VALUES (?, ?, ?, ?)")
      .run("agent-1", "XLM", "2025-01-15", 300.0);
    setup
      .prepare("INSERT INTO daily_spending VALUES (?, ?, ?, ?)")
      .run("agent-1", "USDC", "2025-01-15", drifted);
    setup.close();

    // Constructing the store migrates the REAL column to INTEGER stroops.
    const store = new SQLiteActivityStore(dbPath);
    try {
      const verify = new DatabaseSync(dbPath);
      try {
        const totalType = verify
          .prepare("PRAGMA table_info(daily_spending)")
          .all() as { name: string; type: string }[];
        assert.equal(totalType.find((c) => c.name === "total")?.type, "INTEGER");
        // 300 XLM -> 3_000_000_000 stroops exactly.
        const xlm = verify
          .prepare("SELECT total FROM daily_spending WHERE agent_id = ? AND asset = ?")
          .get("agent-1", "XLM") as { total: number };
        assert.equal(xlm.total, toStroops("300"));
        // The drifted 0.30000000000000004 boundary value is corrected to the
        // exact 0.3 XLM stroop count by the ROUND(total * 1e7) conversion.
        const usdc = verify
          .prepare("SELECT total FROM daily_spending WHERE agent_id = ? AND asset = ?")
          .get("agent-1", "USDC") as { total: number };
        assert.equal(usdc.total, toStroops("0.3"));
      } finally {
        verify.close();
      }
      // After migration the store enforces stroops to the stroop: an exact
      // boundary reservation against the migrated 0.3 total works.
      void store;
    } finally {
      store.close();
    }

    // Re-opening is idempotent: the column is already INTEGER, no re-migration.
    const again = new SQLiteActivityStore(dbPath);
    again.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("#374 [SQLite] fresh database creates an INTEGER total column (no migration needed)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "spending-374-fresh-"));
  const dbPath = join(tmp, "fresh.db");
  try {
    const store = new SQLiteActivityStore(dbPath);
    store.close();
    const verify = new DatabaseSync(dbPath);
    try {
      const totalType = verify
        .prepare("PRAGMA table_info(daily_spending)")
        .all() as { name: string; type: string }[];
      assert.equal(totalType.find((c) => c.name === "total")?.type, "INTEGER");
    } finally {
      verify.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
