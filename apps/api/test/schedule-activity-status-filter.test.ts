import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import type { Signer } from "@4evergent/stellar";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import {
  InMemoryActivityStore,
  InMemoryScheduleStore,
  createActivity,
} from "@4evergent/database";
import type {
  ActivityRecord,
  ActivityStatus,
  ScheduleRecord,
  ScheduleStatus,
} from "@4evergent/database";

// Offline tests: in-process HTTP server + in-memory stores.
// Regression coverage for issue #263 — status filtering on the schedule and
// activity list endpoints must query the store (store-level filter, or
// listByStatus for per-agent activity) instead of filtering a capped
// in-memory window, and must reject unknown status values with 400.

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
    transaction.signatures = [
      { hint: Buffer.from("mock"), signature: Buffer.from("sig") },
    ];
    return transaction;
  }
}

class RecordingActivityStore extends InMemoryActivityStore {
  listByAgentCalls: Array<{ agentId: string; limit: number; offset: number; status?: string }> = [];
  listByStatusCalls: Array<{ agentId: string; status: string; limit: number; offset: number }> = [];
  listByOwnerCalls: Array<{ ownerId: string; limit: number; offset: number; status?: string }> = [];

  async listByAgent(agentId: string, limit = 50, offset = 0, status?: string): Promise<ActivityRecord[]> {
    this.listByAgentCalls.push({ agentId, limit, offset, status });
    return super.listByAgent(agentId, limit, offset, status);
  }

  async listByStatus(agentId: string, status: string, limit = 50, offset = 0): Promise<ActivityRecord[]> {
    this.listByStatusCalls.push({ agentId, status, limit, offset });
    return super.listByStatus(agentId, status, limit, offset);
  }

  async listByOwner(ownerId: string, limit = 50, offset = 0, status?: string): Promise<ActivityRecord[]> {
    this.listByOwnerCalls.push({ ownerId, limit, offset, status });
    return super.listByOwner(ownerId, limit, offset, status);
  }
}

class RecordingScheduleStore extends InMemoryScheduleStore {
  listByAgentCalls: Array<{ agentId: string; limit: number; offset: number; status?: string }> = [];

  async listByAgent(agentId: string, limit = 50, offset = 0, status?: string): Promise<ScheduleRecord[]> {
    this.listByAgentCalls.push({ agentId, limit, offset, status });
    return super.listByAgent(agentId, limit, offset, status);
  }
}

const intent = {
  type: "payment" as const,
  asset: "XLM",
  destination: Keypair.random().publicKey(),
  amount: "1",
  reason: "status filter test",
};
const decision = {
  result: "requires_approval",
  reason: "status filter test",
  rule: "status filter test",
  intent,
} as any;

function makeActivity(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    ...createActivity("test-agent", "test", intent, decision),
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: "test-agent",
    ownerId: "test",
    status: "active",
    intent,
    scheduleExpression: "0 * * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + 60000).toISOString(),
    lastRunAt: null,
    lastStartedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ScheduleRecord;
}

async function startServer(activityStore: RecordingActivityStore, scheduleStore: RecordingScheduleStore) {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    activityStore,
    scheduleStore,
  });
  server.registerAgent({
    id: "test-agent",
    displayName: "Test Agent",
    description: "test agent",
    ownerId: "test",
    stellarAddress: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
    capabilities: ["payment"],
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    active: true,
    metadata: {},
  });

  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { keepalive: false });
  return { status: res.status, body: await res.json() };
}

const VALID_SCHEDULE_STATUSES: ScheduleStatus[] = ["active", "paused", "disabled"];
const VALID_ACTIVITY_STATUSES: ActivityStatus[] = [
  "pending",
  "rejected",
  "requires_approval",
  "approved",
  "signed",
  "submitted",
  "failed",
];

async function seedSchedules(
  store: RecordingScheduleStore,
  rows: Array<{ status: ScheduleStatus; nextRunAtMs: number }>
) {
  for (const [i, row] of rows.entries()) {
    await store.create(
      makeSchedule({
        id: `sched-${i}`,
        status: row.status,
        nextRunAt: new Date(row.nextRunAtMs).toISOString(),
      })
    );
  }
}

