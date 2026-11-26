import { DatabaseSync } from "node:sqlite";
import type {
  ActivityRecord,
  AgentIntent,
  AuthorizationStatus,
  PolicyDecision,
  SimulationResult,
} from "@4evergent/shared";
import { toStroops } from "@4evergent/shared";
import { getSharedConnection, closeSharedConnection } from "./shared-connection.js";
import { clampOffset, clampLimit } from "./pagination.js";
import { ensureTable, MigrationError } from "./migration.js";
import {
  idempotencyCutoff,
  resolveIdempotencyWindowMs,
  type ActivityStoreOptions,
} from "./idempotency-window.js";
import type {
  ActivityStore,
  ApprovalStore,
  ApprovalRecord,
  ApprovalStatus,
} from "./index.js";

/**
 * SQLiteActivityStore — persistent ActivityStore backed by SQLite.
 *
 * Uses Node.js built-in node:sqlite (Node 22+, stable in Node 26). No external
 * database server required. Data persists across process restarts in a file
 * at the path provided to the constructor.
 *
 * Schema is versioned in _meta (schema_version = 5). initSchema() is
 * idempotent and safe to call on every construction.
 */
export class SQLiteActivityStore implements ActivityStore {
  private db: DatabaseSync;
  private dbPath: string;
  private closed = false;
  /** #109: Idempotency-Key replay window. */
  readonly idempotencyWindowMs: number;
  private readonly now: () => number;

