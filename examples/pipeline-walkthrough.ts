/**
 * Example 4 — Pipeline Walkthrough
 *
 * Assembles a TransactionPipeline with a mock signer and in-memory stores,
 * then runs four intents through it to show where each gate rejects:
 *
 *   Gate 1 — Intent validation   (invalid amount)
 *   Gate 2 — Policy deny          (asset not in allowlist)
 *   Gate 3 — Policy requires_approval (amount above threshold)
 *   Gate 4 — Simulation           (allow path; fails gracefully with no network)
 *
 * IMPORTANT: This example is fully OFFLINE-friendly.  The pipeline's
 * simulation gate makes a real Horizon network call (fetchBaseFee + account
 * lookup).  Without network, fetchBaseFee fails; with network, the fake
 * account's sequence won't match the on-chain sequence.  Either way the
 * pipeline catches the error and returns `simulation_failed` — this is the
 * intended, graceful behaviour and demonstrates that the simulation gate is
 * a hard stop before signing.
 *
 * No secrets, API keys, or funded accounts are required.
 *
 * Run:  npx tsx examples/pipeline-walkthrough.ts   (after `pnpm build`)
 */

import { TransactionPipeline } from "@4evergent/stellar";
import type { Signer } from "@4evergent/stellar";
import { InMemoryActivityStore, InMemoryApprovalStore } from "@4evergent/database";
import type { AgentIntent } from "@4evergent/shared";

const TESTNET = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const DEST = "GBDMPFEAZOQW7XVTAVPXBT7PPA4ZZW7ZFJW5KJNBYRPJ35H6ASW4ASE3";

/**
 * MockSigner — a fake Signer for the offline example.
 *
 * In every case below the pipeline stops BEFORE the signing gate, so
 * sign() is never called.  If it were, we throw to make the failure loud.
 */
class MockSigner implements Signer {
  getAccountId(): string {
    return DEST;
  }
  getNetworkPassphrase(): string {
    return PASSPHRASE;
  }
  // sign() is never reached in the offline example — the pipeline stops at
  // simulation.  The method exists only to satisfy the Signer interface.
  async sign(_transaction: any): Promise<any> {
    throw new Error(
      "MockSigner: signing reached — this should not happen in the offline example"
    );
  }
}

/**
 * A minimal fake source account.  The pipeline reads agentId / ownerId from
 * it and passes it to the transaction builder, which only needs accountId(),
 * sequenceNumber(), and incrementSequenceNumber().
 */
function fakeAccount(agentId: string, ownerId: string): unknown {
  return {
    accountId: () => DEST,
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
    agentId,
    ownerId,
  };
}

const activityStore = new InMemoryActivityStore();
const approvalStore = new InMemoryApprovalStore();

const pipeline = new TransactionPipeline({
  horizonUrl: TESTNET,
  networkPassphrase: PASSPHRASE,
  signer: new MockSigner(),
  activityStore,
  approvalStore,
  policyRules: {
    maxTxAmount: { XLM: "100" },
    requireHumanApprovalForAmountAbove: "50",
    allowedAssets: ["XLM"],
  },
});

function payment(amount: string, asset = "XLM"): AgentIntent {
  return { type: "payment", asset, destination: DEST, amount, reason: "pipeline demo" };
}

const src = fakeAccount("agent-001", "owner-001");

console.log("=== Pipeline Walkthrough (offline) ===\n");

// Gate 1 — Intent validation rejects a negative amount.
const r1 = await pipeline.execute({
  intent: payment("-5"),
  sourceAccount: src as any,
});
console.log("Gate 1  validation         ", r1.status);
console.log("        message:", r1.message);
console.log();

// Gate 2 — Policy denies a non-allowlisted asset.
// assetDetails is required for non-XLM assets to pass IntentValidator;
// the PolicyEngine then extracts the asset as "USDC:<issuer>" and denies
// it because only XLM is in allowedAssets.
const r2 = await pipeline.execute({
  intent: {
    type: "payment",
    asset: "USDC",
    assetDetails: { code: "USDC", issuer: "GDUWFOAXXMRMVR4A5P2FVUKWJOHMLB7CI7T6U4CUVDGAMWYKRJWHBH7H" },
    destination: DEST,
    amount: "10",
    reason: "USDC payment",
  },
  sourceAccount: src as any,
});
console.log("Gate 2  policy deny         ", r2.status);
console.log("        message:", r2.message);
console.log();

// Gate 3 — Policy requires approval for an amount above the threshold.
const r3 = await pipeline.execute({
  intent: payment("75"),
  sourceAccount: src as any,
});
console.log("Gate 3  requires_approval  ", r3.status);
console.log("        message:", r3.message);
if ("approvalId" in r3 && r3.approvalId) {
  console.log("        approvalId:", r3.approvalId);
}
console.log();

// Gate 4 — Policy allows a small payment; the pipeline proceeds to
// simulation, which fails gracefully.  Without network access, Horizon
// fetchBaseFee fails.  With network access, the fake source account's
// sequence number won't match the real on-chain sequence.  Either way,
// the simulation gate is a hard stop before signing.
const r4 = await pipeline.execute({
  intent: payment("10"),
  sourceAccount: src as any,
});
console.log("Gate 4  simulation_failed   ", r4.status);
console.log("        message:", r4.message);
console.log("        (simulation gate rejects — no funded account or network required)");
console.log();

// Verify the activity log captured every gate.
const log = await activityStore.listByAgent("agent-001", 10);
console.log("=== Activity Log ===");
for (const entry of log) {
  console.log(
    `  ${entry.id.slice(0, 8)}…  status=${entry.status.padEnd(18)}` +
    (entry.error ? `  error: ${entry.error}` : "")
  );
}
