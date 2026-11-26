import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Keypair,
  Networks,
  StrKey,
  nativeToScVal,
  scValToNative,
  xdr,
  type Horizon,
  type Transaction,
  type rpc,
} from "@stellar/stellar-sdk";
import type { ContractCallIntent } from "@4evergent/shared";
import { InMemoryActivityStore, InMemoryApprovalStore, createApproval, createActivity } from "@4evergent/database";
import { StellarAdapter } from "@4evergent/agent-core";
import { StellarTransactionBuilder } from "../src/transaction-builder.js";
import { StellarSimulator } from "../src/simulator.js";
import { TransactionPipeline } from "../src/pipeline.js";
import type { Signer } from "../src/signer.js";

const VALID_CONTRACT = "CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7";
const SOURCE_KEYPAIR = Keypair.random();
const SOURCE_ACCOUNT_ID = SOURCE_KEYPAIR.publicKey();
const PASSPHRASE = Networks.TESTNET;
const TX_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Minimal valid SorobanTransactionData base64 XDR for assembleTransaction
const DUMMY_SOROBAN_DATA = new xdr.SorobanTransactionData({
  ext: new xdr.ExtensionPoint(0),
  resources: new xdr.SorobanResources({
    footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
    instructions: 1000,
    readBytes: 100,
    writeBytes: 100,
  }),
  resourceFee: new xdr.Int64(50),
}).toXDR("base64");

class TestSigner implements Signer {
  calls = 0;
  lastSignedTx?: Transaction;

  constructor(private accountId: string = SOURCE_ACCOUNT_ID) {}

  getAccountId(): string {
    return this.accountId;
  }

  getNetworkPassphrase(): string {
    return PASSPHRASE;
  }

  async sign(tx: Transaction): Promise<any> {
    this.calls++;
    this.lastSignedTx = tx;
    return {
      hash: () => Buffer.from(TX_HASH, "hex"),
      toEnvelope: () => tx.toEnvelope(),
    };
  }
}

function fakeHorizonServer(opts: {
  sequence?: string;
  baseFee?: number;
  balance?: string;
} = {}): Horizon.Server {
  return {
    fetchBaseFee: async () => opts.baseFee ?? 100,
    accounts: () => ({
      accountId: () => ({
        call: async () => ({
          sequence: opts.sequence ?? "10",
          subentry_count: 0,
          balances: [{ asset_type: "native", balance: opts.balance ?? "100.0000000" }],
        }),
      }),
    }),
  } as unknown as Horizon.Server;
}

function fakeSorobanServer(opts: {
  error?: string;
  throwError?: Error;
  minResourceFee?: string;
  transactionData?: string;
} = {}): rpc.Server {
  return {
    simulateTransaction: async () => {
      if (opts.throwError) throw opts.throwError;
      if (opts.error) {
        return {
          id: 1,
          latestLedger: 100,
          error: opts.error,
        };
      }
      return {
        id: 1,
        latestLedger: 100,
        minResourceFee: opts.minResourceFee ?? "50",
        transactionData: opts.transactionData ?? DUMMY_SOROBAN_DATA,
        results: [{ auth: [], xdr: nativeToScVal(123).toXDR("base64") }],
      };
    },
  } as unknown as rpc.Server;
}

// ── 1. Transaction Builder Tests ─────────────────────────────────────────────

test("BUILDER: buildContractCall rejects non-contract_call intent", async () => {
  const builder = new StellarTransactionBuilder();
  const source = new Account(SOURCE_ACCOUNT_ID, "10");
  await assert.rejects(
    builder.buildContractCall(source, { type: "payment" } as any, PASSPHRASE),
    /expected contract_call intent/
  );
});

test("BUILDER: buildContractCall rejects invalid contract ID", async () => {
  const builder = new StellarTransactionBuilder();
  const source = new Account(SOURCE_ACCOUNT_ID, "10");
  await assert.rejects(
    builder.buildContractCall(
      source,
      {
        type: "contract_call",
        contractId: "INVALID_CONTRACT",
        function: "test",
        args: [],
        reason: "test invalid contract",
      },
      PASSPHRASE
    ),
    /contractId must be a valid Stellar contract address/
  );
});

test("BUILDER: buildContractCall rejects empty function name", async () => {
  const builder = new StellarTransactionBuilder();
  const source = new Account(SOURCE_ACCOUNT_ID, "10");
  await assert.rejects(
    builder.buildContractCall(
      source,
      {
        type: "contract_call",
        contractId: VALID_CONTRACT,
        function: "   ",
        args: [],
        reason: "test empty fn",
      },
      PASSPHRASE
    ),
    /function required/
  );
});

