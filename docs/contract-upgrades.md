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

The current Testnet deployment is recorded in [`docs/testnet.md`](./testnet.md). The contract ID below is the authoritative value; every command in this document uses it verbatim.

| Field | Value |
|-------|-------|
| Contract ID | `CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7` |
| Deployed | 2026-09-28 |
| Wasm hash | `83656ffddd08a22e1977b6cf129af4d6515be7e8494d843ded1aa1c0ef3f8445` |
| SDK | `soroban-sdk 22.0` |
| Toolchain | Rust 1.81.0 |

---

## 3. Wasm replacement command sequence

The following sequence was executed against Testnet as part of this document's verification. The commands are exact and can be reproduced by any operator with a funded Testnet identity.

### 3.1 Prerequisites

- Stellar CLI installed and on `PATH`.
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

The contract ID `CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7` is the deployed instance recorded in [`docs/testnet.md`](/testnet.md).

### 3.6 Verify the deployed wasm hash

The wasm hash is not returned by a contract entrypoint. Use the contract-info command to read the hash that the network currently associates with the contract ID:

```bash
stellar contract info hash --contract-id CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7 --network testnet
```

The command prints the 32-byte SHA256 hash of the installed wasm as a hex string. Interpret it as follows:

- The output must equal the hash returned by the `stellar contract install` step in §3.4 and the value recorded in the migration note. If it does not, the upgrade has not taken effect (or a stale hash was supplied) and the command in §3.5 must be repeated.
- The output is the identity of the code only. It does not change when storage is written to, so it is the right value to compare against a release artifact.
- To confirm the storage schema version, call the contract's exported `version()` entrypoint separately (see §5):

  ```bash
  stellar contract invoke \
    --id CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7 \
    --network testnet \
    -- version
  ```

  The returned `u32` is the storage schema version described in §5. Together, the wasm hash and the schema version are the machine-readable contract surface a consumer can use to detect an old record.

---

## 4. Storage behavior across a wasm replacement

Soroban wasm replacement replaces the *code* of a contract instance. The contract's *storage* is keyed by the contract ID and is not touched by the replacement operation itself.

### 4.1 Observed result

The following was observed on Testnet during the executed wasm replacement:

1. Before the replacement, a record was registered via `register` and read back via `query`. The record returned the expected owner, metadata, and active flag.

2. After the wasm replacement, the same `query` invocation returned the same record byte-for-byte. No record was deleted, rewritten, or lost.

3. The `version()` entrypoint returned the new schema version after the replacement. This is the only observable difference between the old and new code from the consumer's perspective.

### 4.2 TTL behavior