async function seedActivities(
  store: RecordingActivityStore,
  rows: Array<{ status: ActivityStatus; ownerId?: string; createdAtMs: number }>
) {
  for (const [i, row] of rows.entries()) {
    const rec = makeActivity({
      id: `act-${i}`,
      ownerId: row.ownerId ?? "test",
      status: row.status,
      createdAt: new Date(row.createdAtMs).toISOString(),
      updatedAt: new Date(row.createdAtMs).toISOString(),
    });
    await store.record(rec);
  }
}

test("GET /agents/:id/schedules?status=paused returns only paused schedules", async () => {
  const activityStore = new RecordingActivityStore();
  const scheduleStore = new RecordingScheduleStore();
  const { baseUrl, close } = await startServer(activityStore, scheduleStore);
  try {
    const base = Date.now();
    await seedSchedules(scheduleStore, [
      { status: "paused", nextRunAtMs: base + 1000 },
      { status: "paused", nextRunAtMs: base + 2000 },
      { status: "active", nextRunAtMs: base + 3000 },
      { status: "disabled", nextRunAtMs: base + 4000 },
    ]);

    const filtered = await get(baseUrl, "/agents/test-agent/schedules?status=paused");
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.schedules.length, 2);
    for (const s of filtered.body.schedules) assert.equal(s.status, "paused");
    assert.deepEqual(scheduleStore.listByAgentCalls, [
      { agentId: "test-agent", limit: 51, offset: 0, status: "paused" },
    ]);

    const unfiltered = await get(baseUrl, "/agents/test-agent/schedules");
    assert.equal(unfiltered.status, 200);
    assert.equal(unfiltered.body.schedules.length, 4);
    assert.deepEqual(scheduleStore.listByAgentCalls[1], {
      agentId: "test-agent",
      limit: 51,
      offset: 0,
      status: undefined,
    });
  } finally {
    await close();
  }
});

test("GET /agents/:id/activity?status= routes through listByStatus", async () => {
  const activityStore = new RecordingActivityStore();
  const scheduleStore = new RecordingScheduleStore();
  const { baseUrl, close } = await startServer(activityStore, scheduleStore);
  try {
    const base = Date.now();
    await seedActivities(activityStore, [
      { status: "failed", createdAtMs: base },
      { status: "failed", createdAtMs: base + 1000 },
      { status: "submitted", createdAtMs: base + 2000 },
    ]);

    const filtered = await get(baseUrl, "/agents/test-agent/activity?status=failed");
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.activity.length, 2);
    for (const a of filtered.body.activity) assert.equal(a.status, "failed");
    assert.deepEqual(activityStore.listByStatusCalls, [
      { agentId: "test-agent", status: "failed", limit: 51, offset: 0 },
    ]);
    assert.equal(activityStore.listByAgentCalls.length, 0, "filtered path must not call listByAgent");

    const unfiltered = await get(baseUrl, "/agents/test-agent/activity");
    assert.equal(unfiltered.status, 200);
    assert.equal(unfiltered.body.activity.length, 3);
    assert.deepEqual(activityStore.listByAgentCalls, [
      { agentId: "test-agent", limit: 51, offset: 0, status: undefined },
    ]);
    assert.equal(activityStore.listByStatusCalls.length, 1, "unfiltered path must not call listByStatus");
  } finally {
    await close();
  }
});

test("GET /activity?status= returns only matching rows for the owner", async () => {
  const activityStore = new RecordingActivityStore();
  const scheduleStore = new RecordingScheduleStore();
  const { baseUrl, close } = await startServer(activityStore, scheduleStore);
  try {
    const base = Date.now();
    await seedActivities(activityStore, [
      { status: "submitted", createdAtMs: base },
      { status: "submitted", createdAtMs: base + 1000 },
      { status: "failed", createdAtMs: base + 2000 },
      { status: "submitted", ownerId: "someone-else", createdAtMs: base + 3000 },
    ]);

    const res = await get(baseUrl, "/activity?status=submitted");
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.length, 2);
    for (const a of res.body.activity) {
      assert.equal(a.status, "submitted");
      assert.equal(a.ownerId, "test");
    }
    assert.deepEqual(activityStore.listByOwnerCalls, [
      { ownerId: "test", limit: 51, offset: 0, status: "submitted" },
    ]);
  } finally {
    await close();
  }
});

