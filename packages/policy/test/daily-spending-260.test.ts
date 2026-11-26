import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { PolicyEngine } from "../src/engine.js";
import type { AgentIntent } from "@4evergent/shared";
import { toStroops } from "@4evergent/shared";
import {
  createActivity,
  InMemoryActivityStore,
  SQLiteActivityStore,
} from "../../database/src/index.js";

function makePaymentIntent(amount: string, asset = "XLM"): AgentIntent {
  return {
    type: "payment",
    asset,
    destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount,
    reason: "test #260",
  };
}

function makePolicy(dailyLimit: string) {
  return {
    maxTxAmount: { XLM: "10000" },
    dailySpendingLimit: { XLM: dailyLimit },
    allowedAssets: ["XLM"],
    allowedDestinations: [] as string[],
    allowedContractIds: [] as string[],
    txTypeRestrictions: {
      payment: true,
      trustline: true,
      swap: true,
      contract_call: true,
    },
    requireHumanApprovalForAmountAbove: "100000",
  };
}

const BACKENDS = ["InMemory", "SQLite"] as const;

for (const backend of BACKENDS) {
  test(`#260 [${backend}] counts all 250 same-day submitted activities and denies approve-path re-check when limit exceeded`, async () => {
    let store: InMemoryActivityStore | SQLiteActivityStore;
    let cleanup: () => void = () => {};

    if (backend === "InMemory") {
      store = new InMemoryActivityStore();
    } else {
      const dir = mkdtempSync(join(tmpdir(), "policy-260-"));
      const dbPath = join(dir, "test.db");
      store = new SQLiteActivityStore(dbPath);
      cleanup = () => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      };
    }

    try {
      const agentId = `agent-260-${backend.toLowerCase()}`;
      const now = new Date();

      // Seed 250 submitted payment activities of 1 XLM today
      const todayBaseMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 0, 0);
      for (let i = 0; i < 250; i++) {
        const activityTime = new Date(todayBaseMs + i * 1000).toISOString();
        const record = createActivity(agentId, "owner-1", makePaymentIntent("1"));
        record.id = `act-${backend}-${i}`;
        record.status = "submitted";
        record.createdAt = activityTime;
        record.updatedAt = activityTime;
        await store.record(record);
      }

      // Also seed 50 activities from yesterday (should NOT be counted)
      const yesterdayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 12, 0, 0);
      for (let i = 0; i < 50; i++) {
        const activityTime = new Date(yesterdayMs + i * 1000).toISOString();
        const record = createActivity(agentId, "owner-1", makePaymentIntent("5"));
        record.id = `act-${backend}-yesterday-${i}`;
        record.status = "submitted";
        record.createdAt = activityTime;
        record.updatedAt = activityTime;
        await store.record(record);
      }

      // 1. Verify getDailySpent sums all 250 same-day submitted activities (250 XLM in stroops)
      // Without pagination, this would have truncated at 200.
      const engine = new PolicyEngine(makePolicy("250"), store);
      const totalSpent = await engine.getDailySpent("XLM", agentId);
      assert.equal(totalSpent, toStroops("250"), `${backend}: must sum all 250 same-day activities, not truncate at 200`);

      // 2. Approve-path re-check (skipReservation: true):
      // When limit is 250 and 250 is already spent, an additional 1 XLM must be denied
      const denyDecision = await engine.evaluate(makePaymentIntent("1"), agentId, { skipReservation: true });
      assert.equal(denyDecision.result, "deny", `${backend}: approve-path re-check must deny when limit exceeded`);
      assert.equal(denyDecision.rule, "dailySpendingLimit");
      assert.match(denyDecision.reason, /spent 250(?:\.0+)?, limit 250, remaining 0(?:\.0+)?/);

      // 3. When limit is higher (e.g. 300), 250 spent leaves 50 remaining, so 10 XLM is allowed
      const higherEngine = new PolicyEngine(makePolicy("300"), store);
      const allowDecision = await higherEngine.evaluate(makePaymentIntent("10"), agentId, { skipReservation: true });
      assert.equal(allowDecision.result, "allow", `${backend}: approve-path re-check allows when within limit`);
    } finally {
      cleanup();
    }
  });
}
