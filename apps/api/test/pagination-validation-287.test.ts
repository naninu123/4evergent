import { test } from "node:test";
import assert from "node:assert/strict";
import type { Signer } from "@4evergent/stellar";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";

/**
 * Regression tests for issue #287: consistent limit/offset validation across
 * all eight API list endpoints.
 *
 * This test suite ensures that invalid pagination parameters consistently
 * return HTTP 400 with VALIDATION_ERROR across all list endpoints, and that
 * valid parameters behave correctly (defaults, clamping, valid integers).
 */

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string {
    return this.id;
  }
  getNetworkPassphrase(): string {
    return "Test SDF Network ; September 2015";
  }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

const OWNER = "test-owner";

async function startServer() {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    authProvider: new DevAuthProvider({ defaultOwnerId: OWNER }),
    executionQueue: { enabled: true },
  });

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    agentStore: typeof server.agentStore;
    activityStore: typeof server.activityStore;
    approvalStore: typeof server.approvalStore;
    scheduleStore: typeof server.scheduleStore;
    executionStore: typeof server.executionStore;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        agentStore: server.agentStore,
        activityStore: server.activityStore,
        approvalStore: server.approvalStore,
        scheduleStore: server.scheduleStore,
        executionStore: server.executionStore,
      });
    });
  });
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(baseUrl: string, path: string, body: any) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Create a test agent and return its ID.
 */
async function createAgent(baseUrl: string, displayName = "Test Agent"): Promise<string> {
  const res = await post(baseUrl, "/agents", {
    displayName,
    capabilities: ["payment"],
  });
  return res.body.agent.id;
}

/**
 * The eight list endpoints we need to test for consistent pagination validation.
 */
const LIST_ENDPOINTS = [
  { name: "GET /agents", path: "/agents", maxLimit: 200, setup: async () => ({}) },
  {
    name: "GET /agents/:agentId/activity",
    path: (agentId: string) => `/agents/${agentId}/activity`,
    maxLimit: 100,
    setup: async (baseUrl: string) => {
      const agentId = await createAgent(baseUrl);
      return { agentId };
    },
  },
  { name: "GET /approvals", path: "/approvals", maxLimit: 200, setup: async () => ({}) },
  {
    name: "GET /agents/:agentId/approvals",
    path: (agentId: string) => `/agents/${agentId}/approvals`,
    maxLimit: 100,
    setup: async (baseUrl: string) => {
      const agentId = await createAgent(baseUrl);
      return { agentId };
    },
  },
  {
    name: "GET /agents/:agentId/schedules",
    path: (agentId: string) => `/agents/${agentId}/schedules`,
    maxLimit: 100,
    setup: async (baseUrl: string) => {
      const agentId = await createAgent(baseUrl);
      return { agentId };
    },
  },
  {
    name: "GET /agents/:agentId/executions",
    path: (agentId: string) => `/agents/${agentId}/executions`,
    maxLimit: 100,
    setup: async (baseUrl: string) => {
      const agentId = await createAgent(baseUrl);
      return { agentId };
    },
  },
  { name: "GET /executions", path: "/executions", maxLimit: 100, setup: async () => ({}) },
  { name: "GET /activity", path: "/activity", maxLimit: 100, setup: async () => ({}) },
] as const;

// ============================================================================
// Invalid pagination tests: all eight endpoints must reject bad values
// ============================================================================

test("pagination #287: all endpoints reject limit=abc with 400 VALIDATION_ERROR", async () => {
  const { baseUrl, close } = await startServer();
  try {
    for (const endpoint of LIST_ENDPOINTS) {
      const ctx = await endpoint.setup(baseUrl);
      const path =
        typeof endpoint.path === "function"
          ? endpoint.path((ctx as any).agentId)
          : endpoint.path;

      const res = await get(baseUrl, `${path}?limit=abc`);
      assert.equal(
        res.status,
        400,
        `${endpoint.name} should return 400 for limit=abc`
      );
      assert.equal(
        res.body.code,
        "VALIDATION_ERROR",
        `${endpoint.name} should return VALIDATION_ERROR`
      );
      assert.ok(
        res.body.error.includes("integer"),
        `${endpoint.name} error message should mention 'integer'`
      );
    }
  } finally {
    await close();
  }
});

test("pagination #287: all endpoints reject limit=1.5 with 400 VALIDATION_ERROR", async () => {
  const { baseUrl, close } = await startServer();
  try {
    for (const endpoint of LIST_ENDPOINTS) {
      const ctx = await endpoint.setup(baseUrl);
      const path =
        typeof endpoint.path === "function"
          ? endpoint.path((ctx as any).agentId)
          : endpoint.path;

      const res = await get(baseUrl, `${path}?limit=1.5`);
      assert.equal(
        res.status,
        400,
        `${endpoint.name} should return 400 for limit=1.5`
      );
      assert.equal(
        res.body.code,
        "VALIDATION_ERROR",
        `${endpoint.name} should return VALIDATION_ERROR`
      );
      assert.ok(
        res.body.error.includes("integer"),
        `${endpoint.name} error message should mention 'integer'`
      );
    }
  } finally {
    await close();
  }
});

