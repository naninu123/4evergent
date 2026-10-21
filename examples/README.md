# Examples

This directory contains runnable TypeScript examples demonstrating how to use the `@4evergent/*` workspace packages programmatically.

## Prerequisites

The workspace packages must be built first, because the package imports resolve to `dist/`:

```bash
pnpm install
pnpm build
```

All examples are offline (no network, API keys, or secrets required). They import workspace packages via `@4evergent/*` and can be run with `npx tsx`.

## Examples

| Example | What it demonstrates |
| --- | --- |
| [`policy-evaluation.ts`](./policy-evaluation.ts) | Create an intent, run it through `PolicyEngine.evaluate()` with custom rules. Covers `allow`, `deny` (over limit), and `requires_approval` (above threshold). |
| [`intent-validation.ts`](./intent-validation.ts) | Run several intents through `IntentValidator.validate()`, printing pass/fail with error messages. Covers payment, trustline, and an invalid intent. |
| [`in-memory-stores.ts`](./in-memory-stores.ts) | Use `InMemoryActivityStore` and `InMemoryApprovalStore` to record activities, enforce a daily limit via `reserveDailySpending()`, and query back. Demonstrates the persistence interfaces without SQLite. |
| [`pipeline-walkthrough.ts`](./pipeline-walkthrough.ts) | Assemble a `TransactionPipeline` with a mock signer and a mocked Horizon (via constructor injection). Shows where each gate rejects - validation, policy, build, simulation. `LIVE_SUBMIT=0` is expected; the example fails gracefully at the simulation step with no network access. |

## Running the examples

From the repository root (after `pnpm build`):

```bash
npx tsx examples/policy-evaluation.ts
npx tsx examples/intent-validation.ts
npx tsx examples/in-memory-stores.ts
npx tsx examples/pipeline-walkthrough.ts
```