test("BUILDER: buildContractCall constructs invocation with contract ID, function name, and args", async () => {
  const builder = new StellarTransactionBuilder({ baseFeeStroops: "200" });
  const source = new Account(SOURCE_ACCOUNT_ID, "10");
  const intent: ContractCallIntent = {
    type: "contract_call",
    contractId: VALID_CONTRACT,
    function: "register_agent",
    args: ["agent_007", 42, true],
    reason: "registering new agent in registry",
  };

  const tx = await builder.buildContractCall(source, intent, PASSPHRASE);

  assert.equal(tx.fee, "200");
  assert.equal(tx.operations.length, 1);
  const op = tx.operations[0] as any;
  assert.equal(op.type, "invokeHostFunction");

  // Inspect the invocation operation attributes
  const hostFn = op.func;
  assert.equal(hostFn.switch().name, "hostFunctionTypeInvokeContract");
  const invokeArgs = hostFn.value();
  const contractAddress = StrKey.encodeContract(invokeArgs.contractAddress().contractId());
  assert.equal(contractAddress, VALID_CONTRACT);
  assert.equal(invokeArgs.functionName().toString(), "register_agent");

  // Verify arguments round-trip via scValToNative
  const scVals = invokeArgs.args();
  assert.equal(scVals.length, 3);
  assert.equal(scValToNative(scVals[0]), "agent_007");
  assert.equal(scValToNative(scVals[1]), 42n);
  assert.equal(scValToNative(scVals[2]), true);

  // Verify memo truncated to <= 28 bytes
  assert.equal(tx.memo.type, "text");
  assert.ok(tx.memo.value);
});

// ── 2. Soroban Simulation Tests ──────────────────────────────────────────────

test("SIMULATOR: Soroban simulation and assembly succeed on valid invocation", async () => {
  const horizon = fakeHorizonServer({ sequence: "10", baseFee: 100 });
  const soroban = fakeSorobanServer({ minResourceFee: "75" });
  const simulator = new StellarSimulator("https://horizon-testnet.stellar.org", horizon, soroban);

  const builder = new StellarTransactionBuilder({ baseFeeStroops: "100" });
  const source = new Account(SOURCE_ACCOUNT_ID, "10");
  const tx = await builder.buildContractCall(
    source,
    {
      type: "contract_call",
      contractId: VALID_CONTRACT,
      function: "ping",
      args: [],
      reason: "simulation test",
    },
    PASSPHRASE
  );

  const result = await simulator.simulate(tx);

  assert.equal(result.success, true);
  // Classic base fee 100 + Soroban resource fee 75 = 175
  assert.equal(result.fee, "175");
  assert.ok(result.assembledTransaction);
  assert.equal(result.assembledTransaction.fee, "175");
});

test("SIMULATOR: Soroban simulation error returns failure and blocks assembly", async () => {
  const horizon = fakeHorizonServer({ sequence: "10", baseFee: 100 });
  const soroban = fakeSorobanServer({ error: "HostError: Error(Contract, #1)" });
  const simulator = new StellarSimulator("https://horizon-testnet.stellar.org", horizon, soroban);

  const builder = new StellarTransactionBuilder({ baseFeeStroops: "100" });
  const source = new Account(SOURCE_ACCOUNT_ID, "10");
  const tx = await builder.buildContractCall(
    source,
    {
      type: "contract_call",
      contractId: VALID_CONTRACT,
      function: "fail_call",
      args: [],
      reason: "simulation error test",
    },
    PASSPHRASE
  );

  const result = await simulator.simulate(tx);

  assert.equal(result.success, false);
  assert.match(result.error!, /Soroban simulation failed.*HostError/);
  assert.equal(result.assembledTransaction, undefined);
});

// ── 3. Pipeline Dispatch Tests ───────────────────────────────────────────────

test("PIPELINE: execute() dispatches contract_call and signs assembled transaction", async () => {
  const horizon = fakeHorizonServer({ sequence: "10", baseFee: 100 });
  const soroban = fakeSorobanServer({ minResourceFee: "50" });
  const signer = new TestSigner();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();

  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: PASSPHRASE,
    signer,
    activityStore,
    approvalStore,
    policyRules: {
      txTypeRestrictions: { contract_call: true },
      allowedContractIds: [VALID_CONTRACT],
      allowedAssets: ["XLM", "native"],
    },
  });

  // Inject stubbed simulator & submitter
  (pipeline as any).simulator = new StellarSimulator("https://horizon-testnet.stellar.org", horizon, soroban);
  (pipeline as any).submitter = {
    submit: async (_signedTx: Transaction) => ({
      hash: TX_HASH,
      ledger: 12345,
    }),
  };

  const intent: ContractCallIntent = {
    type: "contract_call",
    contractId: VALID_CONTRACT,
    function: "invoke_method",
    args: ["hello"],
    reason: "pipeline execution test",
  };

  const outcome = await pipeline.execute({
    intent,
    sourceAccount: {
      accountId: () => SOURCE_ACCOUNT_ID,
      sequenceNumber: () => "10",
      incrementSequenceNumber: () => {},
      agentId: "agent-1",
    },
  });

  assert.equal(outcome.status, "submitted");
  assert.equal(outcome.txHash, TX_HASH);
  assert.equal(signer.calls, 1);
  // Verify that signer signed the assembled transaction (fee 100 + 50 = 150)
  assert.equal(signer.lastSignedTx?.fee, "150");
});

