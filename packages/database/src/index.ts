import type {
  ActivityRecord,
  AgentIntent,
  AuthorizationStatus,
  PolicyDecision,
  SimulationResult,
  ScheduleStatus,
} from "@4evergent/shared";
import { toStroops } from "@4evergent/shared";
import { clampOffset, clampLimit } from "./pagination.js";
import {
  idempotencyCutoff,
  resolveIdempotencyWindowMs,
  type ActivityStoreOptions,
} from "./idempotency-window.js";

export {
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  idempotencyCutoff,
  resolveIdempotencyWindowMs,
  type ActivityStoreOptions,
} from "./idempotency-window.js";

/**
 * ActivityStore — persistence interface for the transaction activity log.
 *
 * The store is keyed by activity id and records the FULL decision trail for
 * every intent the pipeline touches, including the ones it rejects. It NEVER
 * stores private keys, seeds, or mnemonics — the ActivityRecord type has no
 * field for secret material, by construction.
 */
export interface ActivityStore {
  record(record: ActivityRecord): Promise<void>;
  get(id: string): Promise<ActivityRecord | null>;
  /** List activity for an agent. `status` filters at the store level so that
   *  `offset`/`limit` page over the FILTERED set, not the unfiltered one. */
  listByAgent(agentId: string, limit?: number, offset?: number, status?: string): Promise<ActivityRecord[]>;
  listByStatus(agentId: string, status: string, limit?: number, offset?: number): Promise<ActivityRecord[]>;
  listAll(limit?: number, offset?: number): Promise<ActivityRecord[]>;
  /** List activity for an owner. `status` filters at the store level (see listByAgent). */
  listByOwner(ownerId: string, limit?: number, offset?: number, status?: string): Promise<ActivityRecord[]>;
  getForOwner(id: string, ownerId: string): Promise<ActivityRecord | null>;
  update(id: string, patch: Partial<ActivityRecord>): Promise<ActivityRecord | null>;
  getByIdempotencyKey(ownerId: string, agentId: string, key: string): Promise<ActivityRecord | null>;
  recordIdempotent(key: string, record: ActivityRecord): Promise<{ record: ActivityRecord; created: boolean }>;
  /**
   * #109: release the Idempotency-Key of at most `limit` activities created
   * before `cutoff` (ISO-8601). Only the key is cleared; the activity record
   * (the audit trail) is never deleted. Returns the number of keys released.
   */
  releaseExpiredIdempotencyKeys?(cutoff: string, limit?: number): Promise<number>;
  /** Atomically reserve daily spending. Returns true if reservation succeeded, false if limit would be exceeded. */
  reserveDailySpending(agentId: string, asset: string, amount: string, limit: string, now?: Date): Promise<boolean>;
  /**
   * Release a previously reserved amount (#353). Decrements the day's total
   * for (agentId, asset) by `amount`, floored at 0; a no-op when nothing was
   * reserved. Callers MUST only release amounts proven reserved (see
   * PolicyDecision.reservedDailySpending) — releasing an unreserved amount
   * would free another intent's reservation.
   */
  releaseDailySpending(agentId: string, asset: string, amount: string, now?: Date): Promise<void>;
  /** Get current day's reserved total for an agent, in INTEGER STROOPS (#374),
   *  or null when nothing is reserved. Convert to a decimal at the boundary
   *  (`fromStroops`); the enforcement path compares these integers directly. */
  getDailySpending(agentId: string, asset: string, now?: Date): Promise<number | null>;
  /** Remove at most `limit` rows with a UTC day earlier than cutoffDay. */
  sweepDailySpending(cutoffDay: string, limit?: number): Promise<number>;
  close?(): void;
}

/**
 * ApprovalStore — persistence interface for transaction approval records.
 *
 * An ApprovalRecord tracks the lifecycle of a transaction that requires
 * human/authoritative approval before it can be signed and submitted.
 *
 * State machine:
 *   PENDING_APPROVAL → APPROVED → EXECUTING → SUBMITTED/CONFIRMED/FAILED
 *   PENDING_APPROVAL → REJECTED
 *   PENDING_APPROVAL → EXPIRED
 *
 * Approval records NEVER store private keys, transaction blobs, or XDR.
 */
