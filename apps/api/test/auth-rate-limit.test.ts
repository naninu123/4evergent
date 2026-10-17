import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/index.js";
import { createAuthModule } from "../src/auth.js";
import { SlidingWindowRateLimiter } from "../src/rate-limit.js";

/* ============================ unit: limiter ============================ */

test("limiter: allows up to max attempts, then limits with a retry hint", () => {
  const limiter = new SlidingWindowRateLimiter({ maxAttempts: 3, windowMs: 60_000, maxKeys: 100 });
  const now = 1_000_000;
  assert.equal(limiter.check("ip", now).limited, false);
  limiter.record("ip", now);
  limiter.record("ip", now + 1);
  limiter.record("ip", now + 2);
  const decision = limiter.check("ip", now + 3);
  assert.equal(decision.limited, true);
  assert.ok(decision.retryAfterSeconds >= 1, "retry hint is at least one second");
  // A different source has its own budget.
  assert.equal(limiter.check("other", now + 3).limited, false);
});

test("limiter: resets once the window has slid past the recorded attempts", () => {
  const limiter = new SlidingWindowRateLimiter({ maxAttempts: 2, windowMs: 1_000, maxKeys: 100 });
  const t0 = 5_000;
  limiter.record("ip", t0);
  limiter.record("ip", t0 + 10);
  assert.equal(limiter.check("ip", t0 + 20).limited, true);
  // Past the window the old attempts expire and the source is allowed again.
  assert.equal(limiter.check("ip", t0 + 1_011).limited, false);
  limiter.record("ip", t0 + 1_011);
  assert.equal(limiter.check("ip", t0 + 1_012).limited, false);
});

test("limiter: reset() clears a source immediately", () => {
  const limiter = new SlidingWindowRateLimiter({ maxAttempts: 1, windowMs: 60_000, maxKeys: 100 });
  limiter.record("ip", 100);
  assert.equal(limiter.check("ip", 100).limited, true);
  limiter.reset("ip");
  assert.equal(limiter.check("ip", 100).limited, false);
});

test("limiter: memory stays bounded — the source map never grows past maxKeys", () => {
  const limiter = new SlidingWindowRateLimiter({ maxAttempts: 2, windowMs: 60_000, maxKeys: 5 });
  for (let i = 0; i < 50; i++) limiter.record(`ip-${i}`, 1_000);
  assert.ok(limiter.size <= 5, `size ${limiter.size} must stay <= 5`);

  // Stale sources are pruned on the next sweep.
  const fresh = new SlidingWindowRateLimiter({ maxAttempts: 2, windowMs: 1_000, maxKeys: 5 });
  for (let i = 0; i < 3; i++) fresh.record(`ip-${i}`, 1_000);
  assert.equal(fresh.size, 3);
  fresh.record("new", 10_000);
  assert.equal(fresh.size, 1, "stale sources are dropped");
});

/* ========================= integration: http ========================== */

async function createAuthTestServer(config: Parameters<typeof createAuthModule>[0]["config"]) {
  const authModule = createAuthModule({ fallbackProvider: null, config: config ?? {} });
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: {
      getAccountId: () => "GMOCKSIGNER000000000000000000000000000000000000000000000MOCK",
      getNetworkPassphrase: () => "Test SDF Network ; September 2015",
      async sign(tx: any) { tx.signatures = []; return tx; },
    },
    authModule,
  });
  await server.listen(0);
  const addr = server.server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

const XRW = { "X-Requested-With": "4evergent" };

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...XRW },
    body: JSON.stringify(body),
  });
  const json = res.status !== 204 ? await res.json().catch(() => null) : null;
  return { status: res.status, body: json, res };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("login: 401s until the limit, then 429 with Retry-After; distinct codes; window + success path", async () => {
  const { server, baseUrl } = await createAuthTestServer({
    rateLimit: { maxAttempts: 3, windowSeconds: 1 },
  });
  try {
    await post(baseUrl, "/auth/register", { email: "rl@example.com", password: "password123" });

    // Within the limit: wrong password → 401 invalid_credentials.
    const blockedAfter = 3;
    let last401: { status: number; body: any } | null = null;
    for (let i = 0; i < blockedAfter; i++) {
      const res = await post(baseUrl, "/auth/login/email", { email: "rl@example.com", password: "wrong" });
      assert.equal(res.status, 401, `attempt ${i + 1} within the limit is 401`);
      assert.equal(res.body.error, "invalid_credentials");
      last401 = res;
    }

    // Past the limit → 429 with a Retry-After header and a distinct error code.
    const blocked = await post(baseUrl, "/auth/login/email", { email: "rl@example.com", password: "wrong" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, "rate_limited");
    assert.notEqual(blocked.body.error, last401!.body.error, "429 is distinguishable from 401");
    const retryAfter = blocked.res.headers.get("retry-after");
    assert.ok(retryAfter && Number(retryAfter) >= 1, "Retry-After is a positive integer of seconds");

    // After the window slides, the source is allowed again and a legitimate
    // sign-in still succeeds.
    await sleep(1_100);
    const good = await post(baseUrl, "/auth/login/email", { email: "rl@example.com", password: "password123" });
    assert.equal(good.status, 200, "legitimate sign-in works after the window resets");
  } finally {
    await server.close();
  }
});

test("register and stellar challenge are rate limited too", async () => {
  const { server, baseUrl } = await createAuthTestServer({
    rateLimit: { maxAttempts: 2, windowSeconds: 60 },
  });
  try {
    assert.equal((await post(baseUrl, "/auth/register", { email: "r1@example.com", password: "password123" })).status, 201);
    assert.equal((await post(baseUrl, "/auth/register", { email: "r2@example.com", password: "password123" })).status, 201);
    const regBlocked = await post(baseUrl, "/auth/register", { email: "r3@example.com", password: "password123" });
    assert.equal(regBlocked.status, 429);
    assert.equal(regBlocked.body.error, "rate_limited");

    const ch1 = await post(baseUrl, "/auth/stellar/challenge", { publicKey: "NOT-A-KEY" });
    const ch2 = await post(baseUrl, "/auth/stellar/challenge", { publicKey: "NOT-A-KEY" });
    assert.equal(ch1.status, 400);
    assert.equal(ch2.status, 400);
    const chBlocked = await post(baseUrl, "/auth/stellar/challenge", { publicKey: "NOT-A-KEY" });
    assert.equal(chBlocked.status, 429, "challenge issuance is bounded");
  } finally {
    await server.close();
  }
});