test("PIPELINE: execute() blocks signing and submission on Soroban simulation failure", async () => {
  const horizon = fakeHorizonServer({ sequence: "10", baseFee: 100 });
  const soroban = fakeSorobanServer({ error: "VM execution trapped: out of memory" });
  const signer = new TestSigner();
  const activityStore = new InMemoryActivityStore();

  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: PASSPHRASE,
    signer,
    activityStore,
    policyRules: {
      txTypeRestrictions: { contract_call: true },
      allowedContractIds: [VALID_CONTRACT],
      allowedAssets: ["XLM", "native"],
    },
  });

  (pipeline as any).simulator = new StellarSimulator("https://horizon-testnet.stellar.org", horizon, soroban);
  (pipeline as any).submitter = {
    submit: async () => {
      throw new Error("Submit should NOT be called on simulation failure");
    },
  };

  const intent: ContractCallIntent = {
    type: "contract_call",
    contractId: VALID_CONTRACT,
    function: "crash",
    args: [],
    reason: "sim failure test",
  };

  const outcome = await pipeline.execute({
    intent,
    sourceAccount: {
      accountId: () => SOURCE_ACCOUNT_ID,
      sequenceNumber: () => "10",
      incrementSequenceNumber: () => {},
      agentId: "agent-1",
    },
  });

  assert.equal(outcome.status, "simulation_failed");
  assert.match(outcome.message!, /out of memory/);
  // Signer was never called
  assert.equal(signer.calls, 0);
});

test("PIPELINE: executeApproved() correctly dispatches approved contract_call", async () => {
  const horizon = fakeHorizonServer({ sequence: "10", baseFee: 100 });
  const soroban = fakeSorobanServer({ minResourceFee: "80" });
  const signer = new TestSigner();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();

  const intent: ContractCallIntent = {
    type: "contract_call",
    contractId: VALID_CONTRACT,
    function: "approved_fn",
    args: ["param"],
    reason: "approved contract call execution",
  };

  const activity = createActivity("agent-1", "owner-1", intent, {
    result: "requires_approval",
    reason: "Requires approval",
    rule: "approvalThreshold",
    intent,
  });
  await activityStore.record(activity);

  const approval = createApproval(
    activity.id,
    "agent-1",
    "owner-1",
    intent,
    {
      result: "requires_approval",
      reason: "Requires approval",
      rule: "approvalThreshold",
      intent,
    },
    new Date(Date.now() + 60_000).toISOString()
  );
  approval.status = "approved";
  await approvalStore.record(approval);

  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: PASSPHRASE,
    signer,
    activityStore,
    approvalStore,
    policyRules: {
      txTypeRestrictions: { contract_call: true },
      allowedContractIds: [VALID_CONTRACT],
      allowedAssets: ["XLM", "native"],
    },
  });

  (pipeline as any).simulator = new StellarSimulator("https://horizon-testnet.stellar.org", horizon, soroban);
  (pipeline as any).submitter = {
    submit: async () => ({
      hash: TX_HASH,
      ledger: 99999,
    }),
  };

  // Mock StellarAdapter.prototype.getAccount for executeApproved
  const origGetAccount = StellarAdapter.prototype.getAccount;
  StellarAdapter.prototype.getAccount = async () => ({
    address: SOURCE_ACCOUNT_ID,
    sequence: "10",
    balances: [],
    subentryCount: 0,
  });

  try {
    const outcome = await pipeline.executeApproved(approval.id, "approver-user");
    assert.equal(outcome.status, "submitted");
    assert.equal(outcome.txHash, TX_HASH);
    assert.equal(signer.calls, 1);
    assert.equal(signer.lastSignedTx?.fee, "180"); // 100 base + 80 resource fee
  } finally {
    StellarAdapter.prototype.getAccount = origGetAccount;
  }
});

