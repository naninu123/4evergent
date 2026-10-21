import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseShutdownTimeout,
  registerShutdownHandlers,
} from "../src/server.js";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { Signer } from "@4evergent/stellar";

const __dirname = dirname(fileURLToPath(import.meta.url));

class MockSigner implements Signer {
  private id: string;
  constructor(id: string = "GC4B7QQGMAX7EXAMPLE") {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string {
    return this.id;
  }
  getNetworkPassphrase(): string {
    return "Test SDF Network ; September 2015";
  }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

// ---------------------------------------------------------------------------
// 1. parseShutdownTimeout configuration
// ---------------------------------------------------------------------------

test("parseShutdownTimeout: returns default when undefined or empty", () => {
  assert.equal(parseShutdownTimeout(undefined), 10_000);
  assert.equal(parseShutdownTimeout(""), 10_000);
  assert.equal(parseShutdownTimeout("   "), 10_000);
  assert.equal(parseShutdownTimeout(undefined, 5_000), 5_000);
});

test("parseShutdownTimeout: parses valid positive number", () => {
  assert.equal(parseShutdownTimeout("5000"), 5000);
  assert.equal(parseShutdownTimeout("15000"), 15000);
});

test("parseShutdownTimeout: throws on non-numeric or non-positive values", () => {
  assert.throws(() => parseShutdownTimeout("0"), /Invalid shutdown timeout/);
  assert.throws(() => parseShutdownTimeout("-100"), /Invalid shutdown timeout/);
  assert.throws(() => parseShutdownTimeout("abc"), /Invalid shutdown timeout/);
});

// ---------------------------------------------------------------------------
// 2. registerShutdownHandlers unit behavior
// ---------------------------------------------------------------------------

test("registerShutdownHandlers: SIGTERM triggers server.close() and exits 0", async () => {
  const fakeProcess = new EventEmitter() as any;
  let closeCalled = false;
  const mockServer = {
    close: async () => {
      closeCalled = true;
    },
  };

  const logs: string[] = [];
  let exitCode: number | null = null;

  const registration = registerShutdownHandlers(mockServer, {
    drainTimeoutMs: 5_000,
    processObj: fakeProcess,
    logger: {
      log: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    },
    onExit: (code) => {
      exitCode = code;
    },
  });

  try {
    fakeProcess.emit("SIGTERM");
    // Allow async tick to complete
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(closeCalled, true);
    assert.equal(exitCode, 0);
    assert.ok(logs.some((l) => l.includes("SIGTERM received — shutting down")));
  } finally {
    registration.unregister();
  }
});

test("registerShutdownHandlers: SIGINT triggers server.close() and exits 0", async () => {
  const fakeProcess = new EventEmitter() as any;
  let closeCalled = false;
  const mockServer = {
    close: async () => {
      closeCalled = true;
    },
  };

  const logs: string[] = [];
  let exitCode: number | null = null;

  const registration = registerShutdownHandlers(mockServer, {
    drainTimeoutMs: 5_000,
    processObj: fakeProcess,
    logger: {
      log: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    },
    onExit: (code) => {
      exitCode = code;
    },
  });

  try {
    fakeProcess.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(closeCalled, true);
    assert.equal(exitCode, 0);
    assert.ok(logs.some((l) => l.includes("SIGINT received — shutting down")));
  } finally {
    registration.unregister();
  }
});

test("registerShutdownHandlers: multiple signals do not re-enter shutdown (idempotency)", async () => {
  const fakeProcess = new EventEmitter() as any;
  let closeCalls = 0;
  const mockServer = {
    close: async () => {
      closeCalls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };

  const exitCalls: number[] = [];
  const registration = registerShutdownHandlers(mockServer, {
    drainTimeoutMs: 5_000,
    processObj: fakeProcess,
    logger: { log: () => {}, error: () => {} },
    onExit: (code) => {
      exitCalls.push(code);
    },
  });

  try {
    fakeProcess.emit("SIGTERM");
    fakeProcess.emit("SIGTERM");
    fakeProcess.emit("SIGINT");

    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(closeCalls, 1, "server.close() should be called exactly once");
    assert.deepEqual(exitCalls, [0], "exit should be called exactly once with code 0");
  } finally {
    registration.unregister();
  }
});

test("registerShutdownHandlers: drain timeout force-exits with code 1 if close() hangs", async () => {
  const fakeProcess = new EventEmitter() as any;
  // A server.close() that hangs indefinitely
  const mockServer = {
    close: () => new Promise<void>(() => {}),
  };

  const errorLogs: string[] = [];
  let exitCode: number | null = null;

  const registration = registerShutdownHandlers(mockServer, {
    drainTimeoutMs: 50, // Short timeout for test
    processObj: fakeProcess,
    logger: {
      log: () => {},
      error: (msg) => errorLogs.push(msg),
    },
    onExit: (code) => {
      exitCode = code;
    },
  });

  try {
    fakeProcess.emit("SIGTERM");

    // Wait for the 50ms drain timeout to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(exitCode, 1, "should force-exit with code 1 on timeout");
    assert.ok(
      errorLogs.some((l) => l.includes("Shutdown timeout of 50ms exceeded — forcing exit")),
      "should log shutdown timeout warning"
    );
  } finally {
    registration.unregister();
  }
});

test("registerShutdownHandlers: exits code 1 if server.close() rejects", async () => {
  const fakeProcess = new EventEmitter() as any;
  const mockServer = {
    close: async () => {
      throw new Error("simulated close failure");
    },
  };

  const errorLogs: string[] = [];
  let exitCode: number | null = null;

  const registration = registerShutdownHandlers(mockServer, {
    drainTimeoutMs: 5_000,
    processObj: fakeProcess,
    logger: {
      log: () => {},
      error: (msg) => errorLogs.push(msg),
    },
    onExit: (code) => {
      exitCode = code;
    },
  });

  try {
    fakeProcess.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(exitCode, 1);
    assert.ok(errorLogs.some((l) => l.includes("Error during shutdown")));
  } finally {
    registration.unregister();
  }
});

test("registerShutdownHandlers: unregister removes listeners", () => {
  const fakeProcess = new EventEmitter() as any;
  const registration = registerShutdownHandlers({ close: async () => {} }, { processObj: fakeProcess });

  assert.equal(fakeProcess.listenerCount("SIGTERM"), 1);
  assert.equal(fakeProcess.listenerCount("SIGINT"), 1);

  registration.unregister();

  assert.equal(fakeProcess.listenerCount("SIGTERM"), 0);
  assert.equal(fakeProcess.listenerCount("SIGINT"), 0);
});

// ---------------------------------------------------------------------------
// 3. Worker lifecycle shutdown on live ApiServer instance
// ---------------------------------------------------------------------------

test("shutdown stops all background workers (scheduler, execution queue, reconciler)", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("GWORKERTEST"),
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    scheduler: { enabled: true, intervalMs: 60_000 },
    executionQueue: { enabled: true, intervalMs: 60_000 },
    reconciliation: { enabled: true, intervalMs: 60_000 },
  });

  assert.equal(server.scheduler?.isRunning(), true, "scheduler should be running");
  assert.equal(server.executionQueue?.isRunning(), true, "executionQueue should be running");

  const fakeProcess = new EventEmitter() as any;
  let exitCode: number | null = null;

  const registration = registerShutdownHandlers(server, {
    drainTimeoutMs: 5_000,
    processObj: fakeProcess,
    onExit: (code) => {
      exitCode = code;
    },
  });

  try {
    fakeProcess.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(exitCode, 0, "should exit cleanly with code 0");
    assert.equal(server.scheduler?.isRunning(), false, "scheduler should be stopped");
    assert.equal(server.executionQueue?.isRunning(), false, "executionQueue should be stopped");
  } finally {
    registration.unregister();
  }
});

