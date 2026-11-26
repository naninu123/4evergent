import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";

const OWNER_B_KEY = "owner-b-key";
const OWNER_B_HEADERS = { Authorization: `Bearer ${OWNER_B_KEY}` };

function makeSigner(accountId: string): any {
  return {
    getAccountId: () => accountId,
    getNetworkPassphrase: () => "Test SDF Network ; September 2015",
    sign: async (tx: any) => tx,
  };
}

async function startHarness() {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: makeSigner("GTEST"),
    authProvider: new DevAuthProvider({
      defaultOwnerId: "owner-a",
      apiKeys: { [OWNER_B_KEY]: "owner-b" },
    }),
  });
  await server.listen(0);
  const address = server.server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => server.close(),
  };
}

interface ApiResult {
  status: number;
  body: any;
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function createAgent(baseUrl: string, overrides: Record<string, unknown> = {}) {
  const res = await call(baseUrl, "POST", "/agents", {
    displayName: "Original Agent",
    ...overrides,
  });
  assert.equal(res.status, 201);
  return res.body.agent;
}

test("PATCH /agents/:id updates displayName, description and capabilities (visible via GET)", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl, {
      displayName: "Old Name",
      description: "Old description",
      capabilities: ["payment"],
      stellarAddress: "GABC",
    });

    const res = await call(baseUrl, "PATCH", `/agents/${created.id}`, {
      displayName: "  New Name  ",
      description: "New description",
      capabilities: [" payment ", "stellar"],
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.agent.displayName, "New Name");
    assert.equal(res.body.agent.description, "New description");
    assert.deepEqual(res.body.agent.capabilities, ["payment", "stellar"]);
    // Fields outside the metadata surface are untouched.
    assert.equal(res.body.agent.stellarAddress, "GABC");
    assert.equal(res.body.agent.status, "active");

    const get = await call(baseUrl, "GET", `/agents/${created.id}`);
    assert.equal(get.status, 200);
    assert.equal(get.body.displayName, "New Name");
    assert.equal(get.body.description, "New description");
    assert.deepEqual(get.body.capabilities, ["payment", "stellar"]);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id applies a partial patch and can clear capabilities", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl, {
      displayName: "Partial",
      description: "Keep me",
      capabilities: ["payment"],
    });

    const onlyDescription = await call(baseUrl, "PATCH", `/agents/${created.id}`, {
      description: "Changed only this",
    });
    assert.equal(onlyDescription.status, 200);
    assert.equal(onlyDescription.body.agent.displayName, "Partial");
    assert.equal(onlyDescription.body.agent.description, "Changed only this");
    assert.deepEqual(onlyDescription.body.agent.capabilities, ["payment"]);

    const cleared = await call(baseUrl, "PATCH", `/agents/${created.id}`, { capabilities: [] });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.agent.capabilities, []);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id accepts values at the documented caps", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl);
    const capabilities = Array.from({ length: 32 }, (_, i) => `cap-${i}`.padEnd(32, "x"));

    const res = await call(baseUrl, "PATCH", `/agents/${created.id}`, {
      displayName: "d".repeat(100),
      description: "s".repeat(500),
      capabilities,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.agent.displayName, "d".repeat(100));
    assert.equal(res.body.agent.description, "s".repeat(500));
    assert.deepEqual(res.body.agent.capabilities, capabilities);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id rejects an over-length displayName with 400", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl, { displayName: "Keep Me" });
    const res = await call(baseUrl, "PATCH", `/agents/${created.id}`, {
      displayName: "x".repeat(101),
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, "VALIDATION_ERROR");
    assert.match(res.body.error, /displayName/);

    const get = await call(baseUrl, "GET", `/agents/${created.id}`);
    assert.equal(get.body.displayName, "Keep Me");
  } finally {
    await close();
  }
});

test("PATCH /agents/:id rejects an empty or non-string displayName with 400", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl);

    for (const displayName of ["", "   ", 42, null]) {
      const res = await call(baseUrl, "PATCH", `/agents/${created.id}`, { displayName });
      assert.equal(res.status, 400, `displayName=${JSON.stringify(displayName)} must be rejected`);
      assert.equal(res.body.code, "VALIDATION_ERROR");
    }
  } finally {
    await close();
  }
});

