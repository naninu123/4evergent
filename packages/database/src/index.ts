import type {
  ActivityRecord,
  AgentIntent,
  AuthorizationStatus,
  PolicyDecision,
  SimulationResult,
  ScheduleStatus,
} from "@4evergent/shared";
import { clampOffset, clampLimit } from "./pagination.js";

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
  listByAgent(agentId: string, limit?: number, offset?: number): Promise<ActivityRecord[]>;
  listByStatus(agentId: string, status: string, limit?: number, offset?: number): Promise<ActivityRecord[]>;
  listAll(limit?: number, offset?: number): Promise<ActivityRecord[]>;
  listByOwner(ownerId: string, limit?: number, offset?: number): Promise<ActivityRecord[]>;
  getForOwner(id: string, ownerId: string): Promise<ActivityRecord | null>;
  update(id: string, patch: Partial<ActivityRecord>): Promise<ActivityRecord | null>;
  getByIdempotencyKey(ownerId: string, agentId: string, key: string): Promise<ActivityRecord | null>;
  recordIdempotent(key: string, record: ActivityRecord): Promise<{ record: ActivityRecord; created: boolean }>;
  /** Atomically reserve daily spending. Returns true if reservation succeeded, false if limit would be exceeded. */
  reserveDailySpending(agentId: string, asset: string, amount: string, limit: string, now?: Date): Promise<boolean>;
  /** Get current day's total spent for an agent. */
  getDailySpending(agentId: string, asset: string, now?: Date): Promise<number | null>;
  /** Remove at most `limit` rows with a UTC day earlier than cutoffDay. */
  sweepDailySpending(cutoffDay: string, limit?: number): Promise<number>;
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
  getForOwner(id: string, ownerId: string): Promise<ApprovalRecord | null>;
  update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null>;
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
  private dailySpending = new Map<string, number>();
  private idempotencyLock: Promise<unknown> = Promise.resolve();
  /** Serializes daily-spending check+commit per store instance (atomicity). */
  private dailySpendingLock: Promise<unknown> = Promise.resolve();
  /** Clock source for day-boundary computation; injectable for tests. */
  private now: () => Date;

  constructor(options?: { now?: () => Date }) {
    this.now = options?.now ?? (() => new Date());
  }

  async record(record: ActivityRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async get(id: string): Promise<ActivityRecord | null> {
    return this.records.get(id) ?? null;
  }

  async listByAgent(agentId: string, limit = 50, offset = 0): Promise<ActivityRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId)
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

  async listByOwner(ownerId: string, limit = 50, offset = 0): Promise<ActivityRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(clampOffset(offset), clampOffset(offset) + clampLimit(limit));
  }

  async getForOwner(id: string, ownerId: string): Promise<ActivityRecord | null> {
    const rec = this.records.get(id);
    return rec?.ownerId === ownerId ? rec : null;
  }

  async getByIdempotencyKey(ownerId: string, agentId: string, key: string): Promise<ActivityRecord | null> {
    for (const rec of this.records.values()) {
      if (rec.ownerId === ownerId && rec.agentId === agentId && rec.idempotencyKey === key) {
        return rec;
      }
    }
    return null;
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
      record.idempotencyKey = key;
      this.records.set(record.id, record);
      return { record, created: true };
    });
    // Update lock to include this operation (catch errors to avoid breaking chain)
    this.idempotencyLock = result.catch(() => undefined);
    return result;
  }

  async reserveDailySpending(agentId: string, asset: string, amount: string, limit: string, now?: Date): Promise<boolean> {
    const amountNum = parseFloat(amount);
    const limitNum = parseFloat(limit);
    if (isNaN(amountNum) || isNaN(limitNum)) return false;

    const effectiveNow = now ?? this.now();
    const day = new Date(Date.UTC(effectiveNow.getUTCFullYear(), effectiveNow.getUTCMonth(), effectiveNow.getUTCDate()))
      .toISOString()
      .slice(0, 10);

    const mapKey = `${agentId}:${asset}:${day}`;

    // Serialize check+commit through a per-instance promise chain so two
    // concurrent reservations cannot both read the same "current" value and
    // both commit past the limit. Mirrors recordIdempotent's approach; SQLite
    // achieves the same via a conditional UPDATE.
    const result = this.dailySpendingLock.then(() => {
      const current = this.dailySpending.get(mapKey) ?? 0;
      if (current + amountNum > limitNum) return false;
      this.dailySpending.set(mapKey, current + amountNum);
      return true;
    });
    this.dailySpendingLock = result.catch(() => undefined);
    return result;
  }

  async getDailySpending(agentId: string, asset: string, now?: Date): Promise<number | null> {
    const effectiveNow = now ?? this.now();
    const day = new Date(Date.UTC(effectiveNow.getUTCFullYear(), effectiveNow.getUTCMonth(), effectiveNow.getUTCDate()))
      .toISOString()
      .slice(0, 10);
    const mapKey = `${agentId}:${asset}:${day}`;
    return this.dailySpending.get(mapKey) ?? null;
  }

  async sweepDailySpending(cutoffDay: string, limit = 1000): Promise<number> {
    let removed = 0;
    for (const key of this.dailySpending.keys()) {
      if (removed >= limit) break;
      const day = key.slice(key.lastIndexOf(":") + 1);
      if (day < cutoffDay) {
        this.dailySpending.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async update(id: string, patch: Partial<ActivityRecord>): Promise<ActivityRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch } as ActivityRecord;
    this.records.set(id, updated);
    return updated;
  }
}

/**
 * InMemoryApprovalStore — process-local approval storage.
 *
 * LIMITATION: not durable. See InMemoryActivityStore for rationale.
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private records = new Map<string, ApprovalRecord>();

  async record(record: ApprovalRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    return this.records.get(id) ?? null;
  }

  async listByAgent(agentId: string, limit = 50, offset = 0, status?: string): Promise<ApprovalRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId && (!status || r.status === status))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(clampOffset(offset), clampOffset(offset) + clampLimit(limit));
  }

  async listByStatus(agentId: string, status: string, limit = 50, offset = 0): Promise<ApprovalRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId && r.status === status)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(clampOffset(offset), clampOffset(offset) + clampLimit(limit));
  }

  async listAll(limit = 50, offset = 0): Promise<ApprovalRecord[]> {
    return [...this.records.values()]
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(clampOffset(offset), clampOffset(offset) + clampLimit(limit));
  }

  async listByOwner(ownerId: string, limit = 50, offset = 0, status?: string): Promise<ApprovalRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.ownerId === ownerId && (!status || r.status === status))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(clampOffset(offset), clampOffset(offset) + clampLimit(limit));
  }

  async getForOwner(id: string, ownerId: string): Promise<ApprovalRecord | null> {
    const rec = this.records.get(id);
    return rec?.ownerId === ownerId ? rec : null;
  }

  async update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch } as ApprovalRecord;
    this.records.set(id, updated);
    return updated;
  }
}

export { clampOffset, clampLimit } from "./pagination.js";

export type { ActivityRecord, AgentIntent, AuthorizationStatus, PolicyDecision, SimulationResult, ScheduleStatus };
