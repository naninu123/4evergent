// Example 4 — pipeline walkthrough.
//
// TransactionPipeline chains every gate an intent must pass:
//
//   validate -> policy -> build -> simulate -> sign -> submit
//
// This script sends one intent at each gate and prints where it stops. It is
// fully offline:
//   - the signer is a throwaway random keypair (no secrets),
//   - Horizon is a fake object answering the two calls the simulator makes,
//   - LIVE_SUBMIT is forced to "0", so the submitter refuses before any
//     network call. The last intent therefore ends at the submit gate.
//
// Run: npx tsx examples/pipeline-walkthrough.ts   (after `pnpm build`)

import { Account, Keypair, type Horizon, type Transaction } from "@stellar/stellar-sdk";
import { InMemoryActivityStore, InMemoryApprovalStore } from "@4evergent/database";
import {
  StellarSimulator,
  TESTNET_HORIZON_URL,
  TESTNET_PASSPHRASE,
  TransactionPipeline,
  type PipelineOutcome,
  type Signer,
} from "@4evergent/stellar";
import type { AgentIntent } from "@4evergent/shared";

process.env.LIVE_SUBMIT = "0";

const AGENT_ID = "agent-demo";
const OWNER_ID = "owner-demo";
const DESTINATION = "GAOX7NLIVKSIKPSRVBAAFI7Q52CXEEZVOWIAEEO5CGRGYMZHUO7ZEH2L";
const SEQUENCE = "100";

// Mock signer: signs locally with a keypair generated for this run.
const keypair = Keypair.random();
const signer: Signer = {
  getAccountId: () => keypair.publicKey(),
  getNetworkPassphrase: () => TESTNET_PASSPHRASE,
  sign: async (tx: Transaction) => {
    tx.sign(keypair);
    return tx;
  },
};

// Fake Horizon: the simulator only calls fetchBaseFee() and
// accounts().accountId(id).call(). The balance is adjustable so one case can
// fail simulation on insufficient funds.
let horizonBalance = "1000";
const fakeHorizon = {
  fetchBaseFee: async () => 100,
  accounts: () => ({
    accountId: (id: string) => ({
      call: async () => ({
        id,
        sequence: SEQUENCE,
        subentry_count: 0,
        balances: [{ asset_type: "native", balance: horizonBalance }],
      }),
    }),
  }),
} as unknown as Horizon.Server;

const pipeline = new TransactionPipeline({
  horizonUrl: TESTNET_HORIZON_URL,
  networkPassphrase: TESTNET_PASSPHRASE,
  signer,
  activityStore: new InMemoryActivityStore(),
  approvalStore: new InMemoryApprovalStore(),
  policyRules: {
    maxTxAmount: { XLM: "100" },
    dailySpendingLimit: { XLM: "500" },
    requireHumanApprovalForAmountAbove: "50",
  },
});

// TransactionPipeline has no constructor option for the simulator, so swap
// in one built on the fake Horizon. StellarSimulator's second constructor
// argument is its documented test seam; the pipeline's own test suite uses
// the same field swap (packages/stellar/test/security.test.ts).
(pipeline as unknown as { simulator: StellarSimulator }).simulator = new StellarSimulator(
  TESTNET_HORIZON_URL,
  fakeHorizon,
);

// The pipeline reads agentId/ownerId off the source account and the
// transaction builder increments its sequence, so build a fresh one per run.
function sourceAccount(): Account {
  return Object.assign(new Account(keypair.publicKey(), SEQUENCE), { agentId: AGENT_ID, ownerId: OWNER_ID });
}

function payment(amount: string, destination = DESTINATION): AgentIntent {
  return { type: "payment", asset: "XLM", destination, amount, reason: "walkthrough" };
}

function print(gate: string, outcome: PipelineOutcome): void {
  console.log(`[${gate}]`);
  console.log(`  status:  ${outcome.status}`);
  console.log(`  policy:  ${outcome.policyDecision.result} (${outcome.policyDecision.rule})`);
  console.log(`  message: ${outcome.message}\n`);
}

async function main(): Promise<void> {
  console.log("=== TransactionPipeline.execute() ===\n");

  // 1. Validation: the destination is not a G... account.
  print("validate", await pipeline.execute({ intent: payment("10", "not-an-account"), sourceAccount: sourceAccount() }));

  // 2. Policy deny: over maxTxAmount.
  print("policy: deny", await pipeline.execute({ intent: payment("150"), sourceAccount: sourceAccount() }));

  // 3. Policy requires_approval: an approval record is created and the
  //    pipeline stops. Executing it later goes through executeApproved().
  print("policy: requires_approval", await pipeline.execute({ intent: payment("75"), sourceAccount: sourceAccount() }));

  // 4. Build: the address starts with G, so it passes validation and policy,
  //    but its checksum is wrong and the Stellar SDK refuses to build it.
  const badChecksum = DESTINATION.slice(0, -1) + (DESTINATION.endsWith("A") ? "B" : "A");
  print("build", await pipeline.execute({ intent: payment("10", badChecksum), sourceAccount: sourceAccount() }));

  // 5. Simulate: the fake account cannot cover the payment plus reserve.
  horizonBalance = "5";
  print("simulate", await pipeline.execute({ intent: payment("10"), sourceAccount: sourceAccount() }));
  horizonBalance = "1000";

  // 6. Sign + submit: simulation and signing succeed, then the submitter
  //    refuses because LIVE_SUBMIT is not "1". Nothing leaves this process.
  print("submit", await pipeline.execute({ intent: payment("10"), sourceAccount: sourceAccount() }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
