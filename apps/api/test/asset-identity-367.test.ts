import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import type { PolicyRules } from "@4evergent/shared";
import { startServer, apiFetch } from "./helpers.js";

// #367: policy configuration, enforcement, and spending reporting all use the
// same canonical asset identity.

const USDC_ISSUER = "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U";
const USDC = `USDC:${USDC_ISSUER}`;

const POLICY: Partial<PolicyRules> = {
  maxTxAmount: { XLM: "1000", [USDC]: "1000" },
  dailySpendingLimit: { XLM: "500", [USDC]: "200" },
  allowedAssets: ["XLM", USDC],
  allowedDestinations: [],
  allowedContractIds: [],
  txTypeRestrictions: {
    payment: true,
    trustline: true,
    contract_call: false,
    account_settings: false,
  },
  requireHumanApprovalForAmountAbove: "50",
};

async function putPolicy(baseUrl: string, body: unknown, agentId = "test-agent") {
  const res = await apiFetch(`${baseUrl}/agents/${agentId}/policy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function postIntent(baseUrl: string, body: unknown, agentId = "test-agent") {
  const res = await apiFetch(`${baseUrl}/agents/${agentId}/intents`, {
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

function payment(amount: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "payment",
    asset: "USDC",
    assetDetails: { code: "USDC", issuer: USDC_ISSUER },
    destination: Keypair.random().publicKey(),
    amount,
    reason: "367 api test",
    ...overrides,
  };
}

test("#367 USDC with assetDetails is capped by the canonical limit and spending shows the same used", async () => {
  const { baseUrl, close, activityStore } = await startServer();
  try {
    const saved = await putPolicy(baseUrl, POLICY);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.policy.dailySpendingLimit[USDC], "200");

    const first = await postIntent(baseUrl, payment("75"));
    assert.equal(first.status, 202);
    assert.equal(first.body.status, "requires_approval");

    // The reservation is written under the canonical identity, and the
    // endpoint reads that same bucket.
    assert.equal((await activityStore.getDailySpending("test-agent", USDC)) ?? 0, 75);
    const spending = await getSpending(baseUrl);
    assert.deepEqual(spending.spending[USDC], { used: 75, limit: "200", remaining: 125 });

    // Enforcement and reporting agree: 75 + 150 exceeds the 200 limit.
    const second = await postIntent(baseUrl, payment("150"));
    assert.equal(second.status, 403);
    assert.equal(second.body.policyDecision.rule, "dailySpendingLimit");
    assert.equal((await activityStore.getDailySpending("test-agent", USDC)) ?? 0, 75);
    assert.deepEqual((await getSpending(baseUrl)).spending[USDC], {
      used: 75,
      limit: "200",
      remaining: 125,
    });
  } finally {
    await close();
  }
});

test("#367 PUT /policy rejects non-canonical limit and allowlist keys", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const badLimit = await putPolicy(baseUrl, { dailySpendingLimit: { USDC: "200" } });
    assert.equal(badLimit.status, 400);
    assert.match(JSON.stringify(badLimit.body), /canonical asset identity/);
    assert.match(JSON.stringify(badLimit.body), /CODE:ISSUER/);

    const badAllowlist = await putPolicy(baseUrl, { allowedAssets: ["XLM", "USDC"] });
    assert.equal(badAllowlist.status, 400);
    assert.match(JSON.stringify(badAllowlist.body), /canonical asset identity/);
  } finally {
    await close();
  }
});