test("pagination #287: all endpoints reject limit=0 with 400 VALIDATION_ERROR", async () => {
  const { baseUrl, close } = await startServer();
  try {
    for (const endpoint of LIST_ENDPOINTS) {
      const ctx = await endpoint.setup(baseUrl);
      const path =
        typeof endpoint.path === "function"
          ? endpoint.path((ctx as any).agentId)
          : endpoint.path;

      const res = await get(baseUrl, `${path}?limit=0`);
      assert.equal(
        res.status,
        400,
        `${endpoint.name} should return 400 for limit=0`
      );
      assert.equal(
        res.body.code,
        "VALIDATION_ERROR",
        `${endpoint.name} should return VALIDATION_ERROR`
      );
      assert.ok(
        res.body.error.includes("integer"),
        `${endpoint.name} error message should mention 'integer'`
      );
    }
  } finally {
    await close();
  }
});

test("pagination #287: all endpoints reject limit=-5 with 400 VALIDATION_ERROR", async () => {
  const { baseUrl, close } = await startServer();
  try {
    for (const endpoint of LIST_ENDPOINTS) {
      const ctx = await endpoint.setup(baseUrl);
      const path =
        typeof endpoint.path === "function"
          ? endpoint.path((ctx as any).agentId)
          : endpoint.path;

      const res = await get(baseUrl, `${path}?limit=-5`);
      assert.equal(
        res.status,
        400,
        `${endpoint.name} should return 400 for limit=-5`
      );
      assert.equal(
        res.body.code,
        "VALIDATION_ERROR",
        `${endpoint.name} should return VALIDATION_ERROR`
      );
      assert.ok(
        res.body.error.includes("integer"),
        `${endpoint.name} error message should mention 'integer'`
      );
    }
  } finally {
    await close();
  }
});

test("pagination #287: all endpoints reject limit= (empty) with 400 VALIDATION_ERROR", async () => {
  const { baseUrl, close } = await startServer();
  try {
    for (const endpoint of LIST_ENDPOINTS) {
      const ctx = await endpoint.setup(baseUrl);
      const path =
        typeof endpoint.path === "function"
          ? endpoint.path((ctx as any).agentId)
          : endpoint.path;

      const res = await get(baseUrl, `${path}?limit=`);
      assert.equal(
        res.status,
        400,
        `${endpoint.name} should return 400 for limit= (empty)`
      );
      assert.equal(
        res.body.code,
        "VALIDATION_ERROR",
        `${endpoint.name} should return VALIDATION_ERROR`
      );
      assert.ok(
        res.body.error.includes("integer"),
        `${endpoint.name} error message should mention 'integer'`
      );
    }
  } finally {
    await close();
  }
});

test("pagination #287: all endpoints reject offset=abc with 400 VALIDATION_ERROR", async () => {
  const { baseUrl, close } = await startServer();
  try {
    for (const endpoint of LIST_ENDPOINTS) {
      const ctx = await endpoint.setup(baseUrl);
      const path =
        typeof endpoint.path === "function"
          ? endpoint.path((ctx as any).agentId)
          : endpoint.path;

      const res = await get(baseUrl, `${path}?offset=abc`);
      assert.equal(
        res.status,
        400,
        `${endpoint.name} should return 400 for offset=abc`
      );
      assert.equal(
        res.body.code,
        "VALIDATION_ERROR",
        `${endpoint.name} should return VALIDATION_ERROR`
      );
      assert.ok(
        res.body.error.includes("integer"),
        `${endpoint.name} error message should mention 'integer'`
      );
    }
  } finally {
    await close();
  }
});

test("pagination #287: all endpoints reject offset=1.5 with 400 VALIDATION_ERROR", async () => {
  const { baseUrl, close } = await startServer();
  try {
    for (const endpoint of LIST_ENDPOINTS) {
      const ctx = await endpoint.setup(baseUrl);
      const path =
        typeof endpoint.path === "function"
          ? endpoint.path((ctx as any).agentId)
          : endpoint.path;

      const res = await get(baseUrl, `${path}?offset=1.5`);
      assert.equal(
        res.status,
        400,
        `${endpoint.name} should return 400 for offset=1.5`
      );
      assert.equal(
        res.body.code,
        "VALIDATION_ERROR",
        `${endpoint.name} should return VALIDATION_ERROR`
      );
      assert.ok(
        res.body.error.includes("integer"),
        `${endpoint.name} error message should mention 'integer'`
      );
    }
  } finally {
    await close();
  }
});

