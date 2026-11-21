// #327: the policy editor now lets operators set per-asset limits for every
// allowed asset (not only XLM). These tests pin the engine behaviour the
// editor relies on: a USDC entry in maxTxAmount / dailySpendingLimit is
// enforced exactly like the XLM entry, and clearing it leaves USDC uncapped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine } from "../src/engine.js";
import type { PolicyRules } from "../src/types.js";
import type { AgentIntent } from "@4evergent/shared";

const usdcIntent = (amount: string): AgentIntent =>
  ({ type: "payment", asset: "USDC", destination: "GAAAA", amount, reason: "test" }) as AgentIntent;

const xlmIntent = (amount: string): AgentIntent =>
  ({ type: "payment", asset: "XLM", destination: "GAAAA", amount, reason: "test" }) as AgentIntent;

/** Rules as the editor saves them for an agent allowed to use XLM and USDC. */
function editorRules(overrides: Partial<PolicyRules> = {}): Partial<PolicyRules> {
  return {
    maxTxAmount: { XLM: "100", USDC: "50" },
    dailySpendingLimit: { XLM: "500", USDC: "100" },
    allowedAssets: ["XLM", "USDC"],
    requireHumanApprovalForAmountAbove: "1000",
    approvalThreshold: "1000",
    ...overrides,
  };
}

/** In-memory atomic reservation store, tracking per-asset daily totals. */
function makeReservingStore() {
  const totals = new Map<string, number>();
  return {
    listByAgent: async () => [],
    reserveDailySpending: async (agentId: string, asset: string, amount: string, limit: string) => {
      const key = `${agentId}:${asset}`;
      const next = (totals.get(key) ?? 0) + Number(amount);
      if (next > Number(limit)) return false;
      totals.set(key, next);
      return true;
    },
    releaseDailySpending: async () => {},
  };
}

test("#327: USDC max-tx of 50 denies a 60 USDC intent", async () => {
  const engine = new PolicyEngine(editorRules());
  const decision = await engine.evaluate(usdcIntent("60"), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.equal(decision.rule, "maxTxAmount");
  assert.match(decision.reason, /60 USDC exceeds max_tx_amount 50/);
});

test("#327: USDC max-tx of 50 allows a 40 USDC intent", async () => {
  const engine = new PolicyEngine(editorRules());
  const decision = await engine.evaluate(usdcIntent("40"), "GAGENT");
  assert.equal(decision.result, "allow");
});

test("#327: USDC daily limit is enforced the same way as the XLM daily limit", async () => {
  const engine = new PolicyEngine(editorRules(), makeReservingStore());

  assert.equal((await engine.evaluate(usdcIntent("45"), "GAGENT")).result, "allow");
  assert.equal((await engine.evaluate(usdcIntent("45"), "GAGENT")).result, "allow");
  const third = await engine.evaluate(usdcIntent("45"), "GAGENT");
  assert.equal(third.result, "deny");
  assert.equal(third.rule, "dailySpendingLimit");

  // The USDC reservation does not consume the XLM budget.
  assert.equal((await engine.evaluate(xlmIntent("90"), "GAGENT")).result, "allow");
});

test("#327: clearing the USDC limits (no map entry) leaves USDC uncapped", async () => {
  const engine = new PolicyEngine(
    editorRules({ maxTxAmount: { XLM: "100" }, dailySpendingLimit: { XLM: "500" } }),
    makeReservingStore()
  );
  const decision = await engine.evaluate(usdcIntent("900"), "GAGENT");
  assert.equal(decision.result, "allow");

  // XLM caps are unchanged.
  const xlm = await engine.evaluate(xlmIntent("150"), "GAGENT");
  assert.equal(xlm.result, "deny");
  assert.equal(xlm.rule, "maxTxAmount");
});
