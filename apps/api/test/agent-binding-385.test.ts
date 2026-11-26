// Issue #385 — Schedule and activity sub-resource endpoints must honour the
// :agentId path segment.
//
// /agents/:id/schedules/:scheduleId and /agents/:id/activity/:activityId name
// an agent in the path. A caller reading the URL reasonably expects the
// resource to belong to that agent; the per-agent list endpoints already do.
// Before the fix, the single-resource handlers checked only owner scoping, so
// agent B's schedule or activity was served (and mutable) under agent A's
// path.
//
// Contract verified here:
//   - cross-agent request  → 404, resource untouched
//   - own-agent request    → 200, resource served/mutated
//   - cross-owner request  → 404 (unchanged owner isolation)
//   - unregistered agent   → 404 (indistinguishable from a nonexistent id)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { clearAgents } from "../src/index.js";
import type { ScheduleRecord, ActivityRecord } from "@4evergent/database";import { startServer, apiFetch, DEFAULT_TEST_AGENT } from "./helpers.js";

const SECOND_AGENT = "agent-two";
const DESTINATION = "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U";

beforeEach(() => {
  clearAgents();
});

function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: SECOND_AGENT,
    ownerId: "test",
    status: "active",
    intent: {
      type: "payment",
      asset: "XLM",
      destination: DESTINATION,
      amount: "10",
      reason: "agent binding test",
    },
    scheduleExpression: "0 * * * *",
    timezone: "UTC",
    nextRunAt: "2099-01-01T00:00:00Z",
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeActivity(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: SECOND_AGENT,
    ownerId: "test",
    intent: { type: "payment", asset: "XLM", destination: DESTINATION, amount: "50", reason: "agent binding test" },
    policyDecision: { decision: "allow", reasons: [] } as any,
    authorizationStatus: "not_required",
    status: "pending",
    txHash: null,
    simulationResult: null,
    error: null,
    idempotencyKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Start a server for owner "test" with two agents owned by that owner:
 * "test-agent" (registered by the harness) and "agent-two" (registered here).
 * The schedule/activity records default to agent-two so the cross-agent case
 * is a same-owner, different-agent request.
 */
async function startTwoAgentServer() {
  const server = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
    deferExecution: true,
  });
  server.server.registerAgent({ ...DEFAULT_TEST_AGENT, id: SECOND_AGENT, ownerId: "test" });
  return server;
}

async function getSchedule(baseUrl: string, agentId: string, scheduleId: string) {
  const res = await apiFetch(`${baseUrl}/agents/${agentId}/schedules/${scheduleId}`);
  return { status: res.status, body: await res.json() };
}

