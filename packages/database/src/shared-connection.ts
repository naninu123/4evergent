import { DatabaseSync } from "node:sqlite";

interface SharedConnectionEntry {
  db: DatabaseSync;
  refCount: number;
}

const connections = new Map<string, SharedConnectionEntry>();

/** Single source of truth for the SQLite schema understood by this release. */
export const EXPECTED_SCHEMA_VERSION = 5;

export function getSharedConnection(dbPath: string): DatabaseSync {
  const existing = connections.get(dbPath);
  if (existing) {
    existing.refCount++;
    return existing.db;
  }
  const db = new DatabaseSync(dbPath);
  try {
    // WAL allows readers to continue while another connection writes. These
    // connection settings apply to every store sharing this connection.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);");
    runSchemaMigrations(db);
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore
    }
    throw err;
  }
  connections.set(dbPath, { db, refCount: 1 });
  return db;
}

export function getSchemaVersion(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (!row) return null;
  const parsed = parseInt(row.value, 10);
  return isNaN(parsed) ? null : parsed;
}

export function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)",
  ).run(String(version));
}

/**
 * Version-gated migration entry point. Additive migrations belong in the
 * explicit switch below; until one exists, mismatched databases fail closed.
 */
export function runSchemaMigrations(db: DatabaseSync): void {
  const actual = getSchemaVersion(db);
  if (actual === null) {
    setSchemaVersion(db, EXPECTED_SCHEMA_VERSION);
    return;
  }
  if (actual !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(
      `FATAL: unsupported database schema version: expected ${EXPECTED_SCHEMA_VERSION}, actual ${actual}`,
    );
  }
}

export function closeSharedConnection(dbPath: string, force = false): void {
  const entry = connections.get(dbPath);
  if (!entry) return;

  if (!force) {
    entry.refCount--;
    if (entry.refCount > 0) {
      return;
    }
  }

  try {
    try {
      entry.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // Best-effort checkpoint before close
    }
    entry.db.close();
  } finally {
    connections.delete(dbPath);
  }
}

export function closeAllSharedConnections(): void {
  for (const entry of connections.values()) {
    try {
      try {
        entry.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // Best-effort checkpoint before close
      }
      entry.db.close();
    } catch {
      // ignore
    }
  }
  connections.clear();
}

export function getSharedConnectionRefCount(dbPath: string): number {
  return connections.get(dbPath)?.refCount ?? 0;
}
