import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { Signer } from "@4evergent/stellar";
import type { AddressInfo } from "node:net";

declare const fetch: typeof globalThis.fetch;

const VALID_CONTRACT = "CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7";

class MockSigner implements Signer {
  getAccountId(): string {
    return "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U";
  }
  getNetworkPassphrase(): string {
    return "Test SDF Network ; September 2015";
  }
  async sign(tx: any): Promise<any> {
    return tx;
  }
}

const TEST_AGENT = {
  id: "test-agent-contract",
  displayName: "Contract Test Agent",
  ownerId: "operator",
  stellarAddress: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
  capabilities: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

test("API: contract_call is no longer rejected by parseIntent", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner(),
    authProvider: new DevAuthProvider({ defaultOwnerId: "operator" }),
  });
  server.registerAgent(TEST_AGENT);
  await server.listen(0);
  const port = (server.server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/agents/${TEST_AGENT.id}/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "contract_call",
        contractId: VALID_CONTRACT,
        function: "ping",
        args: [],
        reason: "testing contract call api",
      }),
    });

    // It reaches the pipeline! Under default policy, it is rejected by policyEngine, NOT parseIntent!
    const body = (await res.json()) as any;
    assert.notEqual(
      body.error,
      "intent type 'contract_call' is not yet supported by the transaction pipeline"
    );
    assert.equal(body.status, "rejected");
    assert.equal(body.policyDecision?.result, "deny");
    assert.equal(body.policyDecision?.rule, "txTypeRestrictions");
  } finally {
    await server.close();
  }
});

test("API: contract_call rejects invalid contractId format at intent validation", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner(),
    authProvider: new DevAuthProvider({ defaultOwnerId: "operator" }),
  });
  server.registerAgent(TEST_AGENT);
  await server.listen(0);
  const port = (server.server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/agents/${TEST_AGENT.id}/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "contract_call",
        contractId: "INVALID_C_ADDRESS",
        function: "ping",
        args: [],
        reason: "testing invalid contractId",
      }),
    });

    const body = (await res.json()) as any;
    assert.equal(res.status, 400);
    assert.match(body.error, /contractId must be a valid Stellar contract address/);
  } finally {
    await server.close();
  }
});
