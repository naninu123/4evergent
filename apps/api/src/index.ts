import { createServer } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { log, generateRequestId, runRequestIdContext } from "./logging.js";
import type {
  ActivityStatus,
  AgentIntent,
  AuthorizationStatus,
  PolicyDecision,
  ScheduleStatus,
  SimulationResult,
} from "@4evergent/shared";
import { toStroops, fromStroops } from "@4evergent/shared";
import { API_ERRORS, type ApiErrorCode } from "./error-codes.js";
import { IntentValidator } from "@4evergent/agent-core";
import { PolicyEngine, DEFAULT_RULES, validatePolicyRules, normalizePolicyRules, parseStrictAmount } from "@4evergent/policy";
import { StellarAdapter } from "@4evergent/agent-core";
import { TransactionPipeline } from "@4evergent/stellar";
import type { Signer } from "@4evergent/stellar";
import { AgentScheduler } from "./scheduler.js";
import { ScheduleExecutionService } from "./schedule-execution.js";
import { ExecutionQueue } from "./execution-queue.js";
import type { PreCheckFn } from "./execution-queue.js";
import { ExecutionRecoveryService } from "./execution-recovery.js";
import { ScheduleRecoveryService } from "./schedule-recovery.js";
import { TransactionStatusReconciler, ApprovalRecoveryService, DEFAULT_SUBMITTED_MAX_AGE_MS } from "@4evergent/stellar";
import { AccountSequenceCoordinator } from "./account-sequence-coordinator.js";
import type { ExecutionRecord, ScheduleRecord } from "@4evergent/database";
import type { ScheduleExecutionResult } from "./schedule-execution.js";
import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
  InMemoryScheduleStore,
  InMemoryExecutionStore,
  InMemoryAgentStore,
  InMemoryPolicyConfigStore,
  SQLiteActivityStore,
  SQLiteApprovalStore,
  SQLiteScheduleStore,
  SQLiteExecutionStore,
  SQLiteAgentStore,
  MAX_LIMIT,
  SQLitePolicyConfigStore,
  assertNoSecrets,
  validateApprovalTransition,
  closeSharedConnection,
  ResourceAuthorizationService,
  classifyPipelineOutcome,
  classifyError,
  type AuthorizationContext,
  type ActivityStore,
  type ApprovalStore,
  type ScheduleStore,
  type ExecutionStore,
  type AgentStore,
  type ApprovalStatus,
  type ActivityRecord,
  type PolicyConfigStore,
  createActivity,
  isOffsetAtCeiling,
  clampOffset,
  getSharedConnection,
  getSchemaVersion,
  resolveIdempotencyWindowMs,
} from "@4evergent/database";
import type { PolicyRules, Agent, RequestContext, AuthorizationService, AuthProvider, AuthenticatedPrincipal } from "@4evergent/shared";
import { createAuthModule, type PrincipalResolution } from "./auth.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import { sweepRetainedData } from "./data-retention.js";

const require = createRequire(import.meta.url);
export const API_VERSION: string = (require("../package.json") as { version: string }).version;

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * #359: age threshold above which an `executing` execution counts as
 * "stuck" on the Overview Needs Attention table. A younger in-flight
 * execution is healthy, not stuck. The predicate is strictly
 * `startedAt < (now - STUCK_EXECUTION_THRESHOLD_MS)`, so a startedAt
 * exactly at the cutoff is NOT yet stuck.
 *
 * Exported so tests can build fixtures at the exact boundary without
 * duplicating the numeric literal (drift between test and prod would
 * recreate the very bug this constant exists to prevent).
 */
export const STUCK_EXECUTION_THRESHOLD_MS = 10 * 60_000;

/**
 * #261: defaults for the per-owner rate limit on the authenticated,
 * money-moving endpoints (intent submission, approve, reject). Same shape
 * as the auth credential-endpoint limit, but a higher budget: these
 * endpoints serve legitimate automation, so the default allows a burst of
 * 60 requests per owner per minute. Override with the `rateLimit` server
 * option (`API_RATE_LIMIT_*` env vars in server.ts).
 */
export const DEFAULT_API_RATE_LIMIT_MAX = 60;
export const DEFAULT_API_RATE_LIMIT_WINDOW_SECONDS = 60;
export const DEFAULT_API_RATE_LIMIT_MAX_KEYS = 10_000;

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

interface IntentResponse {
  activityId: string;
  agentId: string;
  status: string;
  policyDecision: PolicyDecision | null;
  authorizationStatus: AuthorizationStatus;
  simulationResult: SimulationResult | null;
  txHash: string | null;
  error: string | null;
  approvalId?: string;
}

interface ApprovalResponse {
  approvalId: string;
  activityId: string;
  agentId: string;
  status: ApprovalStatus;
  message: string;
}

const agents = new Map<string, Agent>();

// Validation caps for agent metadata (#84). The capability bounds mirror the
// on-chain agent-registry contract (contracts/agent-registry/src/lib.rs:
// MAX_CAPABILITIES, MAX_CAPABILITY_LEN); displayName/description match the
// POST /agents handler.
const MAX_AGENT_DISPLAY_NAME_LEN = 100;
const MAX_AGENT_DESCRIPTION_LEN = 500;
const MAX_AGENT_CAPABILITY_COUNT = 32;
const MAX_AGENT_CAPABILITY_LEN = 32;
const MUTABLE_AGENT_FIELDS: ReadonlySet<string> = new Set([
  "displayName",
  "description",
  "capabilities",
]);

export { ScheduleRecoveryService, type ScheduleRecoveryResult, type ScheduleRecoveryOptions } from "./schedule-recovery.js";

export function clearAgents() {
  agents.clear();
}

const APPROVAL_STATUSES = [
  "pending_approval",
  "approved",
  "rejected",
  "expired",
  "executing",
  "submitted",
  "confirmed",
  "failed",
] as const satisfies readonly ApprovalStatus[];

const SCHEDULE_STATUSES = ["active", "paused", "disabled"] as const satisfies readonly ScheduleStatus[];

const ACTIVITY_STATUSES = [
  "pending",
  "rejected",
  "requires_approval",
  "approved",
  "signed",
  "submitted",
  "failed",
] as const satisfies readonly ActivityStatus[];

function parseStatusFilter<T extends string>(
  raw: string | null,
  valid: readonly T[]
): { ok: true; status?: T } | { ok: false; error: string } {
  if (raw === null) return { ok: true };
  if ((valid as readonly string[]).includes(raw)) {
    return { ok: true, status: raw as T };
  }
  return {
    ok: false,
    error: `invalid status '${raw}'; valid values: ${valid.join(", ")}`,
  };
}

export interface ServerOptions {
  port: number;
  horizonUrl: string;
  sorobanRpcUrl?: string;
  signer: Signer;
  policyRules?: Partial<PolicyRules>;
  activityStore?: ActivityStore;
  approvalStore?: ApprovalStore;
  scheduleStore?: ScheduleStore;
  dbPath?: string;
  deferExecution?: boolean;
  authProvider?: AuthProvider;
  /** Origin allowed for credentialed CORS (the browser app origin). */
  corsOrigin?: string;
  authorizationService?: AuthorizationService;
  /** Readiness probes share one bounded, briefly cached dependency check. */
  readiness?: {
    timeoutMs?: number;
    cacheMs?: number;
    fetcher?: typeof globalThis.fetch;
  };
  /** Enable the background scheduler to execute due schedules. */
  scheduler?: {
    enabled?: boolean;
    intervalMs?: number;
    maxLatenessMs?: number;
    /** Inject a custom scheduler (e.g. for testing). */
    instance?: AgentScheduler;
  };
  /** Execution store — defaults to SQLite if dbPath provided, else in-memory. */
  executionStore?: ExecutionStore;
  /** Agent store — defaults to SQLite if dbPath provided, else in-memory. */
  agentStore?: AgentStore;
  /** Policy configuration store — defaults to SQLite if dbPath provided, else in-memory. */
  policyConfigStore?: import("@4evergent/database").PolicyConfigStore;
  /** Enable the persistent execution queue (opt-in). */
  executionQueue?: {
    enabled?: boolean;
    intervalMs?: number;
    concurrency?: number;
    instance?: ExecutionQueue;
  };
  /** User authentication module (sessions: email / Google / Stellar wallet). */
  authModule?: ReturnType<typeof createAuthModule>;
  /**
   * #261: per-owner rate limiting for the authenticated intent and
   * approval-action endpoints (POST /agents/:id/intents, approve, reject).
   * Same `{ maxAttempts, windowSeconds, maxKeys }` shape as the auth
   * module's credential-endpoint limit; each endpoint gets its own limiter
   * instance so one endpoint's traffic cannot lock an owner out of another.
   * Defaults: 60 attempts / 60s / 10000 keys (see DEFAULT_API_RATE_LIMIT_*).
   */
  rateLimit?: {
    /** Attempts allowed per window, per owner. Default 60. */
    maxAttempts?: number;
    /** Window length in seconds. Default 60. */
    windowSeconds?: number;
    /** Hard cap on tracked owners. Default 10000. */
    maxKeys?: number;
  };
  /**
   * #109: Idempotency-Key replay window in ms (default 24 hours). Applies to
   * the activity store this server creates; an injected `activityStore`
   * keeps its own window. Also bounds the retention sweep's key release.
   */
  idempotencyKeyWindowMs?: number;
  /** Periodic cleanup of expired browser sessions and old daily-spending reservations. */
  retention?: {
    enabled?: boolean;
    intervalMs?: number;
    authSessionDays?: number;
    dailySpendingDays?: number;
  };
  /** Enable on-chain transaction status reconciliation (opt-in). */
  reconciliation?: {
    enabled?: boolean;
    intervalMs?: number;
    /** Max age of a `submitted` execution still `not_found` before it is retired to `failed`. */
    maxAgeMs?: number;
    instance?: import("@4evergent/stellar").TransactionStatusReconciler;
  };
  /** Recover approvals stuck in `executing` after a crash (#376).
   *  Runs once at startup when the execution queue is enabled and, when
   *  reconciliation is enabled, sweeps periodically on the same lifecycle.
   *  The on-chain check uses the Horizon adapter, so no extra config is
   *  needed; pass `instance` to inject a custom service (e.g. for testing). */
  approvalRecovery?: {
    intervalMs?: number;
    staleAfterMs?: number;
    instance?: import("@4evergent/stellar").ApprovalRecoveryService;
  };
}

