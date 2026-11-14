import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { apiFetch, startServer } from "./helpers.js";

const MALFORMED_AMOUNTS = ["10abc", "1e2", "+10", "01", ".5", "10.", " 10", "0.00000001"];

test("POST /agents/:id/intents rejects malformed payment amounts with 400", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: {
      maxTxAmount: { XLM: "1000" },
      dailySpendingLimit: { XLM: "5000" },
      requireHumanApprovalForAmountAbove: "0",
    },
    deferExecution: true,
  });
  try {
    const dest = Keypair.random().publicKey();
    for (const amount of MALFORMED_AMOUNTS) {
      const res = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: dest,
          amount,
          reason: "strict amount validation test",
        }),
      });
      assert.equal(res.status, 400, `expected 400 for amount ${JSON.stringify(amount)}`);
    }

    const okRes = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: dest,
        amount: "0.0000001",
        reason: "valid minimal stroop payment",
      }),
    });
    assert.equal(okRes.status, 202);
  } finally {
    await close();
  }
});

test("POST /agents/:id/intents rejects malformed trustline limits with 400", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { txTypeRestrictions: { payment: true, trustline: true, contract_call: false, account_settings: false } },
    deferExecution: true,
  });
  try {
    const issuer = Keypair.random().publicKey();
    for (const limit of MALFORMED_AMOUNTS) {
      const res = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "trustline",
          assetCode: "USDC",
          issuer,
          limit,
          reason: "strict trustline limit test",
        }),
      });
      assert.equal(res.status, 400, `expected 400 for limit ${JSON.stringify(limit)}`);
    }
  } finally {
    await close();
  }
});

test("PUT /agents/:id/policy rejects malformed amount strings in policy rules with 400", async () => {
  const { baseUrl, close } = await startServer();
  try {
    for (const invalid of ["10abc", "1e2", "+50", "0.00000001"]) {
      const res = await apiFetch(`${baseUrl}/agents/test-agent/policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxTxAmount: { XLM: invalid } }),
      });
      assert.equal(res.status, 400, `expected 400 for maxTxAmount ${JSON.stringify(invalid)}`);

      const threshRes = await apiFetch(`${baseUrl}/agents/test-agent/policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalThreshold: invalid }),
      });
      assert.equal(threshRes.status, 400, `expected 400 for approvalThreshold ${JSON.stringify(invalid)}`);
    }
  } finally {
    await close();
  }
});