test("PATCH /agents/:id rejects an over-length description with 400", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl);
    const tooLong = await call(baseUrl, "PATCH", `/agents/${created.id}`, {
      description: "d".repeat(501),
    });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error, /description/);

    const notString = await call(baseUrl, "PATCH", `/agents/${created.id}`, { description: 7 });
    assert.equal(notString.status, 400);
    assert.match(notString.body.error, /description/);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id rejects an over-length capabilities array with 400", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl, { capabilities: ["payment"] });
    const res = await call(baseUrl, "PATCH", `/agents/${created.id}`, {
      capabilities: Array.from({ length: 33 }, (_, i) => `cap${i}`),
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, "VALIDATION_ERROR");
    assert.match(res.body.error, /capabilities/);

    const get = await call(baseUrl, "GET", `/agents/${created.id}`);
    assert.deepEqual(get.body.capabilities, ["payment"]);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id rejects an over-length capability string with 400", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl);
    const res = await call(baseUrl, "PATCH", `/agents/${created.id}`, {
      capabilities: ["ok", "x".repeat(33)],
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, "VALIDATION_ERROR");
    assert.match(res.body.error, /capability/);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id rejects malformed, empty and duplicate capabilities with 400", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl);
    const invalidBodies: unknown[] = [
      { capabilities: "payment" },
      { capabilities: ["payment", 3] },
      { capabilities: [""] },
      { capabilities: ["  "] },
      { capabilities: ["payment", " payment "] },
    ];

    for (const body of invalidBodies) {
      const res = await call(baseUrl, "PATCH", `/agents/${created.id}`, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} must be rejected`);
      assert.equal(res.body.code, "VALIDATION_ERROR");
    }
  } finally {
    await close();
  }
});

test("PATCH /agents/:id rejects status (use the status endpoint) with 400", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl);
    const res = await call(baseUrl, "PATCH", `/agents/${created.id}`, {
      status: "paused",
      displayName: "Should not apply",
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, "VALIDATION_ERROR");
    assert.match(res.body.error, /PATCH \/agents\/:id\/status/);

    const get = await call(baseUrl, "GET", `/agents/${created.id}`);
    assert.equal(get.body.status, "active");
    assert.equal(get.body.displayName, "Original Agent");
  } finally {
    await close();
  }
});

test("PATCH /agents/:id rejects stellarAddress and unknown fields with 400", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl, { stellarAddress: "GORIGINAL" });

    const address = await call(baseUrl, "PATCH", `/agents/${created.id}`, {
      stellarAddress: "GNEW",
    });
    assert.equal(address.status, 400);
    assert.equal(address.body.code, "VALIDATION_ERROR");
    assert.match(address.body.error, /immutable/);

    const unknown = await call(baseUrl, "PATCH", `/agents/${created.id}`, {
      displayname: "typo",
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, "VALIDATION_ERROR");
    assert.match(unknown.body.error, /unsupported field/);

    const get = await call(baseUrl, "GET", `/agents/${created.id}`);
    assert.equal(get.body.stellarAddress, "GORIGINAL");
    assert.equal(get.body.displayName, "Original Agent");
  } finally {
    await close();
  }
});

test("PATCH /agents/:id rejects an empty patch and invalid JSON with 400", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl);

    const empty = await call(baseUrl, "PATCH", `/agents/${created.id}`, {});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, "VALIDATION_ERROR");

    const notAnObject = await call(baseUrl, "PATCH", `/agents/${created.id}`, []);
    assert.equal(notAnObject.status, 400);
    assert.equal(notAnObject.body.code, "VALIDATION_ERROR");

    const invalidJson = await call(baseUrl, "PATCH", `/agents/${created.id}`, "{not json");
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.body.code, "INVALID_JSON");
  } finally {
    await close();
  }
});

test("PATCH /agents/:id returns 404 for a non-owner and for a nonexistent agent", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const created = await createAgent(baseUrl, { displayName: "Owned by A" });

    const nonOwner = await call(
      baseUrl,
      "PATCH",
      `/agents/${created.id}`,
      { displayName: "Hijacked" },
      OWNER_B_HEADERS,
    );
    assert.equal(nonOwner.status, 404);
    assert.equal(nonOwner.body.code, "AGENT_NOT_FOUND");

    const get = await call(baseUrl, "GET", `/agents/${created.id}`);
    assert.equal(get.body.displayName, "Owned by A");

    const nonexistent = await call(baseUrl, "PATCH", "/agents/does-not-exist", {
      displayName: "Nope",
    });
    assert.equal(nonexistent.status, 404);
    assert.equal(nonexistent.body.code, "AGENT_NOT_FOUND");
  } finally {
    await close();
  }
});
