// Stellar transaction pipeline
export { StellarTransactionBuilder, resolveBaseFeeStroops, DEFAULT_BASE_FEE_STROOPS, STELLAR_BASE_FEE_ENV_VAR } from "./transaction-builder.js";
export type { StellarTransactionBuilderOptions } from "./transaction-builder.js";
export { StellarSimulator, DEFAULT_SOROBAN_RPC_URL } from "./simulator.js";
export type { SimulationOutcome } from "./simulator.js";
export { StellarSubmitter } from "./submitter.js";
export { TransactionPipeline } from "./pipeline.js";
export type { PipelineOptions, PipelineExecuteInput, PipelineOutcome, ExecuteApprovedOptions } from "./pipeline.js";

// Transaction status reconciliation
export {
  TransactionStatusReconciler,
  DEFAULT_SUBMITTED_MAX_AGE_MS,
  FAILED_ACTIVITY_AMBIGUOUS_MARKER,
} from "./reconciler.js";
export type {
  TransactionStatusProvider,
  TransactionStatus,
  ReconciliationResult,
  ReconcilerOptions,
  FailedActivityReconciliationResult,
} from "./reconciler.js";

// Stuck-approval recovery (crash between approval and submission)
export { ApprovalRecoveryService, STALE_EXECUTING_APPROVAL_MS } from "./approval-recovery.js";
export type { ApprovalRecoveryOptions, ApprovalRecoveryResult } from "./approval-recovery.js";

// Signer abstraction
export type { Signer } from "./signer.js";
export { TestnetLocalSigner } from "./testnet-local-signer.js";

// Network safety guard (Phase 21)
export { validateStellarNetwork, isLiveSubmitEnabled, TESTNET_HORIZON_URL, TESTNET_SOROBAN_RPC_URL, TESTNET_PASSPHRASE } from "./network-guard.js";
export type { NetworkValidationResult } from "./network-guard.js";

// Policy resolver (Phase 28A)
export { createPolicyResolver } from "./policy-resolver.js";
export type { PolicyResolver } from "./policy-resolver.js";
