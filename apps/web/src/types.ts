// Client-side types. This file is the web app's single import
// surface for API response types. Types that are shared with the API
// are re-exported from @4evergent/shared so they cannot drift. Only
// genuinely web-only view models are declared locally.

// --- Shared API types (source of truth: @4evergent/shared) ---
export type {
  PolicyRules,
  ActivityStatus,
  ScheduleStatus,
  ScheduleRecord,
  AuthorizationStatus,
  ApprovalStatus,
  AgentStatus,
  IntentType,
  AgentIntent,
  PolicyDecision,
  SimulationResult,
  ActivityRecord,
  ApprovalRecord,
  ExecutionStatus,
  ExecutionRecord,
  QueueSummary,
  ApiError,
} from "@4evergent/shared";

// The shared package names the agent record `Agent`; the dashboard has
// historically called it `AgentRecord`. Alias it here so page imports
// do not all change.
export type AgentRecord = import("@4evergent/shared").Agent;

// --- Web-only view models ---
// The API does not expose a dedicated request body type for these
// form submissions, so they stay local to the dashboard.

export interface SubmitPaymentIntent {
  type: "payment";
  asset: string;
  assetDetails?: {
    code: string;
    issuer: string | null;
  };
  destination: string;
  amount: string;
  reason: string;
  memo?: string;
}

export interface SubmitTrustlineIntent {
  type: "trustline";
  assetCode: string;
  issuer: string;
  limit?: string;
  reason: string;
}