  constructor(dbPath: string, options: ActivityStoreOptions = {}) {
    this.dbPath = dbPath;
    this.idempotencyWindowMs = resolveIdempotencyWindowMs(options.idempotencyWindowMs);
    this.now = options.now ?? Date.now;
    this.db = getSharedConnection(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    // #401: any failure creating the base schema must also fail loudly
    // with the table named, never silently start on a broken database.
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        idempotency_key TEXT,
        intent_json TEXT NOT NULL,
        policy_decision_json TEXT NOT NULL,
        authorization_status TEXT,
        simulation_result_json TEXT,
        tx_hash TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activities_agent ON activities(agent_id);
      CREATE INDEX IF NOT EXISTS idx_activities_status ON activities(status);
      CREATE INDEX IF NOT EXISTS idx_activities_owner ON activities(owner_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_idempotency
        ON activities(owner_id, agent_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      -- #109: bounded sweep of expired Idempotency-Key bindings.
      CREATE INDEX IF NOT EXISTS idx_activities_idempotency_created
        ON activities(created_at)
        WHERE idempotency_key IS NOT NULL;
    `);
    } catch (err) {
      throw new MigrationError("activities", null, err);
    }
    // Phase 23: daily_spending table for atomic spending reservation.
    // #401: this used to be a bare try/catch that swallowed every failure,
    // so the server could start healthy on a database without this table.
    // CREATE TABLE IF NOT EXISTS never throws "already exists", so any
    // error here is real and must abort startup (MigrationError).
    //
    // #374: `total` is INTEGER stroops (1 XLM = 10^7 stroops), not REAL XLM.
    // Binary floats cannot represent most decimal amounts exactly, so a REAL
    // total drifted the ledger and falsely denied exact-limit intents
    // (0.1 + 0.2 = 0.30000000000000004 > 0.3). Integer stroops compare
    // exactly to the stroop. The migration below reinterprets any pre-#374
    // REAL column as INTEGER stroops.
    ensureTable(
      this.db,
      "daily_spending",
      `
        CREATE TABLE IF NOT EXISTS daily_spending (
          agent_id TEXT NOT NULL,
          asset TEXT NOT NULL,
          day TEXT NOT NULL,
          total INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (agent_id, asset, day)
        );
      CREATE INDEX IF NOT EXISTS idx_daily_spending_day ON daily_spending(day);
      `
    );
    // #374: migrate a legacy REAL total column (decimal XLM) to INTEGER
    // stroops in place, so existing reservations survive the upgrade and
    // the integer comparison path works. No-op once the column is INTEGER.
    this.migrateDailySpendingToStroops();
  }

  /**
   * #374: convert a pre-#374 `daily_spending` table whose `total` column is
   * REAL (decimal XLM) to the INTEGER-stroops representation.
   *
   * `CREATE TABLE IF NOT EXISTS` above is a no-op on an existing table, so a
   * database created by an older release keeps its REAL column — and its rows
   * hold decimal XLM totals. Storing integer stroops alongside those would
   * mix units (0.3 XLM + 3000000 stroops = nonsense), so the column and its
   * data are rebuilt together: `ROUND(total * 1e7)` converts each old XLM
   * total to stroops (this is a one-time migration, not the enforcement path,
   * so float arithmetic here is acceptable; the result is a clean integer).
   *
   * SQLite cannot ALTER a column type, so the table is recreated within a
   * single transaction (atomic: a failure rolls back to the original REAL
   * table and aborts startup via MigrationError, never leaving a half-migrated
   * database). Idempotent: once the column is INTEGER the PRAGMA check skips
   * this entirely.
   */
  private migrateDailySpendingToStroops(): void {
    const cols = this.db.prepare("PRAGMA table_info(daily_spending)").all() as
      | { name: string; type: string }[]
      | undefined;
    if (!cols) return;
    const totalCol = cols.find((c) => c.name === "total");
    if (!totalCol) return; // table absent — ensureTable would have created it
    if (/integer/i.test(totalCol.type)) return; // already stroops

    try {
      this.db.exec("BEGIN IMMEDIATE");
      // Drop a stale rebuild table from any prior interrupted attempt so the
      // CREATE below is clean (the transaction makes this safe).
      this.db.exec("DROP TABLE IF EXISTS daily_spending_stroops");
      this.db.exec(`
        CREATE TABLE daily_spending_stroops (
          agent_id TEXT NOT NULL,
          asset TEXT NOT NULL,
          day TEXT NOT NULL,
          total INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (agent_id, asset, day)
        )
      `);
      this.db
        .prepare(
          `INSERT INTO daily_spending_stroops (agent_id, asset, day, total)
           SELECT agent_id, asset, day, CAST(ROUND(total * 10000000) AS INTEGER)
           FROM daily_spending`
        )
        .run();
      this.db.exec("DROP TABLE daily_spending");
      this.db.exec("ALTER TABLE daily_spending_stroops RENAME TO daily_spending");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_daily_spending_day ON daily_spending(day)");
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Best-effort rollback; the MigrationError below carries the cause.
      }
      throw new MigrationError("daily_spending", "total", err);
    }
  }

  async record(record: ActivityRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO activities
         (id, agent_id, owner_id, idempotency_key, intent_json, policy_decision_json, authorization_status,
          simulation_result_json, tx_hash, status, error, created_at, updated_at)
         VALUES (@id, @agent_id, @owner_id, @idempotency_key, @intent_json, @policy_decision_json, @authorization_status,
                 @simulation_result_json, @tx_hash, @status, @error, @created_at, @updated_at)`
      )
      .run({
        id: record.id,
        agent_id: record.agentId,
        owner_id: record.ownerId,
        idempotency_key: record.idempotencyKey ?? null,
        intent_json: JSON.stringify(record.intent),
        policy_decision_json: JSON.stringify(record.policyDecision ?? null),
        authorization_status: record.authorizationStatus,
        simulation_result_json: record.simulationResult
          ? JSON.stringify(record.simulationResult)
          : null,
        tx_hash: record.txHash,
        status: record.status,
        error: record.error,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
  }

  async get(id: string): Promise<ActivityRecord | null> {
    const row = this.db.prepare("SELECT * FROM activities WHERE id = ?").get(id);
    return row ? rowToActivityRecord(row as unknown as ActivityRow) : null;
  }

  async listByAgent(agentId: string, limit = 50, offset = 0, status?: string): Promise<ActivityRecord[]> {
    const safeLimit = clampLimit(limit);
    const safeOffset = clampOffset(offset);
    const where = status === undefined ? "WHERE agent_id = ?" : "WHERE agent_id = ? AND status = ?";
    const params =
      status === undefined ? [agentId, safeLimit, safeOffset] : [agentId, status, safeLimit, safeOffset];
    const rows = this.db
      .prepare(`SELECT * FROM activities ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params);
    return rows.map((r) => rowToActivityRecord(r as unknown as ActivityRow));
  }

  async listByStatus(agentId: string, status: string, limit = 50, offset = 0): Promise<ActivityRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM activities WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(agentId, status, clampLimit(limit), clampOffset(offset));
    return rows.map((r) => rowToActivityRecord(r as unknown as ActivityRow));
  }

  async listAll(limit = 50, offset = 0): Promise<ActivityRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM activities ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(clampLimit(limit), clampOffset(offset));
    return rows.map((r) => rowToActivityRecord(r as unknown as ActivityRow));
  }

  async listByOwner(ownerId: string, limit = 50, offset = 0, status?: string): Promise<ActivityRecord[]> {
    const safeLimit = clampLimit(limit);
    const safeOffset = clampOffset(offset);
    const where = status === undefined ? "WHERE owner_id = ?" : "WHERE owner_id = ? AND status = ?";
    const params =
      status === undefined ? [ownerId, safeLimit, safeOffset] : [ownerId, status, safeLimit, safeOffset];
    const rows = this.db
      .prepare(`SELECT * FROM activities ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params);
    return rows.map((r) => rowToActivityRecord(r as unknown as ActivityRow));
  }

  async getForOwner(id: string, ownerId: string): Promise<ActivityRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM activities WHERE id = ? AND owner_id = ?")
      .get(id, ownerId);
    return row ? rowToActivityRecord(row as unknown as ActivityRow) : null;
  }

  /**
   * #109: only a key bound to an activity created inside the replay window
   * is returned. An older binding no longer suppresses a new request.
   */
  async getByIdempotencyKey(ownerId: string, agentId: string, key: string): Promise<ActivityRecord | null> {
    const cutoff = idempotencyCutoff(this.now(), this.idempotencyWindowMs);
    const row = this.db
      .prepare(
        "SELECT * FROM activities WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ? AND created_at >= ?"
      )
      .get(ownerId, agentId, key, cutoff);
    return row ? rowToActivityRecord(row as unknown as ActivityRow) : null;
  }

  /**
   * #109: clear the Idempotency-Key of at most `limit` activities created
   * before `cutoff`. The activity row itself is kept: it is the audit trail.
   */
  async releaseExpiredIdempotencyKeys(cutoff: string, limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    const result = this.db.prepare(`
      UPDATE activities SET idempotency_key = NULL
      WHERE rowid IN (
        SELECT rowid FROM activities
        WHERE idempotency_key IS NOT NULL AND created_at < ?
        ORDER BY created_at ASC LIMIT ?
      )
    `).run(cutoff, limit);
    return Number(result.changes);
  }

  /**
   * Atomic idempotency reservation.
   *
   * Phase 23: Uses INSERT to leverage the UNIQUE INDEX
   * idx_activities_idempotency. The database guarantees only one record per
   * (owner_id, agent_id, idempotency_key). Concurrent inserts result in exactly
   * one winner; losers catch the UNIQUE violation and read back the winner.
   */
  async recordIdempotent(key: string, record: ActivityRecord): Promise<{ record: ActivityRecord; created: boolean }> {
    // Fast path: check if already exists (avoids INSERT overhead)
    const existing = await this.getByIdempotencyKey(record.ownerId, record.agentId, key);
    if (existing) return { record: existing, created: false };

    // #109: an expired binding of this key no longer suppresses the request,
    // but it still occupies the UNIQUE index. Clear only its key (never the
    // row) so the new activity can bind the key. Synchronous, so no other
    // caller in this process interleaves between this and the INSERT.
    this.db
      .prepare(
        "UPDATE activities SET idempotency_key = NULL WHERE owner_id = ? AND agent_id = ? AND idempotency_key = ? AND created_at < ?"
      )
      .run(record.ownerId, record.agentId, key, idempotencyCutoff(this.now(), this.idempotencyWindowMs));

    // Atomic INSERT — UNIQUE INDEX enforces single winner
    record.idempotencyKey = key;
    try {
      this.db
        .prepare(
          `INSERT INTO activities
           (id, agent_id, owner_id, idempotency_key, intent_json, policy_decision_json, authorization_status,
            simulation_result_json, tx_hash, status, error, created_at, updated_at)
           VALUES (@id, @agent_id, @owner_id, @idempotency_key, @intent_json, @policy_decision_json, @authorization_status,
                   @simulation_result_json, @tx_hash, @status, @error, @created_at, @updated_at)`
        )
        .run({
          id: record.id,
          agent_id: record.agentId,
          owner_id: record.ownerId,
          idempotency_key: record.idempotencyKey ?? null,
          intent_json: JSON.stringify(record.intent),
          policy_decision_json: JSON.stringify(record.policyDecision),
          authorization_status: record.authorizationStatus,
          simulation_result_json: record.simulationResult
            ? JSON.stringify(record.simulationResult)
            : null,
          tx_hash: record.txHash,
          status: record.status,
          error: record.error,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
        });
      return { record, created: true };
    } catch (e: any) {
      // UNIQUE constraint violation — another caller won the race; return their record
      if (e?.message?.includes("UNIQUE") || e?.code === "ERR_SQLITE_CONSTRAINT") {
        const winner = await this.getByIdempotencyKey(record.ownerId, record.agentId, key);
        if (winner) return { record: winner, created: false };
      }
      throw e;
    }
  }

  /**
   * Atomically reserve daily spending using conditional UPDATE.
   *
   * Phase 23: Uses a single SQL UPDATE with WHERE clause checking the limit:
   * - UPDATE ... WHERE agent_id = ? AND asset = ? AND day = ? AND total + amount <= limit
   * - If changes === 1: reservation succeeded
   * - If changes === 0: row doesn't exist OR limit would be exceeded
   *
   * Concurrent calls are serialized by SQLite's row-level locking. The PRIMARY KEY
   * (agent_id, asset, day) ensures one row per asset per day.
   */
  async reserveDailySpending(agentId: string, asset: string, amount: string, limit: string, now = new Date()): Promise<boolean> {
    // #374: compare integer stroops, not REAL XLM. parseFloat/float addition
    // drifts the ledger and falsely denies exact-limit intents
    // (0.1 + 0.2 stroops = 3_000_000 == 0.3 limit stroops, allowed). A
    // non-canonical amount/limit returns null and is rejected, matching the
    // strict parser (#264).
    const amountStroops = toStroops(amount);
    const limitStroops = toStroops(limit);
    if (amountStroops === null || limitStroops === null) return false;

    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      .toISOString()
      .slice(0, 10); // YYYY-MM-DD

    // Conditional UPDATE: only succeeds if current total + amount <= limit
    const updateResult = this.db
      .prepare(
        `UPDATE daily_spending SET total = total + ?
         WHERE agent_id = ? AND asset = ? AND day = ? AND total + ? <= ?`
      )
      .run(amountStroops, agentId, asset, day, amountStroops, limitStroops);

    if (updateResult.changes === 1) {
      return true; // Reservation succeeded
    }

    // UPDATE affected 0 rows — either row doesn't exist or limit exceeded.
    // #353: check the limit BEFORE inserting. The old code inserted first
    // and returned false afterwards, persisting an over-limit row that
    // bricked the asset for the rest of the day.
    if (amountStroops > limitStroops) {
      return false; // First reservation already over limit — persist nothing.
    }

    // Row doesn't exist yet — first spend of the day, within limit.
    try {
      this.db
        .prepare(
          `INSERT INTO daily_spending (agent_id, asset, day, total) VALUES (?, ?, ?, ?)`
        )
        .run(agentId, asset, day, amountStroops);
      return true;
    } catch (_e: any) {
      // PRIMARY KEY conflict — row was created by concurrent caller between our UPDATE and INSERT,
      // or the row exists and the limit would be exceeded. Retry the UPDATE
      // once (the concurrent caller's INSERT committed first).
      const retryResult = this.db
        .prepare(
          `UPDATE daily_spending SET total = total + ?
           WHERE agent_id = ? AND asset = ? AND day = ? AND total + ? <= ?`
        )
        .run(amountStroops, agentId, asset, day, amountStroops, limitStroops);
      return retryResult.changes === 1;
    }
  }

  /**
   * Release a previously reserved amount (#353). Decrements the day's total,
   * floored at 0, and removes the row when it reaches 0. Callers MUST only
   * release amounts proven reserved (PolicyDecision.reservedDailySpending).
   */
  async releaseDailySpending(agentId: string, asset: string, amount: string, now = new Date()): Promise<void> {
    // #374: release integer stroops, matching the reservation unit.
    const amountStroops = toStroops(amount);
    if (amountStroops === null || amountStroops <= 0) return;

    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      .toISOString()
      .slice(0, 10); // YYYY-MM-DD

    this.db
      .prepare(
        `UPDATE daily_spending SET total = MAX(total - ?, 0)
         WHERE agent_id = ? AND asset = ? AND day = ?`
      )
      .run(amountStroops, agentId, asset, day);
    this.db
      .prepare(
        `DELETE FROM daily_spending
         WHERE agent_id = ? AND asset = ? AND day = ? AND total <= 0`
      )
      .run(agentId, asset, day);
  }

  /**
   * #374: returns the current UTC day's reserved total in INTEGER STROOPS
   * (1 XLM = 10^7 stroops), or null when nothing is reserved. Callers that
   * need a decimal amount convert at the boundary via `fromStroops`; the
   * enforcement path compares these integers directly against integer
   * stroop limits.
   */
  async getDailySpending(agentId: string, asset: string, now = new Date()): Promise<number | null> {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      .toISOString().slice(0, 10);
    const row = this.db
      .prepare(`SELECT total FROM daily_spending WHERE agent_id = ? AND asset = ? AND day = ?`)
      .get(agentId, asset, day) as { total: number } | undefined;
    return row ? row.total : null;
  }

  async sweepDailySpending(cutoffDay: string, limit = 500): Promise<number> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDay) || !Number.isInteger(limit) || limit <= 0) return 0;
    const result = this.db.prepare(`
      DELETE FROM daily_spending
      WHERE rowid IN (
        SELECT rowid FROM daily_spending WHERE day < ? ORDER BY day ASC LIMIT ?
      )
    `).run(cutoffDay, limit);
    return Number(result.changes);
  }

