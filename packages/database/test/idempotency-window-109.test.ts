/**
 * #109: Idempotency-Key replay window. The same behavioural set runs against
 * both ActivityStore backends with a short window and an injected clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  SQLiteActivityStore,
  InMemoryActivityStore,
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  createActivity,
  resolveIdempotencyWindowMs,
  type ActivityStore,
  type ActivityStoreOptions,
} from "../src/index.js";
import type { AgentIntent } from "@4evergent/shared";

const WINDOW_MS = 60_000;
const T0 = Date.parse("2026-11-22T12:00:00.000Z");

function intent(amount: string): AgentIntent {
  return {
    type: "payment",
    asset: "XLM",
    destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount,
    reason: "test",
  };
}

/** An activity whose createdAt is the fake clock's current time. */
function activityAt(nowMs: number, amount = "10", ownerId = "owner-a", agentId = "agent-a") {
  const rec = createActivity(agentId, ownerId, intent(amount));
  rec.createdAt = new Date(nowMs).toISOString();
  rec.updatedAt = rec.createdAt;
  return rec;
}

type Backend = {
  name: string;
  make: (options: ActivityStoreOptions) => { store: ActivityStore; cleanup: () => void };
};

const backends: Backend[] = [
  { name: "InMemoryActivityStore", make: (o) => ({ store: new InMemoryActivityStore(o), cleanup: () => {} }) },
  {
    name: "SQLiteActivityStore",
    make: (o) => {
      const dir = mkdtempSync(join(tmpdir(), "idem-109-"));
      const store = new SQLiteActivityStore(join(dir, "test.db"), o);
      return { store, cleanup: () => { store.close?.(); rmSync(dir, { recursive: true, force: true }); } };
    },
  },
];

for (const backend of backends) {
  function setup() {
    let now = T0;
    const { store, cleanup } = backend.make({ idempotencyWindowMs: WINDOW_MS, now: () => now });
    return { store, cleanup, advance: (ms: number) => { now += ms; }, now: () => now };
  }

  test(`${backend.name}: same key inside the window returns the original activity`, async () => {
    const { store, cleanup, advance, now } = setup();
    try {
      const first = await store.recordIdempotent("k1", activityAt(now()));
      assert.equal(first.created, true);
      advance(WINDOW_MS - 1);
      const again = await store.recordIdempotent("k1", activityAt(now()));
      assert.equal(again.created, false);
      assert.equal(again.record.id, first.record.id);
      assert.equal((await store.getByIdempotencyKey("owner-a", "agent-a", "k1"))?.id, first.record.id);
      assert.equal((await store.listByAgent("agent-a")).length, 1);
    } finally { cleanup(); }
  });

  test(`${backend.name}: same key after the window creates a new activity and keeps the old one`, async () => {
    const { store, cleanup, advance, now } = setup();
    try {
      const first = await store.recordIdempotent("k1", activityAt(now()));
      advance(WINDOW_MS + 1);
      assert.equal(await store.getByIdempotencyKey("owner-a", "agent-a", "k1"), null);
      const second = await store.recordIdempotent("k1", activityAt(now()));
      assert.equal(second.created, true);
      assert.notEqual(second.record.id, first.record.id);
      // The audit record survives; only its key binding was released.
      const old = await store.get(first.record.id);
      assert.ok(old);
      assert.equal(old.idempotencyKey ?? null, null);
      assert.equal((await store.listByAgent("agent-a")).length, 2);
      assert.equal((await store.getByIdempotencyKey("owner-a", "agent-a", "k1"))?.id, second.record.id);
    } finally { cleanup(); }
  });

  test(`${backend.name}: a key exactly at the window boundary still suppresses`, async () => {
    const { store, cleanup, advance, now } = setup();
    try {
      const first = await store.recordIdempotent("k1", activityAt(now()));
      advance(WINDOW_MS);
      assert.equal((await store.getByIdempotencyKey("owner-a", "agent-a", "k1"))?.id, first.record.id);
    } finally { cleanup(); }
  });

  test(`${backend.name}: a different intent inside the window still finds the original (409 path)`, async () => {
    const { store, cleanup, advance, now } = setup();
    try {
      const first = await store.recordIdempotent("k1", activityAt(now(), "10"));
      advance(WINDOW_MS / 2);
      const again = await store.recordIdempotent("k1", activityAt(now(), "999"));
      assert.equal(again.created, false);
      assert.equal(again.record.id, first.record.id);
      assert.deepEqual(again.record.intent, intent("10"));
    } finally { cleanup(); }
  });

  test(`${backend.name}: scoping by owner and agent is unchanged`, async () => {
    const { store, cleanup, now } = setup();
    try {
      const a = await store.recordIdempotent("k1", activityAt(now(), "10", "owner-a", "agent-a"));
      const b = await store.recordIdempotent("k1", activityAt(now(), "10", "owner-b", "agent-a"));
      const c = await store.recordIdempotent("k1", activityAt(now(), "10", "owner-a", "agent-b"));
      assert.deepEqual([a.created, b.created, c.created], [true, true, true]);
    } finally { cleanup(); }
  });

  test(`${backend.name}: releaseExpiredIdempotencyKeys clears only expired keys, is bounded, and deletes nothing`, async () => {
    const { store, cleanup, advance, now } = setup();
    try {
      const old1 = await store.recordIdempotent("old-1", activityAt(now()));
      const old2 = await store.recordIdempotent("old-2", activityAt(now()));
      advance(WINDOW_MS + 1);
      const fresh = await store.recordIdempotent("fresh", activityAt(now()));
      const cutoff = new Date(now() - WINDOW_MS).toISOString();

      assert.equal(await store.releaseExpiredIdempotencyKeys!(cutoff, 1), 1);
      assert.equal(await store.releaseExpiredIdempotencyKeys!(cutoff, 500), 1);
      assert.equal(await store.releaseExpiredIdempotencyKeys!(cutoff, 500), 0);

      assert.equal((await store.get(old1.record.id))?.idempotencyKey ?? null, null);
      assert.equal((await store.get(old2.record.id))?.idempotencyKey ?? null, null);
      assert.equal((await store.get(fresh.record.id))?.idempotencyKey, "fresh");
      assert.equal((await store.listByAgent("agent-a")).length, 3);
    } finally { cleanup(); }
  });
}

test("default window is 24 hours and invalid values fall back to it", () => {
  assert.equal(DEFAULT_IDEMPOTENCY_WINDOW_MS, 86_400_000);
  for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveIdempotencyWindowMs(bad), DEFAULT_IDEMPOTENCY_WINDOW_MS);
  }
  assert.equal(resolveIdempotencyWindowMs(1500.7), 1500);
  assert.equal(new InMemoryActivityStore().idempotencyWindowMs, DEFAULT_IDEMPOTENCY_WINDOW_MS);
});
