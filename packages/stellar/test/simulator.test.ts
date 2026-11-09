import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";
import { StellarSimulator, paymentAmount } from "../src/simulator.js";

/**
 * Unit tests for `StellarSimulator` — the mandatory pre-signing gate.
 *
 * Every test is offline: a fake `Horizon.Server` is injected via the
 * constructor seam (production callers keep the default `new Horizon.Server`).
 */

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const USDC = new Asset("USDC", ISSUER);

type FakeBalance = {
  asset_type: string;
  balance: string;
  asset_code?: string;
  asset_issuer?: string;
};

type FakeAccount = {
  sequence: string;
  balances: FakeBalance[];
  subentry_count?: number;
};

function fakeAccount(opts: {
  sequence: string;
  balances?: FakeBalance[];
  subentry_count?: number;
}): FakeAccount {
  return {
    sequence: opts.sequence,
    subentry_count: opts.subentry_count ?? 0,
    balances: opts.balances ?? [{ asset_type: "native", balance: "100.0000000" }],
  };
}

/** Minimal stand-in for the two Horizon calls `simulate()` makes. */
function fakeServer(opts: { baseFee?: number | Error; account?: unknown | Error }): Horizon.Server {
  return {
    fetchBaseFee: async () => {
      if (opts.baseFee instanceof Error) throw opts.baseFee;
      return opts.baseFee ?? 100;
    },
    accounts: () => ({
      accountId: () => ({
        call: async () => {
          if (opts.account instanceof Error) throw opts.account;
          return opts.account;
        },
      }),
    }),
  } as unknown as Horizon.Server;
}

/** Build a real `Transaction` so the envelope round-trip is exercised. */
function buildTx(opts: {
  accountSequence: string;
  fee?: string;
  amount?: string;
  asset?: Asset;
}): Transaction {
  const source = new Account(SOURCE, opts.accountSequence);
  return new TransactionBuilder(source, {
    fee: opts.fee ?? "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: DEST,
        asset: opts.asset ?? Asset.native(),
        amount: opts.amount ?? "10",
      })
    )
    .setTimeout(30)
    .build();
}

// ── Check 1: envelope well-formedness ───────────────────────────────────────
test("SIMULATOR: invalid envelope returns simulation_failed", async () => {
  const sim = new StellarSimulator(HORIZON_URL, fakeServer({}));
  const tx = buildTx({ accountSequence: "100" });
  // Force the XDR round-trip to throw.
  (tx as unknown as { toEnvelope: () => unknown }).toEnvelope = () => {
    throw new Error("malformed XDR");
  };
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /envelope is invalid/i);
});

// ── Check 2: base fee fetch ──────────────────────────────────────────────────
test("SIMULATOR: base fee fetch failure returns simulation_failed", async () => {
  const sim = new StellarSimulator(HORIZON_URL, fakeServer({ baseFee: new Error("network down") }));
  const tx = buildTx({ accountSequence: "100" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /base fee/i);
});

// ── Check 3: source account existence ────────────────────────────────────────
test("SIMULATOR: account not found on network returns simulation_failed", async () => {
  const sim = new StellarSimulator(HORIZON_URL, fakeServer({ account: new Error("404 Not Found") }));
  const tx = buildTx({ accountSequence: "100" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not found on network/i);
});

// ── Check 4: sequence number precondition ────────────────────────────────────
test("SIMULATOR: sequence mismatch returns simulation_failed", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({ account: fakeAccount({ sequence: "100" }) })
  );
  // Build with account sequence "101" → tx.sequence === "102", but the fake
  // on-chain account is still at "100" → 102 !== 100 + 1.
  const tx = buildTx({ accountSequence: "101" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Sequence number mismatch/i);
});

// ── Check 5: fee precondition ────────────────────────────────────────────────
test("SIMULATOR: fee below network base fee returns simulation_failed", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({ baseFee: 100, account: fakeAccount({ sequence: "100" }) })
  );
  const tx = buildTx({ accountSequence: "100", fee: "50" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /below network base fee/i);
});

// ── Check 6: balance precondition (current XLM behaviour) ────────────────────
test("SIMULATOR: insufficient balance returns simulation_failed", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        balances: [{ asset_type: "native", balance: "1.0000000" }],
      }),
    })
  );
  const tx = buildTx({ accountSequence: "100", fee: "100", amount: "10" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Insufficient balance/i);
});

// ── Check 6b: under-1-XLM warning ────────────────────────────────────────────
test("SIMULATOR: warns when remaining balance is under 1 XLM", async () => {
  // available = 10.6 - 0.5 = 10.1; totalCost = 10 + 0.00001 → remaining ≈ 0.09999 < 1
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        balances: [{ asset_type: "native", balance: "10.6000000" }],
      }),
    })
  );
  const tx = buildTx({ accountSequence: "100", fee: "100", amount: "10" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, true);
  assert.ok(
    result.warnings.some((w) => /under 1 XLM/.test(w)),
    `expected under-1-XLM warning, got: ${JSON.stringify(result.warnings)}`
  );
});

