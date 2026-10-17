/**
 * Example 2 — Intent Validation
 *
 * Runs several intents through IntentValidator.validate() and prints
 * pass/fail with error messages.  Covers:
 *   - a valid payment
 *   - a valid trustline
 *   - an invalid payment (negative amount)
 *   - an invalid payment (missing reason)
 *   - an invalid trustline (XLM is native, cannot be a trustline)
 *   - an unknown intent type
 *
 * Run:  npx tsx examples/intent-validation.ts   (after `pnpm build`)
 */

import { IntentValidator } from "@4evergent/agent-core";
import type { AgentIntent } from "@4evergent/shared";

const DEST = "GBDMPFEAZOQW7XVTAVPXBT7PPA4ZZW7ZFJW5KJNBYRPJ35H6ASW4ASE3";
const ISSUER = "GDUWFOAXXMRMVR4A5P2FVUKWJOHMLB7CI7T6U4CUVDGAMWYKRJWHBH7H";

const cases: { label: string; intent: AgentIntent }[] = [
  {
    label: "valid payment (10 XLM)",
    intent: { type: "payment", asset: "XLM", destination: DEST, amount: "10", reason: "rent payment" },
  },
  {
    label: "valid trustline (USDC)",
    intent: { type: "trustline", assetCode: "USDC", issuer: ISSUER, limit: "1000", reason: "add USDC trustline" },
  },
  {
    label: "invalid payment — negative amount",
    intent: { type: "payment", asset: "XLM", destination: DEST, amount: "-5", reason: "bad amount" },
  },
  {
    label: "invalid payment — missing reason",
    intent: { type: "payment", asset: "XLM", destination: DEST, amount: "10", reason: "" },
  },
  {
    label: "invalid trustline — XLM is native",
    intent: { type: "trustline", assetCode: "XLM", issuer: ISSUER, reason: "XLM trustline" },
  },
  {
    label: "unknown intent type",
    // Cast required: "swap" is not a recognised AgentIntent type.
    intent: { type: "swap", asset: "XLM", destination: DEST, amount: "10", reason: "unknown" } as unknown as AgentIntent,
  },
];

console.log("=== Intent Validator ===\n");

for (const { label, intent } of cases) {
  const result = IntentValidator.validate(intent);
  if (result.valid) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}  →  ${result.error}`);
  }
}