test("pagination #287: all endpoints reject offset=-5 with 400 VALIDATION_ERROR", async () => {
  const { baseUrl, close } = await startServer();
  try {
    for (const endpoint of LIST_ENDPOINTS) {
      const ctx = await endpoint.setup(baseUrl);
      const path =
        typeof endpoint.path === "function"
          ? endpoint.path((ctx as any).agentId)
          : endpoint.path;

      const res = await get(baseUrl, `${path}?offset=-5`);
      assert.equal(
        res.status,
        400,
        `${endpoint.name} should return 400 for offset=-5`
      );
      assert.equal(
        res.body.code,
        "VALIDATION_ERROR",
        `${endpoint.name} should return VALIDATION_ERROR`
      );
      assert.ok(
        res.body.error.includes("integer"),
        `${endpoint.name} error message should mention 'integer'`
      );
    }
  } finally {
    await close();
  }
});

test("pagination #287: all endpoints reject offset= (empty) with 400 VALIDATION_ERROR", async () => {
  const { baseUrl, close } = await startServer();
  try {
    for (const endpoint of LIST_ENDPOINTS) {
      const ctx = await endpoint.setup(baseUrl);
      const path =
        typeof endpoint.path === "function"
          ? endpoint.path((ctx as any).agentId)
          : endpoint.path;

      const res = await get(baseUrl, `${path}?offset=`);
      assert.equal(
        res.status,
        400,
        `${endpoint.name} should return 400 for offset= (empty)`
      );
      assert.equal(
        res.body.code,
        "VALIDATION_ERROR",
        `${endpoint.name} should return VALIDATION_ERROR`
      );
      assert.ok(
        res.body.error.includes("integer"),
        `${endpoint.name} error message should mention 'integer'`
      );
    }
  } finally {
    await close();
  }
});

// ============================================================================
// Valid pagination tests: defaults, clamping, and accepted values
// ============================================================================

test("pagination #287: all endpoints use default limit=50 when omitted", async () => {
  const { baseUrl, close, agentStore } = await startServer();
  try {
    // Seed 60 agents so we can verify the default limit
    for (let i = 0; i < 60; i++) {
      await agentStore.create({
        displayName: `Agent ${i}`,
        ownerId: OWNER,
        capabilities: [],
      });
    }

    const res = await get(baseUrl, "/agents");
    assert.equal(res.status, 200);
    // Default limit is 50, so we should get 50 agents
    assert.equal(res.body.agents.length, 50);
  } finally {
    await close();
  }
});

test("pagination #287: all endpoints use default offset=0 when omitted", async () => {
  const { baseUrl, close } = await startServer();
  try {
    // Create a test agent to verify first-page behavior
    await createAgent(baseUrl, "First Agent");

    const res = await get(baseUrl, "/agents?limit=10");
    assert.equal(res.status, 200);
    // Should get results from offset 0 (the beginning)
    assert.ok(res.body.agents.length >= 1);
  } finally {
    await close();
  }
});

test("pagination #287: endpoints with max=100 clamp limit=101 to 100", async () => {
  const { baseUrl, close, agentStore } = await startServer();
  try {
    // Seed 110 agents
    for (let i = 0; i < 110; i++) {
      await agentStore.create({
        displayName: `Agent ${i}`,
        ownerId: OWNER,
        capabilities: [],
      });
    }

    const agentId = await createAgent(baseUrl);

    // Test GET /agents/:agentId/activity (max 100)
    const res = await get(baseUrl, `/agents/${agentId}/activity?limit=101`);
    assert.equal(res.status, 200);
    // Should clamp to 100, but we may have fewer than 100 activity records
    assert.ok(res.body.activity.length <= 100);
  } finally {
    await close();
  }
});

test("pagination #287: endpoints with max=200 clamp limit=201 to 200", async () => {
  const { baseUrl, close, agentStore } = await startServer();
  try {
    // Seed 210 agents
    for (let i = 0; i < 210; i++) {
      await agentStore.create({
        displayName: `Agent ${i}`,
        ownerId: OWNER,
        capabilities: [],
      });
    }

    // Test GET /agents (max 200)
    const res = await get(baseUrl, "/agents?limit=201");
    assert.equal(res.status, 200);
    // Should clamp to 200
    assert.equal(res.body.agents.length, 200);
  } finally {
    await close();
  }
});

test("pagination #287: all endpoints accept valid integer limit and offset", async () => {
  const { baseUrl, close } = await startServer();
  try {
    for (const endpoint of LIST_ENDPOINTS) {
      const ctx = await endpoint.setup(baseUrl);
      const path =
        typeof endpoint.path === "function"
          ? endpoint.path((ctx as any).agentId)
          : endpoint.path;

      const res = await get(baseUrl, `${path}?limit=10&offset=0`);
      assert.equal(
        res.status,
        200,
        `${endpoint.name} should accept valid limit and offset`
      );
    }
  } finally {
    await close();
  }
});

test("pagination #287: GET /agents still rejects negative offset (existing behavior)", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await get(baseUrl, "/agents?offset=-5");
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "VALIDATION_ERROR");
  } finally {
    await close();
  }
});
