import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { PolicyEngine } from "../src/engine.js";
import type { AgentIntent } from "@4evergent/shared";
import { toStroops, fromStroops } from "@4evergent/shared";
import {
  InMemoryActivityStore,
  SQLiteActivityStore,
  type ActivityStore,
} from "../../database/src/index.js";

// #374: the daily-limit enforcement path uses integer stroops end to end, so a
// 0.1 + 0.2 sequence against a 0.3 limit is allowed (true sum equals the
// limit) and the approval-time re-check agrees with enforcement at the
// boundary because both read the same reservation table with the same integer
// arithmetic. Under the old REAL/float path 0.1 + 0.2 = 0.30000000000000004 >
// 0.3, falsely denying the second intent and disagreeing with the re-check.

const DEST = "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function payment(amount: string): AgentIntent {
  return { type: "payment", asset: "XLM", destination: DEST, amount, reason: "test" };
}

function makeStore(backend: "InMemory" | "SQLite"): { store: ActivityStore; cleanup: () => void } {
  if (backend === "InMemory") {
    return { store: new InMemoryActivityStore(), cleanup: () => {} };
  }
  const tmp = mkdtempSync(join(tmpdir(), "policy-374-"));
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
  test(`#374 [${backend}] engine allows 0.1 then 0.2 against a 0.3 daily limit (true sum equals the limit)`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      const engine = new PolicyEngine(
        {
          maxTxAmount: { XLM: "1000" },
          dailySpendingLimit: { XLM: "0.3" },
          allowedAssets: ["XLM"],
          requireHumanApprovalForAmountAbove: "10000",
        },
        store as any
      );
      // Both reservations succeed: 1_000_000 + 2_000_000 <= 3_000_000 stroops.
      const d1 = await engine.evaluate(payment("0.1"), "agent-1");
      assert.equal(d1.result, "allow", "0.1 within 0.3 limit must be allowed");
      const d2 = await engine.evaluate(payment("0.2"), "agent-1");
      assert.equal(d2.result, "allow", "0.1 + 0.2 == 0.3 must be allowed (was falsely denied by floats)");
      // The reservation table holds the exact 0.3 stroop count.
      assert.equal(await store.getDailySpending("agent-1", "XLM"), toStroops("0.3"));
      // A further 1-stroop intent is now denied by the daily limit.
      const d3 = await engine.evaluate(payment("0.0000001"), "agent-1");
      assert.equal(d3.result, "deny");
      assert.equal(d3.rule, "dailySpendingLimit");
    } finally {
      cleanup();
    }
  });

  test(`#374 [${backend}] enforcement and approval-time re-check agree at the 0.3 boundary`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      const engine = new PolicyEngine(
        {
          maxTxAmount: { XLM: "1000" },
          dailySpendingLimit: { XLM: "0.3" },
          allowedAssets: ["XLM"],
          requireHumanApprovalForAmountAbove: "10000",
        },
        store as any
      );
      // Enforcement reserves exactly 0.3 XLM.
      assert.equal((await engine.evaluate(payment("0.1"), "agent-1")).result, "allow");
      assert.equal((await engine.evaluate(payment("0.2"), "agent-1")).result, "allow");
      assert.equal(await store.getDailySpending("agent-1", "XLM"), toStroops("0.3"));

      // Approval-time re-check reads the same reservation table with the same
      // integer arithmetic: reserved (3_000_000) is NOT greater than limit
      // (3_000_000), so the re-check agrees with enforcement that the limit is
      // exactly met, not exceeded.
      const recheck = await engine.evaluate(payment("0.1"), "agent-1", { skipReservation: true });
      assert.notEqual(recheck.result, "deny", "re-check must agree: 0.3 reserved == 0.3 limit, not exceeded");
      assert.equal(await store.getDailySpending("agent-1", "XLM"), toStroops("0.3"), "re-check must not double-reserve");

      // Tighten the limit below the reserved total: the re-check must deny,
      // matching the integer comparison reservedTotal (3_000_000) > limit (2_000_000).
      const tightened = new PolicyEngine(
        {
          maxTxAmount: { XLM: "1000" },
          dailySpendingLimit: { XLM: "0.2" },
          allowedAssets: ["XLM"],
          requireHumanApprovalForAmountAbove: "10000",
        },
        store as any
      );
      const denied = await tightened.evaluate(payment("0.1"), "agent-1", { skipReservation: true });
      assert.equal(denied.result, "deny");
      assert.equal(denied.rule, "dailySpendingLimit");
      // The deny message reports exact decimals, never float garbage.
      assert.match(denied.reason, /0\.3/);
      assert.match(denied.reason, /0\.2/);
      assert.doesNotMatch(denied.reason, /0\.30000000000000004/);
    } finally {
      cleanup();
    }
  });
}