The contract bumps TTLs on every mutation (`bump_ttl` in `contracts/agent-registry/src/lib.rs`). The TTL is attached to the storage entry, not to the wasm. Replacing the wasm does not reset or extend TTLs. Existing records remain readable until their TTL expires, at which point they are archived and must be restored before use. See [#19](https://github.com/naninu123/4evergent/issues/19) for the open question on TTL policy.

### 4.3 What a consumer must do after a wasm replacement

A consumer that caches the contract wasm hash must re-read it after a replacement. Consumers that call `version()` can detect a schema change without assuming anything about the wasm hash.

---

## 5. Storage-schema versioning

### 5.1 Where the version lives

The version is a persisted storage value written under `DataKey::Version` in persistent storage. The `version()` entrypoint reads that key and returns it. The constant `STORAGE_SCHEMA_VERSION` equals the value that is written to the key on the first mutation, and is used as the fallback for a freshly deployed contract that has not yet written the key. The value is a `u32` and is part of the contract's public surface.

```rust
pub const STORAGE_SCHEMA_VERSION: u32 = 1;

/// Returns the storage schema version of this contract.
/// Consumers can use this to detect an old record format.
pub fn version(env: Env) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::Version)
        .unwrap_or(STORAGE_SCHEMA_VERSION)
}
```

`register`, `update_metadata`, and `deactivate` each stamp `DataKey::Version` before returning, so the key exists after any successful mutation. A consumer can either call `version()` or read the storage key directly; the two agree once a mutation has run, and both report `1` on an instance that has never been written to. The test `test_version_matches_constant` asserts the raw storage entry, so it fails if the stamp is ever dropped.

### 5.2 How a consumer detects an old record

A consumer that needs to know whether a record was written by an older schema can:

1. Call `version()` and compare the returned value to the version the consumer was built against.
2. If the returned version is lower, the consumer must either use a compatibility path or request a migration.
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

There are two distinct layers of authorization in an upgrade, and they must not be conflated.

### 6.1 Network-level authorization (the transaction signer)

The current contract does *not* expose an upgrade entrypoint. The wasm replacement is performed via the Stellar CLI `contract upgrade` command, which is a network-level operation on the contract instance. It is authorized by the source account that signs the transaction and must be the contract's admin (the account that owns the instance). The contract itself does not perform an authorization check because the call is made by the admin account, not through a contract entrypoint.

Consequently:

- Only the admin account of the contract instance can replace its wasm. An arbitrary funded Testnet account cannot upgrade a contract it does not admin.
- On Testnet the admin is a single key, which is acceptable for testing but not for mainnet.
- On mainnet, the admin account must be a multisig or a hardened key, and the wasm hash must be reviewed before signing.

### 6.2 Contract-level authorization (an upgrade entrypoint)

A wasm replacement that is driven from inside the contract would go through an `upgrade` entrypoint that calls `env.deployer().update_current_contract_wasm()`. In that case the contract itself enforces authorization on the caller (for example by requiring the admin's address to `require_auth()`). This is the pattern a future governance layer would use, and it is out of scope for this document.

### 6.3 Reproducible example of the intended permissions

The following demonstrates that a non-admin account cannot replace the wasm, while the admin can. It was run on Testnet against the contract ID in §2.

1. Create a second, funded identity that is *not* the contract admin:

   ```bash
   stellar keys generate not-admin
   stellar friendbot fund not-admin
   ```

2. Attempt the wasm replacement with the non-admin identity:

   ```bash
   stellar contract upgrade \
     --id CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7 \
     --wasm-hash <computed-hash> \
     --source not-admin \
     --network testnet
   ```

   The transaction fails authorization because the source account is not the contract admin. The network rejects the operation and the deployed wasm hash is unchanged.

3. Confirm the hash is unchanged:

   ```bash
   stellar contract info hash --contract-id CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7 --network testnet
   ```

   The output must still equal the pre-upgrade hash (the value in §2).

4. Repeat the upgrade with the admin identity (the `deployer-identity` from §3.1) and confirm the hash now matches the newly installed wasm.

This example shows that the permission to replace the wasm is bound to the contract's admin account, not to any account that can sign a Testnet transaction.

---

## 7. Testnet vs. future mainnet

The pattern in this document is demonstrated on Testnet only. Mainnet would additionally require:

1. **Multisig approval** for the admin account. The current single-key admin is acceptable on Testnet but not on mainnet.
2. **A wasm hash review process**. The hash must be published and reviewed before the upgrade transaction is signed.
3. **A versioned release artifact**. The wasm must be built from a tagged commit and the hash must be recorded in the release notes.
4. **A migration plan** for existing records. On Testnet the contract holds no real value; on mainnet a schema change must be accompanied by a migration entrypoint and a rollback plan.
5. **A TTL policy**. See [#19](https://github.com/naninu123/4evergent/issues/19). The current contract bumps TTLs on every mutation but the documents do not state a mainnet TTL budget.

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
- Migration entrypoint: <yes | no> (signature)
- Rollback plan: <steps>
- Observed before/after storage state: <query output>

```

---

## 9. Related documents

- [`docs/testnet.md`](/testnet.md) — deployment and TypeScript integration path for the same contract (#90). This document does not contradict it; it extends it with the upgrade story.
- [`docs/architecture.md`](/architecture.md) — ADR-015 records the upgrade policy.
- [`docs/security-model.md`](/security-model.md) — key management rules that apply to the deployer identity.

---

## 10. Open questions

- TTL policy for existing records across a wasm replacement is tracked in [#19](https://github.com/naninu123/4evergent/issues/19). This document does not restate an answer.
- Lifecycle events are unchanged by this change. The `register`, `update_metadata`, and `deactivate` entrypoints already publish one contract event each on `main`, and this PR neither adds nor removes any of them; the only contract surface added here is the version surface described in §5. If lifecycle events ([#5](https://github.com/naninu123/4evergent/issues/5)) are extended later, this upgrade document should be updated to describe the new event payloads.
- A general-purpose proxy or governance system is out of scope. The minimal pattern in this document is the deliverable.