  async update(id: string, patch: Partial<ActivityRecord>): Promise<ActivityRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    await this.record(updated);
    return updated;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSharedConnection(this.dbPath);
  }
}

// ============================================================
// SQLiteApprovalStore (unchanged except for daily_spending table)
// ============================================================

/**
 * SQLiteApprovalStore — persistent ApprovalStore backed by SQLite.
 *
 * Shares the same DB file as SQLiteActivityStore. The partial unique index
 * idx_approvals_activity_one enforces that at most one PENDING_APPROVAL record
 * exists per activity id. This is the structural guard against duplicate pending
 * approvals for the same intent.
 *
 * record() performs an explicit pre-check for an existing pending approval
 * before inserting, so callers get a clear error (not a raw SQL exception).
 * SQLite's unique index is the final safety net.
 */
export class SQLiteApprovalStore implements ApprovalStore {
  private db: DatabaseSync;
  private dbPath: string;
  private closed = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = getSharedConnection(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        policy_decision_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        approved_at TEXT,
        rejected_at TEXT,
        expired_at TEXT,
        approver TEXT,
        expires_at TEXT,
        tx_hash TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_activity ON approvals(activity_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_owner ON approvals(owner_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_activity_one
        ON approvals(activity_id) WHERE status = 'pending_approval';
    `);
  }

  async record(record: ApprovalRecord): Promise<void> {
    // Invariant: at most one PENDING_APPROVAL per activity id.
    // SQLite's partial unique index (idx_approvals_activity_one) is the final
    // structural guard; this pre-check gives callers a clear error and keeps
    // existing records from being silently replaced.
    if (record.status === "pending_approval") {
      const existing = this.db
        .prepare(
          "SELECT id FROM approvals WHERE activity_id = ? AND status = 'pending_approval' AND id != ?"
        )
        .get(record.activityId, record.id) as { id: string } | undefined;
      if (existing) {
        throw new Error(
          `ApprovalStore: activity ${record.activityId} already has a pending approval (${existing.id}); refusing to create a second one`
        );
      }
    }

    this.db
      .prepare(
        `INSERT INTO approvals
         (id, activity_id, agent_id, owner_id, intent_json, policy_decision_json, status,
          requested_at, approved_at, rejected_at, expired_at, approver, expires_at,
          tx_hash, error, created_at, updated_at)
         VALUES (@id, @activity_id, @agent_id, @owner_id, @intent_json, @policy_decision_json, @status,
                 @requested_at, @approved_at, @rejected_at, @expired_at, @approver, @expires_at,
                 @tx_hash, @error, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           activity_id = excluded.activity_id,
           agent_id = excluded.agent_id,
           owner_id = excluded.owner_id,
           intent_json = excluded.intent_json,
           policy_decision_json = excluded.policy_decision_json,
           status = excluded.status,
           requested_at = excluded.requested_at,
           approved_at = excluded.approved_at,
           rejected_at = excluded.rejected_at,
           expired_at = excluded.expired_at,
           approver = excluded.approver,
           expires_at = excluded.expires_at,
           tx_hash = excluded.tx_hash,
           error = excluded.error,
           updated_at = excluded.updated_at`
      )
      .run({
        id: record.id,
        activity_id: record.activityId,
        agent_id: record.agentId,
        owner_id: record.ownerId,
        intent_json: JSON.stringify(record.intent),
        policy_decision_json: JSON.stringify(record.policyDecision),
        status: record.status,
        requested_at: record.requestedAt,
        approved_at: record.approvedAt,
        rejected_at: record.rejectedAt,
        expired_at: record.expiredAt,
        approver: record.approver,
        expires_at: record.expiresAt,
        tx_hash: record.txHash,
        error: record.error,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    if (!row) return null;
    return rowToApprovalRecord(row as unknown as ApprovalRow);
  }

  async listByAgent(agentId: string, limit = 50, offset = 0, status?: string): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    const safeLimit = clampLimit(limit);
    const filter = approvalStatusFilterClause(status);
    const where = filter.sql ? `WHERE agent_id = ? AND ${filter.sql}` : `WHERE agent_id = ?`;
    const params = [agentId, ...filter.params, safeLimit, safeOffset];
    const rows = this.db
      .prepare(`SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params);
    return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
  }

  async listByStatus(agentId: string, status: string, limit = 50, offset = 0): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    const safeLimit = clampLimit(limit);
    const filter = approvalStatusFilterClause(status);
    const where = filter.sql ? `WHERE agent_id = ? AND ${filter.sql}` : `WHERE agent_id = ?`;
    const params = [agentId, ...filter.params, safeLimit, safeOffset];
    const rows = this.db
      .prepare(`SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params);
    return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
  }

  async listAll(limit = 50, offset = 0): Promise<ApprovalRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(clampLimit(limit), clampOffset(offset));
    return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
  }

  async listByOwner(ownerId: string, limit = 50, offset = 0, status?: string): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    const safeLimit = clampLimit(limit);
    const filter = approvalStatusFilterClause(status);
    const where = filter.sql ? `WHERE owner_id = ? AND ${filter.sql}` : `WHERE owner_id = ?`;
    const params = [ownerId, ...filter.params, safeLimit, safeOffset];
    const rows = this.db
      .prepare(`SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params);
    return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
  }

  async countByOwner(ownerId: string, status?: string): Promise<number> {
    const filter = approvalStatusFilterClause(status);
    const where = filter.sql ? `WHERE owner_id = ? AND ${filter.sql}` : `WHERE owner_id = ?`;
    const params = [ownerId, ...filter.params];
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM approvals ${where}`)
      .get(...params);
    return Number((row as unknown as { count: number | bigint }).count);
  }

  async getForOwner(id: string, ownerId: string): Promise<ApprovalRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE id = ? AND owner_id = ?")
      .get(id, ownerId);
    return row ? rowToApprovalRecord(row as unknown as ApprovalRow) : null;
  }

  async update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    await this.record(updated);
    return updated;
  }

  async updateIfStatus(id: string, expectedStatus: ApprovalStatus, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null> {
    const now = new Date().toISOString();
    const expiryGuard = expectedStatus === "pending_approval" ? "AND (expires_at IS NULL OR expires_at > @p_now)" : "";
    const partial = buildApprovalPartialUpdate(patch);
    if (!partial) {
      const row = this.db
        .prepare(`SELECT * FROM approvals WHERE id = ? AND status = ? ${expectedStatus === "pending_approval" ? "AND (expires_at IS NULL OR expires_at > ?)" : ""}`)
        .get(...(expectedStatus === "pending_approval" ? [id, expectedStatus, now] : [id, expectedStatus])) as unknown as ApprovalRow | undefined;
      return row ? rowToApprovalRecord(row) : null;
    }

    // Single-statement compare-and-swap: the status guard is evaluated by
    // SQLite in the same statement that writes, so exactly one concurrent
    // claimer can win and no other column is overwritten. (Same rationale as
    // SQLiteExecutionStore.updateIfStatus; see execution-store.ts.)
    // updated_at is always refreshed, matching InMemoryApprovalStore.
    const runParams: Record<string, any> = {
      ...partial.params,
      p_updated_at: now,
      id,
      expected_status: expectedStatus,
    };
    if (expectedStatus === "pending_approval") {
      runParams.p_now = now;
    }
    const result = this.db
      .prepare(`UPDATE approvals SET ${partial.sql}, updated_at = @p_updated_at WHERE id = @id AND status = @expected_status ${expiryGuard}`)
      .run(runParams);
    if (Number(result.changes) === 0) return null;

    return this.get(id);
  }

  async sweepExpired(
    now = new Date().toISOString(),
    limit = 500,
    onSwept?: (record: ApprovalRecord) => void | Promise<void>
  ): Promise<number> {
    const safeLimit = clampLimit(limit);
    const rows = this.db
      .prepare(
        "SELECT * FROM approvals WHERE status = 'pending_approval' AND expires_at IS NOT NULL AND expires_at <= ? LIMIT ?"
      )
      .all(now, safeLimit) as unknown as ApprovalRow[];

    if (rows.length === 0) return 0;

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE approvals SET status = 'expired', expired_at = COALESCE(expired_at, ?), updated_at = ? WHERE id IN (${placeholders})`
      )
      .run(now, now, ...ids);

    if (onSwept) {
      for (const row of rows) {
        const record = rowToApprovalRecord({
          ...row,
          status: "expired",
          expired_at: row.expired_at ?? now,
          updated_at: now,
        });
        await onSwept(record);
      }
    }

    return rows.length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSharedConnection(this.dbPath);
  }
}

