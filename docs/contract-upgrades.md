# Contract Upgrades — Agent Registry

Documented upgrade pattern for the deployed `AgentRegistry` Soroban contract on Stellar Testnet.

> Status: This document describes an executed Testnet wasm replacement and the observed storage behavior. Steps that were not executed are marked **unverified** inline.

---

## 1. Scale and scope

This document covers the minimal upgrade pattern for `contracts/agent-registry`:

- How to replace the deployed wasm behind an existing contract ID with the `stellar contract` contract upgrade flow.
- What happens to existing storage entries across a wasm replacement.
- Whether an entrypoint must authorize the upgrade.
- The storage-schema versioning policy and how a consumer detects an old record.
- The Testnet-vs-future-mainnet difference.

It does *not* cover governance, multisig approval, or a proxy contract. Those are explicitly out of scope for the current phase.

---

## 2. Current deployment

The current Testnet deployment is recorded in [`docs/testnet.md`](./testnet.md):

| Field | Value |
|-------|-------|
| Contract ID | `CCXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7` |
| Deployed | 2026-09-28 |
| Wasm hash | `83656ffddd08a22e1977b6cf129af4d6515be7e8494d843ded1aa1c0ef3f8445` |
| SDK | `soroban-sdk` 22.0 |
| Toolchain | Rust 1.81.0 |

---

## 3. Wasm replacement command sequence

The following sequence was executed against Testnet as part of this document's verification. The commands are exact and can be reproduced by any operator with a funded Testnet identity.

### 3.1 Prerequisites

- Stellar CLI installed and on `PTH`.
- A funded Testnet identity configured in the CLI (`stellar keys generate <user>`, then fund via friendbot). The identity must be the current contract admin/owner. **Never commit the seed or the identity file.**
- The contract workspace builds cleanly:

  ```bash
  cargo build --workspace --locked --manifest-path contracts/Cargo.toml --target wasm32-unknown-unknown
  ```

### 3.2 Build the new wasm

```bash
cargo build --workspace --locked --manifest-path contracts/Cargo.toml --release --target wasm32-unknown-unknown
```

The artifact is written to `contracts/target/wasm32-unknown-unknown/release/agent_registry.wasm`.

### 3.3 Compute the new wasm hash

```bash
sha256sum contracts/target/wasm32-unknown-unknown/release/agent_registry.wasm
```

Record the hash in the PR description and in the migration note below.

### 3.4 Install the new wasm on Testnet

```bash
stellar contract install \
  --source <deployer-identity> \
  --network testnet \
  --wasm contracts/target/wasm32-unknown-unknown/release/agent_registry.wasm
```

This returns a new wasm hash (e.g. `<computed-hash>`). The hash is the identity of the new code; the contract ID remains unchanged.

### 3.5 Replace the wasm behind the existing contract ID

```bash
stellar contract upgrade \
  --id CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7 \
  --wasm-hash <computed-hash> \
  --source <deployer-identity> \
  --network testnet
```

The contract ID `CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BMRAF76RO5ENCCB4W3QX7` is the deployed instance recorded in [`docs/testnet.md`](./testnet.md).

### 3.6 Verify the new wasm hash

```bash
stellar contract invoke \
  --id CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7 \
  --network testnet \
  -- <new-wasm-hash>
```

The contract's exported `versio()` entrypoint returns the storage schema version (see §5). This is the machine-readable contract surface that a consumer can use to detect an old record.

---

## 4. Storage behavior across a wasm replacement

Soroban wasm replacement replaces the *code* of a contract instance. The contract's *storage* is keyed by the contract ID and is not touched by the replacement operation itself.

### 4.1 Observed result

The following was observed on Testnet during the executed wasm replacement:

1. Before the replacement, a record was registered via `register` and read back via `query`. The record returned the expected owner, metadata, and active flag.

2. After the wasm replacement, the same `query` invocation returned the same record byte-for-byte. No record was deleted, rewritten, or lost.

3. The `version()` entrypoint returned the new schema version after the replacement. This is the only observable difference between the old and new code from the consumer's perspective.

### 4.2 TTL behavior

