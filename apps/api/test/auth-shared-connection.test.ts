import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Signer } from "@4evergent/stellar";
import { getSharedConnection, closeSharedConnection } from "@4evergent/database";
import { createApiServer } from "../src/index.js";
import { createAuthModule } from "../src/auth.js";

class MockSigner implements Signer {
  getAccountId(): string {
    return "GMOCKSIGNER000000000000000000000000000000000000000000000MOCK";
  }
  getNetworkPassphrase(): string {
    return "Test SDF Network ; September 2015";
  }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

/**
 * Spawns a separate Node process that acquires an exclusive SQLite write lock
 * (`BEGIN IMMEDIATE`), prints "LOCKED\n" once the lock is held, holds it for
 * `holdMs`, and then commits and exits.
 */
function holdWriteLockInChild(dbPath: string, holdMs: number): Promise<{ done: Promise<number> }> {
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.env.LOCK_DB_PATH);
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("CREATE TABLE IF NOT EXISTS _lock_probe (id INTEGER PRIMARY KEY, ts INTEGER);");
    db.exec("BEGIN EXCLUSIVE;");
    db.prepare("INSERT OR REPLACE INTO _lock_probe (id, ts) VALUES (1, ?)").run(Date.now());
    process.send?.("LOCKED");
    setTimeout(() => {
      db.exec("COMMIT;");
      const committedAt = Date.now();
      db.close();
      process.send?.({ committedAt });
    }, Number(process.env.HOLD_MS));
  `;

  return new Promise((resolveReady, rejectReady) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, LOCK_DB_PATH: dbPath, HOLD_MS: String(holdMs) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    let stderr = "";
    let ready = false;
    let committedAt = 0;

    const done = new Promise<number>((resolveDone, rejectDone) => {
      child.on("error", (err) => {
        if (!ready) rejectReady(err);
        rejectDone(err);
      });
      child.on("exit", (code) => {
        if (code === 0) {
          resolveDone(committedAt);
        } else {
          const err = new Error(`Lock holder exited with code ${code}: ${stderr}`);
          if (!ready) rejectReady(err);
          rejectDone(err);
        }
      });
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("message", (msg: unknown) => {
      if (msg === "LOCKED" && !ready) {
        ready = true;
        resolveReady({ done });
      } else if (typeof msg === "object" && msg !== null && "committedAt" in msg) {
        committedAt = Number((msg as { committedAt: number }).committedAt);
      }
    });
  });
}

test("auth stores use the shared SQLite connection and pragmas even when constructed first", () => {
  const dir = mkdtempSync(join(tmpdir(), "4eg-auth-shared-conn-"));
  const dbPath = join(dir, "auth.sqlite");
  try {
    // Mirrors server.ts startup order: auth module is created before other stores.
    createAuthModule({ dbPath, fallbackProvider: null, config: {} });

    const shared = getSharedConnection(dbPath);
    const journalMode = shared.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
    const busyTimeout = shared.prepare("PRAGMA busy_timeout;").get() as { timeout: number };
    const synchronous = shared.prepare("PRAGMA synchronous;").get() as { synchronous: number };

    assert.equal(journalMode.journal_mode.toLowerCase(), "wal");
    assert.equal(busyTimeout.timeout, 5000);
    // SQLite PRAGMA synchronous: 0 = OFF, 1 = NORMAL, 2 = FULL
    assert.equal(synchronous.synchronous, 1);

    const tables = shared
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('auth_users', 'auth_sessions')")
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));
    assert.ok(names.has("auth_users"), "auth_users table should be created on the shared connection");
    assert.ok(names.has("auth_sessions"), "auth_sessions table should be created on the shared connection");
  } finally {
    closeSharedConnection(dbPath, true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth user and session writes wait for a held write lock and succeed instead of failing instantly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "4eg-auth-lock-"));
  const dbPath = join(dir, "auth.sqlite");
  const authModule = createAuthModule({ dbPath, fallbackProvider: null, config: {} });
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner(),
    authModule,
  });
  await server.listen(0);
  const { port } = server.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const holdMs = 600;

  try {
    // 1. Registration writes to both UserStore and SessionStore while another process holds a write lock.
    const { done: lock1Done } = await holdWriteLockInChild(dbPath, holdMs);
    const t0 = Date.now();
    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "4evergent",
      },
      body: JSON.stringify({ email: "locktest@example.com", password: "password123" }),
    });
    const regFinishedAt = Date.now();
    const elapsedReg = regFinishedAt - t0;
    const lock1CommittedAt = await lock1Done;

    assert.equal(regRes.status, 201, "registration should wait for the lock and succeed");
    assert.ok(
      regFinishedAt >= lock1CommittedAt - 50 && elapsedReg >= holdMs - 150,
      `expected registration to wait for the held lock (~${holdMs}ms), elapsed=${elapsedReg}ms, regFinishedAt-lock1CommittedAt=${regFinishedAt - lock1CommittedAt}ms, lock1CommittedAt-t0=${lock1CommittedAt - t0}ms`
    );

    // 2. Login writes to SessionStore while another process holds a write lock.
    const { done: lock2Done } = await holdWriteLockInChild(dbPath, holdMs);
    const t1 = Date.now();
    const loginRes = await fetch(`${baseUrl}/auth/login/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "4evergent",
      },
      body: JSON.stringify({ email: "locktest@example.com", password: "password123" }),
    });
    const loginFinishedAt = Date.now();
    const elapsedLogin = loginFinishedAt - t1;
    const lock2CommittedAt = await lock2Done;

    assert.equal(loginRes.status, 200, "login session write should wait for the lock and succeed");
    assert.ok(
      loginFinishedAt >= lock2CommittedAt - 50 && elapsedLogin >= holdMs - 150,
      `expected login session write to wait for the held lock (~${holdMs}ms), elapsed=${elapsedLogin}ms`
    );

    const setCookies = loginRes.headers.getSetCookie?.() ?? [];
    const sessionCookie = setCookies.find((c) => c.startsWith("four_eg_session="));
    assert.ok(sessionCookie, "login should issue a session cookie");
    const token = sessionCookie.match(/^four_eg_session=([^;]+)/)?.[1];
    assert.ok(token, "session cookie should contain a token");

    const meRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Cookie: `four_eg_session=${token}` },
    });
    assert.equal(meRes.status, 200);
  } finally {
    await server.close();
    closeSharedConnection(dbPath);
    rmSync(dir, { recursive: true, force: true });
  }
});
