# Contract Upgrade Pattern for `agent-registry`

This document describes how the `agent-registry` contract is upgraded in place on Stellar Testnet, what happens to existing storage across a wasm replacement, and the storage-schema versioning policy that future changes must follow.

- Contract: `contracts/agent-registry` (Soroban SDK 22.0, toolchain 1.81.0)
- Testnet contract ID: `CXXQPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7`
- Deployment record: [`docs/testnet.md`](./testnet.md)

For the deployment and TypeScript integration path that this document builds on, see [`docs/testnet.md`](./testnet.md) and the deployment guide in that file. The two documents must not contradict each other; this document assumes the build/deploy commands from `docs/testnet.md` and only adds the *replacement* step.

## Status of this document

This document describes a pattern that is **demonstrated on Testnet only**. It is not a governance system, not a proxy contract, and not a mainnet runbook.

The steps below are marked individually as **executed** or **unverified**. A step marked unverified was not run as part of this work and must not be described as tested. The contract-side version surface and its tests *are* executed by `cargo test`.

When a replacement is actually executed, the PR description must replace the placeholders below with the real command transcript, contract ID, and resulting wasm hash.

## How a wasm replacement works on Soroban

Soroban contracts are identified by a contract ID that is derived from the deployer's address and a salt. The contract ID does not change when the wasm is replaced. The contract's persistent storage is keyed to the contract ID, not to the wasm hash, so existing storage entries remain readable by the new wasm as long as the new wasm reads the same keys with the same data shape.

The replacement is performed by the current contract authorizing a call to `env.deployer().update_current_contract_wasm()`. This is a host function reachable from inside the contract; it cannot be invoked externally without an entrypoint that calls it. The current `agent-registry` wasm does **not** expose such an entrypoint (the four public entrypoints are `register`, `update_metadata`, `deactivate`, and `query`). See "Entrypoint authorization" below.

## Exact CLI sequence for a wasm replacement

All commands assume the same local identity and network configuration used in [`docs/testnet.md`](./testnet.md). The deployer key is a local, uncommitted Testnet identity; it is never committed and never shared. The same rule applies to the upgrade walkthrough.

### 0. Prerequisites

- A funded Testnet identity configured with `stellar configure`. The identity must be the one that owns the contract (the deployer).
- The contract ID of the deployed instance: `CXXQPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7`.
- A wasm built from the current source tree.

### 1. Build the new wasm (executed by CI)

From the repository root:

```bash
cargo build \
  --workspace \
  --locked \
  --manifest-path contracts/Cargo.toml \
  --target wasm32-unknown-unknown \
  --release
```

The resulting artifact is:

```
contracts/target/wasm32-unknown-unknown/release/agent_registry.wasm
```

Status: **executed** by the contract build in the verification section of the issue.

### 2. Compute the new wasm hash

```bash
sha256sum contracts/target/wasm32-unknown-unknown/release/agent_registry.wasm
```

Status: **executed** as part of the build verification. The hash of the wasm actually installed on Testnet is recorded in the PR description when a wasm replacement is performed.

### 3. Install the new wasm and obtain its hash

```bash
stellar contract install \
  --source-account <deployer-identity> \
  --network testnet \
  contracts/target/wasm32-unknown-unknown/release/agent_registry.wasm
```

This prints the wasm hash. Record it.

Status: **executed** when a replacement is actually performed; the hash is pasted into the PR description. If not executed, report it as unverified in the PR.

### 4. Replace the wasm of the existing contract ID

The contract IDE is unshanged. Only the wasm behind it changes.

```bash
stellar contract upgrade \
  --id CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7 \
  --wasm-hash <new-wasm-hash> \
  --source-account <deployer-identity> \
  --network testnet
```

Status: **executed** when a replacement is actually performed. The command transcript and the resulting wasm hash are pasted into the PR description.

### 5. Verify the new wasm is active

```bash
stellar contract invoke \
  --id CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7 \
  --network testnet \
  -- version
```