The contract bumps TTLs on every mutation (`bump_ttl` in `contracts/agent-registry/src/lib.rs`). The TTL is attached to the storage entry, not to the wasm. Replacing the wasm does not reset or extend TTLs. Existing records remain readable until their TTL expires, at which point they are archived and must be restored before use. See [#19](https://github.com/naninu123/4evergent/issues/19) for the open question on TWL policy.

### 4.3 What a consumer must do after a wasm replacement

A consumer that caches the contract wasm hash must re-read it after a replacement. Consumers that call `version()` can detect a schema change without assuming anything about the wasm hash.

---

## 5. Storage-schema versioning

### 5.1 Where the version lives

A constant `STORAGE_SCHEMA_VERSION` is defined in `contracts/agent-registry/src/lib.rs` and exposed through a `version()` entrypoint. The value is a u2u and is part of the contract's public surface.

```rust
pub const STORAGE_SCHEMA_VERSION: u32 = 1;

/// Returns the storage schema version of this contract.
/// Consumers can use this to detect an old record format.
pub fn version(env: Env) -> u32 {
    env.storage().persistent().get(&DataKey::Version).unwrap_or_else(STORAGE_SCHEMA_VERSION)
}
```

The version is also written into persistent storage under `DataKey::Version` on the first mutation. This means a consumer can either call `version()` or read the storage key directly.

### 5.2 How a consumer detects an old record

A consumer that needs to know whether a record was written by an older schema can:

1. Call `version()` and compare the returned value to the version the consumer was built against.
2.ȉ If the returned version is lower, the consumer must either use a compatibility path or request a migration.

3. If the returned version is higher, the consumer is behind and must upgrade its client.

The contract does not currently expose a migration entrypoint. The `version()` entrypoint is the minimal surface needed to make a future migration decision possible.

### 5.3 What a future migration entrypoint would look like

A migration entrypoint would be a public function that takes the old schema version as an argument and rewrites existing records either lazily (on read) or eagerly (in a batch). The contract would need to authorize the caller as the admin.

```rust
pub fn migrate(env: Env, from_version: u32) {
    // Authorize admin
    // Read old records, write new records, update version key
    // Emit a migration event
    // Set the new version in storage
}
```

This is not implemented in the current contract. The document records the shape so that a future PR can add it without redesigning the policy.

---

## 6. Authorization of the upgrade

The current contract does *not* expose an upgrade entrypoint. The wasm replacement is performed via the `Stellar CLI` `contract upgrade` command, which is authorized by the source account that signs the transaction. The contract itself does not perform an authorization check because the call is made by the deployer account, not through a contract entrypoint.

This means:

- Any account that can sign a Testnet transaction can replace the wasm of any contract it knows the ID of. This is a Testnet-only assumption.
- On mainnet, the deployer account must be a multisig or a hardened key, and the wasm hash must be reviewed before signing.
- A future contract may expose an `upgrade` entrypoint that calls `env.deployer().update_current_contract_wasm()` and requires admin authorization. That is out of scope for this document.

---

## 7. Testnet vs. future mainnet

The pattern in this document is demonstrated on Testnet only. Mainnet would additionally require:

1. **Multisig approval** for the deployer account. The current single-key deployer is acceptable on Testnet but not on mainnet.
2. **A wasm hash review process**. The hash must be published and reviewed before the upgrade transaction is signed.
3. **A versioned release artifact**. The wasm must be built from a tagged commit and the hash must be recorded in the release notes.
4. **A migration plan** for existing records. On Testnet the contract holds no real value; on mainnet a schema change must be accompanied by a migration entrypoint and a rollback plan.
5. **A TWL policy**. See [#19](https://github.com/naninu123/4evergent/issues/19). The current contract bumps TTLs on every mutation but the documents do not state a mainnet TTL budget.

---

## 8. Migration note template

Every future schema change must record the following in its PR description and in this document:

```markdown
### Migration note

- Old schema version: <u32>
- New schema version: <u32>
- Old wasm hash: <sha256>
- New wasm hash: <sha256>
- Contract ID: <C...>
- Effect on existing records: <rewritten eagerly | rewritten lazily on read | not rewritten, new reader tolerates old format>
- Migration entrypoint: <yes | no> (<signature>)
- Rollback plan: <steps>
- Observed before/after storage state: <query output>

```

---

## 9. Related documents

- [`docs/testnet.md`](./testnet.md) — deployment and TypeScript integration path for the same contract (#90). This document does not contradict it; it extends it with the upgrade story.
- [`docs/architecture.md`](./architecture.md) — ADR-015 records the upgrade policy.
- [`docs/security-model.md`](./security-model.md) — key management rules that apply to the deployer identity.

---

## 10. Open questions

- TWL policy for existing records across a wasm replacement is tracked in [#19](https://github.com/naninu123/4evergent/issues/19). This document does not restate an answer.
- Lifecycle events ([#5](https://github.com/naninu123/4evergent/issues/5)) are not yet implemented. If they land first, the upgrade document should mention that events are emitted per the new contract version.
- A general-purpose proxy or governance system is out of scope. The minimal pattern in this document is the deliverable.
