/**
 * Landing page content — every claim here is derived from the repository
 * (README.md, docs/*.md, packages/*, apps/*, contracts/*). No invented
 * features, APIs, integrations, or metrics.
 */

export const REPO = 'https://github.com/naninu123/4evergent';

export const DOCS = {
  readme: `${REPO}#readme`,
  architecture: `${REPO}/blob/main/docs/architecture.md`,
  security: `${REPO}/blob/main/docs/security-model.md`,
  capabilities: `${REPO}/blob/main/docs/capabilities.md`,
  api: `${REPO}/blob/main/docs/api.md`,
  cli: `${REPO}/blob/main/docs/cli.md`,
  testnet: `${REPO}/blob/main/docs/testnet.md`,
  roadmap: `${REPO}/blob/main/docs/roadmap.md`,
  changelog: `${REPO}/blob/main/CHANGELOG.md`,
  contributing: `${REPO}/blob/main/CONTRIBUTING.md`,
  license: `${REPO}/blob/main/LICENSE`,
} as const;

export interface Gate {
  /** Source module that performs this step. */
  id: string;
  name: string;
  actor: string;
  summary: string;
  outcome: string;
  verdict: 'allow' | 'deny' | 'hold';
}

/** Gate order is structural: TransactionPipeline.execute() is the only public entry point. */
export const GATES: Gate[] = [
  {
    id: 'validate',
    name: 'Intent validation',
    actor: 'IntentValidator · @4evergent/agent-core',
    summary:
      'The intent is checked against its typed schema. Amounts must be positive numbers, destinations must be well-formed Stellar accounts, and the intent type must exist in the union. Nothing downstream ever sees a raw transaction blob — the pipeline rejects plain XDR and arbitrary operation arrays by design.',
    outcome: 'status: rejected · rule: intent_validation',
    verdict: 'deny',
  },
  {
    id: 'policy',
    name: 'Policy evaluation',
    actor: 'PolicyEngine.evaluate() · @4evergent/policy',
    summary:
      'A pure function decides: allowed types, per-transaction maximums, daily spending, approval threshold, asset allowlist, destination allowlist, contract allowlist. Rules are data, not code paths. Evaluation runs against the agent’s current rules — a stored policy override wins over the defaults.',
    outcome: 'result: allow · deny · requires_approval',
    verdict: 'hold',
  },
  {
    id: 'authorize',
    name: 'Authorization gate',
    actor: 'TransactionPipeline',
    summary:
      'An approval does not bypass the policy engine. When an approved intent is executed, policy is re-evaluated against the agent’s current rules — if the rules were tightened between approval and execution, the execution is denied.',
    outcome: 'status: requires_approval · authorizationStatus: pending_approval',
    verdict: 'hold',
  },
  {
    id: 'construct',
    name: 'Transaction construction',
    actor: 'StellarTransactionBuilder · @4evergent/stellar',
    summary:
      'The builder accepts validated payment and trustline intents only. It does not accept raw XDR, and it cannot be handed an arbitrary operation array. Construction failure is recorded on the activity record and aborts the chain.',
    outcome: 'status: rejected · message: Transaction construction failed',
    verdict: 'deny',
  },
  {
    id: 'simulate',
    name: 'Simulation gate',
    actor: 'StellarSimulator · Horizon API',
    summary:
      'A mandatory gate against the real Horizon endpoint. It verifies the envelope is well-formed, the source account exists, the sequence number is exactly on-chain + 1, the fee covers the network base fee, and the balance covers amount, fee, and minimum reserve. There are no fake or cached simulation results.',
    outcome: 'status: simulation_failed · authorizationStatus: denied_by_simulation',
    verdict: 'deny',
  },
  {
    id: 'sign',
    name: 'Signing',
    actor: 'Signer interface · TestnetLocalSigner',
    summary:
      'Signing is a capability, not a function the LLM can call. The pipeline holds the Signer reference; callers never receive one, and the interface exposes only the public account ID and network passphrase — never key material. A transaction whose simulation failed cannot reach this step.',
    outcome: 'Signer.sign(transaction) — no key-returning methods exist',
    verdict: 'allow',
  },
  {
    id: 'submit',
    name: 'Submission',
    actor: 'StellarSubmitter',
    summary:
      'Submits the signed transaction and rejects unsigned ones. The transaction hash is persisted before submission returns, so a crash inside the submit window still leaves a hash that reconciliation can match.',
    outcome: 'status: submitted · txHash: <64-hex>',
    verdict: 'allow',
  },
  {
    id: 'record',
    name: 'Activity record',
    actor: 'ActivityStore · @4evergent/database',
    summary:
      'Every outcome is appended: intent, policy decision, authorization status, simulation result, transaction hash, status, error. assertNoSecrets() runs on write — a record containing a marker such as “seed”, “private_key”, or “mnemonic” is rejected.',
    outcome: 'appended · no field exists for secrets',
    verdict: 'allow',
  },
];