export interface ApprovalStore {
  record(record: ApprovalRecord): Promise<void>;
  get(id: string): Promise<ApprovalRecord | null>;
  /** List approvals for an agent. `status` filters at the store level so that
   *  `offset`/`limit` page over the FILTERED set, not the unfiltered one. */
  listByAgent(agentId: string, limit?: number, offset?: number, status?: string): Promise<ApprovalRecord[]>;
  listByStatus(agentId: string, status: string, limit?: number, offset?: number): Promise<ApprovalRecord[]>;
  listAll(limit?: number, offset?: number): Promise<ApprovalRecord[]>;
  /** List approvals for an owner. `status` filters at the store level (see listByAgent). */
  listByOwner(ownerId: string, limit?: number, offset?: number, status?: string): Promise<ApprovalRecord[]>;
  /** Count approvals for an owner. `status` filters at the store level (see listByOwner).
   *  Unlike list*, this is never capped, so callers get the true total. */
  countByOwner(ownerId: string, status?: string): Promise<number>;
  getForOwner(id: string, ownerId: string): Promise<ApprovalRecord | null>;
  update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null>;
  /**
   * Atomic compare-and-swap: apply `patch` only if the record's current
   * status is `expectedStatus`, else return null without changing anything.
   * The claim (pending_approval → approved / rejected) in the API approve /
   * reject handlers goes through this so two concurrent decisions cannot both
   * win: exactly one claimer gets the record, the loser gets null (→ 409).
   * InMemory checks-and-sets synchronously; SQLite does it in a single
   * conditional UPDATE ... WHERE status = ? statement.
   */
  updateIfStatus(id: string, expectedStatus: ApprovalStatus, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null>;
  /**
   * Transition pending approvals past their expiresAt to 'expired'.
   * Bounded by `limit`. Calls `onSwept` for each transitioned record.
   * Returns the count of transitioned records.
   */
  sweepExpired(now?: string, limit?: number, onSwept?: (record: ApprovalRecord) => void | Promise<void>): Promise<number>;
  close?(): void;
}

export type ApprovalStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "submitted"
  | "confirmed"
  | "failed";

export interface ApprovalRecord {
  id: string;
  activityId: string;
  agentId: string;
  ownerId: string;
  intent: AgentIntent;
  policyDecision: PolicyDecision;
  status: ApprovalStatus;
  requestedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  expiredAt: string | null;
  approver: string | null;
  expiresAt: string | null;
  txHash: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}


/**
 * InMemoryActivityStore — process-local activity log.
 *
 * LIMITATION: not durable. Records are lost when the process exits. This is
 * acceptable for MVP/development; the interface is what production code
 * depends on, so a Postgres-backed implementation can replace it without
 * touching the pipeline.
 */
export class InMemoryActivityStore implements ActivityStore {
  private records = new Map<string, ActivityRecord>();
  /** #374: values are INTEGER stroops (1 XLM = 10^7 stroops), not decimal XLM. */
  private dailySpending = new Map<string, number>();
  private idempotencyLock: Promise<unknown> = Promise.resolve();
  /** Serializes daily-spending check+commit per store instance (atomicity). */
  private dailySpendingLock: Promise<unknown> = Promise.resolve();
  /** #109: Idempotency-Key replay window. */
  readonly idempotencyWindowMs: number;
  private readonly now: () => number;

  constructor(options: ActivityStoreOptions = {}) {
    this.idempotencyWindowMs = resolveIdempotencyWindowMs(options.idempotencyWindowMs);
    this.now = options.now ?? Date.now;
  }