async function patchSchedule(baseUrl: string, agentId: string, scheduleId: string, body: unknown) {
  const res = await apiFetch(`${baseUrl}/agents/${agentId}/schedules/${scheduleId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function deleteSchedule(baseUrl: string, agentId: string, scheduleId: string) {
  const res = await apiFetch(`${baseUrl}/agents/${agentId}/schedules/${scheduleId}`, { method: "DELETE" });
  return { status: res.status, body: await res.json() };
}

async function scheduleAction(baseUrl: string, agentId: string, scheduleId: string, action: "pause" | "resume" | "disable") {
  const res = await apiFetch(`${baseUrl}/agents/${agentId}/schedules/${scheduleId}/${action}`, { method: "POST" });
  return { status: res.status, body: await res.json() };
}

async function getActivity(baseUrl: string, agentId: string, activityId: string) {
  const res = await apiFetch(`${baseUrl}/agents/${agentId}/activity/${activityId}`);
  return { status: res.status, body: await res.json() };
}

// ===== GET schedule =====

test("GET /agents/:id/schedules/:scheduleId — schedule of another agent under this agent's path returns 404", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test" });
  await scheduleStore.create(schedule);

  try {
    const res = await getSchedule(baseUrl, "test-agent", schedule.id);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("GET /agents/:id/schedules/:scheduleId — same schedule under its own agent's path returns 200", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test" });
  await scheduleStore.create(schedule);

  try {
    const res = await getSchedule(baseUrl, SECOND_AGENT, schedule.id);
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.id, schedule.id);
    assert.equal(res.body.schedule.agentId, SECOND_AGENT);
  } finally {
    await close();
  }
});

// ===== PATCH schedule =====

test("PATCH /agents/:id/schedules/:scheduleId — schedule of another agent returns 404 and is not mutated", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test" });
  await scheduleStore.create(schedule);

  try {
    const res = await patchSchedule(baseUrl, "test-agent", schedule.id, { scheduleExpression: "*/5 * * * *" });
    assert.equal(res.status, 404);

    const after = await scheduleStore.get(schedule.id);
    assert.equal(after?.scheduleExpression, "0 * * * *");
    assert.equal(after?.updatedAt, schedule.updatedAt);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id/schedules/:scheduleId — same schedule under its own agent's path returns 200", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test" });
  await scheduleStore.create(schedule);

  try {
    const res = await patchSchedule(baseUrl, SECOND_AGENT, schedule.id, { scheduleExpression: "*/5 * * * *" });
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.scheduleExpression, "*/5 * * * *");
  } finally {
    await close();
  }
});

// ===== DELETE schedule =====

test("DELETE /agents/:id/schedules/:scheduleId — schedule of another agent returns 404 and is not deleted", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test" });
  await scheduleStore.create(schedule);

  try {
    const res = await deleteSchedule(baseUrl, "test-agent", schedule.id);
    assert.equal(res.status, 404);

    const after = await scheduleStore.get(schedule.id);
    assert.ok(after, "schedule must still exist after rejected cross-agent delete");
  } finally {
    await close();
  }
});

test("DELETE /agents/:id/schedules/:scheduleId — same schedule under its own agent's path returns 200", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test" });
  await scheduleStore.create(schedule);

  try {
    const res = await deleteSchedule(baseUrl, SECOND_AGENT, schedule.id);
    assert.equal(res.status, 200);

    const after = await scheduleStore.get(schedule.id);
    assert.equal(after, null, "schedule must be deleted via its own agent's path");
  } finally {
    await close();
  }
});

// ===== Schedule actions (pause / resume / disable) =====

test("POST pause — schedule of another agent returns 404 and status is unchanged", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test", status: "active" });
  await scheduleStore.create(schedule);

  try {
    const res = await scheduleAction(baseUrl, "test-agent", schedule.id, "pause");
    assert.equal(res.status, 404);
    assert.equal((await scheduleStore.get(schedule.id))?.status, "active");
  } finally {
    await close();
  }
});

test("POST pause — same schedule under its own agent's path returns 200 paused", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test", status: "active" });
  await scheduleStore.create(schedule);

  try {
    const res = await scheduleAction(baseUrl, SECOND_AGENT, schedule.id, "pause");
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.status, "paused");
  } finally {
    await close();
  }
});

test("POST resume — schedule of another agent returns 404 and status is unchanged", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test", status: "paused" });
  await scheduleStore.create(schedule);

  try {
    const res = await scheduleAction(baseUrl, "test-agent", schedule.id, "resume");
    assert.equal(res.status, 404);
    assert.equal((await scheduleStore.get(schedule.id))?.status, "paused");
  } finally {
    await close();
  }
});

test("POST resume — same schedule under its own agent's path returns 200 active", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test", status: "paused" });
  await scheduleStore.create(schedule);

  try {
    const res = await scheduleAction(baseUrl, SECOND_AGENT, schedule.id, "resume");
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.status, "active");
  } finally {
    await close();
  }
});

test("POST disable — schedule of another agent returns 404 and status is unchanged", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test", status: "active" });
  await scheduleStore.create(schedule);

  try {
    const res = await scheduleAction(baseUrl, "test-agent", schedule.id, "disable");
    assert.equal(res.status, 404);
    assert.equal((await scheduleStore.get(schedule.id))?.status, "active");
  } finally {
    await close();
  }
});

test("POST disable — same schedule under its own agent's path returns 200 disabled", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test", status: "active" });
  await scheduleStore.create(schedule);

  try {
    const res = await scheduleAction(baseUrl, SECOND_AGENT, schedule.id, "disable");
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.status, "disabled");
  } finally {
    await close();
  }
});

// ===== GET activity detail =====

test("GET /agents/:id/activity/:activityId — activity of another agent under this agent's path returns 404", async () => {
  const { baseUrl, close, activityStore } = await startTwoAgentServer();
  const activity = makeActivity({ agentId: SECOND_AGENT, ownerId: "test" });
  await activityStore.record(activity);

  try {
    const res = await getActivity(baseUrl, "test-agent", activity.id);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("GET /agents/:id/activity/:activityId — same activity under its own agent's path returns 200", async () => {
  const { baseUrl, close, activityStore } = await startTwoAgentServer();
  const activity = makeActivity({ agentId: SECOND_AGENT, ownerId: "test" });
  await activityStore.record(activity);

  try {
    const res = await getActivity(baseUrl, SECOND_AGENT, activity.id);
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.id, activity.id);
    assert.equal(res.body.activity.agentId, SECOND_AGENT);
  } finally {
    await close();
  }
});

// ===== No-leak: unregistered agent path =====

test("GET schedule under an unregistered agent path returns the same 404 as a nonexistent id", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  const schedule = makeSchedule({ agentId: SECOND_AGENT, ownerId: "test" });
  await scheduleStore.create(schedule);

  try {
    const cross = await getSchedule(baseUrl, "no-such-agent", schedule.id);
    const missing = await getSchedule(baseUrl, SECOND_AGENT, "no-such-schedule");
    assert.equal(cross.status, 404);
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});

// ===== Owner isolation unchanged =====

test("cross-owner behaviour is unchanged — another owner's schedule still returns 404 under every path", async () => {
  const { baseUrl, close, scheduleStore } = await startTwoAgentServer();
  // Schedule attached to the requester's own agent but owned by someone else.
  const foreign = makeSchedule({ agentId: "test-agent", ownerId: "other-owner" });
  await scheduleStore.create(foreign);

  try {
    const res = await getSchedule(baseUrl, "test-agent", foreign.id);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});