// ---------------------------------------------------------------------------
// 4. E2E process integration test (Acceptance Criterion 6)
// ---------------------------------------------------------------------------

test("sending SIGTERM to a started server process exits 0 with workers stopped", async () => {
  const serverPath = join(__dirname, "../src/server.ts");
  const tsxBin = join(__dirname, "../node_modules/.bin/tsx");

  // Valid offline testnet secret key for keypair initialization
  const testSecretKey = "SD3ESQ67UH6ZUIHX7TITN56KT3TSLSFIBHHI4AFWUVBIBN5ZISCQSRQ6";

  const child = spawn(tsxBin, [serverPath], {
    cwd: join(__dirname, ".."),
    env: {
      ...process.env,
      STELLAR_TESTNET_SECRET_KEY: testSecretKey,
      PORT: "0",
      HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "1",
      RECONCILIATION_INTERVAL_MS: "60000",
      EXECUTION_QUEUE_INTERVAL_MS: "60000",
      SCHEDULER_INTERVAL_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let sigtermSent = false;

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
    if (!sigtermSent && stdout.includes("Server listening on")) {
      sigtermSent = true;
      child.kill("SIGTERM");
    }
  });

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitResult = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  assert.equal(sigtermSent, true, "server should have started and reached listening state");
  assert.equal(exitResult.code, 0, `process should exit 0, got code ${exitResult.code}, stderr: ${stderr}`);
  assert.ok(stdout.includes("[4evergent] SIGTERM received — shutting down"), "should log SIGTERM received");
  assert.ok(stdout.includes("[scheduler] stopped"), "should log scheduler stopped");
  assert.ok(stdout.includes("[execution-queue] stopped"), "should log execution-queue stopped");
  assert.ok(stdout.includes("[reconciler] stopped"), "should log reconciler stopped");
});
