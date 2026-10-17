# Examples

Runnable, self-contained TypeScript scripts that show how to use the
`@4evergent/*` packages programmatically.  Each example is a single `.ts`
file — no test framework, no CI wiring, no network access.

## Prerequisites

```bash
pnpm install
pnpm build        # workspace packages must be built — imports resolve to dist/
```

> **Why `pnpm build` first?**  The examples import workspace packages via
> `@4evergent/*` (e.g. `@4evergent/policy`).  These packages expose their
> public API from `dist/` (see the `exports` field in each `package.json`).
> `pnpm` workspaces link them, but the compiled output must exist for the
> imports to resolve.  Running `pnpm build` compiles every package.

## Running an example

```bash
npx tsx examples/<script>.ts
```

No additional dependencies are needed — `tsx` is already a workspace
devDependency.

## Examples

| Script | Demonstrates |
|--------|-------------|
| [`policy-evaluation.ts`](./policy-evaluation.ts) | `PolicyEngine.evaluate()` with custom rules — allow, deny (over limit), requires_approval (above threshold), and daily-spending-limit enforcement. |
| [`intent-validation.ts`](./intent-validation.ts) | `IntentValidator.validate()` for payment, trustline, and invalid intents — prints pass/fail with error messages. |
| [`in-memory-stores.ts`](./in-memory-stores.ts) | `InMemoryActivityStore` + `InMemoryApprovalStore` — record activities, enforce daily limits via `reserveDailySpending`, query back, and simulate an approval lifecycle. No SQLite. |
| [`pipeline-walkthrough.ts`](./pipeline-walkthrough.ts) | `TransactionPipeline` with a mock signer and in-memory stores — shows where each gate rejects (validation → policy → build → simulate). The allow path fails gracefully at the simulation gate (no funded account or network required). |

## What these examples prove

- The `@4evergent/*` package exports work from outside the monorepo `apps/` —
  a consumer can import `PolicyEngine`, `IntentValidator`, the in-memory
  stores, and `TransactionPipeline` and use them directly.
- The pipeline gates are ordered and independent: a denial at an earlier gate
  never reaches a later one (validation → policy → build → simulate → sign →
  submit).
- No example requires network access, API keys, secrets, or a funded account.
  The pipeline walkthrough's simulation gate fails gracefully — without
  network, Horizon `fetchBaseFee` fails; with network, the fake account's
  sequence won't match the real on-chain value. Either way, the pipeline
  returns `simulation_failed` without reaching the signer.

## Notes

- These scripts are **documentation, not tests**.  They are not wired into CI.
  A future issue could add a smoke check that runs them and asserts exit 0.
- No new dependencies are introduced.  Everything used here is already in the
  workspace.