export interface Rule {
  order: string;
  rule: string;
  detail: string;
}

/** Evaluation order from PolicyEngine.evaluateWithRules(). */
export const RULES: Rule[] = [
  { order: '01', rule: 'txTypeRestrictions', detail: 'Type must be permitted. Deny by default — payment and trustline ship allowed; contract_call and account_settings ship denied.' },
  { order: '02', rule: 'maxTxAmount', detail: 'Per-transaction ceiling, per asset. Default 100 XLM.' },
  { order: '03', rule: 'dailySpendingLimit', detail: 'Per agent, per UTC day, counted from submitted activities. Default 500 XLM.' },
  { order: '04', rule: 'requireHumanApprovalForAmountAbove', detail: 'Amounts at or above the threshold route to a human review queue. Default 50 XLM.' },
  { order: '05', rule: 'allowedAssets', detail: 'Asset allowlist. Empty means unrestricted; the default allows XLM only.' },
  { order: '06', rule: 'allowedDestinations', detail: 'Payment destination allowlist. Empty means unrestricted.' },
  { order: '07', rule: 'allowedContractIds', detail: 'Contract allowlist for contract calls, which are denied by default regardless.' },
];

export interface Decision {
  kind: 'allow' | 'deny' | 'hold';
  label: string;
  reason: string;
}

export const DECISIONS: Decision[] = [
  { kind: 'allow', label: 'allow', reason: 'All policy checks passed — rule: default' },
  { kind: 'deny', label: 'deny', reason: 'Amount 250 XLM exceeds max_tx_amount 100 — rule: maxTxAmount' },
  { kind: 'hold', label: 'requires_approval', reason: 'Amount 80 XLM requires human approval (>= 50) — rule: approvalThreshold' },
];

export interface Capability {
  intent: string;
  state: 'on' | 'hold' | 'off';
  stateLabel: string;
  note: string;
}

export const CAPABILITIES: Capability[] = [
  { intent: 'payment', state: 'on', stateLabel: 'supported', note: 'Native XLM and issued assets with assetDetails { code, issuer }.' },
  { intent: 'trustline', state: 'on', stateLabel: 'supported', note: 'assetCode, issuer, optional limit.' },
  { intent: 'contract_call', state: 'off', stateLabel: 'denied by default', note: 'Validates and reaches policy, which denies it unless the type is explicitly enabled and the contract id is allowlisted. The pipeline does not build contract invocations yet.' },
  { intent: 'account_settings', state: 'off', stateLabel: 'denied by default', note: 'Validates and reaches policy, which denies it by default.' },
];

export interface ToolingTab {
  id: string;
  label: string;
  code: string;
  note: string;
  noteHref: string;
  noteText: string;
}

