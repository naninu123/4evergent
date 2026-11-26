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
 *
 * Dependency note: these tests assert the *current* check-6 behaviour (XLM
 * payment vs native balance). Sibling issue #43 ("Fix simulator balance check
 * to use the payment's actual asset") will change check 6; the balance tests
 * here must be updated when that fix lands.
 */

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const HORIZON_URL = "https://horizon-testnet.stellar.org";

type FakeAccount = {
  sequence: string;
  balances: { asset_type: string; balance: string; asset_code?: string; asset_issuer?: string }[];
  subentry_count?: number;
};

function fakeAccount(opts: {
  sequence: string;
  balances?: { asset_type: string; balance: string; asset_code?: string; asset_issuer?: string }[];
  subentry_count?: number;
}): FakeAccount {
  return {
    sequence: opts.sequence,
    subentry_count: opts.subentry_count ?? 0,
    balances: opts.balances ?? [{ asset_type: "native", balance: "100.0000000" }],
  };
}

/**
 * Minimal stand-in for the Horizon calls `simulate()` makes. `account` is
 * served for the source; `destinationAccount` is served for the payment
 * destination (defaults to the source account, i.e. an existing destination
 * with a native balance). Pass an `Error` to make the load throw, as Horizon
 * does with a 404 for a non-existent account.
 */
function fakeServer(opts: {
  baseFee?: number | Error;
  account?: unknown | Error;
  destinationAccount?: unknown | Error;
}): Horizon.Server {
  return {
    fetchBaseFee: async () => {
      if (opts.baseFee instanceof Error) throw opts.baseFee;
      return opts.baseFee ?? 100;
    },
    accounts: () => ({
      accountId: (id: string) => ({
        call: async () => {
          const target = id === DEST ? opts.destinationAccount ?? opts.account : opts.account;
          if (target instanceof Error) throw target;
          return target;
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
      Operation.payment({ destination: DEST, asset: opts.asset ?? Asset.native(), amount: opts.amount ?? "10" })
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

// ── Check 7: destination-account preconditions ───────────────────────────────
test("SIMULATOR: payment below 1 XLM to a non-existent destination fails", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({ sequence: "100" }),
      destinationAccount: new Error("404 Not Found"),
    })
  );
  const tx = buildTx({ accountSequence: "100", fee: "100", amount: "0.5" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /does not exist/i);
  assert.match(result.error ?? "", /1 XLM minimum/);
});

test("SIMULATOR: payment of at least 1 XLM to a non-existent destination succeeds (account creation)", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({ sequence: "100" }),
      destinationAccount: new Error("404 Not Found"),
    })
  );
  const tx = buildTx({ accountSequence: "100", fee: "100", amount: "10" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, true);
});

test("SIMULATOR: payment of exactly 1 XLM to a non-existent destination succeeds", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({ sequence: "100" }),
      destinationAccount: new Error("404 Not Found"),
    })
  );
  const tx = buildTx({ accountSequence: "100", fee: "100", amount: "1" });
  const result = await sim.simulate(tx);
  assert.equal(result.success, true);
});

test("SIMULATOR: non-native payment to an account without the trustline fails naming the asset", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        balances: [
          { asset_type: "native", balance: "100.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "50.0000000" },
        ],
      }),
      destinationAccount: fakeAccount({
        sequence: "5",
        balances: [{ asset_type: "native", balance: "50.0000000" }],
      }),
    })
  );
  const tx = buildTx({
    accountSequence: "100",
    fee: "100",
    amount: "10",
    asset: new Asset("USDC", ISSUER),
  });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /no trustline/i);
  assert.match(result.error ?? "", /USDC/);
});

test("SIMULATOR: non-native payment to an account with the trustline succeeds", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        balances: [
          { asset_type: "native", balance: "100.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "50.0000000" },
        ],
      }),
      destinationAccount: fakeAccount({
        sequence: "5",
        balances: [
          { asset_type: "native", balance: "50.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "0.0000000" },
        ],
      }),
    })
  );
  const tx = buildTx({
    accountSequence: "100",
    fee: "100",
    amount: "10",
    asset: new Asset("USDC", ISSUER),
  });
  const result = await sim.simulate(tx);
  assert.equal(result.success, true);
});

test("SIMULATOR: non-native payment to a non-existent destination fails naming the asset", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        balances: [
          { asset_type: "native", balance: "100.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "50.0000000" },
        ],
      }),
      destinationAccount: new Error("404 Not Found"),
    })
  );
  const tx = buildTx({
    accountSequence: "100",
    fee: "100",
    amount: "10",
    asset: new Asset("USDC", ISSUER),
  });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /does not exist/i);
  assert.match(result.error ?? "", /USDC/);
});

