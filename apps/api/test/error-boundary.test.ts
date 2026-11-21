import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, apiFetch } from "./helpers.js";
import type { PolicyRules } from "@4evergent/shared";

const DESTINATION = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

test("unexpected throw in routed handler returns 500 INTERNAL_ERROR with X-Request-Id and logs server-side", async () => {
  const { baseUrl, close, activityStore } = await startServer();
  const capturedLogs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(" "));
  };

  try {
    // Force an unexpected throw inside GET /activity
    activityStore.listByOwner = async () => {
      throw new Error("SQLITE_CORRUPT: secret internal detail");
    };

    const reqId = "req-boundary-test-123";
    const res = await apiFetch(`${baseUrl}/activity`, {
      headers: { "X-Request-Id": reqId },
    });

    assert.equal(res.status, 500);
    assert.equal(res.headers.get("x-request-id"), reqId);

    const rawText = await res.text();
    const body = JSON.parse(rawText);
    assert.deepEqual(body, {
      code: "INTERNAL_ERROR",
      error: "internal_error",
    });

    // Must not leak internal error message or stack trace
    assert.ok(!rawText.includes("SQLITE_CORRUPT"), "response must not leak internal error string");
    assert.ok(!rawText.includes("secret internal detail"), "response must not leak internal error detail");
    assert.ok(!rawText.includes("Error:"), "response must not leak stack trace");

    // Must be logged server-side with the request id
    const errorLog = capturedLogs
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.level === "error" && entry?.msg === "unhandled request error");

    assert.ok(errorLog, "expected unhandled request error log entry");
    assert.equal(errorLog.requestId, reqId);
    assert.equal(errorLog.error, "SQLITE_CORRUPT: secret internal detail");
  } finally {
    console.log = originalLog;
    await close();
  }
});

test("POST /approvals/:id/approve returns 500 INTERNAL_ERROR when execution queue enqueue fails", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const { baseUrl, close, executionStore } = await startServer({
    policyRules: rules,
    schedulerEnabled: true,
    intervalMs: 50,
  });

  const capturedLogs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(" "));
  };

  try {
    // 1. Create an intent that requires approval
    const intentRes = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: DESTINATION,
        amount: "50",
        reason: "approve enqueue failure test",
      }),
    });
    assert.equal(intentRes.status, 202);
    const intentBody = (await intentRes.json()) as { approvalId: string };
    assert.ok(intentBody.approvalId);

    // 2. Make the execution queue store write fail
    executionStore.create = async () => {
      throw new Error("DB write failed: disk full");
    };

    // 3. Approve — must fail with 500 INTERNAL_ERROR instead of false 200
    const reqId = "req-approve-fail-456";
    const approveRes = await apiFetch(`${baseUrl}/approvals/${intentBody.approvalId}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": reqId,
      },
      body: JSON.stringify({ approver: "tester" }),
    });

    assert.equal(approveRes.status, 500);
    assert.equal(approveRes.headers.get("x-request-id"), reqId);

    const rawText = await approveRes.text();
    const body = JSON.parse(rawText);
    assert.deepEqual(body, {
      code: "INTERNAL_ERROR",
      error: "internal_error",
    });

    assert.ok(!rawText.includes("queued for execution"), "must not claim execution was queued");
    assert.ok(!rawText.includes("disk full"), "must not leak internal store error");

    const errorLog = capturedLogs
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.level === "error" && entry?.msg === "unhandled request error");

    assert.ok(errorLog, "expected unhandled request error log entry");
    assert.equal(errorLog.requestId, reqId);
    assert.equal(errorLog.error, "DB write failed: disk full");
  } finally {
    console.log = originalLog;
    await close();
  }
});