export const TOOLING: ToolingTab[] = [
  {
    id: 'api',
    label: 'HTTP API',
    code: `# every endpoint except /health requires auth
GET  /agents                       list your agents
POST /agents                       create an agent
POST /agents/:id/intents           submit a typed intent
GET  /agents/:id/policy            effective policy rules
PUT  /agents/:id/policy            set the agent's policy
POST /agents/:id/schedules         create a schedule
POST /approvals/:id/approve        approve a pending intent
GET  /executions/:id               execution record
POST /executions/:id/retry         retry a failed execution
GET  /agent-queue                  queue summary by status

# optional on POST /agents/:id/intents
Idempotency-Key: weekly-payout-42`,
    note: 'The core endpoint returns 403 for a policy deny, 202 with an approvalId when approval is required, and 200 with the transaction hash when the intent executes.',
    noteHref: DOCS.api,
    noteText: 'docs/api.md',
  },
  {
    id: 'cli',
    label: 'Operator CLI',
    code: `$ 4evergent health
$ 4evergent agent list
$ 4evergent agent pause agent-123
$ 4evergent approval list
$ 4evergent approval approve ap-123
$ 4evergent execution retry exec-123
$ 4evergent policy get agent-123
$ 4evergent activity list agent-123 10
$ 4evergent intent submit agent-123 payment XLM 25 GDAAAA… \\
    "weekly payout" --idempotency-key weekly-42`,
    note: 'The CLI is an HTTP client. It never signs, never builds Stellar operations, and never touches Horizon directly — it reads its API key from the environment on each run.',
    noteHref: DOCS.cli,
    noteText: 'docs/cli.md',
  },
  {
    id: 'contracts',
    label: 'Soroban contract',
    code: `# contracts/agent-registry — Rust workspace, pinned toolchain
register          -> AgentInfo   caller becomes owner
update_metadata   -> AgentInfo   owner only (require_auth)
deactivate        -> bool        permanent tombstone,
                                 no reactivation entrypoint
query             -> Option<AgentInfo>   pure read

# deployed on Stellar Testnet
CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7`,
    note: 'Agent identity on-chain: registration binds the agent id to a stellar_address with that address’s consent. Records extend their own TTL on every write and are archived, not deleted, at the TTL ceiling. The sibling permissions crate is excluded from the workspace and intentionally not deployed.',
    noteHref: `${REPO}/blob/main/contracts/agent-registry/DESIGN.md`,
    noteText: 'contracts/agent-registry/DESIGN.md',
  },
];

export interface Limit {
  title: string;
  detail: string;
}

/** Known limitations, from docs/roadmap.md, docs/security-model.md and docs/testnet.md. */
export const LIMITS: Limit[] = [
  { title: 'Testnet only', detail: 'The adapter defaults to testnet and rejects a mainnet passphrase and URL. Live submission stays off until LIVE_SUBMIT=1 is set explicitly.' },
  { title: 'No production signer', detail: 'TestnetLocalSigner is development infrastructure. User-wallet, KMS, and hardware signers plug into the Signer interface but are not implemented.' },
  { title: 'No project token', detail: 'No token, no sale, no bonding curve. Actions use XLM or native testnet assets. Recorded as ADR-006.' },
  { title: 'Exactly-once is not guaranteed', detail: 'A single-process SQLite queue gives at-most-once deduplication through atomic status claims. Retries are bounded, then dead-lettered for manual review.' },
];

export const STEPS: { label: string; title: string; code: string }[] = [
  {
    label: 'Step 01',
    title: 'Install',
    code: `git clone ${REPO}
cd 4evergent
pnpm install --frozen-lockfile
pnpm build`,
  },
  {
    label: 'Step 02',
    title: 'Run the API and dashboard',
    code: `pnpm --filter @4evergent/api dev
pnpm --filter @4evergent/web dev`,
  },
  {
    label: 'Step 03',
    title: 'Check the pipeline',
    code: `pnpm test
pnpm lint
pnpm typecheck`,
  },
];
