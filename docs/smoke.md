# Smoke Test: Offline and Testnet Pipeline Validation

This document describes the prerequisites, execution modes, preflight checks, and scenario coverage for the `pnpm smoke` test suite in 4evergent.

---

## 1. Prerequisites

Before running the smoke tests, ensure your local development environment has:

- **Node.js**: `v22+` (specified in `package.json` engines)
- **pnpm**: `v9+` (repo packageManager is `pnpm@10.34.5`)
- **Stellar Testnet Keypair**: A funded Stellar Testnet secret key (`S...`) with at least **10 XLM**.

---

## 2. Obtaining and Funding a Testnet Keypair

You can generate and fund a testnet keypair using friendbot:

### Step 1: Generate a Keypair
```bash
node -e "const { Keypair } = require('@stellar/stellar-sdk'); const kp = Keypair.random(); console.log('Public:', kp.publicKey()); console.log('Secret:', kp.secret());"
```

### Step 2: Fund via Friendbot
Friendbot funds new Testnet accounts with 10,000 test XLM:
```bash
curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"
```
Or open in a browser:
```
https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>
```

---

## 3. Environment Variables & Gating

The smoke test is strictly opt-in and safe by default to keep the standard test suite offline:

| Variable | Description | Required for `pnpm smoke` |
| :--- | :--- | :--- |
| `LIVE_E2E=1` | Enables live end-to-end and smoke test runners. | Yes |
| `STELLAR_TESTNET_SECRET_KEY` | Secret key (`S...`) for the funded Testnet account. Never committed. | Yes |
| `LIVE_SUBMIT=1` | Explicit enable for broadcasting live transactions to Testnet Horizon. | **No** (Defaults to simulation mode) |

### Guard Behavior

1. **`LIVE_E2E` is unset or not `1`**:
   The script outputs:
   ```text
   Set LIVE_E2E=1 and STELLAR_TESTNET_SECRET_KEY to run the smoke test. See docs/smoke.md.
   ```
   and exits cleanly with exit code `0`.

2. **`LIVE_E2E=1` is set, but `STELLAR_TESTNET_SECRET_KEY` is missing or empty**:
   The script outputs instructions pointing to friendbot:
   ```text
   Missing STELLAR_TESTNET_SECRET_KEY. Obtain and fund a testnet keypair via https://friendbot.stellar.org. See docs/smoke.md.
   ```
   and exits cleanly with exit code `0`.

3. **Preflight Funded Account Check**:
   Before executing scenarios, the runner queries the Horizon Testnet API (`https://horizon-testnet.stellar.org/accounts/<PUBLIC_KEY>`). If the account does not exist or has $\le 10$ XLM, it reports the current balance and the friendbot funding URL, failing fast with an error before running scenarios.

4. **Simulation Mode Safety**:
   The smoke test does **not** require `LIVE_SUBMIT=1`. Without `LIVE_SUBMIT=1`, tests run through simulation and preflight gates without broadcasting transactions, preventing accidental state changes.

---

## 4. Running the Smoke Test

Build the workspace packages (or let `pnpm smoke` auto-build if `dist/` is absent):

```bash
pnpm build
```

Run the smoke test with both environment variables exported or passed inline:

```bash
LIVE_E2E=1 STELLAR_TESTNET_SECRET_KEY=S... pnpm smoke
```

Or configure in your local `.env` (which is git-ignored):
```env
LIVE_E2E=1
STELLAR_TESTNET_SECRET_KEY=S...
```
and run:
```bash
pnpm smoke
```

---

## 5. What the Scenarios Exercise (9 Scenarios)

The smoke suite executes two test suites covering 9 end-to-end scenarios against the real Stellar Testnet:

### `packages/stellar/test/live-smoke.ts` (3 Scenarios)

1. **Network Passphrase Validation**:
   - Queries `https://horizon-testnet.stellar.org/`.
   - Confirms HTTP 200, positive ledger sequence, and that the returned network passphrase matches `Test SDF Network ; September 2015`.
2. **Real Horizon Simulation Call**:
   - Constructs a genuine transaction envelope with an unfunded keypair.
   - Invokes `StellarSimulator.simulate()` against real Horizon API to verify simulation pipeline failure semantics (account not found) without throwing uncaught exceptions.
3. **TransactionBuilder Output Verification**:
   - Builds a valid normalized payment transaction envelope locally and verifies sequence number, operation type, and fee alignment against SDK rules.

### `packages/stellar/test/live-e2e.ts` (6 Scenarios / Pipeline Stages)

1. **Live Network Identity & Passphrase**:
   - Validates live Horizon connectivity and testnet ledger synchronization.
2. **Fail-Closed Network Guard**:
   - Validates Testnet acceptance and guarantees immediate rejection of Mainnet endpoints.
3. **Signer Key Isolation**:
   - Instantiates `TestnetLocalSigner` securely from environment variables without logging or exposing secret material.
4. **On-Chain Sequence Number Fetch**:
   - Retrieves real on-chain account state and sequence numbers via `StellarAdapter`.
5. **Policy & Simulation Authorization**:
   - Evaluates payment intent against `TransactionPipeline` policy rules and runs live simulation through `StellarSimulator`.
6. **Execution, Submission Gate & Reconciliation**:
   - Exercises the full pipeline to signing and simulation gate (and on-chain submission + Horizon confirmation + status reconciliation if `LIVE_SUBMIT=1`).