This calls the `version()` entrypoint added by this change. It returns the storage schema version as a `u32`. The current value is `1 (`STORAGE_VERSION` in `contracts/agent-registry/src/lib.rs`).

Status: **executed** when a replacement is actually performed. If not executed, report it as unverified in the PR.

## What happens to existing storage across a wasm replacement

Storage is keyed to the contract ID and is not deleted or rewritten by a wasm replacement. After step 4 above, the following is true:

- Every agent registered before the replacement remains readable through `query`. The key layout (`DataKey::Agent(address)`) and the `AgentInfo` shape are unchanged, so the new wasm deserializes old records with the same code path as the old wasm.
- TLLs written by the old wasm (`pump.tll`) are still present and are renewed on the next mutation of that record (`bump_ttl` is called from `register`, `update_metadata`, and `deactivate`). TLL policy itself is an open question (see "Policy open questions" below).
- No storage is migrated eagerly by the replacement itself. Migration, if any, is lazy and must be implemented explicitly in a future wasm.

The observed result for the executed replacement is recorded in the PR description as a before/after pair of `stellar contract invoke -- query` outputs for a record registered before the replacement. If the replacement was not executed, this section is marked **unverified** and the PR states that no storage observation was made.

## Entrypoint authorization

A Soroban wasm replacement must be authorized by the current contract. The host requires the contract to invoke `env.deployer().update_current_contract_wasm()`. There is no external admin key that can replace the wasm directly.

The current `agent-registry` wasm does **not** expose an upgrade entrypoint. This means the deployed instance at `CXXQPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7` cannot be upgraded in place until a wasm that exposes such an entrypoint is installed. The choice of how to authorize that entrypoint (owner-only, multisig, governance) would be a separate decision and is out of scope for this document. The added `version()` entrypoint is read-only and does not authorize anything.

## Storage-schema versioning policy

The contract exports a machine-readable storage schema version through a `version()` entrypoint:

```rust
pub fn version(env: Env) -> u32 {
    STORAGE_VERSION
}
```

The constant `STORAGE_VERSION` lives in `contracts/agent-registry/src/lib.rs` and is the single source of truth for the storage schema version. It is `u32` and begins at `1 for the current schema.

How a consumer detects an old record:

- A consumer calls `query(address)`. The returned `AgentInfo` has no version field in schema v1, so the consumer cannot detect an old record from the record alone. Instead, a consumer must call `version()` to learn the schema version of the running wasm, and compare it to the version it was built against.
- A consumer that sees a version it does not understand must refuse to interpret the record rather than guessing.
- When a future schema adds a version field to `AgentInfo`, the consumer can also read that field directly. The `version()` entrypoint remains the authoritative signal for the wasm's schema version.

A sketch of what a future migration entrypoint would look like (not implemented here):

```rust
// NOT implemented. Sketch of the shape a future migration entrypoint would take.
pub fn migrate(env: Env, address: Address) -> Result<(), Error> {
    // 1. Authorize the caller (e.g. address.require_auth() or an owner check).
    // 2. Read the existing record at the old shape.
    // 3. Rewrite it in the new shape.
    // 4. Bump the storage version or record the migration in storage.
    // 5. Return an error if the record is already at the new version.
    todo!()
}
```

The actual implementation must be scoped in its own issue and must come with its own tests and a migration note (see below).

## Migration note template

Any future change that alters the storage schema must record the following in its PR and in this document:

```markdown
### Migration note: <short description>

- Old schema version: <u32>
- New schema version: <u32>
- Old shape: <describe the keys/fields and their types>
- New shape: <describe the keys/fields and their types>
- Existing records rewritten lazily or eagerly: <lazy on read via a migration entrypoint, or eagerly in the upgrade transaction>
- How a consumer detects an old record: <state the signal>
- Whether the `version()` entrypoint returns the new version immediately or only after migration: <state it>
- Tests covering the migration: <link to tests>
- Rollback plan: <state whether the previous wasm can still read the new records>
```

## Testnet vs. mainnet

The pattern in this document is demonstrated on Testnet only. Testnet has no economic value at stake and the deployer key is a local, uncommitted identity. Mainnet would require additionally:

- **Authorization for the upgrade entrypoint**. The current contract exposes no upgrade entrypoint, so a mainnet upgrade path requires a wasm that does, and that entrypoint must be authorized by a key that is not the deployer's local key (e.g. a multisig or governance contract).
- **A rollback plan**. Before replacing the wasm, the previous wasm hash must be recorded and the previous wasm must remain installed on chain so it can be restored.
- **A staging verification step**. The new wasm must be installed and verified on Testnet against a copy of the mainnet storage shape before being applied to mainnet.
- **A storage backup**. The persistent storage of the mainnet instance must be read and recorded before the replacement, so that a migration failure can be diagnosed.
- **A migration note** for the specific change, following the template above.

## Policy open questions

- TLS across a wasm replacement: existing TLLs are preserved and renewed on the next mutation. Whether that is the desired policy is an open question (tracked in #19). This document refers to it rather than restating an answer.
- Events across a wasm replacement: events are emitted per the new contract version after the replacement. If #5 (lifecycle events) lands first, this document should mention that the event shape is versioned by the wasm and that consumers must handle both shapes during a replacement.

## Related documents

- [`docs/testnet.md`](./testnet.md) — build, deploy, and verify commands for the current deployment. This document adds the replacement step and the schema-version policy.
- [`docs/architecture.md`](./architecture.md) — ADR entry for the chosen upgrade policy.
- [`README.md`](../README.md) — repository overview and link to this document.
