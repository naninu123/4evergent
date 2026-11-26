import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import type { PolicyRules } from "@4evergent/shared";
import { ProductionApiKeyAuthProvider } from "@4evergent/shared";
import { startServer, apiFetch, sleep, DEFAULT_TEST_AGENT } from "./helpers.js";

// #261: per-owner rate limiting on the authenticated intent and
// approval-action endpoints. Intents that require human approval return
// 202 without executing, so these tests never touch the network.
const APPROVAL_RULES: Partial<PolicyRules> = {
  maxTxAmount: { XLM: "1000" },
  requireHumanApprovalForAmountAbove: "10",
};

function intentBody() {
  return {
    type: "payment",
    asset: "XLM",
    destination: Keypair.random().publicKey(),
    amount: "50",
    reason: "rate limit test",
  };
}

async function post(baseUrl: string, path: string, body: unknown, apiKey?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await apiFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), res };
}

async function submitIntent(baseUrl: string, agentId: string, apiKey?: string) {
  return post(baseUrl, `/agents/${agentId}/intents`, intentBody(), apiKey);
}

async function submitApprovalIntent(baseUrl: string, agentId: string, apiKey?: string) {
  const res = await submitIntent(baseUrl, agentId, apiKey);
  assert.equal(res.status, 202, `intent must be accepted (got ${res.status}: ${JSON.stringify(res.body)})`);
  assert.ok(res.body.approvalId, "approvalId must be returned");
  return res.body.approvalId as string;
}

function assertRateLimited(res: { status: number; body: any; res: Response }) {
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "RATE_LIMITED");
  assert.equal(res.body.error, "rate_limited");
  const retryAfter = res.res.headers.get("retry-after");
  assert.ok(retryAfter && Number(retryAfter) >= 1, "Retry-After is a positive integer of seconds");
}

/* ============================ intents ============================ */

test("intents: past the limit returns 429 with Retry-After and RATE_LIMITED", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: APPROVAL_RULES,
    rateLimit: { maxAttempts: 3, windowSeconds: 60 },
  });
  try {
    for (let i = 0; i < 3; i++) {
      const res = await submitIntent(baseUrl, "test-agent");
      assert.equal(res.status, 202, `attempt ${i + 1} within the limit is accepted`);
    }
    const blocked = await submitIntent(baseUrl, "test-agent");
    assertRateLimited(blocked);
  } finally {
    await close();
  }
});

test("intents: requests succeed again after the window expires", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: APPROVAL_RULES,
    rateLimit: { maxAttempts: 3, windowSeconds: 1 },
  });
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal((await submitIntent(baseUrl, "test-agent")).status, 202);
    }
    assert.equal((await submitIntent(baseUrl, "test-agent")).status, 429);
    await sleep(1_100);
    const recovered = await submitIntent(baseUrl, "test-agent");
    assert.equal(recovered.status, 202, "intent succeeds after the window slides past");
  } finally {
    await close();
  }
});

test("intents: one owner's limit does not affect another owner", async () => {
  const { baseUrl, close, server } = await startServer({
    policyRules: APPROVAL_RULES,
    rateLimit: { maxAttempts: 3, windowSeconds: 60 },
    ownerId: "owner-a",
    authProvider: new ProductionApiKeyAuthProvider({
      apiKeys: {
        "key-a": { ownerId: "owner-a", subject: "key:a" },
        "key-b": { ownerId: "owner-b", subject: "key:b" },
      },
    }),
  });
  try {
    server.registerAgent({ ...DEFAULT_TEST_AGENT, id: "test-agent-b", ownerId: "owner-b" });
    // Owner A exhausts their own budget.
    for (let i = 0; i < 3; i++) {
      assert.equal((await submitIntent(baseUrl, "test-agent", "key-a")).status, 202);
    }
    assert.equal((await submitIntent(baseUrl, "test-agent", "key-a")).status, 429);
    // Owner B is untouched by A's limit.
    const other = await submitIntent(baseUrl, "test-agent-b", "key-b");
    assert.equal(other.status, 202, "another owner still submits while A is limited");
  } finally {
    await close();
  }
});

/* ============================ approve / reject ============================ */

test("approve: past the limit returns 429 with Retry-After", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: APPROVAL_RULES,
    deferExecution: true,
    rateLimit: { maxAttempts: 3, windowSeconds: 60 },
  });
  try {
    const ids = [
      await submitApprovalIntent(baseUrl, "test-agent"),
      await submitApprovalIntent(baseUrl, "test-agent"),
      await submitApprovalIntent(baseUrl, "test-agent"),
    ];
    for (const id of ids) {
      const res = await post(baseUrl, `/approvals/${id}/approve`, { approver: "tester" });
      assert.equal(res.status, 200, `approve ${id} within the limit is 200`);
      assert.equal(res.body.status, "approved");
    }
    // Approve budget exhausted: a further approve is shed at the gate,
    // before the already-decided state is even looked at.
    const blocked = await post(baseUrl, `/approvals/${ids[0]}/approve`, { approver: "tester" });
    assertRateLimited(blocked);
  } finally {
    await close();
  }
});

test("reject: past the limit returns 429 with Retry-After", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: APPROVAL_RULES,
    deferExecution: true,
    rateLimit: { maxAttempts: 3, windowSeconds: 60 },
  });
  try {
    const ids = [
      await submitApprovalIntent(baseUrl, "test-agent"),
      await submitApprovalIntent(baseUrl, "test-agent"),
      await submitApprovalIntent(baseUrl, "test-agent"),
    ];
    for (const id of ids) {
      const res = await post(baseUrl, `/approvals/${id}/reject`, {});
      assert.equal(res.status, 200, `reject ${id} within the limit is 200`);
      assert.equal(res.body.status, "rejected");
    }
    const blocked = await post(baseUrl, `/approvals/${ids[0]}/reject`, {});
    assertRateLimited(blocked);
  } finally {
    await close();
  }
});

test("approve and reject have separate budgets", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: APPROVAL_RULES,
    deferExecution: true,
    rateLimit: { maxAttempts: 2, windowSeconds: 60 },
  });
  try {
    const first = await submitApprovalIntent(baseUrl, "test-agent");
    const second = await submitApprovalIntent(baseUrl, "test-agent");
    assert.equal((await post(baseUrl, `/approvals/${first}/approve`, {})).status, 200);
    assert.equal((await post(baseUrl, `/approvals/${second}/approve`, {})).status, 200);
    // Approve budget is now exhausted, but reject has its own budget: the
    // reject passes the gate and fails only on the approval's state.
    const rejected = await post(baseUrl, `/approvals/${first}/reject`, {});
    assert.notEqual(rejected.status, 429, "exhausted approve budget must not block reject");
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, "APPROVAL_INVALID_STATE");
  } finally {
    await close();
  }
});
