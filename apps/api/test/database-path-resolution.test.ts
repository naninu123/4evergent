// DATABASE_PATH resolution tests:
// - Relative paths resolve against the repository root regardless of process.cwd().
// - Startup log prints the resolved absolute path.
// - An agent created when started from apps/api is still listed when restarted from repo root.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { Keypair } from "@stellar/stellar-sdk";
import { DEFAULT_DATABASE_ANCHOR, resolveDatabasePath } from "../src/server.js";

test("resolveDatabasePath returns undefined when unset or blank (in-memory fallback)", () => {
  assert.equal(resolveDatabasePath(undefined), undefined);
  assert.equal(resolveDatabasePath(""), undefined);
  assert.equal(resolveDatabasePath("   "), undefined);
});

test("resolveDatabasePath preserves :memory: verbatim", () => {
  assert.equal(resolveDatabasePath(":memory:"), ":memory:");
  assert.equal(resolveDatabasePath("  :memory:  "), ":memory:");
});

test("resolveDatabasePath maps ./4evergent.db to the same absolute path regardless of process.cwd()", () => {
  const originalCwd = process.cwd();
  const repoRoot = DEFAULT_DATABASE_ANCHOR;
  const apiDir = path.join(repoRoot, "apps", "api");
  const expected = path.join(repoRoot, "4evergent.db");

  try {
    process.chdir(repoRoot);
    const fromRoot = resolveDatabasePath("./4evergent.db");

    process.chdir(apiDir);
    const fromApiDir = resolveDatabasePath("./4evergent.db");

    assert.equal(fromRoot, expected);
    assert.equal(fromApiDir, expected);
    assert.equal(fromRoot, fromApiDir);
    assert.ok(path.isAbsolute(fromRoot!));
  } finally {
    process.chdir(originalCwd);
  }
});

test("resolveDatabasePath preserves and normalizes absolute paths", () => {
  const abs = path.join(DEFAULT_DATABASE_ANCHOR, "tmp", "..", "custom.db");
  const resolved = resolveDatabasePath(abs);
  assert.equal(resolved, path.join(DEFAULT_DATABASE_ANCHOR, "custom.db"));
  assert.ok(path.isAbsolute(resolved!));
});

function startServerProcess(opts: {
  cwd: string;
  port: number;
  dbPathEnv: string;
  secretKey: string;
}): Promise<{ child: ChildProcess; stdout: string; databaseLogLine: string }> {
  const serverScript = path.join(DEFAULT_DATABASE_ANCHOR, "apps", "api", "dist", "server.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverScript], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        PORT: String(opts.port),
        HOST: "127.0.0.1",
        DATABASE_PATH: opts.dbPathEnv,
        STELLAR_TESTNET_SECRET_KEY: opts.secretKey,
        API_KEYS: "",
        LIVE_SUBMIT: "0",
        SCHEDULER_ENABLED: "0",
        DATA_RETENTION_ENABLED: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`Server failed to start within timeout.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    }, 15_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (!settled && stdout.includes("[4evergent] Database:") && stdout.includes("listening")) {
        settled = true;
        clearTimeout(timeout);
        const dbLine =
          stdout
            .split(/\r?\n/)
            .find((line) => line.includes("[4evergent] Database:")) ?? "";
        resolve({ child, stdout, databaseLogLine: dbLine });
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Server exited early with code ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
}

function stopServerProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5_000).unref();
  });
}

test("agent persists across restarts from apps/api and repo root with relative DATABASE_PATH, and startup log prints absolute path", async () => {
  const serverScript = path.join(DEFAULT_DATABASE_ANCHOR, "apps", "api", "dist", "server.js");
  assert.ok(
    fs.existsSync(serverScript),
    `Expected built server at ${serverScript} — run pnpm build first`
  );

  const uniqueName = `.tmp-db-anchor-${process.pid}-${Date.now()}.db`;
  const relativeDbPath = `./${uniqueName}`;
  const expectedAbsolutePath = path.join(DEFAULT_DATABASE_ANCHOR, uniqueName);
  const secretKey = Keypair.random().secret();
  const port = 34_000 + (process.pid % 1000);
  const apiDir = path.join(DEFAULT_DATABASE_ANCHOR, "apps", "api");

  try {
    // 1. Start from apps/api (simulating `pnpm --filter @4evergent/api start`)
    const first = await startServerProcess({
      cwd: apiDir,
      port,
      dbPathEnv: relativeDbPath,
      secretKey,
    });

    let createdAgentId: string;
    try {
      assert.ok(
        first.databaseLogLine.includes(expectedAbsolutePath),
        `Expected startup log to include absolute path ${expectedAbsolutePath}, got: ${first.databaseLogLine}`
      );

      const createRes = await fetch(`http://127.0.0.1:${port}/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Anchor Persistence Agent",
          description: "Verifies DATABASE_PATH anchor across start commands",
        }),
      });
      assert.equal(createRes.status, 201);
      const created = (await createRes.json()) as { agent: { id: string; displayName: string } };
      createdAgentId = created.agent.id;
      assert.ok(createdAgentId);
    } finally {
      await stopServerProcess(first.child);
    }

    // 2. Restart from repo root (simulating `node apps/api/dist/server.js`)
    const second = await startServerProcess({
      cwd: DEFAULT_DATABASE_ANCHOR,
      port,
      dbPathEnv: relativeDbPath,
      secretKey,
    });

    try {
      assert.ok(
        second.databaseLogLine.includes(expectedAbsolutePath),
        `Expected startup log to include absolute path ${expectedAbsolutePath}, got: ${second.databaseLogLine}`
      );
      assert.equal(second.databaseLogLine, first.databaseLogLine);

      const listRes = await fetch(`http://127.0.0.1:${port}/agents`);
      assert.equal(listRes.status, 200);
      const listed = (await listRes.json()) as { agents: Array<{ id: string; name: string }> };
      assert.ok(
        listed.agents.some((a) => a.id === createdAgentId),
        `Expected agent ${createdAgentId} to persist across start commands`
      );
    } finally {
      await stopServerProcess(second.child);
    }
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${expectedAbsolutePath}${suffix}`;
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
      }
    }
  }
});
