import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import type { PolicyRules } from "@4evergent/shared";
import { startServer, apiFetch } from "./helpers.js";

// #374: the spending endpoint converts integer stroops back to exact decimal
// numbers for `used`/`remaining`, so the dashboard never renders IEEE-754
// float garbage like 0.30000000000000004 or 0.19999999999999998. The store
// compares integer stroops, so a 0.1 + 0.2 sequence against a 0.3 limit reserves
// exactly 0.3 (the true sum equals the limit) instead of falsely denying it.

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await apiFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function getSpending(baseUrl: string, agentId = "test-agent") {
  const res = await apiFetch(`${baseUrl}/agents/${agentId}/spending`);
  assert.equal(res.status, 200);
  return (await res.json()) as {
    spending: Record<string, { used: number; limit: string; remaining: number }>;
  };
}

function payment(amount: string, destination?: string) {
  return {
    type: "payment" as const,
    asset: "XLM",
    destination: destination ?? Keypair.random().publicKey(),
    amount,
    reason: "374 api test",
  };
}

test("#374 API: 0.1 + 0.2 against a 0.3 limit shows exact 0.3 used / 0 remaining (no float garbage)", async () => {
  // requireHumanApprovalForAmountAbove below the payments so they reserve and
  // hold (requires_approval) without submitting — isolating the spending view.
  const RULES: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    dailySpendingLimit: { XLM: "0.3" },
    requireHumanApprovalForAmountAbove: "0.01",
  };
  const { baseUrl, close } = await startServer({ policyRules: RULES });
  try {
    const first = await post(baseUrl, "/agents/test-agent/intents", payment("0.1"));
    assert.equal(first.status, 202);
    const second = await post(baseUrl, "/agents/test-agent/intents", payment("0.2"));
    assert.equal(second.status, 202, "0.1 + 0.2 == 0.3 must be allowed, not falsely denied by floats");

    const spending = await getSpending(baseUrl);
    assert.equal(spending.spending.XLM.limit, "0.3");
    // 0.1 + 0.2 in floats is 0.30000000000000004; in stroops it is exactly 0.3.
    assert.equal(spending.spending.XLM.used, 0.3);
    assert.equal(spending.spending.XLM.remaining, 0);
    // The serialized response carries no IEEE-754 float garbage anywhere.
    assert.doesNotMatch(JSON.stringify(spending), /0\.30000000000000004/);
    assert.doesNotMatch(JSON.stringify(spending), /0\.1999999999999999/);
  } finally {
    await close();
  }
});

test("#374 API: ten 0.1 payments against a 1.0 limit show exactly 1 used / 0 remaining", async () => {
  const RULES: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    dailySpendingLimit: { XLM: "1.0" },
    requireHumanApprovalForAmountAbove: "0.01",
  };
  const { baseUrl, close } = await startServer({ policyRules: RULES });
  try {
    for (let i = 0; i < 10; i++) {
      const r = await post(baseUrl, "/agents/test-agent/intents", payment("0.1"));
      assert.equal(r.status, 202);
    }
    const spending = await getSpending(baseUrl);
    assert.equal(spending.spending.XLM.limit, "1.0");
    // 10 * 0.1 in floats accumulates to 0.9999999999999999; in stroops it is exactly 1.
    assert.equal(spending.spending.XLM.used, 1);
    assert.equal(spending.spending.XLM.remaining, 0);
    assert.doesNotMatch(JSON.stringify(spending), /0\.9999999999999999/);
  } finally {
    await close();
  }
});

test("#374 API: remaining after 0.8 of 1.0 shows exactly 0.2, not 0.19999999999999998", async () => {
  const RULES: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    dailySpendingLimit: { XLM: "1.0" },
    requireHumanApprovalForAmountAbove: "0.01",
  };
  const { baseUrl, close } = await startServer({ policyRules: RULES });
  try {
    const r = await post(baseUrl, "/agents/test-agent/intents", payment("0.8"));
    assert.equal(r.status, 202);
    const spending = await getSpending(baseUrl);
    assert.equal(spending.spending.XLM.used, 0.8);
    // 1.0 - 0.8 in floats is 0.19999999999999998; in stroops it is exactly 0.2.
    assert.equal(spending.spending.XLM.remaining, 0.2);
    assert.doesNotMatch(JSON.stringify(spending), /0\.1999999999999999/);
  } finally {
    await close();
  }
});
