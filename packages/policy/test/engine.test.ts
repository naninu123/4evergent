import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine } from "../src/engine.js";
import type { AgentIntent } from "@4evergent/shared";

const baseIntent = (overrides: Record<string, unknown>): AgentIntent =>
  ({ type: "payment", asset: "XLM", destination: "GAAAA", amount: "10", reason: "test", ...overrides }) as AgentIntent;

// ===== Synchronous call helpers =====
// PolicyEngine.evaluate is async; existing tests call it synchronously.
// We keep the sync signature by unwrapping the promise in tests.

function _evalSync(engine: PolicyEngine, intent: AgentIntent, agent: string): AgentIntent & { result: string; reason: string; rule: string } {
  // Evaluate synchronously by using a pre-computed decision
  return engine.evaluate(intent, agent) as unknown as AgentIntent & { result: string; reason: string; rule: string };
}

test("allows payment within limits", async () => {
  const engine = new PolicyEngine();
  const decision = await engine.evaluate(baseIntent({ amount: "10" }), "GAGENT");
  assert.equal(decision.result, "allow");
});

test("denies amount exceeding maxTxAmount", async () => {
  const engine = new PolicyEngine({ maxTxAmount: { XLM: "100" } });
  const decision = await engine.evaluate(baseIntent({ amount: "150" }), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.match(decision.reason, /max_tx_amount/);
});

test("denies amount exceeding dailySpendingLimit", async () => {
  // The daily limit check requires an ActivityStore to read persisted data.
  // Pass the fake store as the second constructor argument.
  const store = makeFakeStore([]);
  const engine = new PolicyEngine(
    { dailySpendingLimit: { XLM: "500" }, maxTxAmount: { XLM: "1000" } },
    store
  );
  const decision = await engine.evaluate(baseIntent({ amount: "600" }), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.match(decision.reason, /daily/);
});

test("requires approval at threshold", async () => {
  const engine = new PolicyEngine({ requireHumanApprovalForAmountAbove: "50" });
  const decision = await engine.evaluate(baseIntent({ amount: "50" }), "GAGENT");
  assert.equal(decision.result, "requires_approval");
});

test("denies disallowed asset", async () => {
  const engine = new PolicyEngine({ allowedAssets: ["XLM"] });
  const decision = await engine.evaluate(baseIntent({ asset: "USDC" }), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.match(decision.reason, /allowed_assets/);
});

test("denies disallowed destination", async () => {
  const engine = new PolicyEngine({ allowedDestinations: ["GONLY"] });
  const decision = await engine.evaluate(baseIntent({ destination: "GEVIL" }), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.match(decision.reason, /allowed_destinations/);
});

// #354: the allowlist is a hard boundary — it is checked BEFORE the approval
// threshold, so an above-threshold intent to a disallowed destination/asset/
// contract is denied outright instead of being routed to requires_approval.
test("denies above-threshold payment to disallowed destination (allowlist beats threshold)", async () => {
  const engine = new PolicyEngine({
    allowedDestinations: ["GONLY"],
    requireHumanApprovalForAmountAbove: "50",
  });
  const decision = await engine.evaluate(baseIntent({ amount: "100", destination: "GEVIL" }), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.equal(decision.rule, "allowedDestinations");
  assert.match(decision.reason, /allowed_destinations/);
});

test("denies above-threshold payment with disallowed asset (allowlist beats threshold)", async () => {
  const engine = new PolicyEngine({
    allowedAssets: ["XLM"],
    requireHumanApprovalForAmountAbove: "50",
  });
  const decision = await engine.evaluate(baseIntent({ amount: "100", asset: "USDC" }), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.equal(decision.rule, "allowedAssets");
});

test("denies contract call to disallowed contract", async () => {
  // Contract calls carry no amount, so the threshold never applies to them;
  // this pins the contract allowlist itself. The threshold-ordering proof
  // lives in the destination/asset tests above.
  const engine = new PolicyEngine({
    // Contract calls carry no payment asset (extractAsset → "native"), so
    // allowlist "native" here to let the denial come from the contract list.
    allowedAssets: ["XLM", "native"],
    allowedContractIds: ["CONLY"],
    requireHumanApprovalForAmountAbove: "50",
    txTypeRestrictions: { contract_call: true },
  });
  const intent = { type: "contract_call", contractId: "CEVIL", reason: "test" } as AgentIntent;
  const decision = await engine.evaluate(intent, "GAGENT");
  assert.equal(decision.result, "deny");
  assert.equal(decision.rule, "allowedContractIds");
});

test("above-threshold payment to allowed destination still requires approval", async () => {
  const engine = new PolicyEngine({
    allowedDestinations: ["GONLY"],
    requireHumanApprovalForAmountAbove: "50",
  });
  const decision = await engine.evaluate(baseIntent({ amount: "100", destination: "GONLY" }), "GAGENT");
  assert.equal(decision.result, "requires_approval");
  assert.equal(decision.rule, "approvalThreshold");
});

test("below-threshold payment to disallowed destination still denied", async () => {
  const engine = new PolicyEngine({
    allowedDestinations: ["GONLY"],
    requireHumanApprovalForAmountAbove: "50",
  });
  const decision = await engine.evaluate(baseIntent({ amount: "10", destination: "GEVIL" }), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.equal(decision.rule, "allowedDestinations");
});

test("skipApprovalThreshold: approved amount re-evaluates to allow, allowlist still enforced", async () => {
  const engine = new PolicyEngine({
    allowedDestinations: ["GONLY"],
    requireHumanApprovalForAmountAbove: "50",
  });
  // Threshold gate satisfied by the approval itself → allow.
  const allowed = await engine.evaluate(
    baseIntent({ amount: "100", destination: "GONLY" }), "GAGENT", { skipApprovalThreshold: true }
  );
  assert.equal(allowed.result, "allow");
  // Tightened allowlist still blocks, even with the threshold skipped.
  const denied = await engine.evaluate(
    baseIntent({ amount: "100", destination: "GEVIL" }), "GAGENT", { skipApprovalThreshold: true }
  );
  assert.equal(denied.result, "deny");
  assert.equal(denied.rule, "allowedDestinations");
});

test("denies tx type not in allowlist", async () => {
  const engine = new PolicyEngine({ txTypeRestrictions: { payment: false } });
  const decision = await engine.evaluate(baseIntent({}), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.match(decision.reason, /not permitted/);
});

test("denies contract_call by default", async () => {
  const engine = new PolicyEngine();
  const decision = await engine.evaluate(
    { type: "contract_call", contractId: "CAAAA", function: "foo", args: [], reason: "t" },
    "GAGENT"
  );
  assert.equal(decision.result, "deny");
});

test("trustline with amount over limit is denied", async () => {
  const engine = new PolicyEngine({ maxTxAmount: { native: "100" }, txTypeRestrictions: { payment: true, trustline: true } });
  const decision = await engine.evaluate(
    { type: "trustline", assetCode: "T", issuer: "GAAAA", limit: "200", reason: "t" },
    "GAGENT"
  );
  assert.equal(decision.result, "deny");
});

// ===== New: daily spending limit enforcement =====

function makeFakeStore(records: { id: string; agentId: string; intent: AgentIntent; status: string; createdAt: string }[]) {
  return {
    listByAgent: async (agentId: string, _limit?: number) =>
      records.filter((r) => r.agentId === agentId),
  };
}

test("daily limit: first payment within limit allows", async () => {
  const store = makeFakeStore([]);
  const engine = new PolicyEngine(
    { dailySpendingLimit: { XLM: "100" }, maxTxAmount: { XLM: "100" }, requireHumanApprovalForAmountAbove: "1000" },
    store
  );
  const decision = await engine.evaluate(baseIntent({ amount: "60" }), "GAGENT");
  assert.equal(decision.result, "allow");
});

test("daily limit: cumulative payments reaching limit denies next", async () => {
  const now = new Date().toISOString();
  const store = makeFakeStore([
    { id: "x", agentId: "GAGENT", status: "submitted", createdAt: now, intent: baseIntent({ amount: "60" }) },
  ]);
  const engine = new PolicyEngine(
    { dailySpendingLimit: { XLM: "100" }, maxTxAmount: { XLM: "100" }, requireHumanApprovalForAmountAbove: "1000" },
    store
  );
  const decision = await engine.evaluate(baseIntent({ amount: "50" }), "GAGENT");
  assert.equal(decision.result, "deny");
  assert.match(decision.reason, /daily/);
});

test("daily limit: rejected transaction does not consume limit", async () => {
  const now = new Date().toISOString();
  const store = makeFakeStore([
    { id: "x", agentId: "GAGENT", status: "rejected", createdAt: now, intent: baseIntent({ amount: "60" }) },
  ]);
  const engine = new PolicyEngine(
    { dailySpendingLimit: { XLM: "100" }, maxTxAmount: { XLM: "100" }, requireHumanApprovalForAmountAbove: "1000" },
    store
  );
  const decision = await engine.evaluate(baseIntent({ amount: "60" }), "GAGENT");
  assert.equal(decision.result, "allow");
});

test("daily limit: different agent does not share limit", async () => {
  const now = new Date().toISOString();
  const store = makeFakeStore([
    { id: "x", agentId: "GOTHER", status: "submitted", createdAt: now, intent: baseIntent({ amount: "90" }) },
  ]);
  const engine = new PolicyEngine(
    { dailySpendingLimit: { XLM: "100" }, maxTxAmount: { XLM: "100" }, requireHumanApprovalForAmountAbove: "1000" },
    store
  );
  // Evaluate for GAGENT — the prior submitted tx belongs to GOTHER, so it
  // must NOT count against GAGENT's daily limit.
  const decision = await engine.evaluate(baseIntent({ amount: "60" }), "GAGENT");
  assert.equal(decision.result, "allow");
});

test("daily limit: different asset does not consume other asset limit", async () => {
  const now = new Date().toISOString();
  const store = makeFakeStore([
    { id: "x", agentId: "GAGENT", status: "submitted", createdAt: now, intent: baseIntent({ asset: "USDC", amount: "90" }) },
  ]);
  const engine = new PolicyEngine(
    { dailySpendingLimit: { XLM: "100", USDC: "100" }, maxTxAmount: { XLM: "100", USDC: "100" }, allowedAssets: ["XLM", "USDC"], requireHumanApprovalForAmountAbove: "1000" },
    store
  );
  const decision = await engine.evaluate(baseIntent({ asset: "XLM", amount: "60" }), "GAGENT");
  assert.equal(decision.result, "allow");
});

test("daily limit: next day resets limit", async () => {
  const yesterday = new Date(Date.now() - 86400_000).toISOString();
  const store = makeFakeStore([
    { id: "x", agentId: "GAGENT", status: "submitted", createdAt: yesterday, intent: baseIntent({ amount: "90" }) },
  ]);
  const engine = new PolicyEngine(
    { dailySpendingLimit: { XLM: "100" }, maxTxAmount: { XLM: "100" }, requireHumanApprovalForAmountAbove: "1000" },
    store
  );
  const decision = await engine.evaluate(baseIntent({ amount: "60" }), "GAGENT");
  assert.equal(decision.result, "allow");
});

// #326: the enforced approval-threshold field is requireHumanApprovalForAmountAbove
// (see packages/policy/src/engine.ts:173). Pin the three-point boundary so the
// editor's single control can be verified against the engine, not only the UI.
test("requireHumanApprovalForAmountAbove: below allows, at/above requires approval", async () => {
  const engine = new PolicyEngine({ requireHumanApprovalForAmountAbove: "50" });
  const below = await engine.evaluate(baseIntent({ amount: "49.9999999" }), "GAGENT");
  assert.equal(below.result, "allow");
  const at = await engine.evaluate(baseIntent({ amount: "50" }), "GAGENT");
  assert.equal(at.result, "requires_approval");
  assert.equal(at.rule, "approvalThreshold");
  const above = await engine.evaluate(baseIntent({ amount: "100" }), "GAGENT");
  assert.equal(above.result, "requires_approval");
});