export async function createApiServer(options: ServerOptions) {
  const store: ActivityStore =
    options.activityStore ??
    (options.dbPath
      ? new SQLiteActivityStore(options.dbPath, { idempotencyWindowMs: options.idempotencyKeyWindowMs })
      : new InMemoryActivityStore({ idempotencyWindowMs: options.idempotencyKeyWindowMs }));
  const approvals: ApprovalStore =
    options.approvalStore ??
    (options.dbPath ? new SQLiteApprovalStore(options.dbPath) : new InMemoryApprovalStore());
  const schedules: ScheduleStore =
    options.scheduleStore ??
    (options.dbPath ? new SQLiteScheduleStore(options.dbPath) : new InMemoryScheduleStore());
  const agentStore: AgentStore =
    options.agentStore ??
    (options.dbPath ? new SQLiteAgentStore(options.dbPath) : new InMemoryAgentStore());

  // Phase 28A: Policy configuration store (agent-scoped)
  const policyConfigStore: PolicyConfigStore =
    options.policyConfigStore ??
    (options.dbPath ? new SQLitePolicyConfigStore(options.dbPath) : new InMemoryPolicyConfigStore());

  const defaultAuthzCtx: AuthorizationContext = {
    activityStore: store,
    approvalStore: approvals,
    scheduleStore: schedules,
    agents: agents as Map<string, { id: string; ownerId: string }>,
  };
  const authorizationService: AuthorizationService =
    options.authorizationService ?? new ResourceAuthorizationService(defaultAuthzCtx);

  // Phase 28K-1: Authentication Boundary
  // USER AUTH (session cookie) is resolved by the authModule when provided;
  // the bearer AuthProvider remains the machine/API-key fallback.
  const authProvider = options.authProvider;
  const authModule = options.authModule ?? null;

  // #261: per-owner rate limiting for the authenticated, money-moving
  // endpoints. One limiter instance per endpoint (same pattern as the auth
  // module's per-endpoint limiters) so intent traffic cannot lock an owner
  // out of approve/reject, or vice versa. Keyed by ownerId, never global
  // across owners. The gate runs before body parsing so floods are shed
  // early, like the auth credential gate.
  const apiRateLimitConfig = {
    maxAttempts: positiveNumber(options.rateLimit?.maxAttempts, DEFAULT_API_RATE_LIMIT_MAX),
    windowMs: positiveNumber(options.rateLimit?.windowSeconds, DEFAULT_API_RATE_LIMIT_WINDOW_SECONDS) * 1000,
    maxKeys: positiveNumber(options.rateLimit?.maxKeys, DEFAULT_API_RATE_LIMIT_MAX_KEYS),
  };
  const intentLimiter = new SlidingWindowRateLimiter(apiRateLimitConfig);
  const approveLimiter = new SlidingWindowRateLimiter(apiRateLimitConfig);
  const rejectLimiter = new SlidingWindowRateLimiter(apiRateLimitConfig);

  /**
   * Check the per-owner limit for one endpoint. Returns true when the
   * request may proceed (and records the attempt), or false after writing
   * a 429 with a Retry-After header and the standard `{ code, error }`
   * envelope when the limit is exceeded.
   */
  function rateLimitGate(limiter: SlidingWindowRateLimiter, ctx: RequestContext, res: any): boolean {
    const key = `owner:${ctx.ownerId}`;
    const decision = limiter.check(key);
    if (decision.limited) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(decision.retryAfterSeconds) });
      res.end(JSON.stringify({ code: "RATE_LIMITED", error: API_ERRORS.RATE_LIMITED.message }));
      return false;
    }
    limiter.record(key);
    return true;
  }
  const als = new AsyncLocalStorage<RequestContext>();

  async function authenticateRequest(req: any, method: string): Promise<PrincipalResolution> {
    if (authModule) {
      return authModule.authenticate(req, method);
    }
    if (!authProvider) return { principal: null, via: null, csrfFail: false };
    const principal = await authProvider.authenticate({
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    return { principal, via: principal ? "fallback" : null, csrfFail: false };
  }

  function principalToContext(principal: AuthenticatedPrincipal | null): RequestContext {
    if (principal) {
      return { principal, ownerId: principal.ownerId };
    }
    return { principal: null, ownerId: null };
  }

  // Phase 28K-2: No Proxy. All handlers receive ctx explicitly.
  // Any remaining `ctx` usage will fail loudly in development.
  void als;

  // Phase 28A: Create policy resolver that loads agent-specific rules
  // Falls back to DEFAULT_RULES if no custom policy exists for the agent
  const getRules = async (agentId: string): Promise<PolicyRules> => {
    const custom = await policyConfigStore.get(agentId);
    // If agent has persisted policy, use it (highest precedence).
    // Otherwise, deep-merge startup options.policyRules over DEFAULT_RULES
    // so nested fields (maxTxAmount, dailySpendingLimit, txTypeRestrictions)
    // are properly combined rather than overwritten.
    return custom ?? normalizePolicyRules(options.policyRules ?? {});
  };

  const pipeline = new TransactionPipeline({
    horizonUrl: options.horizonUrl,
    sorobanRpcUrl: options.sorobanRpcUrl,
    networkPassphrase: TESTNET_PASSPHRASE,
    signer: options.signer,
    activityStore: store,
    approvalStore: approvals,
    policyRules: options.policyRules,
    policyResolver: getRules,
    agentResolver: async (agentId: string) => {
      const dbAgent = await agentStore.get(agentId);
      if (dbAgent) return dbAgent;
      return agents.get(agentId);
    },
  });

  // Phase 28J: PolicyEngine in API uses the SAME resolver
  const policy = new PolicyEngine(options.policyRules, store as any, getRules);

  /**
   * Release the daily-spending reservation recorded on a policy decision
   * (#353). No-op when the decision reserved nothing. Used by handlers for
   * the paths the pipeline never runs (source-account load failure,
   * approval reject/expiry), where the pipeline's own release cannot fire.
   */
  async function releaseDecisionReservation(agentId: string, decision: PolicyDecision | null | undefined): Promise<void> {
    const reserved = decision?.reservedDailySpending;
    if (!reserved) return;
    try {
      await store.releaseDailySpending(agentId, reserved.asset, reserved.amount);
    } catch {
      // Best-effort bookkeeping; the stale row is swept at the day boundary.
    }
  }

  /**
   * Per-key in-flight lock (#371). Serializes intent handling per
   * (owner, agent, Idempotency-Key) for the whole request duration.
   *
   * WHY A LOCK, NOT AN EARLY PENDING RECORD: recording a pending activity
   * before policy evaluation would need a placeholder decision (the real
   * one does not exist yet), and that placeholder would leak into the
   * activity log if evaluation then denied. The lock instead makes the
   * second concurrent request wait, then hit the pre-check in
   * handleIntentExecute and replay the first request's record — so it
   * never evaluates policy and never reserves daily spending a second
   * time, composing cleanly with #353's single-reservation rule.
   *
   * SCOPE: one server process. Requests without a key bypass the lock
   * entirely. Cross-process duplicates (two server instances sharing one
   * SQLite file) still rely on the store-level `recordIdempotent` atomic
   * reservation plus the pipeline's no-overwrite rule (#371 defense in
   * depth); the lock is the guard for the single-process deployment this
   * server runs as.
   */
  const idempotencyLocks = new Map<string, Promise<void>>();
  async function withIdempotencyKeyLock<T>(scopeKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = idempotencyLocks.get(scopeKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => current);
    idempotencyLocks.set(scopeKey, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (idempotencyLocks.get(scopeKey) === chained) idempotencyLocks.delete(scopeKey);
    }
  }
  const adapter = new StellarAdapter(options.horizonUrl);

  const readinessTimeoutMs = options.readiness?.timeoutMs ?? 2_000;
  const readinessCacheMs = options.readiness?.cacheMs ?? 5_000;
  for (const [name, value] of Object.entries({ readinessTimeoutMs, readinessCacheMs })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
  type DependencyChecks = { horizon: "ok" | "fail"; database: "ok" | "fail" };
  let readinessCache: { checks: DependencyChecks; expiresAt: number } | null = null;
  let readinessInFlight: Promise<DependencyChecks> | null = null;
  // A check that ignores its abort signal keeps running after it times out.
  // Later probes wait on that same call instead of starting another, so a hung
  // dependency holds at most one outstanding call per check, however many
  // probes arrive.
  const outstandingChecks = new Map<string, { work: Promise<unknown>; controller: AbortController }>();

  async function boundedCheck(name: string, check: (signal: AbortSignal) => Promise<unknown>): Promise<"ok" | "fail"> {
    let entry = outstandingChecks.get(name);
    if (!entry) {
      const controller = new AbortController();
      const work = Promise.resolve().then(() => check(controller.signal));
      const started = { work, controller };
      const settle = () => {
        if (outstandingChecks.get(name) === started) outstandingChecks.delete(name);
      };
      work.then(settle, settle);
      outstandingChecks.set(name, started);
      entry = started;
    }
    const { work, controller } = entry;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Readiness check timed out"));
          }, readinessTimeoutMs);
        }),
      ]);
      return "ok";
    } catch {
      // Public responses expose status only, never dependency errors or records.
      return "fail";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function dependencyReadiness(): Promise<DependencyChecks> {
    if (readinessCache && Date.now() < readinessCache.expiresAt) {
      return Promise.resolve(readinessCache.checks);
    }
    if (readinessInFlight) return readinessInFlight;
    readinessInFlight = (async () => {
      const [horizon, database] = await Promise.all([
        boundedCheck("horizon", async signal => {
          const fetcher = options.readiness?.fetcher ?? globalThis.fetch;
          const probeAdapter = new StellarAdapter(options.horizonUrl,
            (input, init) => fetcher(input, { ...init, signal }));
          await probeAdapter.getNetworkInfo();
        }),
        boundedCheck("database", async () => {
          // Exercise the actual configured stores, including injected/in-memory
          // stores, rather than a new connection that could hide a broken handle.
          await Promise.all([
            store.listAll(1), approvals.listAll(1),
            schedules.listByOwner("", 1), executionStore.listByOwner("", 1),
            agentStore.listByOwner("", 1), policyConfigStore.listByOwner(""),
          ]);
        }),
      ]);
      const checks = { horizon, database };
      readinessCache = { checks, expiresAt: Date.now() + readinessCacheMs };
      return checks;
    })().finally(() => { readinessInFlight = null; });
    return readinessInFlight;
  }

  // Phase 28I: Agent existence check with persistent fallback.
  // Mirrors ResourceAuthorizationService.resolveAgent so handlers can find
  // agents that survive a server restart (present in agentStore but not in
  // the session-scoped in-memory `agents` Map).
  async function agentExists(agentId: string): Promise<boolean> {
    if (agents.has(agentId)) return true;
    const dbAgent = await agentStore.get(agentId);
    if (dbAgent) {
      agents.set(agentId, dbAgent);
      return true;
    }
    return false;
  }

  // --- Account sequence coordinator (Phase 25) ---
  // Serializes sequence-sensitive execution for the SAME Stellar source account.
  // Different accounts remain concurrent.
  const sequenceCoordinator = new AccountSequenceCoordinator();

  // --- Execution queue setup ---
  const executionStore: ExecutionStore =
    options.executionStore ??
    (options.dbPath ? new SQLiteExecutionStore(options.dbPath) : new InMemoryExecutionStore());

  // --- Execution recovery setup ---
  // #379: ONE shared pre-check mapping, used by BOTH the execution queue
  // (which covers the manual retry path) and the execution recovery service —
  // no more duplicated three-line collapses. It carries the FULL on-chain
  // transaction status through instead of collapsing `confirmed` and `failed`
  // into a single "found" verdict. getTransactionStatus already distinguishes
  // the cases (confirmed / failed / not_found / network_error), so the mapping
  // is a direct passthrough and the call sites branch on the real status:
  //   confirmed → never re-submit (move to submitted for reconciliation)
  //   failed    → definitively dead, safe to retry with a NEW transaction
  //   not_found → never landed, safe to retry
  //   network_error → ambiguous, do not blind retry
  const preCheck: PreCheckFn = (txHash: string) =>
    adapter.getTransactionStatus(txHash);
  const recoveryService = new ExecutionRecoveryService(executionStore, {
    preCheck,
  });
  let executionQueue: ExecutionQueue | null = null;
  let reconciler: import("@4evergent/stellar").TransactionStatusReconciler | null = null;

  // Run crash recovery BEFORE starting the queue worker.
  if (options.executionQueue?.enabled) {
    try {
      const recoveryResult = await recoveryService.recover();
      if (recoveryResult.found > 0) {
        console.log(
          `[execution-recovery] recovered ${recoveryResult.recovered}/${recoveryResult.found} stuck executions`
        );
      }
    } catch (err) {
      console.error("[execution-recovery] recovery failed:", err);
    }
  }

  // --- Stuck-approval recovery setup (#376) ---
  // Same crash window as executions, one level up: an approval left in
  // `executing` (process died between approval and submission) never reaches
  // a terminal state on its own. Recover once at startup (before the queue
  // worker starts, so a recovered approval is never executed twice) and
  // sweep periodically while the server runs. The on-chain check reuses the
  // Horizon adapter; without a stored hash the approval is failed with an
  // explicit "could not verify" error (see ApprovalRecoveryService).
  const approvalRecovery: import("@4evergent/stellar").ApprovalRecoveryService =
    options.approvalRecovery?.instance ??
    new ApprovalRecoveryService(approvals, store, {
      getStatus: (txHash: string) => adapter.getTransactionStatus(txHash),
    }, {
      intervalMs: options.approvalRecovery?.intervalMs,
      staleAfterMs: options.approvalRecovery?.staleAfterMs,
    });
  if (options.executionQueue?.enabled) {
    try {
      const approvalRecoveryResult = await approvalRecovery.recover();
      if (approvalRecoveryResult.found > 0) {
        console.log(
          `[approval-recovery] recovered ${approvalRecoveryResult.recovered}/${approvalRecoveryResult.found} stuck approvals`
        );
      }
    } catch (err) {
      console.error("[approval-recovery] recovery failed:", err);
    }
  }

  // --- Transaction status reconciliation setup ---
  if (options.reconciliation?.enabled) {
    const statusProvider: import("@4evergent/stellar").TransactionStatusProvider = {
      getStatus: (txHash: string) => adapter.getTransactionStatus(txHash),
    };
    reconciler =
      options.reconciliation.instance ??
      new TransactionStatusReconciler(executionStore, statusProvider, {
        intervalMs: options.reconciliation.intervalMs,
        maxAgeMs: options.reconciliation.maxAgeMs,
        // #276: release the daily-spending reservation of a retired
        // execution, when the record proves one was made (#353).
        // #363: sync on-chain failure to linked activity and approval.
        activityStore: store,
        approvalStore: approvals,
      });
    reconciler.start();
    console.log("[reconciler] started, interval:", options.reconciliation.intervalMs ?? 30_000, "ms");
    // Periodic stuck-approval sweep rides on the reconciliation lifecycle.
    approvalRecovery.start();
    console.log("[approval-recovery] started, interval:", options.approvalRecovery?.intervalMs ?? 60_000, "ms");
    console.log("[reconciler] not_found max age:", options.reconciliation.maxAgeMs ?? DEFAULT_SUBMITTED_MAX_AGE_MS, "ms");
  }

  if (options.executionQueue?.enabled) {
    const getSourceAccount = async () => {
      const account = await adapter.getAccount(options.signer.getAccountId());
      return {
        accountId: () => account.address,
        sequenceNumber: () => account.sequence,
        incrementSequenceNumber: () => {},
      };
    };

    const pipelineExecutor = async (
      record: ExecutionRecord,
      context?: import("./execution-queue.js").ExecutionContext
    ) => {
      // Incident-response boundary: Check agent status before acquiring lock / submitting.
      // An execution queued (or retried) while an agent was active must NOT execute
      // or submit to Horizon if the agent has since been paused or disabled.
      const agent = (await agentStore.get(record.agentId)) ?? agents.get(record.agentId);
      if (agent && agent.status !== "active") {
        const agentStatus = agent.status;
        const message = `agent is ${agentStatus}; queued execution rejected`;
        if (record.approvalId) {
          await approvals.update(record.approvalId, { status: "failed", error: message });
          const app = await approvals.get(record.approvalId);
          if (app) {
            await releaseDecisionReservation(app.agentId, app.policyDecision);
          }
        }
        if (record.activityId) {
          const act = await store.get(record.activityId);
          if (act) {
            await store.update(record.activityId, { status: "failed", error: message });
          }
        }
        return {
          record,
          success: false,
          status: "rejected",
          error: message,
          errorClass: "permanent" as const,
          txHash: undefined,
          submittedHash: null,
          activityId: record.activityId ?? undefined,
        };
      }
      // Phase 25: Wrap sequence-sensitive execution in account-scoped lock.
      //
      // WHY: Two concurrent executions using the SAME Stellar source account
      // could read the same Horizon sequence and build transactions with the
      // same sequence number. One would fail at Horizon with "unexpected
      // sequence". The lock serializes the critical section (read sequence →
      // build → simulate → sign → submit) per Stellar account.
      //
      // The coordination key is the signer's Stellar public key (G...), which
      // is stable per server instance. All executions through this API server
      // share the same signer → same Stellar account → serialized. Different
      // server instances (different signers) are not affected.
      //
      // getSourceAccount() is called INSIDE the lock to prevent the race where
      // two executions read the same sequence before either acquires the lock.
      const accountId = options.signer.getAccountId();
      return sequenceCoordinator.runExclusive(accountId, async () => {
        if (context?.signal?.aborted) {
          const err = new Error("Execution was cancelled");
          err.name = "AbortError";
          throw err;
        }
        try {
          // #275: records carrying an approvalId must go through
          // executeApproved(), not execute(). execute() re-evaluates policy,
          // sees requires_approval again, and creates a DUPLICATE approval —
          // so an approved intent could never be submitted on the default
          // queue path. Records without an approvalId (scheduler, manual)
          // keep using execute().
          let outcome: Awaited<ReturnType<typeof pipeline.executeApproved>>;
          if (record.approvalId) {
            const approval = await approvals.get(record.approvalId);
            if (approval && (approval.status === "expired" || (approval.expiresAt && new Date(approval.expiresAt) < new Date()))) {
              return {
                record,
                success: false,
                status: "failed",
                error: "approval expired without decision",
                errorClass: "permanent",
                activityId: approval.activityId ?? record.activityId ?? undefined,
                approvalId: record.approvalId,
                policyDecision: approval.policyDecision,
              };
            }
            if (approval && approval.status === "pending_approval") {
              return {
                record,
                success: false,
                status: "requires_approval",
                error: approval.policyDecision?.reason ?? "requires approval",
                activityId: approval.activityId ?? record.activityId ?? undefined,
                approvalId: record.approvalId,
                policyDecision: approval.policyDecision,
              };
            }
            outcome = await pipeline.executeApproved(record.approvalId, undefined, {
              signal: context?.signal,
              onBeforeSubmit: () => {
                context?.onBeforeSubmit?.();
              },
            });
          } else {
            // #351: if an approval is already pending for this activity, do not duplicate
            if (record.activityId) {
              const pendingApprovals = await approvals.listByAgent(record.agentId, 50, 0, "pending_approval");
              const existingApproval = pendingApprovals.find((a) => a.activityId === record.activityId);
              if (existingApproval) {
                return {
                  record,
                  success: false,
                  status: "requires_approval",
                  error: existingApproval.policyDecision?.reason ?? "requires approval",
                  activityId: record.activityId,
                  approvalId: existingApproval.id,
                  policyDecision: existingApproval.policyDecision,
                };
              }
            }

            const baseSourceAccount = await getSourceAccount();
            const sourceAccount = {
              ...baseSourceAccount,
              agentId: record.agentId,
              ownerId: record.ownerId,
            };
            if (context?.signal?.aborted) {
              const err = new Error("Execution was cancelled");
              err.name = "AbortError";
              throw err;
            }
            outcome = await pipeline.execute({
              intent: record.intent,
              sourceAccount,
              activityId: record.activityId ?? undefined,
              signal: context?.signal,
              onBeforeSubmit: () => {
                context?.onBeforeSubmit?.();
              },
            });
          }
          const txHash = (outcome as { txHash?: string }).txHash;
          if (txHash) {
            await context?.onSubmitted?.(txHash);
          }
          const approvalId = (outcome as { approvalId?: string }).approvalId ?? record.approvalId ?? undefined;
          return {
            record,
            success: outcome.status === "submitted",
            status: outcome.status,
            error: outcome.message,
            errorClass: classifyPipelineOutcome(outcome),
            txHash,
            submittedHash: txHash ?? null,
            activityId: (outcome as { activityId?: string }).activityId ?? record.activityId ?? undefined,
            approvalId,
            policyDecision: outcome.policyDecision ?? undefined,
          };
        } catch (err: unknown) {
          if (context?.signal?.aborted) {
            if (record.activityId && options.activityStore) {
              try {
                await options.activityStore.update(record.activityId, {
                  status: "failed",
                  error: "cancelled by user",
                  updatedAt: new Date().toISOString(),
                });
              } catch {
                // ActivityStore update failure is non-critical
              }
            }
            throw err;
          }
          // Pipeline failed before persisting activity (e.g., source account load failure).
          // Update the pre-created ActivityRecord to reflect the failure so the
          // activity record is not left in "pending" indefinitely.
          if (record.activityId && options.activityStore) {
            try {
              await options.activityStore.update(record.activityId, {
                status: "failed",
                error: err instanceof Error ? err.message : String(err),
                updatedAt: new Date().toISOString(),
              });
            } catch {
              // ActivityStore update failure is non-critical — execution record still tracks the error.
            }
          }
          return {
            record,
            success: false,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            errorClass: classifyError(err),
            activityId: record.activityId ?? undefined,
          };
        }
      });
    };

    // #379: reuse the shared pre-check mapping (defined above with the
    // recovery service) — one mapping for the queue, the retry path, and the
    // recovery service, carrying the full on-chain status through.
    executionQueue =
      options.executionQueue.instance ??
      new ExecutionQueue(executionStore, pipelineExecutor, getSourceAccount, {
        intervalMs: options.executionQueue.intervalMs,
        concurrency: options.executionQueue.concurrency,
        preCheck,
      });

    executionQueue.start();
    console.log("[execution-queue] started, interval:", options.executionQueue.intervalMs ?? 10_000, "ms");
  }

  // --- Scheduler setup ---
  // The scheduler executes due schedules via the SAME pipeline as manual intents.
  // It is opt-in: only starts if options.scheduler.enabled is true.
  // --- Schedule recovery setup ---
  const scheduleRecoveryService = new ScheduleRecoveryService(schedules);

  let scheduler: AgentScheduler | null = null;
  if (options.scheduler?.enabled) {
    let recoverySucceeded = false;
    try {
      const recoveryResult = await scheduleRecoveryService.recover();
      if (recoveryResult.errors.length > 0) {
        console.error(
          `[schedule-recovery] recovery encountered ${recoveryResult.errors.length} error(s); scheduler will not be started to prevent duplicate triggers`
        );
      } else {
        if (recoveryResult.found > 0) {
          console.log(
            `[schedule-recovery] recovered ${recoveryResult.recovered}/${recoveryResult.found} interrupted schedules`
          );
        }
        recoverySucceeded = true;
      }
    } catch (err) {
      console.error(
        "[schedule-recovery] recovery failed; scheduler will not be started to prevent duplicate triggers:",
        err
      );
    }

    if (recoverySucceeded) {
      const scheduleExecution = new ScheduleExecutionService({
      activityStore: store,
      approvalStore: approvals,
      getSourceAccount: async () => {
        const account = await adapter.getAccount(options.signer.getAccountId());
        return {
          accountId: () => account.address,
          sequenceNumber: () => account.sequence,
          incrementSequenceNumber: () => {},
        };
      },
      pipelineExecutor: (input) => pipeline.execute(input) as any,
      sequenceCoordinator,
      sequenceAccountId: options.signer.getAccountId(),
    });

    const agentStatusStore = {
      get: async (id: string) => {
        // Fast path: in-memory map (covers agents registered this session).
        const agent = agents.get(id);
        if (agent) return { id: agent.id, status: agent.status, ownerId: agent.ownerId };
        // Fallback: persistent store (covers agents surviving a restart).
        // Mirrors ResourceAuthorizationService.resolveAgent logic so the
        // scheduler and authorization layer agree on agent status.
        if (agentStore) {
          const dbAgent = await agentStore.get(id);
          if (dbAgent) return { id: dbAgent.id, status: dbAgent.status, ownerId: dbAgent.ownerId };
        }
        return null;
      },
    };

    scheduler =
      options.scheduler.instance ??
      new AgentScheduler(
        schedules,
        agentStatusStore,
        async (schedule) => {
          // If execution queue is enabled, enqueue; otherwise fall back to
          // direct ScheduleExecutionService invocation.
          if (executionQueue) {
            const now = new Date().toISOString();
            // Pre-create ActivityRecord for audit trail; the pipeline will
            // update this record (not create a duplicate) when activityId is passed.
            const activityId = crypto.randomUUID();
            if (store) {
              const activityRecord = createActivity(
                schedule.agentId,
                schedule.ownerId,
                schedule.intent,
                null
              );
              activityRecord.id = activityId;
              activityRecord.status = "pending";
              activityRecord.authorizationStatus = "not_required";
              await store.record(activityRecord);
            }
            const executionRecord: ExecutionRecord = {
              id: crypto.randomUUID(),
              ownerId: schedule.ownerId,
              agentId: schedule.agentId,
              approvalId: null,
              activityId: activityId,
              intent: schedule.intent,
              status: "queued",
              policyDecision: null,
              simulationResult: null,
              txHash: null,
              submittedHash: null,
              error: null,
              attempt: 0,
              nextRetryAt: null,
              startedAt: null,
              completedAt: null,
              errorClass: null,
              createdAt: now,
              updatedAt: now,
            };
            try {
              await executionQueue.enqueue(executionRecord);
            } catch (err) {
              console.error(`[scheduler] failed to enqueue execution for schedule ${schedule.id}:`, err);
              if (store) {
                try {
                  await store.update(activityId, {
                    status: "failed",
                    error: `Failed to enqueue execution: ${err instanceof Error ? err.message : String(err)}`,
                    updatedAt: new Date().toISOString(),
                  });
                } catch (updateErr) {
                  console.error(`[scheduler] failed to mark activity ${activityId} failed for schedule ${schedule.id}:`, updateErr);
                }
              }
              throw err;
            }
            return {
              status: "submitted",
              message: "schedule enqueued for execution",
              policyDecision: null,
              simulationResult: null,
              txHash: null as unknown as string,
              activityId: undefined,
              approvalId: undefined,
            } as ScheduleExecutionResult;
          }
          return scheduleExecution.executeSchedule(schedule);
        },
        { intervalMs: options.scheduler.intervalMs, maxLatenessMs: options.scheduler.maxLatenessMs }
      );

      scheduler.start();
      console.log("[scheduler] started, interval:", options.scheduler.intervalMs ?? 60_000, "ms");
    }
  }

  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  let retentionRunning = false;
  if (options.retention?.enabled !== false) {
    const intervalMs = Number.isFinite(options.retention?.intervalMs) && options.retention!.intervalMs! > 0
      ? options.retention!.intervalMs!
      : 24 * 60 * 60_000;
    const sessionDays = Number.isFinite(options.retention?.authSessionDays) && options.retention!.authSessionDays! >= 0
      ? options.retention!.authSessionDays!
      : 30;
    const spendingDays = Number.isFinite(options.retention?.dailySpendingDays) && options.retention!.dailySpendingDays! >= 0
      ? options.retention!.dailySpendingDays!
      : 90;
    const sweepRetention = async () => {
      if (retentionRunning) return;
      retentionRunning = true;
      try {
        const result = await sweepRetainedData({
          store,
          approvalStore: approvals,
          authModule,
          now: Date.now(),
          authSessionDays: sessionDays,
          dailySpendingDays: spendingDays,
          idempotencyWindowMs: (store as { idempotencyWindowMs?: number }).idempotencyWindowMs
            ?? resolveIdempotencyWindowMs(options.idempotencyKeyWindowMs),
          batchSize: 500,
          onApprovalExpired: async (approval) => {
            await releaseDecisionReservation(approval.agentId, approval.policyDecision);
            const linkedExecution = await executionStore.getByApprovalId(approval.id);
            if (linkedExecution && linkedExecution.status === "requires_approval") {
              await executionStore.updateIfStatus(linkedExecution.id, "requires_approval", {
                status: "failed",
                error: "approval expired without decision",
                completedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
            }
          },
        });
        console.log(`[retention] sweep complete: auth_sessions=${result.authSessionsRemoved}, daily_spending=${result.dailySpendingRemoved}, expired_approvals=${result.expiredApprovalsSwept}, idempotency_keys_released=${result.idempotencyKeysReleased}`);
      } catch (err) {
        console.error("[retention] sweep failed:", err);
      } finally {
        retentionRunning = false;
      }
    };
    void sweepRetention();
    retentionTimer = setInterval(() => { void sweepRetention(); }, intervalMs);
    retentionTimer.unref?.();
  }

  // CORS configuration — configurable via CORS_ORIGIN environment variable.
  // Supports multiple origins: CORS_ORIGIN=https://app.example.com,https://preview.vercel.app
  const corsOrigins: string[] = (() => {
    const raw = process.env.CORS_ORIGIN ?? options.corsOrigin;
    if (!raw) return [];
    return raw.split(',').map((o: string) => o.trim()).filter(Boolean);
  })();

  function getCorsOrigin(req: any): string | null {
    if (corsOrigins.length === 0) return null;
    const origin = req.headers?.origin;
    if (!origin || typeof origin !== 'string') return null;
    if (corsOrigins.includes(origin)) return origin;
    return null;
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // Phase 28L: Request logging with correlation IDs.
    // Assigned before any handler runs so every response — including
    // OPTIONS preflights and 401/404 errors — carries X-Request-Id.
    const suppliedId = req.headers["x-request-id"];
    const requestId = generateRequestId(
      Array.isArray(suppliedId) ? suppliedId[0] : suppliedId,
    );
    res.setHeader("X-Request-Id", requestId);

    const requestStart = Date.now();
    let ownerId: string | null = null;
    let logged = false;

    const originalEnd = res.end.bind(res);
    res.end = function (...args: any[]) {
      if (!logged) {
        logged = true;
        const durationMs = Date.now() - requestStart;
        const status = res.statusCode || 0;
        log(status >= 500 ? "error" : "info", "request completed", {
          method,
          path: new URL(url, "http://localhost").pathname,
          status,
          durationMs,
          requestId,
          ownerId,
        });
      }
      return originalEnd(...args);
    };

    // Handle CORS preflight (OPTIONS) — does NOT bypass authentication for
    // actual API requests. Preflight is unauthenticated but returns no data.
    if (method === "OPTIONS") {
      const origin = getCorsOrigin(req);
      if (origin) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Requested-With",
          "Access-Control-Allow-Credentials": "true",
          "Vary": "Origin",
        });
      } else {
        res.writeHead(204);
      }
      res.end();
      return;
    }

    // Phase 28W: CORS — echo allowed origin on actual responses.
    // Intercepts writeHead so CORS headers are added without modifying every handler.
    const corsOrigin = getCorsOrigin(req);
    if (corsOrigin) {
      const originalWriteHead = res.writeHead.bind(res);
      res.writeHead = function(status: number, headers?: any) {
        if (typeof status === 'object') {
          headers = status;
          status = 200;
        }
        const merged = { ...(headers ?? {}), 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' };
        return originalWriteHead(status, merged);
      };
    }

    try {
    // Phase 28U: USER AUTH routes (/auth/*) — handled before the auth gate.
    // These are the login/session endpoints (register, login, challenge,
    // verify, google start/callback, logout, me, config).
    if (authModule) {
      const handled = await authModule.handleRoutes(req, res, url, method);
      if (handled) return;
    }

    // Phase 28K-1: Authenticate and create request-scoped context
    const resolution = await authenticateRequest(req, method);
    const requestScopedCtx = principalToContext(resolution.principal);
    ownerId = requestScopedCtx.ownerId;

    await runRequestIdContext(requestId, async () => {
    return await als.run(requestScopedCtx, async () => {
      // Health check is public
      if (method === "GET" && url === "/health") {
        const schemaVersion = options.dbPath
          ? getSchemaVersion(getSharedConnection(options.dbPath))
          : null;
        return json(res, {
          status: "ok",
          signerAccountId: options.signer.getAccountId(),
          version: API_VERSION,
          schemaVersion,
        });
      }

      // Public readiness: bounded/cached dependency reads, fresh worker status.
      if (method === "GET" && url === "/health/ready") {
        return dependencyReadiness().then(dependencies => {
          const checks = {
            ...dependencies,
            executionQueue: options.executionQueue?.enabled
              ? (executionQueue?.isRunning() ? "ok" : "fail") : "disabled",
            scheduler: options.scheduler?.enabled
              ? (scheduler?.isRunning() ? "ok" : "fail") : "disabled",
          };
          const status = dependencies.horizon === "fail" || dependencies.database === "fail"
            ? "unavailable"
            : checks.executionQueue === "fail" || checks.scheduler === "fail" ? "degraded" : "ok";
          return json(res, { status, checks }, status === "ok" ? 200 : 503);
        });
      }

      // CSRF guard: a valid session principal that failed the custom-header
      // check must not be able to mutate state. Checked BEFORE the generic
      // 401 gate so forged (cross-site) writes surface as 403, while an
      // unauthenticated request still gets 401.
      if (resolution.csrfFail) {
        return apiError(res, "CSRF_FAILED");
      }

      // Protected endpoints require authentication
      if (!requestScopedCtx.ownerId) {
        return apiError(res, "UNAUTHORIZED");
      }

      if (method === "POST" && url === "/agents") {
      return handleCreateAgent(requestScopedCtx, req, res);
    }
    if (method === "POST" && /^\/agents\/[^/]+\/intents$/.test(url)) {
      return handleIntent(requestScopedCtx, req, res);
    }
    if (method === "POST" && /^\/approvals\/[^/]+\/(approve|reject)$/.test(url)) {
      const isApprove = url.endsWith("/approve");
      return isApprove ? handleApprove(requestScopedCtx, req, res) : handleReject(requestScopedCtx, req, res);
    }
    if (method === "GET" && url === "/health") {
      return json(res, { status: "ok", signerAccountId: options.signer.getAccountId() });
    }
    if (method === "GET" && /^\/agents\/[^/]+\/policy$/.test(url)) {
      return handleGetPolicy(requestScopedCtx, req, res);
    }
    if (method === "PUT" && /^\/agents\/[^/]+\/policy$/.test(url)) {
      return handlePutPolicy(requestScopedCtx, req, res);
    }

    if (method === "GET" && /^\/agents(\?.*)?$/.test(url)) {
      return handleListAgents(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+$/.test(url)) {
      return handleGetAgent(requestScopedCtx, req, res);
    }
    if (method === "PATCH" && /^\/agents\/[^/]+$/.test(url)) {
      return handleUpdateAgent(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/activity(\?.*)?$/.test(url)) {
      return handleAgentActivity(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/activity\/[^/]+$/.test(url)) {
      return handleActivityDetail(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/approvals(\?.*)?$/.test(url)) {
      return handleAgentApprovals(requestScopedCtx, req, res);
    }
    if (method === "PATCH" && /^\/agents\/[^/]+\/status$/.test(url)) {
      return handleUpdateAgentStatus(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/schedules(\?.*)?$/.test(url)) {
      return handleListSchedules(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/schedules\/[^/]+$/.test(url)) {
      return handleGetSchedule(requestScopedCtx, req, res);
    }
    if (method === "POST" && /^\/agents\/[^/]+\/schedules$/.test(url)) {
      return handleCreateSchedule(requestScopedCtx, req, res);
    }
    if (method === "PATCH" && /^\/agents\/[^/]+\/schedules\/[^/]+$/.test(url)) {
      return handleUpdateSchedule(requestScopedCtx, req, res);
    }
    if (method === "DELETE" && /^\/agents\/[^/]+\/schedules\/[^/]+$/.test(url)) {
      return handleDeleteSchedule(requestScopedCtx, req, res);
    }
    if (method === "POST" && /^\/agents\/[^/]+\/schedules\/[^/]+\/(pause|resume|disable)$/.test(url)) {
      return handleScheduleAction(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/activity(\?.*)?$/.test(url)) {
      return handleListActivity(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/approvals\/[^/]+$/.test(url)) {
      return handleGetApproval(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/approvals(\?.*)?$/.test(url)) {
      return handleListApprovals(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/executions(\?.*)?$/.test(url)) {
      return handleAgentExecutions(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/spending(\?.*)?$/.test(url)) {
      return handleGetAgentSpending(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/executions(\?.*)?$/.test(url)) {
      return handleListExecutions(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/executions\/[^/]+$/.test(url)) {
      return handleExecutionDetail(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agent-queue(\?.*)?$/.test(url)) {
      return handleQueueStatus(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/overview\/attention$/.test(url)) {
      return handleGetOverviewAttention(requestScopedCtx, req, res);
    }
    if (method === "POST" && /^\/executions\/[^/]+\/retry$/.test(url)) {
      return handleRetryExecution(requestScopedCtx, req, res);
    }
    if (method === "POST" && /^\/executions\/[^/]+\/cancel$/.test(url)) {
      return handleCancelExecution(requestScopedCtx, req, res);
    }
    apiError(res, "NOT_FOUND");
    }); // End als.run
    }); // End runRequestIdContext
    } catch (err: unknown) {
      log("error", "unhandled request error", {
        requestId,
        method,
        path: new URL(url, "http://localhost").pathname,
        ownerId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent && !res.writableEnded) {
        apiError(res, "INTERNAL_ERROR");
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  async function handleListAgents(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const capability = urlObj.searchParams.get("capability");
    const hasLimit = urlObj.searchParams.has("limit");
    const rawLimit = urlObj.searchParams.get("limit");
    const hasOffset = urlObj.searchParams.has("offset");
    const rawOffset = urlObj.searchParams.get("offset");

    let limit: number | undefined;
    if (hasLimit) {
      // Empty string, non-numeric, or fractional values are rejected.
      if (rawLimit === null || rawLimit.trim() === "") {
        return apiError(res, "VALIDATION_ERROR", { message: "limit must be a valid integer" });
      }
      const parsed = Number(rawLimit);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        return apiError(res, "VALIDATION_ERROR", { message: "limit must be a valid integer" });
      }
      limit = Math.max(1, Math.min(MAX_LIMIT, parsed));
    }

    // Same strict validation as `limit`: empty, non-numeric, or fractional
    // values are rejected. A negative offset clamps to 0 and an offset past
    // MAX_OFFSET clamps to MAX_OFFSET (see clampOffset).
    let offset = 0;
    if (hasOffset) {
      if (rawOffset === null || rawOffset.trim() === "") {
        return apiError(res, "VALIDATION_ERROR", { message: "offset must be a valid integer" });
      }
      const parsed = Number(rawOffset);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        return apiError(res, "VALIDATION_ERROR", { message: "offset must be a valid integer" });
      }
      offset = clampOffset(parsed);
    }

    const effectiveLimit = limit ?? MAX_LIMIT;
    const [all, total] = capability !== null
      ? [
          await agentStore.listByCapability(ctx.ownerId!, capability, effectiveLimit, offset),
          await agentStore.countByCapability(ctx.ownerId!, capability),
        ]
      : [
          await agentStore.listByOwner(ctx.ownerId!, effectiveLimit, offset),
          await agentStore.countByOwner(ctx.ownerId!),
        ];

    const agentList = all.map((a) => ({
      id: a.id,
      displayName: a.displayName,
      description: a.description,
      ownerId: a.ownerId,
      stellarAddress: a.stellarAddress,
      capabilities: a.capabilities,
      status: a.status,
      active: a.active,
      createdAt: a.createdAt,
    }));
    // Same semantics as GET /approvals: `truncated` means more matching rows
    // exist beyond this page; `hasMore` additionally requires the client to
    // actually be able to fetch them (offset ceiling ends pagination).
    const truncated = offset + agentList.length < total;
    const hasMore = truncated && !isOffsetAtCeiling(offset);
    return json(res, { agents: agentList, hasMore, truncated, total });
  }

  async function handleCreateAgent(ctx: RequestContext, req: any, res: any) {
    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    const b = body as Record<string, unknown>;
    const displayName = b.displayName;
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      return apiError(res, "VALIDATION_ERROR", { message: "displayName is required" });
    }
    if (displayName.trim().length > 100) {
      return apiError(res, "VALIDATION_ERROR", { message: "displayName must be 100 characters or fewer" });
    }

    let description = "";
    if (b.description !== undefined) {
      if (typeof b.description !== "string") {
        return apiError(res, "VALIDATION_ERROR", { message: "description must be a string" });
      }
      if (b.description.length > 500) {
        return apiError(res, "VALIDATION_ERROR", { message: "description must be 500 characters or fewer" });
      }
      description = b.description;
    }

    let capabilities: string[] = [];
    if (b.capabilities !== undefined) {
      if (!Array.isArray(b.capabilities) || !b.capabilities.every((c) => typeof c === "string")) {
        return apiError(res, "VALIDATION_ERROR", { message: "capabilities must be an array of strings" });
      }
      if (b.capabilities.length > 32) {
        return apiError(res, "VALIDATION_ERROR", { message: "capabilities must be 32 entries or fewer" });
      }
      const trimmedCaps: string[] = [];
      const seen = new Set<string>();
      for (const cap of b.capabilities) {
        const trimmed = cap.trim();
        if (trimmed.length === 0) {
          return apiError(res, "VALIDATION_ERROR", { message: "capability entries cannot be empty" });
        }
        if (trimmed.length > 32) {
          return apiError(res, "VALIDATION_ERROR", { message: "capability entries must be 32 characters or fewer" });
        }
        if (seen.has(trimmed)) {
          return apiError(res, "VALIDATION_ERROR", { message: "capabilities must not contain duplicate entries" });
        }
        seen.add(trimmed);
        trimmedCaps.push(trimmed);
      }
      capabilities = trimmedCaps;
    }

    let stellarAddress = "";
    if (b.stellarAddress !== undefined) {
      if (typeof b.stellarAddress !== "string") {
        return apiError(res, "VALIDATION_ERROR", { message: "stellarAddress must be a string" });
      }
      stellarAddress = b.stellarAddress;
    }

    const agent = await agentStore.create({
      displayName: displayName.trim(),
      description,
      capabilities,
      ownerId: ctx.ownerId!,
      stellarAddress,
    });

    // Backward compatibility: keep in-memory map in sync
    agents.set(agent.id, agent);

    return json(res, { agent }, 201);
  }

  /**
   * PATCH /agents/:id — update the mutable metadata of an agent (#84).
   *
   * Accepted fields: displayName, description, capabilities. Everything else
   * is rejected (400) rather than ignored, so a typo such as `displayname`
   * cannot silently do nothing. `status` belongs to PATCH /agents/:id/status,
   * and `stellarAddress` is deliberately immutable: it binds the agent to a
   * Stellar signer/account, so a signer change must go through the on-chain
   * registration path instead of a metadata patch.
   */
  async function handleUpdateAgent(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");

    // Owner-scoped: a non-owner and a nonexistent agent both get the same 404.
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");

    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return apiError(res, "VALIDATION_ERROR", { message: "body must be a JSON object" });
    }
    const b = body as Record<string, unknown>;

    if (Object.prototype.hasOwnProperty.call(b, "status")) {
      return apiError(res, "VALIDATION_ERROR", {
        message: "status cannot be updated here; use PATCH /agents/:id/status",
      });
    }
    if (Object.prototype.hasOwnProperty.call(b, "stellarAddress")) {
      return apiError(res, "VALIDATION_ERROR", {
        message: "stellarAddress is immutable and cannot be updated",
      });
    }
    const unsupported = Object.keys(b).filter((key) => !MUTABLE_AGENT_FIELDS.has(key));
    if (unsupported.length > 0) {
      return apiError(res, "VALIDATION_ERROR", {
        message: `unsupported field(s): ${unsupported.join(", ")}; accepted fields: displayName, description, capabilities`,
      });
    }

    const patch: Partial<Agent> = {};

    if (Object.prototype.hasOwnProperty.call(b, "displayName")) {
      const displayName = b.displayName;
      if (typeof displayName !== "string" || displayName.trim().length === 0) {
        return apiError(res, "VALIDATION_ERROR", { message: "displayName must be a non-empty string" });
      }
      if (displayName.trim().length > MAX_AGENT_DISPLAY_NAME_LEN) {
        return apiError(res, "VALIDATION_ERROR", {
          message: `displayName must be ${MAX_AGENT_DISPLAY_NAME_LEN} characters or fewer`,
        });
      }
      patch.displayName = displayName.trim();
    }

    if (Object.prototype.hasOwnProperty.call(b, "description")) {
      const description = b.description;
      if (typeof description !== "string") {
        return apiError(res, "VALIDATION_ERROR", { message: "description must be a string" });
      }
      if (description.length > MAX_AGENT_DESCRIPTION_LEN) {
        return apiError(res, "VALIDATION_ERROR", {
          message: `description must be ${MAX_AGENT_DESCRIPTION_LEN} characters or fewer`,
        });
      }
      patch.description = description;
    }

    if (Object.prototype.hasOwnProperty.call(b, "capabilities")) {
      const rawCapabilities = b.capabilities;
      if (
        !Array.isArray(rawCapabilities) ||
        !rawCapabilities.every((cap): cap is string => typeof cap === "string")
      ) {
        return apiError(res, "VALIDATION_ERROR", { message: "capabilities must be an array of strings" });
      }
      if (rawCapabilities.length > MAX_AGENT_CAPABILITY_COUNT) {
        return apiError(res, "VALIDATION_ERROR", {
          message: `capabilities must be ${MAX_AGENT_CAPABILITY_COUNT} entries or fewer`,
        });
      }
      const trimmedCapabilities: string[] = [];
      const seen = new Set<string>();
      for (const capability of rawCapabilities) {
        const trimmed = capability.trim();
        if (trimmed.length === 0) {
          return apiError(res, "VALIDATION_ERROR", { message: "capability entries cannot be empty" });
        }
        if (trimmed.length > MAX_AGENT_CAPABILITY_LEN) {
          return apiError(res, "VALIDATION_ERROR", {
            message: `capability entries must be ${MAX_AGENT_CAPABILITY_LEN} characters or fewer`,
          });
        }
        if (seen.has(trimmed)) {
          return apiError(res, "VALIDATION_ERROR", { message: "capabilities must not contain duplicate entries" });
        }
        seen.add(trimmed);
        trimmedCapabilities.push(trimmed);
      }
      patch.capabilities = trimmedCapabilities;
    }

    if (Object.keys(patch).length === 0) {
      return apiError(res, "VALIDATION_ERROR", {
        message: "at least one of displayName, description, capabilities is required",
      });
    }

    const updated = await agentStore.update(agentId, patch);
    if (!updated) return apiError(res, "AGENT_NOT_FOUND");
    // The session-scoped map is used by the status and scheduler lookups; keep
    // it consistent with the store (same as the status handler).
    if (agents.has(agentId)) {
      agents.set(agentId, updated);
    }
    return json(res, { agent: updated });
  }

  async function handleAgentActivity(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/activity$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const statusFilter = parseStatusFilter(urlObj.searchParams.get("status"), ACTIVITY_STATUSES);
    if (!statusFilter.ok) return apiError(res, "VALIDATION_ERROR", { message: statusFilter.error });
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const all =
      statusFilter.status === undefined
        ? await store.listByAgent(agentId, limit + 1, offset)
        : await store.listByStatus(agentId, statusFilter.status, limit + 1, offset);
    const activity = all.slice(0, limit);
    const hasMore = all.length > limit && !isOffsetAtCeiling(offset);
    return json(res, { agentId, activity, hasMore });
  }

  async function handleListApprovals(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const statusFilter = parseStatusFilter(urlObj.searchParams.get("status"), APPROVAL_STATUSES);
    if (!statusFilter.ok) return apiError(res, "VALIDATION_ERROR", { message: statusFilter.error });
    const limit = Math.max(1, Math.min(200, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const rows = await approvals.listByOwner(ctx.ownerId!, limit, offset, statusFilter.status);
    const total = await approvals.countByOwner(ctx.ownerId!, statusFilter.status);
    // `truncated`: more matching rows exist beyond this page.
    // `hasMore`: the client can actually fetch them (offset ceiling ends pagination).
    const truncated = offset + rows.length < total;
    const hasMore = truncated && !isOffsetAtCeiling(offset);
    return json(res, { approvals: rows, hasMore, truncated, total });
  }

  async function handleGetApproval(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/approvals\/([^/]+)$/);
    const approvalId = match?.[1];
    if (!approvalId) return apiError(res, "INVALID_PATH_PARAM");
    const canAccess = await authorizationService.canAccessApproval(ctx, approvalId);
    if (!canAccess) return apiError(res, "APPROVAL_NOT_FOUND");
    const approval = await approvals.get(approvalId);
    if (!approval) return apiError(res, "APPROVAL_NOT_FOUND");
    return json(res, { approval });
  }


  async function handleGetPolicy(ctx: RequestContext, req: any, res: any) {
    const agentId = extractAgentIdFromPolicyUrl(req.url);
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");

    if (!(await agentExists(agentId))) return apiError(res, "AGENT_NOT_FOUND");
    const canAccess = await authorizationService.canAccessAgent(ctx, agentId);
    if (!canAccess) return apiError(res, "AGENT_NOT_FOUND");

    let metadata;
    try {
      metadata = await policyConfigStore.getWithMetadata(agentId);
    } catch (error) {
      if (error instanceof Error && error.name === "CorruptPolicyConfigError") {
        return apiError(res, "POLICY_UNAVAILABLE");
      }
      throw error;
    }
    if (metadata) {
      return json(res, {
        agentId,
        policy: metadata.rules,
        version: metadata.version,
        updatedAt: metadata.updatedAt,
      });
    }
    // No custom policy — return DEFAULT_RULES with version indicator
    return json(res, { agentId, policy: DEFAULT_RULES, version: 0, updatedAt: null });
  }

  async function handlePutPolicy(ctx: RequestContext, req: any, res: any) {
    const agentId = extractAgentIdFromPolicyUrl(req.url);
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");

    if (!(await agentExists(agentId))) return apiError(res, "AGENT_NOT_FOUND");
    const canAccess = await authorizationService.canAccessAgent(ctx, agentId);
    if (!canAccess) return apiError(res, "AGENT_NOT_FOUND");

    let body: unknown;
    try {
      const text = await readBody(req);
      body = JSON.parse(text);
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    if (typeof body !== "object" || body === null) {
      return apiError(res, "VALIDATION_ERROR", { message: "policy must be an object" });
    }

    const validation = validatePolicyRules(body);
    if (!validation.valid) {
      return apiError(res, "VALIDATION_ERROR", { message: "invalid policy", details: validation.errors });
    }

    const normalized = normalizePolicyRules(body as Partial<PolicyRules>);
    const result = await policyConfigStore.upsert(agentId, ctx.ownerId!, normalized);
    return json(res, { agentId, policy: result.rules, version: result.version });
  }

  function extractAgentIdFromPolicyUrl(url: string): string | null {
    const match = url.match(/^\/agents\/([^/]+)\/policy$/);
    return match?.[1] ?? null;
  }


  async function handleGetAgent(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const agent = await agentStore.getForOwner(agentId, ctx.ownerId!);
    if (!agent) return apiError(res, "AGENT_NOT_FOUND");
    return json(res, {
      id: agent.id,
      displayName: agent.displayName,
      description: agent.description,
      ownerId: agent.ownerId,
      stellarAddress: agent.stellarAddress,
      capabilities: agent.capabilities,
      status: agent.status,
      active: agent.active,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    });
  }

  async function handleGetAgentSpending(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/spending$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const rules = await getRules(agentId);
    const spending: Record<string, { used: number; limit: string; remaining: number }> = {};
    for (const asset of Object.keys(rules.dailySpendingLimit)) {
      const limitStr = rules.dailySpendingLimit[asset] ?? "0";
      // #374: enforce and store in integer stroops; convert stroops back to an
      // exact decimal number here at the display boundary so the dashboard
      // never shows float garbage like 0.19999999999999998 (which 1.0 - 0.8
      // produced under the old REAL/float path). A non-canonical limit is
      // skipped (no row), matching the old isNaN(parseFloat) behavior.
      const limitStroops = toStroops(limitStr);
      if (limitStroops === null) continue;
      const usedStroops = (await store.getDailySpending(agentId, asset)) ?? 0;
      const remainingStroops = Math.max(limitStroops - usedStroops, 0);
      spending[asset] = {
        used: Number(fromStroops(usedStroops)),
        limit: limitStr,
        remaining: Number(fromStroops(remainingStroops)),
      };
    }
    return json(res, { agentId, spending });
  }

  async function handleActivityDetail(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/activity\/([^/]+)$/);
    const agentId = match?.[1];
    const activityId = match?.[2];
    if (!agentId || !activityId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    // Issue #385: the activity must belong to the agent named in the path.
    // Same 404 as a nonexistent id — the response must not reveal whether the
    // activity exists under a different agent.
    const canAccess = await authorizationService.canAccessActivity(ctx, activityId, agentId);
    if (!canAccess) return apiError(res, "ACTIVITY_NOT_FOUND");
    const activity = await store.getForOwner(activityId, ctx.ownerId!);
    if (!activity) return apiError(res, "ACTIVITY_NOT_FOUND");
    return json(res, { activity });
  }

  async function handleAgentApprovals(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/approvals$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const statusFilter = parseStatusFilter(urlObj.searchParams.get("status"), APPROVAL_STATUSES);
    if (!statusFilter.ok) return apiError(res, "VALIDATION_ERROR", { message: statusFilter.error });
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const rows =
      statusFilter.status === undefined
        ? await approvals.listByAgent(agentId, limit + 1, offset)
        : await approvals.listByStatus(agentId, statusFilter.status, limit + 1, offset);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit && !isOffsetAtCeiling(offset);
    return json(res, { agentId, approvals: page, hasMore });
  }

  async function handleUpdateAgentStatus(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/status$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const canChange = await authorizationService.canChangeAgentStatus(ctx, agentId);
    if (!canChange) return apiError(res, "AGENT_NOT_FOUND");
    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }
    const status = (body as { status?: unknown })?.status;
    if (status !== "active" && status !== "paused" && status !== "disabled") {
      return apiError(res, "VALIDATION_ERROR", { message: "status must be one of: active, paused, disabled" });
    }
    const result = await agentStore.transitionStatus(agentId, status);
    if (!result.updated) {
      if (result.reason === "not_found") return apiError(res, "AGENT_NOT_FOUND");
      return apiError(res, "AGENT_STATUS_INVALID_TRANSITION", {
        details: { currentStatus: result.currentStatus, requestedStatus: status },
      });
    }
    if (agents.has(agentId)) {
      agents.set(agentId, result.agent);
    }
    return json(res, { id: result.agent.id, status: result.agent.status });
  }

  async function handleListSchedules(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const statusFilter = parseStatusFilter(urlObj.searchParams.get("status"), SCHEDULE_STATUSES);
    if (!statusFilter.ok) return apiError(res, "VALIDATION_ERROR", { message: statusFilter.error });
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const all = await schedules.listByAgent(agentId, limit + 1, offset, statusFilter.status);
    const page = all.slice(0, limit);
    const hasMore = all.length > limit && !isOffsetAtCeiling(offset);
    return json(res, { agentId, schedules: page, hasMore });
  }

  async function handleGetSchedule(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules\/([^/]+)$/);
    const agentId = match?.[1];
    const scheduleId = match?.[2];
    if (!agentId || !scheduleId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    // Issue #385: the schedule must belong to the agent named in the path.
    // Same 404 as a nonexistent id — the response must not reveal whether the
    // schedule exists under a different agent.
    const canAccess = await authorizationService.canAccessSchedule(ctx, scheduleId, agentId);
    if (!canAccess) return apiError(res, "SCHEDULE_NOT_FOUND");
    const schedule = await schedules.get(scheduleId);
    if (!schedule) return apiError(res, "SCHEDULE_NOT_FOUND");
    return json(res, { schedule });
  }

  async function handleCreateSchedule(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const canCreate = await authorizationService.canCreateSchedule(ctx, agentId);
    if (!canCreate) return apiError(res, "AGENT_NOT_FOUND");

    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    const intent = (body as any)?.intent;
    const scheduleExpression = (body as any)?.scheduleExpression;
    const timezone = (body as any)?.timezone ?? "UTC";

    const { validateScheduleExpression, validateScheduleIntent } = await import("@4evergent/database");

    const intentValidation = validateScheduleIntent(intent);
    if (!intentValidation.valid) {
      return apiError(res, "VALIDATION_ERROR", { message: intentValidation.error });
    }

    const exprValidation = validateScheduleExpression(scheduleExpression, timezone);
    if (!exprValidation.valid) {
      return apiError(res, "VALIDATION_ERROR", { message: exprValidation.error });
    }

    // Issue #368: check agent status and evaluate policy at schedule creation time
    // without reserving daily spending (creation is not a spend).
    const agent = (await agentStore.get(agentId)) ?? agents.get(agentId);
    if (!agent) return apiError(res, "AGENT_NOT_FOUND");
    if (agent.status !== "active") {
      return apiError(res, "AGENT_NOT_ACTIVE", {
        message: `agent is ${agent.status}; cannot create schedule for non-active agent`,
      });
    }

    const decision = await policy.evaluate(intent, agentId, { skipReservation: true });
    if (decision.result === "deny") {
      return apiError(res, "POLICY_DENIED", {
        message: `Schedule intent denied by policy (${decision.rule}): ${decision.reason}`,
        details: { rule: decision.rule, reason: decision.reason },
        extra: { policyDecision: decision },
      });
    }

    const now = new Date().toISOString();
    const schedule = await schedules.create({
      id: crypto.randomUUID(),
      agentId,
      ownerId: ctx.ownerId!,
      status: "active",
      intent,
      scheduleExpression,
      timezone,
      nextRunAt: exprValidation.nextRunAt ?? now,
      lastRunAt: null,
      lastStartedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    if (decision.result === "requires_approval") {
      return json(
        res,
        {
          schedule,
          policyDecision: decision,
          warning: `Each scheduled run will require human approval (${decision.rule}: ${decision.reason})`,
        },
        201
      );
    }

    return json(res, { schedule }, 201);
  }

  async function handleUpdateSchedule(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules\/([^/]+)$/);
    const agentId = match?.[1];
    const scheduleId = match?.[2];
    if (!agentId || !scheduleId) return apiError(res, "INVALID_PATH_PARAM");
    // Issue #385: bind the schedule to the agent named in the path.
    const canUpdate = await authorizationService.canUpdateSchedule(ctx, scheduleId, agentId);
    if (!canUpdate) return apiError(res, "AGENT_NOT_FOUND");

    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    const schedule = await schedules.get(scheduleId);
    if (!schedule) return apiError(res, "SCHEDULE_NOT_FOUND");

    // Reject any body that contains unknown top-level fields.
    // Unknown keys are named in the error so the caller can self-correct.
    const ACCEPTED_FIELDS = new Set(["scheduleExpression", "timezone", "intent"]);
    const bodyObj = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const bodyKeys = Object.keys(bodyObj);
    const unknownKeys = bodyKeys.filter((k) => !ACCEPTED_FIELDS.has(k));
    if (unknownKeys.length > 0) {
      return apiError(res, "VALIDATION_ERROR", {
        message: `unknown field(s): ${unknownKeys.join(", ")}; accepted fields: scheduleExpression, timezone, intent`,
      });
    }

    // An empty body carries no update — reject rather than bumping updatedAt for a no-op.
    if (bodyKeys.length === 0) {
      return apiError(res, "VALIDATION_ERROR", {
        message: "body must include at least one of: scheduleExpression, timezone, intent",
      });
    }

    const { validateScheduleExpression, validateScheduleIntent } = await import("@4evergent/database");
    const patch: Partial<ScheduleRecord> = {};

    if (bodyObj.intent !== undefined) {
      if (typeof bodyObj.intent !== "object" || bodyObj.intent === null || Array.isArray(bodyObj.intent)) {
        return apiError(res, "VALIDATION_ERROR", { message: "intent must be an object" });
      }
      const incomingIntent = bodyObj.intent as Record<string, unknown>;
      const mergedIntent: Record<string, unknown> = {
        ...schedule.intent,
        ...incomingIntent,
      };
      if (mergedIntent.asset === "XLM" && incomingIntent.assetDetails === undefined) {
        delete mergedIntent.assetDetails;
      }
      const intentValidation = validateScheduleIntent(mergedIntent as any);
      if (!intentValidation.valid) {
        return apiError(res, "VALIDATION_ERROR", { message: intentValidation.error });
      }
      patch.intent = mergedIntent as any;
    }

    if (bodyObj.scheduleExpression !== undefined || bodyObj.timezone !== undefined) {
      const nextExpression =
        bodyObj.scheduleExpression !== undefined
          ? (bodyObj.scheduleExpression as string)
          : schedule.scheduleExpression;
      const nextTimezone =
        bodyObj.timezone !== undefined
          ? (bodyObj.timezone as string)
          : schedule.timezone;
      const result = validateScheduleExpression(nextExpression, nextTimezone);
      if (!result.valid) return apiError(res, "VALIDATION_ERROR", { message: result.error });

      if (bodyObj.scheduleExpression !== undefined) {
        patch.scheduleExpression = nextExpression;
      }
      if (bodyObj.timezone !== undefined) {
        patch.timezone = nextTimezone;
      }
      patch.nextRunAt = result.nextRunAt ?? schedule.nextRunAt;
    }

    const updated = await schedules.update(scheduleId, patch);
    return json(res, { schedule: updated });
  }

  async function handleDeleteSchedule(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules\/([^/]+)$/);
    const agentId = match?.[1];
    const scheduleId = match?.[2];
    if (!agentId || !scheduleId) return apiError(res, "INVALID_PATH_PARAM");
    // Issue #385: bind the schedule to the agent named in the path.
    const canDelete = await authorizationService.canDeleteSchedule(ctx, scheduleId, agentId);
    if (!canDelete) return apiError(res, "AGENT_NOT_FOUND");
    const deleted = await schedules.delete(scheduleId);
    if (!deleted) return apiError(res, "SCHEDULE_NOT_FOUND");
    return json(res, { deleted: true });
  }

  async function handleScheduleAction(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules\/([^/]+)\/(pause|resume|disable)$/);
    const agentId = match?.[1];
    const scheduleId = match?.[2];
    const action = match?.[3] as "pause" | "resume" | "disable";
    if (!agentId || !scheduleId || !action) return apiError(res, "INVALID_PATH_PARAM");

    let allowed: boolean;
    // Issue #385: bind the schedule to the agent named in the path.
    if (action === "pause") {
      allowed = await authorizationService.canPauseSchedule(ctx, scheduleId, agentId);
    } else if (action === "resume") {
      allowed = await authorizationService.canResumeSchedule(ctx, scheduleId, agentId);
    } else {
      allowed = await authorizationService.canDisableSchedule(ctx, scheduleId, agentId);
    }
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");

    const schedule = await schedules.get(scheduleId);
    if (!schedule) return apiError(res, "SCHEDULE_NOT_FOUND");

    if (!SCHEDULE_TRANSITIONS[schedule.status]?.includes(action)) {
      return apiError(res, "SCHEDULE_INVALID_TRANSITION", { message: `cannot ${action} schedule in status '${schedule.status}'` });
    }

    const status = action === "pause" ? "paused" : action === "resume" ? "active" : "disabled";
    const updated = await schedules.update(scheduleId, { status });
    return json(res, { schedule: updated });
  }

  async function syncExecutionApprovalExpiry(execution: ExecutionRecord): Promise<void> {
    if (execution.status === "requires_approval" && execution.approvalId) {
      const approval = await approvals.get(execution.approvalId);
      if (approval && (approval.status === "expired" || (approval.expiresAt && new Date(approval.expiresAt) < new Date()))) {
        await executionStore.updateIfStatus(execution.id, "requires_approval", {
          status: "failed",
          error: "approval expired without decision",
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        execution.status = "failed";
        execution.error = "approval expired without decision";
        execution.completedAt = new Date().toISOString();
      }
    }
  }

  async function handleAgentExecutions(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/executions$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const all = await executionStore.listByAgent(agentId, limit + 1, offset);
    const executions = all.slice(0, limit);
    for (const e of executions) {
      await syncExecutionApprovalExpiry(e);
    }
    const hasMore = all.length > limit && !isOffsetAtCeiling(offset);
    return json(res, { agentId, executions, hasMore });
  }

  async function handleExecutionDetail(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/executions\/([^/]+)$/);
    const executionId = match?.[1];
    if (!executionId) return apiError(res, "INVALID_PATH_PARAM");
    const execution = await executionStore.getForOwner(executionId, ctx.ownerId!);
    if (!execution) return apiError(res, "EXECUTION_NOT_FOUND");
    await syncExecutionApprovalExpiry(execution);
    return json(res, { execution });
  }

  async function handleQueueStatus(ctx: RequestContext, _req: any, res: any) {
    if (!executionQueue) {
      return apiError(res, "EXECUTION_QUEUE_DISABLED");
    }
    const execCounts = await executionStore.countByOwner(ctx.ownerId!);
    const byStatus: Record<string, number> = {};
    for (const [status, count] of Object.entries(execCounts)) {
      if (count > 0) byStatus[status] = count;
    }
    return json(res, {
      running: executionQueue.isRunning(),
      byStatus,
    });
  }


  async function handleGetOverviewAttention(ctx: RequestContext, _req: any, res: any) {
    const ownerId = ctx.ownerId!;
    // #359: retrying and stuck are DEFINITIONAL, not status-derived. Before
    // this fix, `retryingExecutions` was literally `execCounts.queued` and
    // `stuckExecutions` was `execCounts.executing` — so any healthy queue
    // entry looked "retrying" and any young in-flight execution looked
    // "stuck". The predicates now live in the store (`countAttentionByOwner`)
    // so Overview and the Executions page (inferRetrying in
    // apps/web/src/pages/Executions.tsx) share exactly one definition.
    //
    // pending/failed/dead-letter still come from `countByOwner` below. Their
    // semantics are unchanged — this fix touches only retrying and stuck.
    const stuckOlderThan = new Date(Date.now() - STUCK_EXECUTION_THRESHOLD_MS).toISOString();
    const [pendingApprovals, execCounts, attention] = await Promise.all([
      approvals.countByOwner(ownerId, "pending_approval"),
      executionStore.countByOwner(ownerId),
      executionStore.countAttentionByOwner(ownerId, { stuckOlderThan }),
    ]);
    return json(res, {
      pendingApprovals,
      failedExecutions: execCounts.failed ?? 0,
      deadLetterExecutions: execCounts.dead_letter ?? 0,
      retryingExecutions: attention.retrying,
      stuckExecutions: attention.stuck,
    });
  }

  // ===== Global owner-scoped listing endpoints (N+1 elimination) =====
  // These exist so Web/CLI consumers can fetch all of an owner's executions
  // or activity in ONE request instead of N+1 per-agent requests. Owner
  // isolation is enforced by the store's listByOwner(ctx.ownerId, limit).

  async function handleListExecutions(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const all = await executionStore.listByOwner(ctx.ownerId!, limit + 1, offset);
    const executions = all.slice(0, limit);
    for (const e of executions) {
      await syncExecutionApprovalExpiry(e);
    }
    const hasMore = all.length > limit && !isOffsetAtCeiling(offset);
    return json(res, { executions, hasMore });
  }

  async function handleListActivity(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const statusFilter = parseStatusFilter(urlObj.searchParams.get("status"), ACTIVITY_STATUSES);
    if (!statusFilter.ok) return apiError(res, "VALIDATION_ERROR", { message: statusFilter.error });
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const all = await store.listByOwner(ctx.ownerId!, limit + 1, offset, statusFilter.status);
    const activity = all.slice(0, limit);
    const hasMore = all.length > limit && !isOffsetAtCeiling(offset);
    return json(res, { activity, hasMore });
  }

  async function handleRetryExecution(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/executions\/([^/]+)\/retry$/);
    const executionId = match?.[1];
    if (!executionId) return apiError(res, "INVALID_PATH_PARAM");

    if (!executionQueue) {
      return apiError(res, "EXECUTION_QUEUE_DISABLED");
    }

    const execution = await executionStore.getForOwner(executionId, ctx.ownerId!);
    if (!execution) return apiError(res, "EXECUTION_NOT_FOUND");

    if (execution.status !== "failed" && execution.status !== "dead_letter") {
      return apiError(res, "INVALID_EXECUTION_STATE", { message: `cannot retry execution in status '${execution.status}'` });
    }

    const maxRetries = executionQueue["retryPolicy"]?.maxRetries ?? 3;
    if (execution.attempt >= maxRetries) {
      return apiError(res, "MAX_RETRIES_REACHED", { message: `max retry attempts (${maxRetries}) reached` });
    }

    const result = await executionQueue.retry(executionId, maxRetries);
    if (result.status === "not_found") return apiError(res, "EXECUTION_NOT_FOUND");
    if (result.status === "invalid_state") return apiError(res, "INVALID_EXECUTION_STATE", { message: `cannot retry execution in status '${execution.status}'` });
    if (result.status === "max_retries_reached") return apiError(res, "MAX_RETRIES_REACHED", { message: `max retry attempts (${maxRetries}) reached` });
    if (result.status === "conflict") return apiError(res, "EXECUTION_CONFLICT");
    // #379: pre-check carries the full on-chain status now. A confirmed
    // transaction must never be re-submitted — retry() moves the record to
    // "submitted" so the reconciler confirms it. An ambiguous network state
    // must not trigger a blind re-submission either. Neither outcome is a
    // "queued for retry" event, so they get distinct responses here.
    if (result.status === "submitted") return apiError(res, "INVALID_EXECUTION_STATE", {
      message: "execution transaction was confirmed on-chain; re-submission is not allowed",
    });
    if (result.status === "ambiguous_submission") return apiError(res, "EXECUTION_CONFLICT", {
      message: "transaction status is ambiguous (network error); retry once Horizon is reachable",
    });

    return json(res, { execution: result.execution, message: "execution queued for retry" });
  }

  async function handleCancelExecution(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/executions\/([^/]+)\/cancel$/);
    const executionId = match?.[1];
    if (!executionId) return apiError(res, "INVALID_PATH_PARAM");

    if (!executionQueue) {
      return apiError(res, "EXECUTION_QUEUE_DISABLED");
    }

    const execution = await executionStore.getForOwner(executionId, ctx.ownerId!);
    if (!execution) return apiError(res, "EXECUTION_NOT_FOUND");

    if (execution.status !== "queued" && execution.status !== "executing") {
      return apiError(res, "INVALID_EXECUTION_STATE", { message: `cannot cancel execution in status '${execution.status}'` });
    }

    const result = await executionQueue.cancel(executionId);
    if (result.status === "not_found") return apiError(res, "EXECUTION_NOT_FOUND");
    if (result.status === "invalid_state") {
      const current = await executionStore.get(executionId);
      const currentStatus = current?.status ?? execution.status;
      let msg: string;
      if (currentStatus !== "executing") {
        msg = `cannot cancel execution in status '${currentStatus}'`;
      } else if (result.reason === "not_in_flight") {
        msg = "cannot cancel execution: execution is not actively running on this worker";
      } else {
        msg = "cannot cancel execution: pipeline has already begun submitting transaction";
      }
      return apiError(res, "INVALID_EXECUTION_STATE", { message: msg });
    }
    if (result.status === "conflict") return apiError(res, "EXECUTION_CONFLICT");

    return json(res, { execution: result.execution, message: "execution cancelled" });
  }

  async function handleIntent(ctx: RequestContext, req: any, res: any) {
    // #261: per-owner rate limit, checked before body parsing.
    if (!rateLimitGate(intentLimiter, ctx, res)) return;
    const agentId = extractAgentId(req.url);
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");

    let body: unknown;
    try {
      const text = await readBody(req);
      body = JSON.parse(text);
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    if (isRawTransaction(body)) {
      return apiError(res, "RAW_TRANSACTION_REJECTED");
    }

    let intent: AgentIntent;
    try {
      intent = parseIntent(body);
    } catch (e) {
      return apiError(res, "VALIDATION_ERROR", { message: (e as Error).message });
    }

    const validation = IntentValidator.validate(intent);
    if (!validation.valid) {
      return apiError(res, "VALIDATION_ERROR", { message: `Intent validation failed: ${validation.error}` });
    }

    if (!(await agentExists(agentId))) return apiError(res, "AGENT_NOT_FOUND");
    const canSubmit = await authorizationService.canSubmitIntent(ctx, agentId);
    if (!canSubmit) return apiError(res, "AGENT_NOT_FOUND");

    // Agent status admission boundary: only ACTIVE agents accept NEW intents.
    // Reads the CURRENT status from the persistent agent store so a paused or
    // disabled agent is rejected before policy evaluation, activity records,
    // or execution-queue entries are created. In-flight executions are not
    // affected — this gate only applies at intent submission time.
    const agent = await agentStore.get(agentId);
    if (!agent) return apiError(res, "AGENT_NOT_FOUND");
    if (agent.status !== "active") {
      return apiError(res, "AGENT_NOT_ACTIVE", { message: `agent is ${agent.status}; new intents are rejected` });
    }

    // Idempotency key from header (scoped to owner+agent)
    const idempotencyKey = extractHeader(req, "Idempotency-Key");
    if (idempotencyKey) {
      // Enforce bounded key length to prevent abuse
      if (idempotencyKey.length > 256) {
        return apiError(res, "IDEMPOTENCY_KEY_INVALID");
      }
    }

    // #371: serialize per (owner, agent, key) for the whole request. A
    // concurrent duplicate waits here, then the pre-check inside
    // handleIntentExecute replays the first request's record instead of
    // evaluating policy and executing a second time. Keyless requests
    // bypass the lock entirely.
    if (!idempotencyKey) {
      return handleIntentExecute(ctx, req, res, agentId, intent, null);
    }
    return withIdempotencyKeyLock(`${ctx.ownerId}:${agentId}:${idempotencyKey}`, () =>
      handleIntentExecute(ctx, req, res, agentId, intent, idempotencyKey)
    );
  }

  async function handleIntentExecute(ctx: RequestContext, req: any, res: any, agentId: string, intent: AgentIntent, idempotencyKey: string | null) {
    if (idempotencyKey) {
      const existing = await store.getByIdempotencyKey(ctx.ownerId!, agentId, idempotencyKey);
      if (existing) {
        // Same key + different intent → conflict
        const existingIntentJson = JSON.stringify(existing.intent);
        const newIntentJson = JSON.stringify(intent);
        if (existingIntentJson !== newIntentJson) {
          return apiError(res, "IDEMPOTENCY_CONFLICT");
        }
        // Duplicate request → return existing activity (idempotent success)
        return json(res, toIntentResponse(existing), 200);
      }
    }

    const decision = await policy.evaluate(intent, agentId);

    if (decision.result === "deny") {
      const outcome = await pipeline.execute({ intent, sourceAccount: { agentId, ownerId: ctx.ownerId } as any, idempotencyKey, policyDecision: decision });
      const denied = outcome.activityId ? await store.get(outcome.activityId) : null;
      return json(res, toIntentResponse(denied!), 403);
    }

    if (decision.result === "requires_approval") {
      const outcome = await pipeline.execute({ intent, sourceAccount: { agentId, ownerId: ctx.ownerId } as any, idempotencyKey, policyDecision: decision });
      if (outcome.status === "requires_approval" && outcome.activityId) {
        const pending = await store.get(outcome.activityId);
        assertNoSecrets(pending!);
        return json(res, { ...toIntentResponse(pending!), approvalId: outcome.approvalId }, 202);
      }
      const pending = await store.get(outcome.activityId ?? "");
      return json(res, toIntentResponse(pending!), 202);
    }

    // ALLOW → full execution path
    // Phase 26A: Sequence coordinator MUST wrap the entire sequence-sensitive
    // execution including getSourceAccount(). The coordinator key is the
    // Stellar public key (options.signer.getAccountId()).
    //
    // WHY: Without this, two concurrent ALLOW intents for the same Stellar
    // account could read the same Horizon sequence and build transactions with
    // the same sequence number. One would fail at Horizon.
    //
    // getSourceAccount() is called INSIDE the lock to prevent the race where
    // both executions read the sequence before either acquires the lock.
    const accountId = options.signer.getAccountId();
    const outcome = await sequenceCoordinator.runExclusive(accountId, async () => {
      let sourceAccount: any;
      try {
        const account = await adapter.getAccount(options.signer.getAccountId());
        sourceAccount = {
          accountId: () => account.address,
          sequenceNumber: () => account.sequence,
          incrementSequenceNumber: () => {},
          agentId,
          ownerId: ctx.ownerId!,
        };
      } catch (e) {
        // #353: the pipeline never ran, so it cannot release the reservation
        // made by policy.evaluate() above — release it here before throwing.
        await releaseDecisionReservation(agentId, decision);
        throw new Error(`Unable to load source account: ${(e as Error).message}`);
      }

      // #353: pass the handler's decision — the pipeline must NOT
      // re-evaluate (that would reserve daily spending a second time).
      return pipeline.execute({ intent, sourceAccount, idempotencyKey, policyDecision: decision });
    }).catch((e: any) => {
      return { status: "failed", message: e?.message ?? "Unknown error" } as any;
    });

    // Handle the failure case from getSourceAccount() inside the lock
    if (outcome.status === "failed") {
      const failed = makeActivity(intent, agentId, ctx.ownerId!, decision, "failed", null, outcome.message ?? "Unknown error");
      failed.idempotencyKey = idempotencyKey;
      await store.record(failed);
      return json(res, toIntentResponse(failed), 502);
    }

    if (outcome.status === "submitted") {
      if (outcome.activityId) {
        const submitted = await store.get(outcome.activityId);
        if (submitted) {
          assertNoSecrets(submitted);
          return json(res, toIntentResponse(submitted), 200);
        }
      }
      // Fallback: pipeline returned submitted but no activity id (store-less mode)
      return json(res, {
        activityId: "",
        agentId,
        status: "submitted",
        policyDecision: decision,
        authorizationStatus: "approved",
        simulationResult: outcome.simulationResult,
        txHash: outcome.txHash,
        error: null,
      }, 200);
    }

    if (outcome.status === "simulation_failed") {
      const failed = outcome.activityId ? await store.get(outcome.activityId) : null;
      return json(res, toIntentResponse(failed!), 422);
    }

    const rejected = outcome.activityId ? await store.get(outcome.activityId) : null;
    return json(res, toIntentResponse(rejected!), 403);
  }

  async function handleApprove(ctx: RequestContext, req: any, res: any) {
    // #261: per-owner rate limit, checked before body parsing.
    if (!rateLimitGate(approveLimiter, ctx, res)) return;
    const approvalId = extractApprovalId(req.url);
    if (!approvalId) return apiError(res, "INVALID_PATH_PARAM");

    let body: unknown = {};
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    if (isRawTransaction(body)) {
      return approvalError(res, "RAW_TRANSACTION_REJECTED", { approvalId, activityId: "", status: "rejected", message: "raw XDR and transaction blobs are not accepted at the approve endpoint" });
    }

    // Phase 28K-2: Actor from authenticated principal subject
    const approver = ctx.principal?.subject ?? ctx.ownerId!;

    const approval = await approvals.get(approvalId);
    if (!approval) {
      return approvalError(res, "APPROVAL_NOT_FOUND", { approvalId, activityId: "", status: "rejected", message: "approval not found" });
    }

    const canApprove = await authorizationService.canApprove(ctx, approvalId);
    if (!canApprove) return approvalError(res, "APPROVAL_NOT_FOUND", { approvalId, activityId: "", status: "rejected", message: "approval not found" });

    if (approval.status === "expired" || (approval.expiresAt && new Date(approval.expiresAt) < new Date())) {
      if (approval.status !== "expired") {
        await approvals.update(approvalId, { status: "expired", expiredAt: new Date().toISOString() });
        // #353: expired approval will never execute — release the reservation
        // made when the intent was created.
        await releaseDecisionReservation(approval.agentId, approval.policyDecision);
      }
      return approvalError(res, "APPROVAL_EXPIRED", { approvalId, activityId: approval.activityId, status: "expired", message: "approval expired" });
    }

    const transitionError = validateApprovalTransition(approval.status, "approved");
    if (transitionError) {
      return approvalError(res, "APPROVAL_INVALID_STATE", { approvalId, activityId: approval.activityId, status: approval.status, message: `cannot approve: ${transitionError}` });
    }

    // Incident-response boundary: approving an intent for a non-active agent is rejected.
    // Paused: pending approvals remain in `pending_approval` until TTL expiry, but cannot
    // be approved (`agent is paused; cannot approve intent`). If resumed to active, approval is permitted.
    // Disabled: terminal state. Approve is rejected (`agent is disabled; cannot approve intent`).
    const agent = (await agentStore.get(approval.agentId)) ?? agents.get(approval.agentId);
    if (!agent) {
      return approvalError(res, "AGENT_NOT_FOUND", { approvalId, activityId: approval.activityId, status: approval.status, message: "agent not found" });
    }
    if (agent.status !== "active") {
      return approvalError(res, "AGENT_NOT_ACTIVE", {
        approvalId,
        activityId: approval.activityId,
        status: approval.status,
        message: `agent is ${agent.status}; cannot approve intent`,
      });
    }

    // Atomic claim: pending_approval → approved in one conditional step.
    // A concurrent approve/reject that lands first wins; this request then
    // gets null and returns 409 instead of enqueueing a second execution.
    // (The transition check above still rejects a SEQUENTIAL second decision
    // — e.g. approve after reject — with APPROVAL_INVALID_STATE.)
    const claimed = await approvals.updateIfStatus(approvalId, "pending_approval", { status: "approved", approvedAt: new Date().toISOString(), approver: approver ?? null });
    if (!claimed) {
      const current = await approvals.get(approvalId);
      return approvalError(res, "APPROVAL_CONFLICT", { approvalId, activityId: approval.activityId, status: current?.status ?? approval.status, message: `approval already decided (now ${current?.status ?? approval.status}); refresh before retrying` });
    }

    // Enqueue for execution via the persistent execution queue.
    // If the queue is not enabled, fall back to setImmediate (Phase 8 behavior).
    if (options.deferExecution) {
      // execution deferred intentionally — no action taken here
    } else if (executionQueue) {
      // #351: if an execution record already exists in requires_approval for this approval,
      // transition it to queued rather than creating a duplicate record.
      const existing = await executionStore.getByApprovalId(approvalId);
      if (existing && existing.status === "requires_approval") {
        await executionStore.updateIfStatus(existing.id, "requires_approval", {
          status: "queued",
          approvalId,
          updatedAt: new Date().toISOString(),
        });
      } else {
        const now = new Date().toISOString();
        const executionRecord: ExecutionRecord = {
          id: crypto.randomUUID(),
          ownerId: approval.ownerId,
          agentId: approval.agentId,
          approvalId,
          activityId: approval.activityId,
          intent: approval.intent,
          status: "queued",
          policyDecision: approval.policyDecision,
          simulationResult: null,
          txHash: null,
          submittedHash: null,
          error: null,
          attempt: 0,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: now,
          updatedAt: now,
        };
        try {
          await executionQueue.enqueue(executionRecord);
        } catch (err: unknown) {
          log("error", "failed to enqueue approved execution", {
            approvalId,
            activityId: approval.activityId,
            error: err instanceof Error ? err.message : String(err),
          });
          return apiError(res, "INTERNAL_ERROR");
        }
      }
    } else {
      // Fallback: Phase 8 fire-and-forget behavior
      // Phase 26A: Must also use sequence coordinator
      const accountId = options.signer.getAccountId();
      setImmediate(() => {
        sequenceCoordinator.runExclusive(accountId, async () => {
          return pipeline.executeApproved(approvalId, approver);
        }).catch(() => {});
      });
    }

    return json(res, toApprovalResponse(approvalId, approval.activityId, "approved", "approval accepted; transaction queued for execution"), 200);

  }

  async function handleReject(ctx: RequestContext, req: any, res: any) {
    // #261: per-owner rate limit, checked before body parsing.
    if (!rateLimitGate(rejectLimiter, ctx, res)) return;
    const approvalId = extractApprovalId(req.url);
    if (!approvalId) return apiError(res, "INVALID_PATH_PARAM");

    let body: unknown = {};
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    if (isRawTransaction(body)) {
      return approvalError(res, "RAW_TRANSACTION_REJECTED", { approvalId, activityId: "", status: "rejected", message: "raw XDR and transaction blobs are not accepted at the reject endpoint" });
    }

    const approval = await approvals.get(approvalId);
    if (!approval) {
      return approvalError(res, "APPROVAL_NOT_FOUND", { approvalId, activityId: "", status: "rejected", message: "approval not found" });
    }

    const canReject = await authorizationService.canReject(ctx, approvalId);
    if (!canReject) return approvalError(res, "APPROVAL_NOT_FOUND", { approvalId, activityId: "", status: "rejected", message: "approval not found" });

    if (approval.status === "expired" || (approval.expiresAt && new Date(approval.expiresAt) < new Date())) {
      if (approval.status !== "expired") {
        await approvals.update(approvalId, { status: "expired", expiredAt: new Date().toISOString() });
        await releaseDecisionReservation(approval.agentId, approval.policyDecision);
      }
      return approvalError(res, "APPROVAL_EXPIRED", { approvalId, activityId: approval.activityId, status: "expired", message: "approval expired" });
    }

    const transitionError = validateApprovalTransition(approval.status, "rejected");
    if (transitionError) {
      return approvalError(res, "APPROVAL_INVALID_STATE", { approvalId, activityId: approval.activityId, status: approval.status, message: `cannot reject: ${transitionError}` });
    }

    // Atomic claim: pending_approval → rejected in one conditional step.
    // A concurrent approve/reject that lands first wins; this request then
    // gets null and returns 409 with no state change and no execution record.
    // (The transition check above still rejects a SEQUENTIAL second decision
    // — e.g. reject after approve — with APPROVAL_INVALID_STATE.)
    const claimed = await approvals.updateIfStatus(approvalId, "pending_approval", { status: "rejected", rejectedAt: new Date().toISOString() });
    if (!claimed) {
      const current = await approvals.get(approvalId);
      return approvalError(res, "APPROVAL_CONFLICT", { approvalId, activityId: approval.activityId, status: current?.status ?? approval.status, message: `approval already decided (now ${current?.status ?? approval.status}); refresh before retrying` });
    }
    await store.update(approval.activityId, { status: "rejected", authorizationStatus: "denied_by_approver", error: "approval rejected by human" });
    // #351: if a linked execution exists in requires_approval, mark it failed
    const linkedExecution = await executionStore.getByApprovalId(approvalId);
    if (linkedExecution && linkedExecution.status === "requires_approval") {
      await executionStore.updateIfStatus(linkedExecution.id, "requires_approval", {
        status: "failed",
        error: "approval rejected by human",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    // #353: rejected approval will never execute — release the reservation
    // made when the intent was created.
    await releaseDecisionReservation(approval.agentId, approval.policyDecision);

    return json(res, toApprovalResponse(approvalId, approval.activityId, "rejected", "approval rejected"), 200);
  }

  function toIntentResponse(rec: ActivityRecord): IntentResponse {
    return {
      activityId: rec.id,
      agentId: rec.agentId,
      status: rec.status,
      policyDecision: rec.policyDecision,
      authorizationStatus: rec.authorizationStatus ?? "not_required",
      simulationResult: rec.simulationResult,
      txHash: rec.txHash,
      error: rec.error,
    };
  }

  // Approve/reject errors keep the ApprovalResponse fields (including `message`)
  // and add the structured `code` and `error` so every error carries a code.
  function approvalError(res: any, code: ApiErrorCode, r: { approvalId: string; activityId: string; status: ApprovalStatus; message: string }) {
    const def = API_ERRORS[code];
    return json(res, { code, error: r.message, ...toApprovalResponse(r.approvalId, r.activityId, r.status, r.message) }, def.status);
  }

  function toApprovalResponse(approvalId: string, activityId: string, status: ApprovalStatus, message: string): ApprovalResponse {
    return { approvalId, activityId, agentId: "", status, message };
  }

  return {
    server,
    // Bind host is configurable so the server can be hosted behind a container
    // or reverse proxy. Defaults to loopback: local development and the test
    // suite stay reachable only from this machine unless a caller explicitly
    // opts into a wider bind. See apps/api/src/server.ts — production startup
    // fails closed when HOST is non-loopback and API_KEYS is unset.
    listen: (port: number, host: string = "127.0.0.1") =>
      new Promise<void>((resolve) => server.listen(port, host, resolve)),
    close: (closeOptions?: { drainTimeoutMs?: number }) =>
      new Promise<void>((resolve, reject) => {
        // 1. Stop accepting new requests and prevent workers from claiming new work.
        if (scheduler) {
          scheduler.stop();
          console.log("[scheduler] stopped");
        }
        if (executionQueue) {
          executionQueue.stop();
          console.log("[execution-queue] stopped");
        }
        if (reconciler) {
          reconciler.stop();
          console.log("[reconciler] stopped");
        }
        if (approvalRecovery.isRunning()) {
          approvalRecovery.stop();
          console.log("[approval-recovery] stopped");
        }
        if (retentionTimer) {
          clearInterval(retentionTimer);
          retentionTimer = null;
        }

        // Close idle keep-alive connections so idle sockets do not keep the server open,
        // while allowing in-flight HTTP requests to complete.
        server.closeIdleConnections?.();
        const idleInterval = setInterval(() => {
          server.closeIdleConnections?.();
        }, 20);

        let drainTimer: NodeJS.Timeout | null = null;
        let completed = false;

        const finish = () => {
          if (completed) return;
          completed = true;
          clearInterval(idleInterval);
          if (drainTimer) {
            clearTimeout(drainTimer);
            drainTimer = null;
          }
          resolve();
        };

        const closeDatabase = () => {
          try {
            store.close?.();
            approvals.close?.();
            schedules.close?.();
            agentStore.close?.();
            policyConfigStore.close?.();
            executionStore.close?.();
            authModule?.close?.();
            if (options.dbPath) {
              closeSharedConnection(options.dbPath, true);
            }
          } catch (err) {
            console.error("[database] error closing database:", err);
          }
        };

        const drainTimeout = closeOptions?.drainTimeoutMs;
        if (drainTimeout !== undefined && drainTimeout > 0) {
          drainTimer = setTimeout(() => {
            if (completed) return;
            completed = true;
            clearInterval(idleInterval);
            drainTimer = null;
            // 3. Force-close remaining connections and terminate outstanding work after timeout expires.
            server.closeAllConnections?.();
            executionQueue?.abortInFlight();
            closeDatabase();
            const err = new Error(`Shutdown timeout of ${drainTimeout}ms exceeded — forcing exit`);
            err.name = "ShutdownTimeoutError";
            reject(err);
          }, drainTimeout);
        }

        // 2. Allow active HTTP requests and in-flight executions to finish within the configured drain timeout.
        const httpClose = new Promise<void>((r) => {
          server.close(() => r());
        });
        const queueDrain = executionQueue ? executionQueue.drain(drainTimeout) : Promise.resolve();

        Promise.all([httpClose, queueDrain])
          .then(() => {
            closeDatabase();
            finish();
          })
          .catch((err) => {
            if (drainTimer) clearTimeout(drainTimer);
            closeDatabase();
            reject(err);
          });
      }),
    registerAgent: (agent: Agent) => {
      agents.set(agent.id, agent);
      void agentStore.create({
        id: agent.id,
        displayName: agent.displayName,
        description: agent.description,
        capabilities: agent.capabilities,
        ownerId: agent.ownerId,
        stellarAddress: agent.stellarAddress,
        status: agent.status,
      }).catch(() => {});
    },
    store,
    approvals,
    executionStore,
    agentStore,
    scheduler,
    executionQueue,
    recoveryService,
    scheduleRecoveryService,
  };
}

function makeActivity(
  intent: AgentIntent,
  agentId: string,
  ownerId: string,
  policyDecision: PolicyDecision,
  status: string,
  authorizationStatus: string | null,
  error: string | null
): ActivityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId,
    ownerId,
    intent,
    policyDecision,
    authorizationStatus: authorizationStatus as any,
    simulationResult: null,
    txHash: null,
    status: status as any,
    error,
    createdAt: now,
    updatedAt: now,
  };
}

function apiError(
  res: any,
  code: ApiErrorCode,
  opts: { message?: string; details?: unknown; extra?: Record<string, unknown> } = {},
) {
  const def = API_ERRORS[code];
  const body: Record<string, unknown> = { code, error: opts.message ?? def.message };
  if (opts.details !== undefined) body.details = opts.details;
  // `extra` spreads additional top-level fields into the documented envelope,
  // e.g. conflict details such as currentStatus/requestedStatus. Optional and
  // unused by existing callers, so behavior is unchanged for them.
  if (opts.extra) Object.assign(body, opts.extra);
  return json(res, body, def.status);
}

/**
 * Legal schedule actions per current status. No-ops (pause when paused,
 * resume when active, disable when disabled) are rejected so callers get a
 * signal that nothing changed. `disabled` stays reversible via resume,
 * matching the dashboard's Resume button for disabled schedules.
 */
const SCHEDULE_TRANSITIONS: Record<string, ReadonlyArray<"pause" | "resume" | "disable">> = {
  active: ["pause", "disable"],
  paused: ["resume", "disable"],
  disabled: ["resume"],
};

function json(res: any, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function extractHeader(req: any, name: string): string | null {
  const raw = req.headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] || null;
  if (typeof raw === "string") return raw;
  return null;
}

function extractAgentId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/^\/agents\/([^/]+)\/intents$/);
  return match?.[1] ?? null;
}

function extractApprovalId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/^\/approvals\/([^/]+)\/(approve|reject)$/);
  return match?.[1] ?? null;
}

function isRawTransaction(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.xdr === "string" ||
    typeof b.envelope === "string" ||
    typeof b.transaction === "string" ||
    Array.isArray(b.operations) ||
    typeof b.tx_blob === "string"
  );
}

function parseIntent(body: unknown): AgentIntent {
  if (typeof body !== "object" || body === null) throw new Error("intent must be an object");
  const b = body as Record<string, unknown>;
  if (typeof b.type !== "string") throw new Error("intent.type is required");
  switch (b.type) {
    case "payment": {
      if (typeof b.asset !== "string") throw new Error("payment.asset is required");
      if (typeof b.destination !== "string") throw new Error("payment.destination is required");
      if (typeof b.amount !== "string") throw new Error("payment.amount is required as string");
      // Strict amount (#264): parseFloat would read 10 out of "10abc" and
      // 100 out of "1e2". Reject anything that is not a canonical Stellar
      // decimal (digits, optional "." + 1–7 fractional digits).
      if (parseStrictAmount(b.amount) === null) {
        throw new Error("payment.amount must be a valid Stellar amount (digits with up to 7 decimal places)");
      }
      if (typeof b.reason !== "string") throw new Error("payment.reason is required");
      let validatedDetails: { code: string; issuer: string | null } | undefined;
      const assetDetails = (b.assetDetails as { code?: unknown; issuer?: unknown } | undefined);
      if (assetDetails !== undefined) {
        if (typeof assetDetails.code !== "string" || assetDetails.code.length < 1 || assetDetails.code.length > 12) {
          throw new Error("payment.assetDetails.code must be a Stellar asset code (1-12 characters)");
        }
        if (assetDetails.code === "XLM") {
          if (assetDetails.issuer != null && assetDetails.issuer !== "") {
            throw new Error("payment.assetDetails.issuer must be null for XLM");
          }
          validatedDetails = { code: "XLM", issuer: null };
        } else {
          if (typeof assetDetails.issuer !== "string" || !assetDetails.issuer.startsWith("G") || assetDetails.issuer.length !== 56) {
            throw new Error("payment.assetDetails.issuer must be a valid Stellar address (G...)");
          }
          validatedDetails = { code: assetDetails.code, issuer: assetDetails.issuer };
        }
      }
      return {
        type: "payment",
        asset: b.asset,
        assetDetails: validatedDetails,
        destination: b.destination,
        amount: b.amount,
        reason: b.reason,
        memo: typeof b.memo === "string" ? b.memo : undefined,
      };
    }
    case "trustline": {
      if (typeof b.assetCode !== "string" || b.assetCode.length < 1 || b.assetCode.length > 12) {
        throw new Error("trustline.assetCode must be a Stellar asset code (1-12 characters)");
      }
      if (b.assetCode === "XLM") throw new Error("XLM cannot be used as a trustline asset");
      if (typeof b.issuer !== "string" || !b.issuer.startsWith("G") || b.issuer.length !== 56) {
        throw new Error("trustline.issuer must be a valid Stellar address (G...)");
      }
      if (typeof b.limit === "string" && b.limit.trim().length > 0 && parseStrictAmount(b.limit) === null) {
        throw new Error("trustline.limit must be a valid Stellar amount (digits with up to 7 decimal places)");
      }
      if (typeof b.reason !== "string") throw new Error("trustline.reason is required");
      return {
        type: "trustline",
        assetCode: b.assetCode,
        issuer: b.issuer,
        limit: typeof b.limit === "string" && b.limit.trim().length > 0 ? b.limit : undefined,
        reason: b.reason,
      };
    }
    case "contract_call": {
      if (typeof b.contractId !== "string" || b.contractId.trim().length === 0) {
        throw new Error("contract_call.contractId is required");
      }
      if (typeof b.function !== "string" || b.function.trim().length === 0) {
        throw new Error("contract_call.function is required");
      }
      if (b.args !== undefined && !Array.isArray(b.args)) {
        throw new Error("contract_call.args must be an array");
      }
      if (typeof b.reason !== "string" || b.reason.trim().length === 0) {
        throw new Error("contract_call.reason is required");
      }
      return {
        type: "contract_call",
        contractId: b.contractId,
        function: b.function,
        args: Array.isArray(b.args) ? b.args : [],
        reason: b.reason,
      };
    }
    case "account_settings": {
      if (typeof b.setting !== "string" || b.setting.trim().length === 0) {
        throw new Error("account_settings.setting is required");
      }
      if (typeof b.reason !== "string") throw new Error("account_settings.reason is required");
      return {
        type: "account_settings",
        setting: b.setting,
        value: b.value,
        reason: b.reason,
      };
    }
    default:
      throw new Error(`unknown intent type: ${b.type}`);
  }
}

void TESTNET_PASSPHRASE;
