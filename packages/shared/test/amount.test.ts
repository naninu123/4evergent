import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareStrictAmounts,
  isNonPositiveDecimalString,
  parseDecimalStroops,
  parseStrictPolicyAmount,
} from "../src/index.js";

test("parseDecimalStroops accepts strict unsigned decimal strings up to 7 decimals", () => {
  assert.equal(parseDecimalStroops("0"), 0n);
  assert.equal(parseDecimalStroops("10"), 100_000_000n);
  assert.equal(parseDecimalStroops("10.5"), 105_000_000n);
  assert.equal(parseDecimalStroops("0.0000001"), 1n);
});

test("parseDecimalStroops rejects malformed, signed, leading-zero, and over-precision strings", () => {
  for (const invalid of [
    "",
    "10abc",
    "1e2",
    "1E-3",
    "0x10",
    "+10",
    "-1",
    "01",
    ".5",
    "10.",
    " 10",
    "10 ",
    "0.00000001",
    "NaN",
    "Infinity",
  ]) {
    assert.equal(parseDecimalStroops(invalid), null, `expected null for ${JSON.stringify(invalid)}`);
  }
});

test("parseStrictPolicyAmount validates strings and non-negative finite numbers", () => {
  assert.equal(parseStrictPolicyAmount("0"), 0);
  assert.equal(parseStrictPolicyAmount("50.25"), 50.25);
  assert.equal(parseStrictPolicyAmount(0), 0);
  assert.equal(parseStrictPolicyAmount(100), 100);
  assert.equal(parseStrictPolicyAmount(-0), null);
  assert.equal(parseStrictPolicyAmount(-1), null);
  assert.equal(parseStrictPolicyAmount(Number.NaN), null);
  assert.equal(parseStrictPolicyAmount(Number.POSITIVE_INFINITY), null);
  assert.equal(parseStrictPolicyAmount("10abc"), null);
  assert.equal(parseStrictPolicyAmount("1e2"), null);
  assert.equal(parseStrictPolicyAmount("+10"), null);
});

test("isNonPositiveDecimalString distinguishes negative/zero decimals from malformed input", () => {
  assert.equal(isNonPositiveDecimalString("0"), true);
  assert.equal(isNonPositiveDecimalString("0.0"), true);
  assert.equal(isNonPositiveDecimalString("-5"), true);
  assert.equal(isNonPositiveDecimalString("-0.0000001"), true);
  assert.equal(isNonPositiveDecimalString("0.0000001"), false);
  assert.equal(isNonPositiveDecimalString("-5abc"), false);
  assert.equal(isNonPositiveDecimalString("abc"), false);
});

test("compareStrictAmounts compares using exact stroop integers", () => {
  assert.equal(compareStrictAmounts("10.0000001", "10"), 1);
  assert.equal(compareStrictAmounts("10", "10.0"), 0);
  assert.equal(compareStrictAmounts("9.9999999", "10"), -1);
  assert.equal(compareStrictAmounts("10abc", "10"), 0);
});