  async record(record: ActivityRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async get(id: string): Promise<ActivityRecord | null> {
    return this.records.get(id) ?? null;
  }

  async listByAgent(agentId: string, limit = 50, offset = 0, status?: string): Promise<ActivityRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId && (status === undefined || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(clampOffset(offset), clampOffset(offset) + clampLimit(limit));
  }

  async listByStatus(agentId: string, status: string, limit = 50, offset = 0): Promise<ActivityRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId && r.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(clampOffset(offset), clampOffset(offset) + clampLimit(limit));
  }

  async listAll(limit = 50, offset = 0): Promise<ActivityRecord[]> {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(clampOffset(offset), clampOffset(offset) + clampLimit(limit));
  }

  async listByOwner(ownerId: string, limit = 50, offset = 0, status?: string): Promise<ActivityRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.ownerId === ownerId && (status === undefined || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(clampOffset(offset), clampOffset(offset) + clampLimit(limit));
  }

  async getForOwner(id: string, ownerId: string): Promise<ActivityRecord | null> {
    const rec = this.records.get(id);
    return rec?.ownerId === ownerId ? rec : null;
  }

  /**
   * #109: only a key bound to an activity created inside the replay window
   * is returned. An older binding no longer suppresses a new request.
   */
  async getByIdempotencyKey(ownerId: string, agentId: string, key: string): Promise<ActivityRecord | null> {
    const cutoff = idempotencyCutoff(this.now(), this.idempotencyWindowMs);
    for (const rec of this.records.values()) {
      if (rec.ownerId === ownerId && rec.agentId === agentId && rec.idempotencyKey === key && rec.createdAt >= cutoff) {
        return rec;
      }
    }
    return null;
  }

  async releaseExpiredIdempotencyKeys(cutoff: string, limit = 500): Promise<number> {
    let released = 0;
    for (const rec of this.records.values()) {
      if (released >= limit) break;
      if (rec.idempotencyKey && rec.createdAt < cutoff) {
        rec.idempotencyKey = null;
        released++;
      }
    }
    return released;
  }

  /** Clear the key of an expired binding so the key can be bound again (#109). */
  private releaseExpiredBinding(ownerId: string, agentId: string, key: string): void {
    const cutoff = idempotencyCutoff(this.now(), this.idempotencyWindowMs);
    for (const rec of this.records.values()) {
      if (rec.ownerId === ownerId && rec.agentId === agentId && rec.idempotencyKey === key && rec.createdAt < cutoff) {
        rec.idempotencyKey = null;
      }
    }
  }

  /**
   * Atomic idempotency reservation for InMemory store.
   *
   * Uses a promise chain to serialize get-check-insert operations,
   * mimicking the atomicity provided by SQLite's UNIQUE INDEX.
   */
  async recordIdempotent(key: string, record: ActivityRecord): Promise<{ record: ActivityRecord; created: boolean }> {
    // Serialize through promise chain for atomicity
    const result = this.idempotencyLock.then(async () => {
      const existing = await this.getByIdempotencyKey(record.ownerId, record.agentId, key);
      if (existing) return { record: existing, created: false };
      this.releaseExpiredBinding(record.ownerId, record.agentId, key);
      record.idempotencyKey = key;
      this.records.set(record.id, record);
      return { record, created: true };
    });
    // Update lock to include this operation (catch errors to avoid breaking chain)
    this.idempotencyLock = result.catch(() => undefined);
    return result;
  }

  async reserveDailySpending(agentId: string, asset: string, amount: string, limit: string, now = new Date()): Promise<boolean> {
    // #374: compare integer stroops, not REAL XLM. Float addition drifts the
    // ledger and falsely denies exact-limit intents; integer stroops compare
    // exactly to the stroop. A non-canonical amount/limit (null from
    // toStroops) is rejected, matching the strict parser (#264).
    const amountStroops = toStroops(amount);
    const limitStroops = toStroops(limit);
    if (amountStroops === null || limitStroops === null) return false;

    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      .toISOString()
      .slice(0, 10);

    const mapKey = `${agentId}:${asset}:${day}`;

    // Serialize check+commit through a per-instance promise chain so two
    // concurrent reservations cannot both read the same "current" value and
    // both commit past the limit. Mirrors recordIdempotent's approach; SQLite
    // achieves the same via a conditional UPDATE.
    const result = this.dailySpendingLock.then(() => {
      const current = this.dailySpending.get(mapKey) ?? 0;
      if (current + amountStroops > limitStroops) return false;
      this.dailySpending.set(mapKey, current + amountStroops);
      return true;
    });
    this.dailySpendingLock = result.catch(() => undefined);
    return result;
  }