test("SIMULATOR: trustline for a different issuer does not satisfy the check", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        balances: [
          { asset_type: "native", balance: "100.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "50.0000000" },
        ],
      }),
      destinationAccount: fakeAccount({
        sequence: "5",
        balances: [
          { asset_type: "native", balance: "50.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: Keypair.random().publicKey(),
            balance: "100.0000000",
          },
        ],
      }),
    })
  );
  const tx = buildTx({
    accountSequence: "100",
    fee: "100",
    amount: "10",
    asset: new Asset("USDC", ISSUER),
  });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /no trustline/i);
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

// ── Issue #43: actual-asset balance checks (XLM, USDC, fee/reserve, mixed) ──
test("SIMULATOR (#43): paymentAmount() inspects operation asset for native and issued assets", () => {
  const xlmTx = buildTx({ accountSequence: "100", amount: "25", asset: Asset.native() });
  const usdcTx = buildTx({ accountSequence: "100", amount: "42.5", asset: new Asset("USDC", ISSUER) });
  assert.deepEqual(paymentAmount(xlmTx), {
    amount: 25,
    isNative: true,
    assetCode: "XLM",
    assetIssuer: null,
  });
  assert.deepEqual(paymentAmount(usdcTx), {
    amount: 42.5,
    isNative: false,
    assetCode: "USDC",
    assetIssuer: ISSUER,
  });
});

test("SIMULATOR (#43): USDC payment fails naming USDC when issued-asset balance is insufficient", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        balances: [
          { asset_type: "native", balance: "100.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "5.0000000" },
        ],
      }),
      destinationAccount: fakeAccount({
        sequence: "5",
        balances: [
          { asset_type: "native", balance: "10.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "0.0000000" },
        ],
      }),
    })
  );
  const tx = buildTx({
    accountSequence: "100",
    fee: "100",
    amount: "10",
    asset: new Asset("USDC", ISSUER),
  });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Insufficient balance: payment 10 USDC exceeds available 5\.0000000 USDC/);
});

test("SIMULATOR (#43): USDC payment with insufficient XLM for fee + reserve fails", async () => {
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: fakeAccount({
        sequence: "100",
        subentry_count: 1, // reserve = 0.5 + 0.5 * 1 = 1.0 XLM
        balances: [
          { asset_type: "native", balance: "1.0000000" }, // available XLM = 0.0, cannot cover 100 stroops fee
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "500.0000000" },
        ],
      }),
      destinationAccount: fakeAccount({
        sequence: "5",
        balances: [
          { asset_type: "native", balance: "10.0000000" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "0.0000000" },
        ],
      }),
    })
  );
  const tx = buildTx({
    accountSequence: "100",
    fee: "100",
    amount: "10",
    asset: new Asset("USDC", ISSUER),
  });
  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Insufficient XLM balance for fee/);
});

test("SIMULATOR (#43): mixed-balance scenario — 10 USDC payment from account with 5 XLM and 20 USDC succeeds, while 10 XLM payment fails", async () => {
  const mixedSource = fakeAccount({
    sequence: "100",
    subentry_count: 1, // reserve = 1.0 XLM -> available XLM = 4.0 XLM
    balances: [
      { asset_type: "native", balance: "5.0000000" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "20.0000000" },
    ],
  });
  const destWithTrustline = fakeAccount({
    sequence: "5",
    balances: [
      { asset_type: "native", balance: "10.0000000" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "0.0000000" },
    ],
  });
  const sim = new StellarSimulator(
    HORIZON_URL,
    fakeServer({
      baseFee: 100,
      account: mixedSource,
      destinationAccount: destWithTrustline,
    })
  );

  // 10 USDC payment passes even though XLM balance is only 5 XLM
  const usdcTx = buildTx({
    accountSequence: "100",
    fee: "100",
    amount: "10",
    asset: new Asset("USDC", ISSUER),
  });
  const usdcResult = await sim.simulate(usdcTx);
  assert.equal(usdcResult.success, true);

  // 10 XLM payment fails against the 4.0 available XLM balance despite 20 USDC balance
  const xlmTx = buildTx({
    accountSequence: "100",
    fee: "100",
    amount: "10",
    asset: Asset.native(),
  });
  const xlmResult = await sim.simulate(xlmTx);
  assert.equal(xlmResult.success, false);
  assert.match(xlmResult.error ?? "", /Insufficient balance: payment 10 XLM \+ fee exceeds available 4\.0000000 XLM/);
});
