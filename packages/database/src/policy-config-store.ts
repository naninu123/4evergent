import { DatabaseSync } from "node:sqlite";
import type { PolicyRules } from "@4evergent/shared";
import { getSharedConnection, closeSharedConnection } from "./shared-connection.js";

export interface PolicyConfigStore {
  get(agentId: string): Promise<PolicyRules | null>;
  getForOwner(agentId: string, ownerId: string): Promise<PolicyRules | null>;
  /** Returns rules + version + updatedAt for audit/display. */
  getWithMetadata(agentId: string): Promise<{ rules: PolicyRules; version: number; updatedAt: string } | null>;
  /** Upsert returns the stored rules and the new monotonically-increasing version. */
  upsert(agentId: string, ownerId: string, rules: PolicyRules): Promise<{ rules: PolicyRules; version: number }>;
  delete(agentId: string): Promise<boolean>;
  listByOwner(ownerId: string): Promise<Array<{ agentId: string; rules: PolicyRules }>>;
  close?(): void;
}

/** A persisted policy exists but cannot be decoded safely. */
export class CorruptPolicyConfigError extends Error {
  readonly code = "POLICY_CONFIG_CORRUPT";

  constructor() {
    super("Stored policy configuration is unreadable");
    this.name = "CorruptPolicyConfigError";
  }
}

function parsePolicyRules(raw: string): PolicyRules {
  try {
    return JSON.parse(raw) as PolicyRules;
  } catch {
    throw new CorruptPolicyConfigError();
  }
}

export class SQLitePolicyConfigStore implements PolicyConfigStore {
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

      CREATE TABLE IF NOT EXISTS policy_configs (
        agent_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_policy_configs_owner ON policy_configs(owner_id);
    `);
  }

  async get(agentId: string): Promise<PolicyRules | null> {
    const row = this.db
      .prepare("SELECT rules_json FROM policy_configs WHERE agent_id = ?")
      .get(agentId) as { rules_json: string } | undefined;
    if (!row) return null;
    return parsePolicyRules(row.rules_json);
  }

  async getForOwner(agentId: string, ownerId: string): Promise<PolicyRules | null> {
    const row = this.db
      .prepare("SELECT rules_json FROM policy_configs WHERE agent_id = ? AND owner_id = ?")
      .get(agentId, ownerId) as { rules_json: string } | undefined;
    if (!row) return null;
    return parsePolicyRules(row.rules_json);
  }

  async getWithMetadata(agentId: string): Promise<{ rules: PolicyRules; version: number; updatedAt: string } | null> {
    const row = this.db
      .prepare("SELECT rules_json, version, updated_at FROM policy_configs WHERE agent_id = ?")
      .get(agentId) as { rules_json: string; version: number; updated_at: string } | undefined;
    if (!row) return null;
    return { rules: parsePolicyRules(row.rules_json), version: row.version, updatedAt: row.updated_at };
  }

  async upsert(agentId: string, ownerId: string, rules: PolicyRules): Promise<{ rules: PolicyRules; version: number }> {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT owner_id, version FROM policy_configs WHERE agent_id = ?")
      .get(agentId) as { owner_id: string; version: number } | undefined;

    let newVersion: number;
    if (existing) {
      if (existing.owner_id !== ownerId) {
        throw new Error(`Policy config for agent ${agentId} is owned by another user`);
      }
      newVersion = existing.version + 1;
      const update = this.db
        .prepare(
          `UPDATE policy_configs SET rules_json = ?, version = ?, updated_at = ? WHERE agent_id = ? AND owner_id = ?`
        )
        .run(JSON.stringify(rules), newVersion, now, agentId, ownerId);
      if (update.changes === 0) {
        throw new Error(`Policy config for agent ${agentId} is owned by another user`);
      }
    } else {
      newVersion = 1;
      this.db
        .prepare(
          `INSERT INTO policy_configs (agent_id, owner_id, rules_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(agentId, ownerId, JSON.stringify(rules), newVersion, now, now);
    }
    return { rules, version: newVersion };
  }

  async delete(agentId: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM policy_configs WHERE agent_id = ?").run(agentId);
    return result.changes > 0;
  }

  async listByOwner(ownerId: string): Promise<Array<{ agentId: string; rules: PolicyRules }>> {
    const rows = this.db
      .prepare("SELECT agent_id, rules_json FROM policy_configs WHERE owner_id = ?")
      .all(ownerId) as Array<{ agent_id: string; rules_json: string }>;
    return rows.map((r) => ({ agentId: r.agent_id, rules: parsePolicyRules(r.rules_json) }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSharedConnection(this.dbPath);
  }
}
