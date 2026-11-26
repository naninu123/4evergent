import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepRetainedData } from "../src/data-retention.js";

test("Data retention: a zero-day window keeps both tables forever", async () => {
  let sessionsSwept = 0;
  let spendingSwept = 0;
  const result = await sweepRetainedData({
    store: { sweepDailySpending: async () => { spendingSwept++; return 0; } },
    authModule: { sweepExpiredSessions: () => { sessionsSwept++; return 0; } },
    now: Date.parse("2026-01-15T12:00:00.000Z"),
    authSessionDays: 0,
    dailySpendingDays: 0,
  });

  assert.deepEqual(result, { authSessionsRemoved: 0, dailySpendingRemoved: 0, expiredApprovalsSwept: 0, idempotencyKeysReleased: 0 });
  assert.equal(sessionsSwept, 0);
  assert.equal(spendingSwept, 0);
});

test("Data retention: sweeps use the configured age cutoffs", async () => {
  let sessionCutoff = 0;
  let spendingCutoff = "";
  const now = Date.parse("2026-01-15T12:00:00.000Z");
  const result = await sweepRetainedData({
    store: { sweepDailySpending: async (cutoff) => { spendingCutoff = cutoff; return 2; } },
    authModule: { sweepExpiredSessions: (cutoff) => { sessionCutoff = cutoff; return 1; } },
    now,
    authSessionDays: 30,
    dailySpendingDays: 90,
  });

  assert.deepEqual(result, { authSessionsRemoved: 1, dailySpendingRemoved: 2, expiredApprovalsSwept: 0, idempotencyKeysReleased: 0 });
  assert.equal(sessionCutoff, now - 30 * 24 * 60 * 60_000);
  assert.equal(spendingCutoff, "2025-10-17");
});

test("Data retention: sweeps expired approvals and calls onApprovalExpired", async () => {
  let approvalCutoff = "";
  let approvalLimit = 0;
  const expiredCalls: string[] = [];
  const now = Date.parse("2026-01-15T12:00:00.000Z");

  const result = await sweepRetainedData({
    store: { sweepDailySpending: async () => 0 },
    approvalStore: {
      sweepExpired: async (cutoff, limit, onSwept) => {
        approvalCutoff = cutoff ?? "";
        approvalLimit = limit ?? 0;
        if (onSwept) {
          await onSwept({ id: "app-1", agentId: "agent-1" } as any);
        }
        return 1;
      },
    },
    now,
    authSessionDays: 0,
    dailySpendingDays: 0,
    batchSize: 100,
    onApprovalExpired: (app) => {
      expiredCalls.push(app.id);
    },
  });

  assert.deepEqual(result, { authSessionsRemoved: 0, dailySpendingRemoved: 0, expiredApprovalsSwept: 1, idempotencyKeysReleased: 0 });
  assert.equal(approvalCutoff, "2026-01-15T12:00:00.000Z");
  assert.equal(approvalLimit, 100);
  assert.deepEqual(expiredCalls, ["app-1"]);
});

test("Data retention: releases Idempotency-Keys older than the replay window (#109)", async () => {
  let keyCutoff = "";
  let keyLimit = 0;
  const now = Date.parse("2026-01-15T12:00:00.000Z");
  const result = await sweepRetainedData({
    store: {
      sweepDailySpending: async () => 0,
      releaseExpiredIdempotencyKeys: async (cutoff, limit) => { keyCutoff = cutoff; keyLimit = limit ?? 0; return 4; },
    },
    now,
    authSessionDays: 0,
    dailySpendingDays: 0,
    idempotencyWindowMs: 24 * 60 * 60_000,
    batchSize: 250,
  });

  assert.equal(result.idempotencyKeysReleased, 4);
  assert.equal(keyCutoff, "2026-01-14T12:00:00.000Z");
  assert.equal(keyLimit, 250);
});

test("Data retention: no window, no key release (#109)", async () => {
  let called = false;
  const result = await sweepRetainedData({
    store: { sweepDailySpending: async () => 0, releaseExpiredIdempotencyKeys: async () => { called = true; return 1; } },
    authSessionDays: 0,
    dailySpendingDays: 0,
  });
  assert.equal(result.idempotencyKeysReleased, 0);
  assert.equal(called, false);
});
