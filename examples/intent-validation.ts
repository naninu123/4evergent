// Example 2 — intent validation.
//
// IntentValidator is the first gate in the pipeline: a structural check that
// runs before policy. It is synchronous and has no dependencies. This script
// validates a payment, a trustline, and several invalid intents, printing
// pass/fail with the validator's error message.
//
// Run: npx tsx examples/intent-validation.ts   (after `pnpm build`)

import { IntentValidator } from "@4evergent/agent-core";
import type { AgentIntent } from "@4evergent/shared";

const DESTINATION = "GAOX7NLIVKSIKPSRVBAAFI7Q52CXEEZVOWIAEEO5CGRGYMZHUO7ZEH2L";
const ISSUER = "GAWERPILE5J3CINLCOMYM6I43JEGIZFIPVMRBEMFSFUYROHIZKFU5DMJ";

const cases: Array<[label: string, intent: AgentIntent]> = [
  [
    "payment: 25.5 XLM",
    { type: "payment", asset: "XLM", destination: DESTINATION, amount: "25.5", reason: "service payment" },
  ],
  [
    "trustline: USDC",
    { type: "trustline", assetCode: "USDC", issuer: ISSUER, limit: "1000", reason: "accept USDC" },
  ],
  [
    "payment: destination is not a G... account",
    { type: "payment", asset: "XLM", destination: "not-an-account", amount: "10", reason: "bad destination" },
  ],
  [
    "payment: negative amount",
    { type: "payment", asset: "XLM", destination: DESTINATION, amount: "-5", reason: "bad amount" },
  ],
  [
    "trustline: XLM is native",
    { type: "trustline", assetCode: "XLM", issuer: ISSUER, reason: "bad trustline" },
  ],
];

console.log("=== IntentValidator.validate() ===\n");

for (const [label, intent] of cases) {
  const result = IntentValidator.validate(intent);
  console.log(`${result.valid ? "PASS" : "FAIL"}  ${label}`);
  if (!result.valid) console.log(`      error: ${result.error}`);
}
