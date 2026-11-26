import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearAgents } from "../src/index.js";
import { InMemoryScheduleStore } from "@4evergent/database";
import { startServer, apiFetch } from "./helpers.js";

const ALLOWED_DEST = "GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA";
const DISALLOWED_DEST = "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U";

async function createSchedule(baseUrl: string, agentId: string, body: unknown) {
  const res = await apiFetch(`${baseUrl}/agents/${encodeURIComponent(agentId)}/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

function scheduleBody(intent: Record<string, unknown>) {
  return { intent, scheduleExpression: "0 0 * * *", timezone: "UTC" };
}

beforeEach(() => {
  clearAgents();
});

test("POST /agents/:id/schedules — schedule to a disallowed destination is refused with 403 naming allowedDestinations and does not reserve spending", async () => {
  const { baseUrl, close, scheduleStore, activityStore } = await startServer({
    scheduleStore: new InMemoryScheduleStore(),
    policyRules: {
      allowedDestinations: [ALLOWED_DEST],
      maxTxAmount: { XLM: "500" },
      dailySpendingLimit: { XLM: "1000" },
    },
    deferExecution: true,
  });

  try {
    const res = await createSchedule(
      baseUrl,
      "test-agent",
      scheduleBody({
        type: "payment",
        asset: "XLM",
        destination: DISALLOWED_DEST,
        amount: "25",
        reason: "disallowed destination schedule",
      })
    );
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "POLICY_DENIED");
    assert.match(res.body.error, /allowedDestinations|allowed_destinations/);
    assert.equal(res.body.policyDecision.result, "deny");
    assert.equal(res.body.policyDecision.rule, "allowedDestinations");
    assert.equal((await scheduleStore.listByAgent("test-agent")).length, 0);
    assert.equal((await activityStore.getDailySpending?.("test-agent", "XLM")) ?? 0, 0);
  } finally {
    await close();
  }
});

test("POST /agents/:id/schedules — schedule above maxTxAmount is refused with 403 naming maxTxAmount", async () => {
  const { baseUrl, close, scheduleStore } = await startServer({
    scheduleStore: new InMemoryScheduleStore(),
    policyRules: {
      maxTxAmount: { XLM: "100" },
    },
    deferExecution: true,
  });

  try {
    const res = await createSchedule(
      baseUrl,
      "test-agent",
      scheduleBody({
        type: "payment",
        asset: "XLM",
        destination: ALLOWED_DEST,
        amount: "250",
        reason: "over max tx amount",
      })
    );
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "POLICY_DENIED");
    assert.match(res.body.error, /maxTxAmount|max_tx_amount/);
    assert.equal(res.body.policyDecision.rule, "maxTxAmount");
    assert.equal((await scheduleStore.listByAgent("test-agent")).length, 0);
  } finally {
    await close();
  }
});

test("POST /agents/:id/schedules — schedule above approval threshold is accepted (201) with warning and does not reserve daily spending", async () => {
  const { baseUrl, close, scheduleStore, activityStore } = await startServer({
    scheduleStore: new InMemoryScheduleStore(),
    policyRules: {
      maxTxAmount: { XLM: "1000" },
      dailySpendingLimit: { XLM: "1000" },
      requireHumanApprovalForAmountAbove: "50",
    },
    deferExecution: true,
  });

  try {
    const res = await createSchedule(
      baseUrl,
      "test-agent",
      scheduleBody({
        type: "payment",
        asset: "XLM",
        destination: ALLOWED_DEST,
        amount: "100",
        reason: "above approval threshold schedule",
      })
    );
    assert.equal(res.status, 201);
    assert.ok(res.body.schedule?.id);
    assert.equal(typeof res.body.warning, "string");
    assert.match(res.body.warning, /require human approval/i);
    assert.equal(res.body.policyDecision?.result, "requires_approval");
    assert.equal(res.body.policyDecision?.rule, "approvalThreshold");
    assert.equal((await scheduleStore.listByAgent("test-agent")).length, 1);
    // Creation is not a spend — daily spending reservation must remain 0
    assert.equal((await activityStore.getDailySpending?.("test-agent", "XLM")) ?? 0, 0);
  } finally {
    await close();
  }
});

test("POST /agents/:id/schedules — schedule for a paused or disabled agent is refused with 409 AGENT_NOT_ACTIVE", async () => {
  const { baseUrl, close, scheduleStore } = await startServer({
    scheduleStore: new InMemoryScheduleStore(),
    deferExecution: true,
  });

  try {
    const pauseRes = await apiFetch(`${baseUrl}/agents/test-agent/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    assert.equal(pauseRes.status, 200);

    const pausedCreate = await createSchedule(
      baseUrl,
      "test-agent",
      scheduleBody({
        type: "payment",
        asset: "XLM",
        destination: ALLOWED_DEST,
        amount: "10",
        reason: "paused agent schedule",
      })
    );
    assert.equal(pausedCreate.status, 409);
    assert.equal(pausedCreate.body.code, "AGENT_NOT_ACTIVE");

    const disableRes = await apiFetch(`${baseUrl}/agents/test-agent/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "disabled" }),
    });
    assert.equal(disableRes.status, 200);

    const disabledCreate = await createSchedule(
      baseUrl,
      "test-agent",
      scheduleBody({
        type: "payment",
        asset: "XLM",
        destination: ALLOWED_DEST,
        amount: "10",
        reason: "disabled agent schedule",
      })
    );
    assert.equal(disabledCreate.status, 409);
    assert.equal(disabledCreate.body.code, "AGENT_NOT_ACTIVE");
    assert.equal((await scheduleStore.listByAgent("test-agent")).length, 0);
  } finally {
    await close();
  }
});
