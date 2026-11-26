import { test } from "node:test";
import assert from "node:assert/strict";
import { IntentValidator } from "../src/index.js";
import type { AgentIntent } from "@4evergent/shared";

// A real 56-char StrKey ed25519 public key (checksum-valid). Placeholder
// addresses such as "GABCDEF" no longer pass validation.
const VALID_ACCOUNT = "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U";

const mkPayment = (over: Partial<AgentIntent> = {}): AgentIntent =>
  ({ type: "payment", asset: "XLM", destination: VALID_ACCOUNT, amount: "10", reason: "test payment", ...over }) as AgentIntent;

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

test("valid trustline passes", () => {
  const r = IntentValidator.validate({
    type: "trustline",
    assetCode: "USDC",
    issuer: VALID_ACCOUNT,
    limit: "100",
    reason: "need USDC",
  });
  assert.equal(r.valid, true);
});

// NOTE: this test previously asserted that issuer "GUSDC" (5 chars, not a
// valid Stellar address) PASSED validation. That was the bug: the validator
// only checked startsWith("G"), so the value survived until `new Asset(...)`
// rejected it at build time. It must now be rejected at the semantic gate.
test("trustline with 5-char issuer fails", () => {
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

test("trustline with space in assetCode fails", () => {
  const r = IntentValidator.validate({
    type: "trustline",
    assetCode: "WITH SPACE",
    issuer: VALID_ACCOUNT,
    reason: "need asset",
  });
  assert.equal(r.valid, false);
  assert.match(r.error!, /assetCode/);
});

test("trustline with 13-char assetCode fails", () => {
  const r = IntentValidator.validate({
    type: "trustline",
    assetCode: "ABCDEFGHIJKLM",
    issuer: VALID_ACCOUNT,
    reason: "need asset",
  });
  assert.equal(r.valid, false);
  assert.match(r.error!, /assetCode/);
});

test("trustline with punctuation in assetCode fails", () => {
  const r = IntentValidator.validate({
    type: "trustline",
    assetCode: "ASSET!",
    issuer: VALID_ACCOUNT,
    reason: "need asset",
  });
  assert.equal(r.valid, false);
  assert.match(r.error!, /assetCode/);
});

test("trustline with empty assetCode fails", () => {
  const r = IntentValidator.validate({
    type: "trustline",
    assetCode: "",
    issuer: VALID_ACCOUNT,
    reason: "need asset",
  });
  assert.equal(r.valid, false);
  assert.match(r.error!, /assetCode/);
});

test("trustline with 56-char non-G issuer fails", () => {
  const r = IntentValidator.validate({
    type: "trustline",
    assetCode: "USDC",
    issuer: "XDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
    reason: "need USDC",
  });
  assert.equal(r.valid, false);
  assert.match(r.error!, /issuer/);
});

test("trustline with 56-char bad-checksum issuer fails", () => {
  const r = IntentValidator.validate({
    type: "trustline",
    assetCode: "USDC",
    issuer: "GDUWFOAXXMRMVR4A5P2FVUKWJOHMLB7CI7T6U4CUVDGAMWYKRJWHBH7H",
    reason: "need USDC",
  });
  assert.equal(r.valid, false);
  assert.match(r.error!, /issuer/);
});

test("payment with short destination fails", () => {
  const r = IntentValidator.validate(mkPayment({ destination: "GDEST" }));
  assert.equal(r.valid, false);
  assert.match(r.error!, /Stellar/);
});

test("payment with non-native assetDetails and invalid issuer fails", () => {
  const r = IntentValidator.validate(
    mkPayment({ asset: "USDC", assetDetails: { code: "USDC", issuer: "GUSDC" } } as Partial<AgentIntent>)
  );
  assert.equal(r.valid, false);
  assert.match(r.error!, /asset/);
});

test("payment with non-native assetDetails and valid issuer passes", () => {
  const r = IntentValidator.validate(
    mkPayment({ asset: "USDC", assetDetails: { code: "USDC", issuer: VALID_ACCOUNT } } as Partial<AgentIntent>)
  );
  assert.equal(r.valid, true);
});

const VALID_CONTRACT = "CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7";

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

test("contract_call with invalid contract address format fails", () => {
  const shortResult = IntentValidator.validate({
    type: "contract_call",
    contractId: "C123",
    function: "hello",
    args: [],
    reason: "test short contract ID",
  });
  assert.equal(shortResult.valid, false);
  assert.match(shortResult.error!, /contractId/);

  const accountResult = IntentValidator.validate({
    type: "contract_call",
    contractId: VALID_ACCOUNT, // G... address is not a contract address
    function: "hello",
    args: [],
    reason: "test account instead of contract",
  });
  assert.equal(accountResult.valid, false);
  assert.match(accountResult.error!, /contractId/);

  const corruptResult = IntentValidator.validate({
    type: "contract_call",
    contractId: "CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QXX", // Bad checksum
    function: "hello",
    args: [],
    reason: "test invalid checksum",
  });
  assert.equal(corruptResult.valid, false);
  assert.match(corruptResult.error!, /contractId/);
});

test("contract_call with valid contract address passes", () => {
  const r = IntentValidator.validate({
    type: "contract_call",
    contractId: VALID_CONTRACT,
    function: "hello",
    args: ["world"],
    reason: "test valid contract call",
  });
  assert.equal(r.valid, true);
});

test("unknown intent type fails", () => {
  const r = IntentValidator.validate({ type: "unknown" } as AgentIntent);
  assert.equal(r.valid, false);
  assert.match(r.error!, /Unknown/);
});