// #374: the getDailySpent fallback (used when the store cannot report the
// reservation table, e.g. a minimal test double) also sums integer stroops, so
// it stays in exact agreement with the reservation path at the boundary.
test("#374: getDailySpent fallback sums integer stroops and agrees at the boundary", async () => {
  const today = new Date().toISOString();
  // A minimal store: listByAgent returns two "submitted" activities whose
  // amounts are 0.1 and 0.2 (the float-trap pair); no reservation methods.
  const minimal: Pick<ActivityStore, "listByAgent"> = {
    listByAgent: async () => [
      {
        id: "1",
        agentId: "agent-1",
        intent: payment("0.1"),
        status: "submitted",
        createdAt: today,
      },
      {
        id: "2",
        agentId: "agent-1",
        intent: payment("0.2"),
        status: "submitted",
        createdAt: today,
      },
    ],
  };
  const engine = new PolicyEngine(
    {
      maxTxAmount: { XLM: "1000" },
      dailySpendingLimit: { XLM: "0.3" },
      allowedAssets: ["XLM"],
      requireHumanApprovalForAmountAbove: "10000",
    },
    minimal as any
  );
  // 0.3 already "spent" via the fallback sum; a 1-stroop intent is denied
  // because remaining is 0 (3_000_000 - 3_000_000), and 1 > 0.
  const denied = await engine.evaluate(payment("0.0000001"), "agent-1");
  assert.equal(denied.result, "deny");
  assert.equal(denied.rule, "dailySpendingLimit");
  // Under a looser limit (0.4), 1 stroop is allowed: remaining = 1_000_000.
  const loose = new PolicyEngine(
    {
      maxTxAmount: { XLM: "1000" },
      dailySpendingLimit: { XLM: "0.4" },
      allowedAssets: ["XLM"],
      requireHumanApprovalForAmountAbove: "10000",
    },
    minimal as any
  );
  const allowed = await loose.evaluate(payment("0.0000001"), "agent-1");
  assert.equal(allowed.result, "allow");
});

// #374: the reserve path denies at the exact boundary (0.3 already reserved),
// and the skipReservation re-check message formats exact decimals via
// fromStroops (covered above). This smoke-checks the boundary denial and that
// fromStroops round-trips the reserved total to exactly "0.3" (no garbage).
test("#374: reserve path denies at the exact 0.3 boundary; fromStroops is exact", async () => {
  const store = new InMemoryActivityStore();
  const engine = new PolicyEngine(
    {
      maxTxAmount: { XLM: "1000" },
      dailySpendingLimit: { XLM: "0.3" },
      allowedAssets: ["XLM"],
      requireHumanApprovalForAmountAbove: "10000",
    },
    store
  );
  // Reserve exactly 0.3 (0.1 + 0.2 in stroops == 3_000_000).
  assert.equal((await engine.evaluate(payment("0.1"), "agent-1")).result, "allow");
  assert.equal((await engine.evaluate(payment("0.2"), "agent-1")).result, "allow");
  // The next 1-stroop intent is denied at the exact boundary.
  const denied = await engine.evaluate(payment("0.0000001"), "agent-1");
  assert.equal(denied.result, "deny");
  assert.equal(denied.rule, "dailySpendingLimit");
  // The reserved total round-trips to exactly "0.3", never float garbage.
  assert.equal(fromStroops((await store.getDailySpending("agent-1", "XLM")) ?? 0), "0.3");
});
