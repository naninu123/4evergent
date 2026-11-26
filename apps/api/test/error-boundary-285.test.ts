import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { clearAgents } from "../src/index.js";
import { API_ERRORS } from "../src/error-codes.js";
import { InMemoryExecutionStore, InMemoryAgentStore } from "@4evergent/database";
import { apiFetch } from "./helpers.js";

beforeEach(() => {
  clearAgents();
});

test("API_ERRORS defines INTERNAL_ERROR with status 500 and generic message", () => {
  assert.deepEqual(API_ERRORS.INTERNAL_ERROR, {
    status: 500,
    message: "internal_error",
    description: "An unexpected server error occurred.",
  });
});

test("unexpected throw in routed handler returns 500 INTERNAL_ERROR with X-Request-Id and no leaked internal details", async () => {
  const failingAgentStore = new InMemoryAgentStore();
  failingAgentStore.listByOwner = async () => {
    throw new Error("SQLITE_CORRUPT: secret internal database path /var/data/prod.db");
  };

  const { createApiServer } = await import("../src/index.js");
  const { DevAuthProvider } = await import("@4evergent/shared");
  const { MockSigner } = await import("./helpers.js");

  const srv = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("err-boundary"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    agentStore: failingAgentStore,
    deferExecution: true,
  });

  await new Promise<void>((r) => srv.server.listen(0, "127.0.0.1", r));
  const addr = srv.server.address() as import("node:net").AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  try {
    const res = await apiFetch(`${url}/agents`, {
      headers: { "X-Request-Id": "req-boundary-285" },
    });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("x-request-id"), "req-boundary-285");
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, {
      code: "INTERNAL_ERROR",
      error: "internal_error",
    });
    assert.ok(!JSON.stringify(body).includes("SQLITE_CORRUPT"));
    assert.ok(!JSON.stringify(body).includes("/var/data/prod.db"));
  } finally {
    await srv.close();
  }
});

test("POST /approvals/:id/approve returns 500 INTERNAL_ERROR when executionQueue.enqueue throws and does not claim queued", async () => {
  const { createApiServer } = await import("../src/index.js");
  const { DevAuthProvider } = await import("@4evergent/shared");
  const { MockSigner, DEFAULT_TEST_AGENT } = await import("./helpers.js");

  const failingExecutionStore = new InMemoryExecutionStore();
  failingExecutionStore.record = async () => {
    throw new Error("disk full while persisting execution queue record");
  };

  const srv = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("approve-enqueue-fail"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    policyRules: {
      maxTxAmount: { XLM: "1000" },
      requireHumanApprovalForAmountAbove: "10",
    },
    executionStore: failingExecutionStore,
    executionQueue: { enabled: true, intervalMs: 60_000 },
  });
  srv.registerAgent({ ...DEFAULT_TEST_AGENT, id: "test-agent", ownerId: "test" });

  await new Promise<void>((r) => srv.server.listen(0, "127.0.0.1", r));
  const addr = srv.server.address() as import("node:net").AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  try {
    const intentRes = await apiFetch(`${url}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: Keypair.random().publicKey(),
        amount: "50",
        reason: "above threshold approval test",
      }),
    });
    assert.equal(intentRes.status, 202);
    const { approvalId } = (await intentRes.json()) as { approvalId: string };

    const approveRes = await apiFetch(`${url}/approvals/${approvalId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "req-approve-500" },
      body: JSON.stringify({}),
    });
    assert.equal(approveRes.status, 500);
    assert.equal(approveRes.headers.get("x-request-id"), "req-approve-500");
    const approveBody = (await approveRes.json()) as Record<string, unknown>;
    assert.equal(approveBody.code, "INTERNAL_ERROR");
    assert.equal(approveBody.error, "internal_error");
    assert.ok(!JSON.stringify(approveBody).includes("queued for execution"));
  } finally {
    await srv.close();
  }
});