// ── Success path ─────────────────────────────────────────────────────────────
test("SIMULATOR: valid transaction returns success", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        balances: [{ asset_type: "native", balance: "100.0000000" }],
      }),
    })
  );
  const tx = buildTx({ accountSequence: "100", fee: "100", amount: "10" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, true);
  assert.equal(result.fee, "100");
  assert.equal(result.operations, 1);
  assert.deepEqual(result.warnings, []);
});

// ── Check 6c: paymentAmount() inspects op.asset for native & issued assets ───
test("SIMULATOR: paymentAmount() inspects payment asset for native and issued-asset payments", () => {
  const xlmTx = buildTx({ accountSequence: "100", amount: "12.5", asset: Asset.native() });
  const usdcTx = buildTx({ accountSequence: "100", amount: "25.75", asset: USDC });

  assert.equal(paymentAmount(xlmTx), 12.5);
  assert.equal(paymentAmount(xlmTx, { code: "XLM" }), 12.5);
  assert.equal(paymentAmount(xlmTx, { code: "USDC", issuer: ISSUER }), 0);

  assert.equal(paymentAmount(usdcTx), 25.75);
  assert.equal(paymentAmount(usdcTx, { code: "USDC", issuer: ISSUER }), 25.75);
  assert.equal(paymentAmount(usdcTx, { code: "XLM" }), 0);
});

// ── Check 6d: USDC payment (pass + fail) ─────────────────────────────────────
test("SIMULATOR: USDC payment passes when USDC balance covers amount and XLM covers fee", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        subentry_count: 1,
        balances: [
          { asset_type: "native", balance: "5.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "50.0000000",
          },
        ],
      }),
    })
  );
  const tx = buildTx({ accountSequence: "100", fee: "100", amount: "10", asset: USDC });
  const result = await sim.simulate(tx);
  assert.equal(result.success, true);
  assert.equal(result.error, undefined);
});

test("SIMULATOR: USDC payment fails with USDC in error message when USDC balance is insufficient", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        subentry_count: 1,
        balances: [
          { asset_type: "native", balance: "100.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "4.0000000",
          },
        ],
      }),
    })
  );
  const tx = buildTx({ accountSequence: "100", fee: "100", amount: "10", asset: USDC });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Insufficient balance: payment 10 USDC exceeds available 4\.0000000 USDC/);
});

// ── Check 6e: USDC payment with insufficient XLM for fees + reserve ──────────
test("SIMULATOR: USDC payment fails when XLM balance cannot cover fee + reserve", async () => {
  // subentry_count = 1 => reserve = 0.5 + 0.5 * 1 = 1.0 XLM
  // native balance = 1.0000000 => available XLM = 0.0000000, fee = 0.00001 XLM
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        subentry_count: 1,
        balances: [
          { asset_type: "native", balance: "1.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "100.0000000",
          },
        ],
      }),
    })
  );
  const tx = buildTx({ accountSequence: "100", fee: "100", amount: "10", asset: USDC });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Insufficient balance: fee .* XLM exceeds available 0\.0000000 XLM/);
});

// ── Check 6f: mixed-balance scenario (XLM vs issued assets, including alphanum12) ──
test("SIMULATOR: mixed-balance scenario checks the exact asset being paid", async () => {
  const longAsset = new Asset("LONGASSET12", ISSUER);
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        subentry_count: 2,
        balances: [
          { asset_type: "native", balance: "5.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "100.0000000",
          },
          {
            asset_type: "credit_alphanum12",
            asset_code: "LONGASSET12",
            asset_issuer: ISSUER,
            balance: "20.0000000",
          },
        ],
      }),
    })
  );

  // 1) 10 XLM payment must fail against 5 XLM (even though USDC is 100)
  const xlmTx = buildTx({ accountSequence: "100", fee: "100", amount: "10", asset: Asset.native() });
  const xlmRes = await sim.simulate(xlmTx);
  assert.equal(xlmRes.success, false);
  assert.match(xlmRes.error ?? "", /payment 10 XLM/);

  // 2) 10 USDC payment must pass against 100 USDC (with 5 XLM covering fee + 1.5 XLM reserve)
  const usdcTx = buildTx({ accountSequence: "100", fee: "100", amount: "10", asset: USDC });
  const usdcRes = await sim.simulate(usdcTx);
  assert.equal(usdcRes.success, true);

  // 3) 15 LONGASSET12 (credit_alphanum12) payment passes against 20 LONGASSET12
  const longPassTx = buildTx({ accountSequence: "100", fee: "100", amount: "15", asset: longAsset });
  const longPassRes = await sim.simulate(longPassTx);
  assert.equal(longPassRes.success, true);

  // 4) 25 LONGASSET12 payment fails naming LONGASSET12
  const longFailTx = buildTx({ accountSequence: "100", fee: "100", amount: "25", asset: longAsset });
  const longFailRes = await sim.simulate(longFailTx);
  assert.equal(longFailRes.success, false);
  assert.match(longFailRes.error ?? "", /payment 25 LONGASSET12 exceeds available 20\.0000000 LONGASSET12/);
});
