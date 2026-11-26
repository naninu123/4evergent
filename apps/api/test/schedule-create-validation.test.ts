import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearAgents } from "../src/index.js";
import { InMemoryScheduleStore } from "@4evergent/database";
import { startServer, apiFetch } from "./helpers.js";

// A real 56-char StrKey ed25519 public key (checksum-valid).
const VALID_ISSUER = "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U";
const VALID_DESTINATION = "GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA";

async function createSchedule(baseUrl: string, agentId: string, body: unknown) {
  const res = await apiFetch(`${baseUrl}/agents/${encodeURIComponent(agentId)}/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

function scheduleBody(intent: Record<string, unknown>) {
  return { intent, scheduleExpression: "0 0 * * *", timezone: "UTC" };
}

beforeEach(() => {
  clearAgents();
});

// A non-native schedule payment without an issuer can never execute: the
// transaction builder throws on every run. It must be rejected at creation.
test("POST /agents/:id/schedules — USDC without issuer returns 400 naming the missing issuer", async () => {
  const { baseUrl, close, scheduleStore } = await startServer({
    scheduleStore: new InMemoryScheduleStore(),
    deferExecution: true,
  });

  try {
    const res = await createSchedule(baseUrl, "test-agent", scheduleBody({
      type: "payment",
      asset: "USDC",
      destination: VALID_DESTINATION,
      amount: "10",
      reason: "monthly usdc",
    }));
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /issuer/i);
    assert.equal((await scheduleStore.listByAgent("test-agent")).length, 0);
  } finally {
    await close();
  }
});

test("POST /agents/:id/schedules — USDC with a valid issuer returns 201", async () => {
  const { baseUrl, close } = await startServer({
    scheduleStore: new InMemoryScheduleStore(),
    policyRules: {
      allowedAssets: ["XLM", `USDC:${VALID_ISSUER}`],
    },
    deferExecution: true,
  });

  try {
    const res = await createSchedule(baseUrl, "test-agent", scheduleBody({
      type: "payment",
      asset: "USDC",
      assetDetails: { code: "USDC", issuer: VALID_ISSUER },
      destination: VALID_DESTINATION,
      amount: "10",
      reason: "monthly usdc",
    }));
    assert.equal(res.status, 201);
    assert.equal(res.body.schedule.intent.assetDetails.issuer, VALID_ISSUER);
  } finally {
    await close();
  }
});

test("POST /agents/:id/schedules — XLM without assetDetails still returns 201", async () => {
  const { baseUrl, close } = await startServer({
    scheduleStore: new InMemoryScheduleStore(),
    deferExecution: true,
  });

  try {
    const res = await createSchedule(baseUrl, "test-agent", scheduleBody({
      type: "payment",
      asset: "XLM",
      destination: VALID_DESTINATION,
      amount: "10",
      reason: "monthly xlm",
    }));
    assert.equal(res.status, 201);
  } finally {
    await close();
  }
});