/**
 * Columns writable by SQLiteApprovalStore.updateIfStatus().
 * `id` is deliberately absent: the primary key is immutable.
 */
const APPROVAL_WRITE_COLUMNS: Record<string, string> = {
  activityId: "activity_id",
  agentId: "agent_id",
  ownerId: "owner_id",
  intent: "intent_json",
  policyDecision: "policy_decision_json",
  status: "status",
  requestedAt: "requested_at",
  approvedAt: "approved_at",
  rejectedAt: "rejected_at",
  expiredAt: "expired_at",
  approver: "approver",
  expiresAt: "expires_at",
  txHash: "tx_hash",
  error: "error",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const APPROVAL_JSON_COLUMNS = new Set(["intent_json", "policy_decision_json"]);

/**
 * Builds a partial SET clause from a patch: only the caller's fields are
 * written, in one statement. `undefined` values are skipped ("field not
 * supplied"); explicit `null` clears. Returns null when the patch carries
 * nothing writable (caller falls back to a status-guarded read).
 */
function buildApprovalPartialUpdate(patch: Partial<ApprovalRecord>): { sql: string; params: Record<string, unknown> } | null {
  const assignments: string[] = [];
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    // hasOwnProperty guard: a `__proto__`/`constructor` key from an untrusted
    // patch must not resolve to an inherited value and end up in the SET clause.
    if (!Object.prototype.hasOwnProperty.call(APPROVAL_WRITE_COLUMNS, key)) continue;
    const column = APPROVAL_WRITE_COLUMNS[key];
    if (!column || value === undefined) continue;
    const param = `p_${column}`;
    assignments.push(`${column} = @${param}`);
    params[param] = APPROVAL_JSON_COLUMNS.has(column) ? JSON.stringify(value) : value;
  }
  if (assignments.length === 0) return null;
  return { sql: assignments.join(", "), params };
}