  /**
   * #374: returns the current UTC day's reserved total in INTEGER STROOPS,
   * or null when nothing is reserved. Convert to a decimal at the boundary;
   * the enforcement path compares these integers directly.
   */
  async getDailySpending(agentId: string, asset: string, now = new Date()): Promise<number | null> {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      .toISOString().slice(0, 10);
    const mapKey = `${agentId}:${asset}:${day}`;
    return this.dailySpending.get(mapKey) ?? null;
  }

  async releaseDailySpending(agentId: string, asset: string, amount: string, now = new Date()): Promise<void> {
    // #374: release integer stroops, matching the reservation unit.
    const amountStroops = toStroops(amount);
    if (amountStroops === null || amountStroops <= 0) return;

    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      .toISOString()
      .slice(0, 10);

    const mapKey = `${agentId}:${asset}:${day}`;

    // Serialize through the same promise chain as reserveDailySpending so a
    // release cannot interleave with a concurrent reserve check+commit.
    // Floored at 0: releasing more than reserved (caller bug / stale
    // decision) must never drive the total negative or free another
    // intent's reservation beyond zeroing this key.
    const result = this.dailySpendingLock.then(() => {
      const current = this.dailySpending.get(mapKey) ?? 0;
      const next = current - amountStroops;
      if (next <= 0) this.dailySpending.delete(mapKey);
      else this.dailySpending.set(mapKey, next);
    });
    this.dailySpendingLock = result.catch(() => undefined);
    return result;
  }

  async sweepDailySpending(cutoffDay: string, limit = 500): Promise<number> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDay) || !Number.isInteger(limit) || limit <= 0) return 0;
    let removed = 0;
    for (const key of this.dailySpending.keys()) {
      const day = key.slice(key.lastIndexOf(":") + 1);
      if (day < cutoffDay) {
        this.dailySpending.delete(key);
        removed++;
        if (removed >= limit) break;
      }
    }
    return removed;
  }

  async update(id: string, patch: Partial<ActivityRecord>): Promise<ActivityRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(id, updated);
    return updated;
  }

  close(): void {}
}

function isApprovalRecordExpired(r: ApprovalRecord, now: string): boolean {
  return r.status === "pending_approval" && r.expiresAt !== null && r.expiresAt <= now;
}

function resolveApprovalRecordStatus(r: ApprovalRecord, now = new Date().toISOString()): ApprovalRecord {
  if (isApprovalRecordExpired(r, now)) {
    return {
      ...r,
      status: "expired",
      expiredAt: r.expiredAt ?? r.expiresAt,
    };
  }
  return r;
}

function matchesApprovalStatus(r: ApprovalRecord, status: string | undefined, now: string): boolean {
  if (status === undefined) return true;
  const effective = isApprovalRecordExpired(r, now) ? "expired" : r.status;
  return effective === status;
}

