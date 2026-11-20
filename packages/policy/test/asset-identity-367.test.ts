import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine } from "../src/engine.js";
import { validatePolicyRules } from "../src/validation.js";
import { InMemoryActivityStore } from "../../database/src/index.js";
import type { AgentIntent, PolicyRules } from "@4evergent/shared";

// #367: one canonical asset identity for policy configuration, enforcement,
// and reporting.

const USDC_ISSUER = "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U";
const OTHER_ISSUER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const USDC = `USDC:${USDC_ISSUER}`;
const TRUSTLINE_USDC = `trustline:${USDC}`;

const RULES: PolicyRules = {
  maxTxAmount: { XLM: "1000", [USDC]: "100" },
  dailySpendingLimit: { XLM: "5000", [USDC]: "500" },
  allowedAssets: ["XLM", USDC],
  allowedDestinations: [],
  allowedContractIds: [],
  txTypeRestrictions: {
    payment: true,
    trustline: true,
    contract_call: true,
    account_settings: true,
  },
  approvalThreshold: "10000",
  requireHumanApprovalForAmountAbove: "10000",
};

function payment(amount: string, overrides: Record<string, unknown> = {}): AgentIntent {
  return {
    type: "payment",
    asset: "USDC",
    destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    amount,
    reason: "367 test",
    ...overrides,
  } as AgentIntent;
}

test("#367 validation rejects non-canonical maxTxAmount keys and names the expected form", () => {
  const result = validatePolicyRules({ maxTxAmount: { USDC: "100" } });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.includes("maxTxAmount.USDC") &&
        error.includes("canonical asset identity") &&
        error.includes("CODE:ISSUER"),
    ),
    result.errors.join("\n"),
  );
});

test("#367 validation rejects non-canonical dailySpendingLimit keys", () => {
  const result = validatePolicyRules({ dailySpendingLimit: { USDC: "200" } });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.includes("dailySpendingLimit.USDC") &&
        error.includes("canonical asset identity") &&
        error.includes("CODE:ISSUER"),
    ),
    result.errors.join("\n"),
  );
});

test("#367 validation rejects non-canonical allowedAssets entries", () => {
  const result = validatePolicyRules({ allowedAssets: ["XLM", "USDC"] });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.includes("allowedAssets[1]") &&
        error.includes("canonical asset identity") &&
        error.includes("CODE:ISSUER"),
    ),
    result.errors.join("\n"),
  );
});

test("#367 validation accepts canonical asset and trustline identities", () => {
  assert.deepEqual(
    validatePolicyRules({
      maxTxAmount: { XLM: "100", [USDC]: "100", [TRUSTLINE_USDC]: "1000" },
      dailySpendingLimit: { native: "5000", [USDC]: "200", [TRUSTLINE_USDC]: "1000" },
      allowedAssets: ["XLM", USDC, TRUSTLINE_USDC],
    }),
    { valid: true, errors: [] },
  );
});

test("#367 a USDC payment with assetDetails is capped by the canonical USDC maxTxAmount", async () => {
  const engine = new PolicyEngine(RULES);
  const decision = await engine.evaluate(
    payment("150", { assetDetails: { code: "USDC", issuer: USDC_ISSUER } }),
    "agent-1",
  );
  assert.equal(decision.result, "deny");
  assert.equal(decision.rule, "maxTxAmount");
  assert.match(decision.reason, /max_tx_amount/);
});

test("#367 a USDC payment without assetDetails resolves to the same canonical key and is capped", async () => {
  const engine = new PolicyEngine(RULES);
  const decision = await engine.evaluate(payment("150"), "agent-1");
  assert.equal(decision.result, "deny");
  assert.equal(decision.rule, "maxTxAmount");
});

test("#367 an unresolvable bare non-native payment is denied instead of bypassing limits", async () => {
  const engine = new PolicyEngine({
    ...RULES,
    maxTxAmount: { XLM: "1000" },
    dailySpendingLimit: { XLM: "5000" },
    allowedAssets: [],
  });
  const decision = await engine.evaluate(payment("1"), "agent-1");
  assert.equal(decision.result, "deny");
  assert.equal(decision.rule, "assetIdentity");
  assert.match(decision.reason, /canonical asset identity/);
});

test("#367 an ambiguous code (two issuers) is denied rather than guessed", async () => {
  const engine = new PolicyEngine({
    ...RULES,
    allowedAssets: [],
    maxTxAmount: { XLM: "1000", [USDC]: "100", [`USDC:${OTHER_ISSUER}`]: "100" },
  });
  const decision = await engine.evaluate(payment("1"), "agent-1");
  assert.equal(decision.result, "deny");
  assert.equal(decision.rule, "assetIdentity");
});

