import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarTransactionBuilder } from "../src/transaction-builder.js";

const PASSPHRASE = "Test SDF Network ; September 2015";

function fakeAccount(): any {
  const kp = Keypair.random();
  return {
    accountId: () => kp.publicKey(),
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  };
}

async function build(options: any): Promise<any> {
  const tx = await new StellarTransactionBuilder().buildSetOptions(fakeAccount(), options, PASSPHRASE);
  assert.equal(tx.operations.length, 1);
  assert.equal(tx.operations[0]!.type, "setOptions");
  return tx.operations[0];
}

test("setOptions: signer add", async () => {
  const key = Keypair.random().publicKey();
  const op = await build({ signer: { ed25519PublicKey: key, weight: 1 } });
  assert.equal(op.signer.ed25519PublicKey, key);
  assert.equal(op.signer.weight, 1);
});

test("setOptions: signer update", async () => {
  const key = Keypair.random().publicKey();
  const op = await build({ signer: { ed25519PublicKey: key, weight: 5 } });
  assert.equal(op.signer.weight, 5);
});

test("setOptions: signer remove (weight 0)", async () => {
  const key = Keypair.random().publicKey();
  const op = await build({ signer: { ed25519PublicKey: key, weight: 0 } });
  assert.equal(op.signer.weight, 0);
});

test("setOptions: set flags", async () => {
  const op = await build({ setFlags: 1 | 2 });
  assert.equal(op.setFlags, 3);
  assert.equal(op.clearFlags, undefined);
});

test("setOptions: clear flags", async () => {
  const op = await build({ clearFlags: 2 });
  assert.equal(op.clearFlags, 2);
  assert.equal(op.setFlags, undefined);
});

test("setOptions: threshold change and master weight; omitted fields stay unset", async () => {
  const op = await build({ masterWeight: 2, lowThreshold: 1, medThreshold: 2, highThreshold: 3 });
  assert.equal(op.masterWeight, 2);
  assert.equal(op.lowThreshold, 1);
  assert.equal(op.medThreshold, 2);
  assert.equal(op.highThreshold, 3);
  assert.equal(op.homeDomain, undefined);
  assert.equal(op.signer, undefined);
});

test("setOptions: home domain", async () => {
  const op = await build({ homeDomain: "example.com" });
  assert.equal(op.homeDomain, "example.com");
});

test("setOptions: empty options object throws", async () => {
  await assert.rejects(build({}), /at least one option/);
  await assert.rejects(build({ homeDomain: undefined }), /at least one option/);
});

test("setOptions: rejects out of range and malformed values", async () => {
  await assert.rejects(build({ lowThreshold: 256 }), /lowThreshold/);
  await assert.rejects(build({ masterWeight: -1 }), /masterWeight/);
  await assert.rejects(build({ homeDomain: "x".repeat(33) }), /homeDomain/);
  await assert.rejects(build({ inflationDest: "nope" }), /inflationDest/);
  await assert.rejects(build({ signer: { ed25519PublicKey: Keypair.random().publicKey(), weight: 300 } }), /signer.weight/);
});

test("setOptions: uses builder base fee", async () => {
  const tx = await new StellarTransactionBuilder({ baseFeeStroops: "250" }).buildSetOptions(
    fakeAccount(),
    { homeDomain: "a.io" },
    PASSPHRASE
  );
  assert.equal(tx.fee, "250");
});
