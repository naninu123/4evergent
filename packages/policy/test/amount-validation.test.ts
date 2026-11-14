import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine } from "../src/engine.js";

test("POLICY: negative amount rejected", async () => {
  const engine = new PolicyEngine();
  const result = await engine.evaluate(
    { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "-10", reason: "test" },
    "agent-a"
  );
  assert.equal(result.result, "deny");
  assert.match(result.reason, /positive/);
});

test("POLICY: zero amount rejected", async () => {
  const engine = new PolicyEngine();
  const result = await engine.evaluate(
    { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "0", reason: "test" },
    "agent-a"
  );
  assert.equal(result.result, "deny");
  assert.match(result.reason, /positive/);
});

test("POLICY: non-numeric amount rejected", async () => {
  const engine = new PolicyEngine();
  const result = await engine.evaluate(
    { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "abc", reason: "test" },
    "agent-a"
  );
  assert.equal(result.result, "deny");
  assert.match(result.reason, /valid number/);
});

test("POLICY: valid positive amount passes amount check", async () => {
  const engine = new PolicyEngine();
  const result = await engine.evaluate(
    { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "10", reason: "test" },
    "agent-a"
  );
  assert.equal(result.result, "allow");
});

test("POLICY: daily spending atomic reservation enforced", async () => {
  const engine = new PolicyEngine({
    maxTxAmount: { XLM: "1000" },
    dailySpendingLimit: { XLM: "100" },
    requireHumanApprovalForAmountAbove: "500",
  }, {
    listByAgent: async () => [],
    reserveDailySpending: async (agentId, asset, amount, _limit) => {
      // Simulate: first call succeeds, second fails (limit reached)
      if (amount === "60") {
        return false; // Simulate limit would be exceeded
      }
      return true;
    },
  });

  // Amount 60 with limit 100 but reservation fails → deny
  const result = await engine.evaluate(
    { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "60", reason: "test" },
    "agent-a"
  );
  assert.equal(result.result, "deny");
  assert.match(result.reason, /daily limit/);
});

test("POLICY: daily spending within limit allowed", async () => {
  const engine = new PolicyEngine({
    maxTxAmount: { XLM: "1000" },
    dailySpendingLimit: { XLM: "100" },
    requireHumanApprovalForAmountAbove: "500",
  }, {
    listByAgent: async () => [],
    reserveDailySpending: async () => true, // Always succeeds
  });

  const result = await engine.evaluate(
    { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "50", reason: "test" },
    "agent-a"
  );
  assert.equal(result.result, "allow");
});

test("POLICY: malformed amount strings (trailing junk, scientific notation, whitespace, >7 decimals) rejected", async () => {
  const engine = new PolicyEngine({ maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "1000" });
  for (const bad of ["10abc", "1e2", "1E2", "+10", " 10", "10 ", "010", "10.", ".5", "0.00000001", "10.12.3"]) {
    const result = await engine.evaluate(
      { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: bad, reason: "test" },
      "agent-a"
    );
    assert.equal(result.result, "deny", `expected ${JSON.stringify(bad)} to be rejected`);
    assert.match(result.reason, /valid number/);
  }

  for (const good of ["0.0000001", "10", "10.50", "999.9999999"]) {
    const result = await engine.evaluate(
      { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: good, reason: "test" },
      "agent-a"
    );
    assert.equal(result.result, "allow", `expected ${good} to be allowed`);
  }
});