test("#367 both intent shapes reserve against the same canonical daily bucket", async () => {
  const store = new InMemoryActivityStore();
  const engine = new PolicyEngine(RULES, store as any);

  const withDetails = await engine.evaluate(
    payment("100", { assetDetails: { code: "USDC", issuer: USDC_ISSUER } }),
    "agent-1",
  );
  assert.equal(withDetails.result, "allow");
  assert.deepEqual(withDetails.reservedDailySpending, { asset: USDC, amount: "100" });
  assert.equal((await store.getDailySpending("agent-1", USDC)) ?? 0, 100);

  const withoutDetails = await engine.evaluate(payment("50"), "agent-1");
  assert.equal(withoutDetails.result, "allow");
  assert.deepEqual(withoutDetails.reservedDailySpending, { asset: USDC, amount: "50" });
  assert.equal((await store.getDailySpending("agent-1", USDC)) ?? 0, 150);
});

test("#367 contract_call and account_settings are not denied by an asset allowlist", async () => {
  const engine = new PolicyEngine({
    ...RULES,
    allowedAssets: ["XLM"],
    txTypeRestrictions: {
      payment: true,
      trustline: true,
      contract_call: true,
      account_settings: true,
    },
  });

  const contractCall = await engine.evaluate(
    { type: "contract_call", contractId: "CAAAA", function: "foo", args: [], reason: "367" },
    "agent-1",
  );
  assert.equal(contractCall.result, "allow");
  assert.notEqual(contractCall.rule, "allowedAssets");

  const accountSettings = await engine.evaluate(
    { type: "account_settings", setting: "home_domain", value: "example.com", reason: "367" },
    "agent-1",
  );
  assert.equal(accountSettings.result, "allow");
  assert.notEqual(accountSettings.rule, "allowedAssets");
});

test("#367 trustline allowlist and limits use their documented canonical identities", async () => {
  const engine = new PolicyEngine({
    ...RULES,
    maxTxAmount: { XLM: "1000", [TRUSTLINE_USDC]: "100" },
    dailySpendingLimit: { XLM: "5000" },
    allowedAssets: ["XLM", TRUSTLINE_USDC],
    txTypeRestrictions: {
      payment: true,
      trustline: true,
      contract_call: false,
      account_settings: false,
    },
  });

  const allowed = await engine.evaluate(
    { type: "trustline", assetCode: "USDC", issuer: USDC_ISSUER, limit: "50", reason: "367" },
    "agent-1",
  );
  assert.equal(allowed.result, "allow");

  const denied = await engine.evaluate(
    { type: "trustline", assetCode: "USDC", issuer: USDC_ISSUER, limit: "150", reason: "367" },
    "agent-1",
  );
  assert.equal(denied.result, "deny");
  assert.equal(denied.rule, "maxTxAmount");
});

test("#367 a trustline asset must still be in allowedAssets", async () => {
  const engine = new PolicyEngine({
    ...RULES,
    allowedAssets: ["XLM"],
    txTypeRestrictions: {
      payment: true,
      trustline: true,
      contract_call: false,
      account_settings: false,
    },
  });
  const decision = await engine.evaluate(
    { type: "trustline", assetCode: "USDC", issuer: USDC_ISSUER, limit: "50", reason: "367" },
    "agent-1",
  );
  assert.equal(decision.result, "deny");
  assert.equal(decision.rule, "allowedAssets");
});

test("#367 default XLM behaviour is unchanged", async () => {
  const store = new InMemoryActivityStore();
  const engine = new PolicyEngine(
    {
      maxTxAmount: { XLM: "100" },
      dailySpendingLimit: { XLM: "500" },
      allowedAssets: ["XLM"],
      requireHumanApprovalForAmountAbove: "10000",
    },
    store as any,
  );

  const allowed = await engine.evaluate(
    { type: "payment", asset: "XLM", destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", amount: "10", reason: "367" },
    "agent-1",
  );
  assert.equal(allowed.result, "allow");
  assert.deepEqual(allowed.reservedDailySpending, { asset: "XLM", amount: "10" });
  assert.equal((await store.getDailySpending("agent-1", "XLM")) ?? 0, 10);

  const denied = await engine.evaluate(
    { type: "payment", asset: "XLM", destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", amount: "150", reason: "367" },
    "agent-1",
  );
  assert.equal(denied.result, "deny");
  assert.equal(denied.rule, "maxTxAmount");
});
