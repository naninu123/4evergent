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
import { ExecutionQueue } from "../src/execution-queue.js";
import { InMemoryExecutionStore } from "@4evergent/database";
import type { ExecutionRecord } from "@4evergent/database";
import { ExecutionRecoveryService } from "../src/execution-recovery.js";

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

function makeExecutionRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-test",
    agentId: "agent-test",
    approvalId: null,
    activityId: null,
    intent: { type: "payment", asset: "XLM", destination: "GDEST", amount: "10", reason: "test" },
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
    ...overrides,
  };
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
// 4. Regression test: active in-flight HTTP request finishes during normal shutdown
// ---------------------------------------------------------------------------

test("regression: active in-flight HTTP request is allowed to finish during normal shutdown", async () => {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner(),
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
  });

  await server.listen(0, "127.0.0.1");
  const port = (server.server.address() as any).port;

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
    // Send a valid request
    const requestPromise = fetch(`http://127.0.0.1:${port}/health`);

    // Wait a brief moment for the request socket to connect, then signal shutdown
    await new Promise((r) => setTimeout(r, 2));
    fakeProcess.emit("SIGTERM");

    // The active request must succeed without socket hangup
    const res = await requestPromise;
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");

    // Allow shutdown to complete
    for (let i = 0; i < 25 && exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(exitCode, 0, "server should have exited cleanly with code 0");

    // New requests after shutdown must be refused
    await assert.rejects(
      async () => {
        await fetch(`http://127.0.0.1:${port}/health`);
      },
      /fetch failed|ECONNREFUSED/
    );
  } finally {
    registration.unregister();
  }
});

// ---------------------------------------------------------------------------
// 5. Regression test: in-flight queue executions drain before shutdown completes
// ---------------------------------------------------------------------------

test("regression: in-flight queue executions finish within drain timeout", async () => {
  const store = new InMemoryExecutionStore();
  let executionCompleted = false;

  const queue = new ExecutionQueue(
    store,
    async (rec) => {
      // Simulate an execution pipeline running for 60ms
      await new Promise((r) => setTimeout(r, 60));
      executionCompleted = true;
      return {
        record: rec,
        success: true,
        status: "submitted",
        txHash: "tx-graceful-1",
        error: null,
      };
    },
    async () => ({
      accountId: () => "GACC",
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    })
  );

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner(),
    executionStore: store,
    executionQueue: { enabled: true, instance: queue },
  });

  const rec = makeExecutionRecord({ id: "exec-drain-1", status: "queued" });
  await store.record(rec);

  // Start processing the execution
  const processPromise = queue.processDue();

  // Allow execution to be claimed and become active
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(queue.getActiveCount(), 1, "execution should be active");

  const fakeProcess = new EventEmitter() as any;
  let exitCode: number | null = null;
  const registration = registerShutdownHandlers(server, {
    drainTimeoutMs: 2_000,
    processObj: fakeProcess,
    onExit: (code) => {
      exitCode = code;
    },
  });

  try {
    fakeProcess.emit("SIGTERM");

    await processPromise;
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(executionCompleted, true, "in-flight execution should complete before shutdown exits");
    assert.equal(queue.getActiveCount(), 0, "active count should be 0");
    assert.equal(exitCode, 0, "shutdown should exit 0");

    const finalRecord = await store.get("exec-drain-1");
    assert.equal(finalRecord?.status, "submitted");
  } finally {
    registration.unregister();
  }
});

// ---------------------------------------------------------------------------
// 6. Regression test: actual createApiServer() shutdown path
// ---------------------------------------------------------------------------

