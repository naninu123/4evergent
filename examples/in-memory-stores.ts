/**
 * Example 3 — In-Memory Stores
 *
 * Uses InMemoryActivityStore and InMemoryApprovalStore to record activities,
 * enforce a daily spending limit via reserveDailySpending, and query data
 * back — all without SQLite or any persistent storage.
 *
 * Run:  npx tsx examples/in-memory-stores.ts   (after `pnpm build`)
 */

import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
  createActivity,
  createApproval,
} from "@4evergent/database";
import type { AgentIntent, PolicyDecision } from "@4evergent/shared";

const DEST = "GBDMPFEAZOQW7XVTAVPXBT7PPA4ZZW7ZFJW5KJNBYRPJ35H6ASW4ASE3";
const AGENT = "agent-001";
const OWNER = "owner-001";

const activityStore = new InMemoryActivityStore();
const approvalStore = new InMemoryApprovalStore();

// ---- Activity store --------------------------------------------------

const intent: AgentIntent = {
  type: "payment",
  asset: "XLM",
  destination: DEST,
  amount: "10",
  reason: "demo payment",
};

const decision: PolicyDecision = {
  result: "allow",
  reason: "All policy checks passed",
  rule: "default",
  intent,
};

// createActivity gives a well-formed record in "pending" state.
const record = createActivity(AGENT, OWNER, intent, decision);
record.status = "submitted"; // mark as if the pipeline completed
await activityStore.record(record);
console.log("=== Activity Store ===");
console.log(`  Recorded activity ${record.id} (status=${record.status})`);

// Query it back by id …
const found = await activityStore.get(record.id);
console.log(`  get()              → id=${found?.id}, status=${found?.status}`);

// … and by agent.
const byAgent = await activityStore.listByAgent(AGENT, 10);
console.log(`  listByAgent()      → ${byAgent.length} record(s) for ${AGENT}`);

// ---- Daily spending limit --------------------------------------------

console.log("\n=== Daily Spending Limit (reserveDailySpending) ===");

const ok = await activityStore.reserveDailySpending(AGENT, "XLM", "30", "50");
console.log(`  Reserve 30 XLM against limit 50  → ${ok}   (total: 30)`);

const over = await activityStore.reserveDailySpending(AGENT, "XLM", "30", "50");
console.log(`  Reserve 30 XLM against limit 50  → ${over}  (30 + 30 = 60 > 50, denied)`);

const spent = await activityStore.getDailySpending(AGENT, "XLM");
console.log(`  getDailySpending()               → ${spent} XLM reserved today`);

// ---- Approval store --------------------------------------------------

console.log("\n=== Approval Store ===");

const approval = createApproval(record.id, AGENT, OWNER, intent, decision);
await approvalStore.record(approval);
console.log(`  Recorded approval ${approval.id} (status=${approval.status})`);

const foundApproval = await approvalStore.get(approval.id);
console.log(`  get()  → id=${foundApproval?.id}, status=${foundApproval?.status}`);

const approvalsByAgent = await approvalStore.listByAgent(AGENT, 10);
console.log(`  listByAgent() → ${approvalsByAgent.length} approval(s) for ${AGENT}`);

// ---- Simulate approval lifecycle --------------------------------------

console.log("\n=== Approval Lifecycle ===");
const updated = await approvalStore.update(approval.id, {
  status: "approved",
  approvedAt: new Date().toISOString(),
  approver: "human-001",
});
console.log(`  After approve → status=${updated?.status}, approver=${updated?.approver}`);

const rejected = await approvalStore.update(approval.id, {
  status: "rejected",
  rejectedAt: new Date().toISOString(),
});
console.log(`  After reject  → status=${rejected?.status}`);
