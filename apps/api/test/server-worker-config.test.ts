// Background-worker interval configuration (#87, documented by #96).
//
// The API server reads RECONCILIATION_INTERVAL_MS, EXECUTION_QUEUE_INTERVAL_MS,
// and SCHEDULER_INTERVAL_MS. validateIntervalMs is the pure parser behind them,
// so these tests are deterministic and need no network or secrets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIntervalMs } from "../src/server.js";

test("validateIntervalMs keeps the default when unset or blank", () => {
  assert.equal(validateIntervalMs("X", undefined, 30_000), 30_000);
  assert.equal(validateIntervalMs("X", "", 30_000), 30_000);
  assert.equal(validateIntervalMs("X", "   ", 30_000), 30_000);
});

test("validateIntervalMs accepts a positive integer, trimming whitespace", () => {
  assert.equal(validateIntervalMs("X", "5000", 30_000), 5_000);
  assert.equal(validateIntervalMs("X", " 1500 ", 30_000), 1_500);
  assert.equal(validateIntervalMs("X", "60000", 60_000), 60_000);
});

test("validateIntervalMs rejects non-numeric, zero, negative, and fractional values", () => {
  for (const bad of ["abc", "0", "-1", "1.5", "NaN", "Infinity", "10px"]) {
    assert.throws(
      () => validateIntervalMs("RECONCILIATION_INTERVAL_MS", bad, 30_000),
      /positive integer/,
      `expected "${bad}" to be rejected`
    );
  }
});