test("regression: actual createApiServer() shutdown path force-exits with code 1 when drain deadline is exceeded, and 0 on normal shutdown", async () => {
  // Case 1: Active request hangs and exceeds drain deadline -> must force-exit with code 1
  {
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: new MockSigner(),
      authProvider: {
        authenticate: async ({ headers }) => {
          if (headers["x-hang"] === "true") {
            // Hang indefinitely to simulate an in-flight request exceeding drain deadline
            await new Promise(() => {});
          }
          return { ownerId: "test", subject: "test" };
        },
      },
    });

    await server.listen(0, "127.0.0.1");
    const port = (server.server.address() as any).port;

    const fakeProcess = new EventEmitter() as any;
    let exitCode: number | null = null;
    const errorLogs: string[] = [];

    const registration = registerShutdownHandlers(server, {
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
      // Start request that hangs during authentication
      const hangingReqPromise = fetch(`http://127.0.0.1:${port}/agents`, {
        headers: { "x-hang": "true" },
      });

      // Allow request socket to connect and enter handler
      await new Promise((r) => setTimeout(r, 10));
      fakeProcess.emit("SIGTERM");

      // The hanging connection must be destroyed when drain timeout expires
      await assert.rejects(async () => {
        await hangingReqPromise;
      });

      // Wait for shutdown handler to exit
      for (let i = 0; i < 25 && exitCode === null; i++) {
        await new Promise((r) => setTimeout(r, 15));
      }

      assert.equal(exitCode, 1, "exceeded drain deadline on actual createApiServer() must exit with code 1");
      assert.ok(
        errorLogs.some((l) => l.includes("Shutdown timeout of 50ms exceeded — forcing exit")),
        "should log shutdown timeout warning"
      );
    } finally {
      registration.unregister();
    }
  }

  // Case 2: Normal graceful shutdown on actual createApiServer() exits with code 0
  {
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: new MockSigner(),
      authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    });

    await server.listen(0, "127.0.0.1");
    const port = (server.server.address() as any).port;

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
      // Send a request that finishes normally
      const reqPromise = fetch(`http://127.0.0.1:${port}/health`);
      await new Promise((r) => setTimeout(r, 2));

      fakeProcess.emit("SIGTERM");

      const res = await reqPromise;
      assert.equal(res.status, 200);

      for (let i = 0; i < 25 && exitCode === null; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }

      assert.equal(exitCode, 0, "normal graceful shutdown on actual createApiServer() must exit with code 0");
    } finally {
      registration.unregister();
    }
  }
});

// ---------------------------------------------------------------------------
// 7. Ambiguous submission recovery: preCheck prevents blind retries
// ---------------------------------------------------------------------------

test("ambiguous submission recovery: executing record with txHash found on-chain moves to submitted without retry", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecutionRecord({
    id: "exec-ambig-1",
    status: "executing",
    txHash: "tx-hash-confirmed-1",
    submittedHash: "tx-hash-confirmed-1",
    attempt: 1,
  });
  await store.record(execution);

  const recoveryService = new ExecutionRecoveryService(store, {
    preCheck: async (txHash) => {
      assert.equal(txHash, "tx-hash-confirmed-1");
      return "found";
    },
  });

  const result = await recoveryService.recover();
  assert.equal(result.recovered, 1);
  assert.equal(result.skipped, 0);

  const updated = await store.get("exec-ambig-1");
  assert.equal(updated?.status, "submitted", "should move to submitted for reconciler without blind retry");
  assert.equal(updated?.attempt, 1, "attempt count should be preserved");
});

test("ambiguous submission recovery: executing record with txHash not on-chain moves to failed for retry", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecutionRecord({
    id: "exec-ambig-2",
    status: "executing",
    txHash: "tx-hash-notfound-2",
    submittedHash: "tx-hash-notfound-2",
    attempt: 1,
  });
  await store.record(execution);

  const recoveryService = new ExecutionRecoveryService(store, {
    preCheck: async () => "not_found",
  });

  const result = await recoveryService.recover();
  assert.equal(result.recovered, 1);

  const updated = await store.get("exec-ambig-2");
  assert.equal(updated?.status, "failed", "should safely move to failed for retry");
  assert.ok(updated?.nextRetryAt, "nextRetryAt should be set");
});

test("ambiguous submission recovery: executing record with network error is skipped without blind retry", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecutionRecord({
    id: "exec-ambig-3",
    status: "executing",
    txHash: "tx-hash-neterr-3",
    submittedHash: "tx-hash-neterr-3",
    attempt: 1,
  });
  await store.record(execution);

  const recoveryService = new ExecutionRecoveryService(store, {
    preCheck: async () => "network_error",
  });

  const result = await recoveryService.recover();
  assert.equal(result.recovered, 0);
  assert.equal(result.skipped, 1);

  const unchanged = await store.get("exec-ambig-3");
  assert.equal(unchanged?.status, "executing", "should not be blindly marked failed or retried");
});

// ---------------------------------------------------------------------------
// 8. E2E process integration test (Acceptance Criterion 6)
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