/**
 * InMemoryApprovalStore — process-local approval log.
 *
 * LIMITATION: not durable. Records are lost when the process exits.
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private records = new Map<string, ApprovalRecord>();

  async record(record: ApprovalRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    const rec = this.records.get(id);
    return rec ? resolveApprovalRecordStatus(rec) : null;
  }

  async listByAgent(agentId: string, limit = 50, offset = 0, status?: string): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    const now = new Date().toISOString();
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId && matchesApprovalStatus(r, status, now))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(safeOffset, safeOffset + clampLimit(limit))
      .map((r) => resolveApprovalRecordStatus(r, now));
  }

  async listByStatus(agentId: string, status: string, limit = 50, offset = 0): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    const now = new Date().toISOString();
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId && matchesApprovalStatus(r, status, now))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(safeOffset, safeOffset + clampLimit(limit))
      .map((r) => resolveApprovalRecordStatus(r, now));
  }

  async listAll(limit = 50, offset = 0): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    const now = new Date().toISOString();
    return [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(safeOffset, safeOffset + clampLimit(limit))
      .map((r) => resolveApprovalRecordStatus(r, now));
  }

  async listByOwner(ownerId: string, limit = 50, offset = 0, status?: string): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    const now = new Date().toISOString();
    return [...this.records.values()]
      .filter((r) => r.ownerId === ownerId && matchesApprovalStatus(r, status, now))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(safeOffset, safeOffset + clampLimit(limit))
      .map((r) => resolveApprovalRecordStatus(r, now));
  }

  async countByOwner(ownerId: string, status?: string): Promise<number> {
    const now = new Date().toISOString();
    let n = 0;
    for (const r of this.records.values()) {
      if (r.ownerId === ownerId && matchesApprovalStatus(r, status, now)) n++;
    }
    return n;
  }

  async getForOwner(id: string, ownerId: string): Promise<ApprovalRecord | null> {
    const rec = this.records.get(id);
    if (!rec || rec.ownerId !== ownerId) return null;
    return resolveApprovalRecordStatus(rec);
  }

  async update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(id, updated);
    return updated;
  }

  async updateIfStatus(id: string, expectedStatus: ApprovalStatus, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const effective = isApprovalRecordExpired(existing, now) ? "expired" : existing.status;
    if (effective !== expectedStatus) return null;
    const updated = { ...existing, ...patch, id: existing.id, updatedAt: now };
    this.records.set(id, updated);
    return updated;
  }

  async sweepExpired(
    now = new Date().toISOString(),
    limit = 500,
    onSwept?: (record: ApprovalRecord) => void | Promise<void>
  ): Promise<number> {
    const safeLimit = clampLimit(limit);
    let count = 0;
    for (const [id, r] of this.records.entries()) {
      if (r.status === "pending_approval" && r.expiresAt !== null && r.expiresAt <= now) {
        const updated: ApprovalRecord = {
          ...r,
          status: "expired",
          expiredAt: r.expiredAt ?? r.expiresAt ?? now,
          updatedAt: now,
        };
        this.records.set(id, updated);
        count++;
        if (onSwept) {
          await onSwept(updated);
        }
        if (count >= safeLimit) break;
      }
    }
    return count;
  }

  close(): void {}
}

/**
 * Security assertion — call from the API layer before persisting any record.
 * Fails loudly if secret material ever enters a record, so it can never be
 * persisted silently.
 */
export function assertNoSecrets(record: ActivityRecord | ApprovalRecord): void {
  const blob = JSON.stringify(record).toLowerCase();
  const forbidden = ["secret", "seed", "private_key", "mnemonic", "keypair"];
  for (const term of forbidden) {
    if (blob.includes(term.toLowerCase())) {
      throw new Error(
        `Store: refusing to persist record — contains forbidden key material marker '${term}'`
      );
    }
  }
}

/**
 * Creates a new ActivityRecord in its initial pending state.
 */
export function createActivity(
  agentId: string,
  ownerId: string,
  intent: AgentIntent,
  policyDecision?: PolicyDecision | null,
  idempotencyKey?: string | null
): ActivityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId,
    ownerId,
    idempotencyKey,
    intent,
    policyDecision: policyDecision ?? null,
    authorizationStatus: null,
    simulationResult: null,
    txHash: null,
    status: "pending",
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Creates a new ApprovalRecord in PENDING_APPROVAL state.
 */