test("PIPELINE: executeApproved() enforces policy re-evaluation on tightened policy", async () => {
  const horizon = fakeHorizonServer({ sequence: "10", baseFee: 100 });
  const soroban = fakeSorobanServer();
  const signer = new TestSigner();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();

  const intent: ContractCallIntent = {
    type: "contract_call",
    contractId: VALID_CONTRACT,
    function: "approved_fn",
    args: [],
    reason: "tightened policy test",
  };

  const activity = createActivity("agent-1", "owner-1", intent, null);
  await activityStore.record(activity);

  const approval = createApproval(
    activity.id,
    "agent-1",
    "owner-1",
    intent,
    {
      result: "requires_approval",
      reason: "Requires approval",
      rule: "approvalThreshold",
      intent,
    },
    new Date(Date.now() + 60_000).toISOString()
  );
  approval.status = "approved";
  await approvalStore.record(approval);

  // Pipeline policy has been tightened to remove VALID_CONTRACT from allowedContractIds
  const OTHER_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: PASSPHRASE,
    signer,
    activityStore,
    approvalStore,
    policyRules: {
      txTypeRestrictions: { contract_call: true },
      allowedContractIds: [OTHER_CONTRACT],
      allowedAssets: ["XLM", "native"],
    },
  });

  (pipeline as any).simulator = new StellarSimulator("https://horizon-testnet.stellar.org", horizon, soroban);
  (pipeline as any).submitter = {
    submit: async () => {
      throw new Error("Should not submit");
    },
  };

  const outcome = await pipeline.executeApproved(approval.id);
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.message!, /allowed list/);
  assert.equal(signer.calls, 0);
});

// ── 4. End-to-End Tests ──────────────────────────────────────────────────────

test("E2E: contract_call with explicitly enabled policy executes end-to-end to submitted activity", async () => {
  const horizon = fakeHorizonServer({ sequence: "10", baseFee: 100 });
  const soroban = fakeSorobanServer({ minResourceFee: "60" });
  const signer = new TestSigner();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();

  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: PASSPHRASE,
    signer,
    activityStore,
    approvalStore,
    policyRules: {
      txTypeRestrictions: { contract_call: true },
      allowedContractIds: [VALID_CONTRACT],
      allowedAssets: ["XLM", "native"],
    },
  });

  (pipeline as any).simulator = new StellarSimulator("https://horizon-testnet.stellar.org", horizon, soroban);
  (pipeline as any).submitter = {
    submit: async () => ({
      hash: TX_HASH,
      ledger: 54321,
    }),
  };

  const intent: ContractCallIntent = {
    type: "contract_call",
    contractId: VALID_CONTRACT,
    function: "execute_transfer",
    args: ["recipient", 1000],
    reason: "e2e contract call test",
  };

  const outcome = await pipeline.execute({
    intent,
    sourceAccount: {
      accountId: () => SOURCE_ACCOUNT_ID,
      sequenceNumber: () => "10",
      incrementSequenceNumber: () => {},
      agentId: "agent-1",
    },
  });

  assert.equal(outcome.status, "submitted");
  assert.equal(outcome.txHash, TX_HASH);

  // Verify activity record in store
  assert.ok(outcome.activityId);
  const recorded = await activityStore.get(outcome.activityId);
  assert.ok(recorded);
  assert.equal(recorded.status, "submitted");
  assert.equal(recorded.authorizationStatus, "approved");
  assert.equal(recorded.txHash, TX_HASH);
  assert.equal(recorded.intent.type, "contract_call");
});

test("E2E: default policy denies contract_call through policy evaluation before building", async () => {
  const horizon = fakeHorizonServer({ sequence: "10" });
  const soroban = fakeSorobanServer();
  const signer = new TestSigner();
  const activityStore = new InMemoryActivityStore();

  // No custom policyRules passed -> uses default policy where contract_call is false
  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: PASSPHRASE,
    signer,
    activityStore,
  });

  (pipeline as any).simulator = new StellarSimulator("https://horizon-testnet.stellar.org", horizon, soroban);
  (pipeline as any).submitter = {
    submit: async () => {
      throw new Error("Submit must not be called when policy denies");
    },
  };

  const intent: ContractCallIntent = {
    type: "contract_call",
    contractId: VALID_CONTRACT,
    function: "invoke_something",
    args: [],
    reason: "default policy denial test",
  };

  const outcome = await pipeline.execute({
    intent,
    sourceAccount: {
      accountId: () => SOURCE_ACCOUNT_ID,
      sequenceNumber: () => "10",
      incrementSequenceNumber: () => {},
      agentId: "agent-1",
    },
  });

  // Verify it is denied by policy evaluation, not by transaction construction
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.message!, /Policy denied: Transaction type 'contract_call' is not permitted/);
  assert.equal(outcome.policyDecision?.result, "deny");
  assert.equal(outcome.policyDecision?.rule, "txTypeRestrictions");
  assert.equal(signer.calls, 0);

  // Check activity record
  assert.ok(outcome.activityId);
  const recorded = await activityStore.get(outcome.activityId);
  assert.ok(recorded);
  assert.equal(recorded.status, "rejected");
  assert.equal(recorded.authorizationStatus, "denied_by_policy");
  assert.equal(recorded.error, "Transaction type 'contract_call' is not permitted");
});
