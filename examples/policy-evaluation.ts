// Example 1 — policy evaluation.
//
// PolicyEngine is the deterministic gate that decides whether an intent may
// proceed toward signing. This script evaluates three payments against a
// custom rule set and prints the decision for each: allow, deny (over the
// per-transaction limit), and requires_approval (at/above the threshold).
//
// Run: npx tsx examples/policy-evaluation.ts   (after `pnpm build`)

import { PolicyEngine, type PolicyRules } from "@4evergent/policy";
import type { AgentIntent, PolicyDecision } from "@4evergent/shared";

const DESTINATION = "GAOX7NLIVKSIKPSRVBAAFI7Q52CXEEZVOWIAEEO5CGRGYMZHUO7ZEH2L";

// Any field left out falls back to DEFAULT_RULES (see normalizePolicyRules).
const rules: Partial<PolicyRules> = {
  maxTxAmount: { XLM: "100" },
  requireHumanApprovalForAmountAbove: "50",
  allowedAssets: ["XLM"],
  txTypeRestrictions: { payment: true, trustline: true, contract_call: false, account_settings: false },
};

function payment(amount: string): AgentIntent {
  return { type: "payment", asset: "XLM", destination: DESTINATION, amount, reason: "example payment" };
}

function print(label: string, decision: PolicyDecision): void {
  console.log(`${label}`);
  console.log(`  result: ${decision.result}`);
  console.log(`  rule:   ${decision.rule}`);
  console.log(`  reason: ${decision.reason}\n`);
}

async function main(): Promise<void> {
  console.log("=== PolicyEngine.evaluate() ===\n");

  // No ActivityStore is passed, so the daily spending check is skipped —
  // see in-memory-stores.ts for that gate.
  const engine = new PolicyEngine(rules);

  print("1. payment 10 XLM (within limits)", await engine.evaluate(payment("10"), "agent-1"));
  print("2. payment 150 XLM (over maxTxAmount 100)", await engine.evaluate(payment("150"), "agent-1"));
  print("3. payment 75 XLM (>= approval threshold 50)", await engine.evaluate(payment("75"), "agent-1"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