export function createApproval(
  activityId: string,
  agentId: string,
  ownerId: string,
  intent: AgentIntent,
  policyDecision: PolicyDecision,
  expiresAt?: string | null
): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    activityId,
    agentId,
    ownerId,
    intent,
    policyDecision,
    status: "pending_approval",
    requestedAt: now,
    approvedAt: null,
    rejectedAt: null,
    expiredAt: null,
    approver: null,
    expiresAt: expiresAt ?? null,
    txHash: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateActivity(
  record: ActivityRecord,
  patch: Partial<ActivityRecord>
): ActivityRecord {
  return { ...record, ...patch, updatedAt: new Date().toISOString() };
}

export function updateApproval(
  record: ApprovalRecord,
  patch: Partial<ApprovalRecord>
): ApprovalRecord {
  return { ...record, ...patch, updatedAt: new Date().toISOString() };
}

/**
 * Validates state transitions for approval records.
 * Returns null if valid, error message if invalid.
 */
export function validateApprovalTransition(
  current: ApprovalStatus,
  next: ApprovalStatus
): string | null {
  const allowed: Record<ApprovalStatus, ApprovalStatus[]> = {
    pending_approval: ["approved", "rejected", "expired", "executing"],
    approved: ["executing", "submitted", "failed"],
    rejected: [],
    expired: [],
    executing: ["submitted", "confirmed", "failed"],
    submitted: ["confirmed", "failed"],
    confirmed: [],
    failed: [],
  };
  if (!allowed[current].includes(next)) {
    return `Invalid transition: ${current} -> ${next}`;
  }
  return null;
}

export type { ActivityRecord, AgentIntent, AuthorizationStatus, PolicyDecision, SimulationResult, ScheduleStatus };

// SQLite-backed persistent stores
export { SQLiteActivityStore, SQLiteApprovalStore } from "./sqlite-store.js";

// Schedule stores + types
export { InMemoryScheduleStore, SQLiteScheduleStore } from "./schedule-store.js";
export type { ScheduleStore, ScheduleRecord } from "./schedule-types.js";

// Schedule validation
export { validateScheduleExpression, validateScheduleIntent } from "./schedule-validation.js";
export type { ScheduleValidationResult } from "./schedule-validation.js";

// Agent stores + types
export { InMemoryAgentStore, SQLiteAgentStore, MAX_LIMIT } from "./agent-store.js";
export { getAllowedPreviousAgentStatuses } from "./agent-types.js";
export type { AgentStore, AgentStatusTransitionResult, CreateAgentInput } from "./agent-types.js";

// Policy configuration stores (Phase 28A)
export { CorruptPolicyConfigError, SQLitePolicyConfigStore } from "./policy-config-store.js";
export { InMemoryPolicyConfigStore } from "./in-memory-policy-config-store.js";
export type { PolicyConfigStore } from "./policy-config-store.js";

// Execution queue stores + types
export { InMemoryExecutionStore, SQLiteExecutionStore } from "./execution-store.js";
export type { ExecutionStore, ExecutionRecord, ExecutionStatus } from "./execution-types.js";

// Execution retry policy
export {
  classifyPipelineOutcome,
  classifyError,
  shouldRetry,
  computeNextRetryAt,
  DEFAULT_RETRY_POLICY,
} from "./execution-policy.js";
export type { ErrorClass } from "./execution-policy.js";
export type { RetryPolicy } from "./execution-policy.js";

// Authorization service
export { ResourceAuthorizationService } from "./authorization.js";
export type { AuthorizationContext } from "./authorization.js";

// Shared SQLite connection
export {
  EXPECTED_SCHEMA_VERSION,
  runSchemaMigrations,
  getSharedConnection,
  getSchemaVersion,
  setSchemaVersion,
  closeSharedConnection,
  closeAllSharedConnections,
  getSharedConnectionRefCount,
} from "./shared-connection.js";

// Pagination bounds (shared by every list* store method)
export { MAX_OFFSET, MAX_PAGE_LIMIT, clampOffset, clampLimit, isOffsetAtCeiling } from "./pagination.js";
