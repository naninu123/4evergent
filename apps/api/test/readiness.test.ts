import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryActivityStore } from "@4evergent/database";
import type { Signer } from "@4evergent/stellar";
import { createApiServer, type ServerOptions } from "../src/index.js";

const horizonOk: typeof fetch = async () => new Response(JSON.stringify({
  network_passphrase: "Test SDF Network ; September 2015",
}));
const signer: Signer = {
  getAccountId: () => `G${"A".repeat(55)}`,
  getNetworkPassphrase: () => "Test SDF Network ; September 2015",
  sign: async transaction => transaction,
};

async function start(overrides: Partial<ServerOptions> = {}) {
  const api = await createApiServer({
    port: 0, horizonUrl: "https://horizon.invalid", signer,
    readiness: { fetcher: horizonOk, timeoutMs: 50, cacheMs: 100 },
    ...overrides,
  });
  await api.listen(0);
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  return { api, get: (path = "/health/ready") => fetch(`${base}${path}`) };
}

test("readiness: public all-ok response reports disabled optional workers", async () => {
  const { api, get } = await start();
  try {
    const res = await get();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok", checks: {
      horizon: "ok", database: "ok", executionQueue: "disabled", scheduler: "disabled",
    } });
  } finally { await api.close(); }
});

test("readiness: Horizon failure returns 503 without leaking errors; liveness stays unchanged", async () => {
  let calls = 0;
  const { api, get } = await start({ readiness: { fetcher: async () => {
    calls++; throw new Error("private dependency details");
  } } });
  try {
    const live = await get("/health");
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "ok", signerAccountId: signer.getAccountId() });
    assert.equal(calls, 0);
    const ready = await get();
    assert.equal(ready.status, 503);
    const body = await ready.json() as any;
    assert.equal(body.status, "unavailable");
    assert.equal(body.checks.horizon, "fail");
    assert.ok(!JSON.stringify(body).includes("private"));
  } finally { await api.close(); }
});

test("readiness: non-2xx Horizon response fails", async () => {
  const { api, get } = await start({ readiness: { fetcher: async () => new Response("down", { status: 503 }) } });
  try { assert.equal((await get()).status, 503); } finally { await api.close(); }
});

test("readiness: timeout bounds an unresponsive fetcher and aborts its signal", async () => {
  let signal: AbortSignal | null | undefined;
  const { api, get } = await start({ readiness: { timeoutMs: 20, fetcher: async (_input, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  } } });
  try {
    const response = await get();
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as any).checks.horizon, "fail");
    assert.equal(signal?.aborted, true);
  } finally { await api.close(); }
});

test("readiness: store failures and store timeouts are unavailable", async () => {
  for (const hangs of [false, true]) {
    const store = new InMemoryActivityStore();
    store.listAll = async () => {
      if (hangs) return new Promise(() => {});
      throw new Error("locked database path must not leak");
    };
    const { api, get } = await start({ activityStore: store });
    try {
      const res = await get();
      assert.equal(res.status, 503);
      const body = await res.json() as any;
      assert.equal(body.checks.database, "fail");
      assert.equal(body.checks.horizon, "ok");
    } finally { await api.close(); }
  }
});

test("readiness: concurrent probes share a check; cached failures expire", async () => {
  let calls = 0;
  const { api, get } = await start({ readiness: { cacheMs: 40, fetcher: async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return calls === 1 ? new Response("down", { status: 503 }) : horizonOk("https://horizon.invalid");
  } } });
  try {
    const responses = await Promise.all(Array.from({ length: 5 }, () => get()));
    assert.ok(responses.every(r => r.status === 503));
    assert.equal(calls, 1);
    assert.equal((await get()).status, 503);
    assert.equal(calls, 1);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal((await get()).status, 200);
    assert.equal(calls, 2);
  } finally { await api.close(); }
});

test("readiness: enabled workers report live status even while dependencies are cached", async () => {
  const { api, get } = await start({
    executionQueue: { enabled: true, intervalMs: 3_600_000 },
    scheduler: { enabled: true, intervalMs: 3_600_000 },
  });
  try {
    const healthy = await get();
    assert.equal(healthy.status, 200);
    assert.equal(((await healthy.json()) as any).checks.executionQueue, "ok");
    api.executionQueue!.stop();
    api.scheduler!.stop();
    const stopped = await get();
    assert.equal(stopped.status, 503);
    const body = await stopped.json() as any;
    assert.equal(body.status, "degraded");
    assert.equal(body.checks.executionQueue, "fail");
    assert.equal(body.checks.scheduler, "fail");
  } finally { await api.close(); }
});

test("readiness: actual SQLite stores pass the read probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "readiness-"));
  const { api, get } = await start({ dbPath: join(dir, "test.sqlite") });
  try {
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).checks.database, "ok");
  } finally { await api.close(); rmSync(dir, { recursive: true, force: true }); }
});
