// Example 3 — in-memory stores.
//
// ActivityStore and ApprovalStore are the persistence interfaces the pipeline
// depends on. The in-memory implementations satisfy the same contracts as the
// SQLite ones, so this script runs with no database. It:
//   1. enforces a daily spending limit with reserveDailySpending(),
//   2. records an activity and a pending approval,
//   3. moves the approval through its state machine,
//   4. queries everything back.
//
// Run: npx tsx examples/in-memory-stores.ts   (after `pnpm build`)

import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
  createActivity,
  createApproval,
  validateApprovalTransition,
} from "@4evergent/database";
import type { AgentIntent, PolicyDecision } from "@4evergent/shared";

const AGENT_ID = "agent-demo";
const OWNER_ID = "owner-demo";
const DESTINATION = "GAOX7NLIVKSIKPSRVBAAFI7Q52CXEEZVOWIAEEO5CGRGYMZHUO7ZEH2L";

async function main(): Promise<void> {
  const activities = new InMemoryActivityStore();
  const approvals = new InMemoryApprovalStore();

  // 1. Daily limit. Each reservation is an atomic check-and-commit against
  //    the agent's running total for the current UTC day.
  console.log("=== reserveDailySpending() — limit 100 XLM ===\n");
  for (const amount of ["40", "30", "50", "30"]) {
    const ok = await activities.reserveDailySpending(AGENT_ID, "XLM", amount, "100");
    const spent = await activities.getDailySpending(AGENT_ID, "XLM");
    console.log(`  reserve ${amount.padStart(2)} XLM -> ${ok ? "reserved" : "REFUSED "}  (spent today: ${spent})`);
  }

  // 2. Record an activity and the approval request it needs. This is what the
  //    pipeline does when policy returns requires_approval.
  console.log("\n=== record() an activity + approval ===\n");
  const intent: AgentIntent = {
    type: "payment",
    asset: "XLM",
    destination: DESTINATION,
    amount: "75",
    reason: "large vendor payment",
  };
  const decision: PolicyDecision = {
    result: "requires_approval",
    reason: "Amount 75 XLM requires human approval (>= 50)",
    rule: "approvalThreshold",
    intent,
  };

  const activity = createActivity(AGENT_ID, OWNER_ID, intent, decision);
  activity.status = "requires_approval";
  activity.authorizationStatus = "pending_approval";
  await activities.record(activity);

  const approval = createApproval(activity.id, AGENT_ID, OWNER_ID, intent, decision);
  await approvals.record(approval);
  console.log(`  activity ${activity.id}  status=${activity.status}`);
  console.log(`  approval ${approval.id}  status=${approval.status}`);

  // 3. Approval state machine. Invalid transitions are reported, not thrown.
  console.log("\n=== approval transitions ===\n");
  console.log(`  pending_approval -> approved : ${validateApprovalTransition("pending_approval", "approved") ?? "ok"}`);
  console.log(`  rejected         -> approved : ${validateApprovalTransition("rejected", "approved") ?? "ok"}`);
  await approvals.update(approval.id, { status: "approved", approver: OWNER_ID, approvedAt: new Date().toISOString() });

  // 4. Query back.
  console.log("\n=== query ===\n");
  const forAgent = await activities.listByAgent(AGENT_ID);
  console.log(`  activities for ${AGENT_ID}: ${forAgent.length}`);
  const pending = await approvals.listByAgent(AGENT_ID, 50, 0, "pending_approval");
  const approved = await approvals.listByAgent(AGENT_ID, 50, 0, "approved");
  console.log(`  approvals pending: ${pending.length}, approved: ${approved.length}`);
  const fetched = await approvals.getForOwner(approval.id, OWNER_ID);
  console.log(`  getForOwner(${OWNER_ID}) -> status=${fetched?.status}, approver=${fetched?.approver}`);
  const otherOwner = await approvals.getForOwner(approval.id, "someone-else");
  console.log(`  getForOwner(someone-else) -> ${otherOwner === null ? "null (owner-scoped)" : "LEAKED"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
