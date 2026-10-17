/**
 * Example 1 — Policy Evaluation
 *
 * Demonstrates how to evaluate an intent against the PolicyEngine with custom
 * rules.  Covers three outcomes:
 *   - allow               (amount within all limits)
 *   - deny (over limit)   (per-tx max exceeded)
 *   - requires_approval   (amount above the human-approval threshold)
 *
 * A fourth case shows the daily spending limit kicking in after prior
 * reservations have consumed the allowance.
 *
 * Run:  npx tsx examples/policy-evaluation.ts   (after `pnpm build`)
 */

import { PolicyEngine } from "@4evergent/policy";
import { InMemoryActivityStore } from "@4evergent/database";
import type { AgentIntent, PolicyDecision } from "@4evergent/shared";

// A valid-looking Stellar public key (G + 55 base32 chars).
const DEST = "GBDMPFEAZOQW7XVTAVPXBT7PPA4ZZW7ZFJW5KJNBYRPJ35H6ASW4ASE3";
const AGENT = "agent-001";

// Custom rules — tighten the defaults so the three outcomes are easy to see.
const rules = {
  maxTxAmount: { XLM: "100" },
  dailySpendingLimit: { XLM: "150" },
  requireHumanApprovalForAmountAbove: "50",
  allowedAssets: ["XLM"],
  txTypeRestrictions: { payment: true, trustline: true },
};

// The ActivityStore powers the daily-spending limit.  InMemory keeps
// everything in-process — no SQLite, no files.
const activityStore = new InMemoryActivityStore();
const engine = new PolicyEngine(rules, activityStore);

function payment(amount: string): AgentIntent {
  return { type: "payment", asset: "XLM", destination: DEST, amount, reason: "policy demo" };
}

function print(label: string, decision: PolicyDecision): void {
  console.log(`  ${label} → ${decision.result.padEnd(18)} rule=${decision.rule}  ${decision.reason}`);
}

console.log("=== Policy Engine — custom rules ===");
console.log("  maxTxAmount: 100 XLM | dailyLimit: 150 XLM | approvalThreshold: 50 XLM");
console.log();

// 1. Small payment — allowed.
const d1 = await engine.evaluate(payment("10"), AGENT);
print("10 XLM  (allow)", d1);

// 2. Above approval threshold but under max — requires approval.
const d2 = await engine.evaluate(payment("75"), AGENT);
print("75 XLM  (requires_approval)", d2);

// 3. Above per-tx max — denied immediately.
const d3 = await engine.evaluate(payment("200"), AGENT);
print("200 XLM (deny — over maxTxAmount)", d3);

// 4. Daily limit: prior reservations (10 + 75 = 85) leave 65 XLM.
//    A 90 XLM intent now exceeds the remaining daily allowance.
const d4 = await engine.evaluate(payment("90"), AGENT);
print("90 XLM  (deny — over daily limit)", d4);

console.log();
console.log("Daily spending reserved so far:",
  await activityStore.getDailySpending(AGENT, "XLM"), "XLM");