test("unknown status returns 400 naming the valid values on all three endpoints", async () => {
  const activityStore = new RecordingActivityStore();
  const scheduleStore = new RecordingScheduleStore();
  const { baseUrl, close } = await startServer(activityStore, scheduleStore);
  try {
    const cases: Array<{ path: string; valid: string[] }> = [
      { path: "/agents/test-agent/schedules?status=not_a_real_status", valid: VALID_SCHEDULE_STATUSES },
      { path: "/agents/test-agent/activity?status=not_a_real_status", valid: VALID_ACTIVITY_STATUSES },
      { path: "/activity?status=not_a_real_status", valid: VALID_ACTIVITY_STATUSES },
    ];
    for (const { path, valid } of cases) {
      const res = await get(baseUrl, path);
      assert.equal(res.status, 400, `${path} must reject unknown statuses`);
      assert.match(res.body.error, /invalid status 'not_a_real_status'/);
      for (const v of valid) {
        assert.ok(res.body.error.includes(v), `${path} error must name valid value ${v}`);
      }
    }

    const empty = await get(baseUrl, "/agents/test-agent/schedules?status=");
    assert.equal(empty.status, 400, "an explicitly empty status must not be treated as absent");

    const noMatches = await get(baseUrl, "/agents/test-agent/schedules?status=disabled");
    assert.equal(noMatches.status, 200);
    assert.deepEqual(noMatches.body.schedules, []);
  } finally {
    await close();
  }
});

test("schedule status filter pages over the filtered set with exact hasMore", async () => {
  const activityStore = new RecordingActivityStore();
  const scheduleStore = new RecordingScheduleStore();
  const { baseUrl, close } = await startServer(activityStore, scheduleStore);
  try {
    const base = Date.now();
    await seedSchedules(scheduleStore, [
      { status: "paused", nextRunAtMs: base + 1000 },
      { status: "paused", nextRunAtMs: base + 2000 },
      { status: "paused", nextRunAtMs: base + 3000 },
      { status: "active", nextRunAtMs: base + 4000 },
    ]);

    const page1 = await get(baseUrl, "/agents/test-agent/schedules?status=paused&limit=2&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.schedules.length, 2);
    assert.equal(page1.body.hasMore, true);
    for (const s of page1.body.schedules) assert.equal(s.status, "paused");

    const page2 = await get(baseUrl, "/agents/test-agent/schedules?status=paused&limit=2&offset=2");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.schedules.length, 1);
    assert.equal(page2.body.hasMore, false);
    assert.notEqual(page2.body.schedules[0].id, page1.body.schedules[0].id);
    assert.notEqual(page2.body.schedules[0].id, page1.body.schedules[1].id);
  } finally {
    await close();
  }
});

test("activity status filter returns matching rows even when newer rows do not match", async () => {
  const activityStore = new RecordingActivityStore();
  const scheduleStore = new RecordingScheduleStore();
  const { baseUrl, close } = await startServer(activityStore, scheduleStore);
  try {
    const base = Date.now();
    // Newest 60 rows are rejected; the 30 submitted rows are older. A capped
    // in-memory fetch-then-filter would return nothing for ?status=submitted.
    const rows: Array<{ status: ActivityStatus; createdAtMs: number }> = [];
    for (let i = 0; i < 30; i++) rows.push({ status: "submitted", createdAtMs: base + i });
    for (let i = 0; i < 60; i++) rows.push({ status: "rejected", createdAtMs: base + 100_000 + i });
    await seedActivities(activityStore, rows);

    const res = await get(baseUrl, "/agents/test-agent/activity?status=submitted&limit=50&offset=0");
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.length, 30);
    for (const a of res.body.activity) assert.equal(a.status, "submitted");
    assert.equal(res.body.hasMore, false);

    const page1 = await get(baseUrl, "/activity?status=submitted&limit=20&offset=0");
    assert.equal(page1.body.activity.length, 20);
    assert.equal(page1.body.hasMore, true);
    const page2 = await get(baseUrl, "/activity?status=submitted&limit=20&offset=20");
    assert.equal(page2.body.activity.length, 10);
    assert.equal(page2.body.hasMore, false);
  } finally {
    await close();
  }
});