// ============================================================
// Row types + conversion functions
// ============================================================

interface ActivityRow {
  id: string;
  agent_id: string;
  owner_id: string;
  idempotency_key: string | null;
  intent_json: string;
  policy_decision_json: string | null;
  authorization_status: string | null;
  simulation_result_json: string | null;
  tx_hash: string | null;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  activity_id: string;
  agent_id: string;
  owner_id: string;
  intent_json: string;
  policy_decision_json: string;
  status: string;
  requested_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  expired_at: string | null;
  approver: string | null;
  expires_at: string | null;
  tx_hash: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToActivityRecord(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    ownerId: row.owner_id,
    idempotencyKey: row.idempotency_key,
    intent: JSON.parse(row.intent_json) as AgentIntent,
    policyDecision: row.policy_decision_json && row.policy_decision_json !== "null"
      ? (JSON.parse(row.policy_decision_json) as PolicyDecision)
      : null,
    authorizationStatus: row.authorization_status as AuthorizationStatus | null,
    simulationResult: row.simulation_result_json
      ? (JSON.parse(row.simulation_result_json) as SimulationResult)
      : null,
    txHash: row.tx_hash,
    status: row.status as ActivityRecord["status"],
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function approvalStatusFilterClause(status: string | undefined): { sql: string; params: (string | number)[] } {
  if (status === undefined) {
    return { sql: "", params: [] };
  }
  const now = new Date().toISOString();
  if (status === "pending_approval") {
    return {
      sql: "status = 'pending_approval' AND (expires_at IS NULL OR expires_at > ?)",
      params: [now],
    };
  }
  if (status === "expired") {
    return {
      sql: "(status = 'expired' OR (status = 'pending_approval' AND expires_at IS NOT NULL AND expires_at <= ?))",
      params: [now],
    };
  }
  return {
    sql: "status = ?",
    params: [status],
  };
}

function rowToApprovalRecord(row: ApprovalRow): ApprovalRecord {
  const now = new Date().toISOString();
  const isExp = row.status === "pending_approval" && row.expires_at !== null && row.expires_at <= now;
  return {
    id: row.id,
    activityId: row.activity_id,
    agentId: row.agent_id,
    ownerId: row.owner_id,
    intent: JSON.parse(row.intent_json) as AgentIntent,
    policyDecision: JSON.parse(row.policy_decision_json) as PolicyDecision,
    status: isExp ? "expired" : (row.status as ApprovalStatus),
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    expiredAt: isExp ? (row.expired_at ?? row.expires_at) : row.expired_at,
    approver: row.approver,
    expiresAt: row.expires_at,
    txHash: row.tx_hash,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
