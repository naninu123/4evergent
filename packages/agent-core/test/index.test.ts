import { test } from "node:test";
import assert from "node:assert/strict";
import { IntentValidator } from "../src/index.js";
import type { AgentIntent } from "@4evergent/shared";

const VALID_STELLAR_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const mkPayment = (over: Partial<AgentIntent> = {}): AgentIntent =>
  ({
    type: "payment",
    asset: "XLM",
    destination: VALID_STELLAR_KEY,
    amount: "10",
    reason: "test payment",
    ...over,
  }) as AgentIntent;

test("valid payment passes validation", () => {
  const r = IntentValidator.validate(mkPayment());
  assert.equal(r.valid, true);
});

test("missing amount fails", () => {
  const r = IntentValidator.validate(mkPayment({ amount: "" }));
  assert.equal(r.valid, false);
  assert.match(r.error!, /amount/);
});

test("negative amount fails", () => {
  const r = IntentValidator.validate(mkPayment({ amount: "-1" }));
  assert.equal(r.valid, false);
});

test("zero amount fails", () => {
  const r = IntentValidator.validate(mkPayment({ amount: "0" }));
  assert.equal(r.valid, false);
});

test("invalid destination fails", () => {
  const r = IntentValidator.validate(mkPayment({ destination: "INVALID" }));
  assert.equal(r.valid, false);
  assert.match(r.error!, /Stellar/);
});

test("short G-prefixed destination fails", () => {
  const r = IntentValidator.validate(mkPayment({ destination: "GABCDEF" }));
  assert.equal(r.valid, false);
  assert.match(r.error!, /Stellar/);
});

test("amount over global maximum fails", () => {
  const r = IntentValidator.validate(mkPayment({ amount: "9999999" }));
  assert.equal(r.valid, false);
  assert.match(r.error!, /maximum/);
});

test("unknown asset fails", () => {
  const r = IntentValidator.validate(mkPayment({ asset: "BTC" }));
  assert.equal(r.valid, false);
  assert.match(r.error!, /asset/);
});

test("empty reason fails", () => {
  const r = IntentValidator.validate(mkPayment({ reason: "ab" }));
  assert.equal(r.valid, false);
  assert.match(r.error!, /reason/);
});

test("trustline with short GUSDC issuer is rejected", () => {
  // Previously asserted valid: true due to weak startsWith("G") check;
  // updated to assert rejection because "GUSDC" is not a valid 56-char Stellar ed25519 public key.
  const r = IntentValidator.validate({
    type: "trustline",
    assetCode: "USDC",
    issuer: "GUSDC",
    limit: "100",
    reason: "need USDC",
  });
  assert.equal(r.valid, false);
  assert.match(r.error!, /issuer/);
});

test("valid trustline with real 56-char Stellar key passes", () => {
  const r = IntentValidator.validate({
    type: "trustline",
    assetCode: "USDC",
    issuer: VALID_STELLAR_KEY,
    limit: "100",
    reason: "need USDC",
  });
  assert.equal(r.valid, true);
});

test("trustline with space or punctuation in assetCode fails", () => {
  const withSpace = IntentValidator.validate({
    type: "trustline",
    assetCode: "WITH SPACE",
    issuer: VALID_STELLAR_KEY,
    limit: "100",
    reason: "invalid assetCode",
  });
  assert.equal(withSpace.valid, false);
  assert.match(withSpace.error!, /assetCode/);

  const withBang = IntentValidator.validate({
    type: "trustline",
    assetCode: "ASSET!",
    issuer: VALID_STELLAR_KEY,
    limit: "100",
    reason: "invalid assetCode",
  });
  assert.equal(withBang.valid, false);
  assert.match(withBang.error!, /assetCode/);
});

test("trustline with 13-character assetCode fails", () => {
  const r = IntentValidator.validate({
    type: "trustline",
    assetCode: "ABCDEFGHIJKLM",
    issuer: VALID_STELLAR_KEY,
    limit: "100",
    reason: "too long assetCode",
  });
  assert.equal(r.valid, false);
  assert.match(r.error!, /assetCode/);
});

test("trustline with 56-character non-G issuer or bad checksum fails", () => {
  const nonG = IntentValidator.validate({
    type: "trustline",
    assetCode: "USDC",
    issuer: "S" + "A".repeat(55),
    limit: "100",
    reason: "non-G 56-char",
  });
  assert.equal(nonG.valid, false);
  assert.match(nonG.error!, /issuer/);

  const badChecksum = IntentValidator.validate({
    type: "trustline",
    assetCode: "USDC",
    issuer: "G" + "A".repeat(55),
    limit: "100",
    reason: "bad checksum 56-char",
  });
  assert.equal(badChecksum.valid, false);
  assert.match(badChecksum.error!, /issuer/);
});

test("contract_call requires contractId and function", () => {
  const r = IntentValidator.validate({
    type: "contract_call",
    contractId: "",
    function: "x",
    args: [],
    reason: "test",
  });
  assert.equal(r.valid, false);
  assert.match(r.error!, /contractId/);
});

test("unknown intent type fails", () => {
  const r = IntentValidator.validate({ type: "unknown" } as AgentIntent);
  assert.equal(r.valid, false);
  assert.match(r.error!, /Unknown/);
});
