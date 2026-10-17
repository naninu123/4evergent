# Your first agent, end to end (Testnet)

This is the single guided path from an empty checkout to a validated agent
lifecycle on **Stellar Testnet**:

```
create an agent â†’ set its policy â†’ submit an allowed payment
â†’ submit a payment that needs approval â†’ submit a denied payment
â†’ approve the queued intent â†’ read the execution record
â†’ register the same identity on-chain
```

It complements the reference documents rather than replacing them:

- [`cli.md`](cli.md) â€” every operator CLI command
- [`api.md`](api.md) â€” every HTTP route and response field
- [`security-model.md`](security-model.md) â€” the policy model and limits
- [`architecture.md`](architecture.md) â€” the transaction pipeline
- [`testnet.md`](testnet.md) â€” funding, simulation, live submission, and the
  deployed `agent-registry` contract

**Testnet only.** There is no mainnet path in this repository. Every command
below is copy-pasteable and uses the variables defined in
[Set up your shell](#set-up-your-shell). Placeholders such as
`<YOUR_TESTNET_SECRET_KEY>` are the only values you supply.

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | >= 22 | `node:sqlite` powers the persistent stores and the API |
| pnpm | >= 10 | workspace package manager (matches CI) |
| `curl` | any | HTTP calls in this walkthrough |
| `jq` | any | reads ids out of JSON responses |
| Stellar CLI | optional | only for the on-chain identity step |

```bash
node --version     # v22 or newer
pnpm --version     # 10.x
curl --version
jq --version
```

---

## 1. Clone, install, build

```bash
git clone https://github.com/naninu123/4evergent
cd 4evergent
pnpm install --frozen-lockfile
pnpm build
```

Run `pnpm build` **before** `pnpm typecheck` on a fresh checkout: workspace
packages resolve each other through `dist/`, so typechecking before the first
build fails with `TS2307: Cannot find module '@4evergent/shared'`. The same
ordering is used in CI (see [CONTRIBUTING.md](../CONTRIBUTING.md) and
`pnpm verify`).

---

## 2. Set up your shell

Create a **testnet-only** keypair and fund it with Friendbot. The secret stays
in your shell environment â€” never in the repository, `.env.example`, a log, or
a test.

```bash
# Generate a testnet keypair (one time). Keep the output private.
node --input-type=module -e "
import { Keypair } from '@stellar/stellar-sdk';
const k = Keypair.random();
console.log(JSON.stringify({ publicKey: k.publicKey(), secret: k.secret() }));
"
```

Copy the two values into placeholders (the quotes matter â€” bash treats bare
`<...>` as redirection):

```bash
export STELLAR_TESTNET_SECRET_KEY="<YOUR_TESTNET_SECRET_KEY>"
export STELLAR_PUBLIC_KEY="<YOUR_TESTNET_PUBLIC_KEY>"

# Fund the account on Testnet
curl -sS "https://friendbot.stellar.org/?addr=$STELLAR_PUBLIC_KEY" > /dev/null
```

Now define the variables used by every later command:

```bash
export API_URL="http://127.0.0.1:3000"
# Use the signer's own account as the payment destination so no second
# funded account is needed. Change this to any funded Testnet account.
export DESTINATION="$STELLAR_PUBLIC_KEY"
```

> `STELLAR_TESTNET_SECRET_KEY` is read by `TestnetLocalSigner` at startup and
> is never exposed through the API, activity records, or logs. See
> [security-model.md](security-model.md#key-management).

---

## 3. Start the API in Testnet mode

In this shell (the server inherits the variables you just exported):

```bash
export STELLAR_HORIZON_URL="https://horizon-testnet.stellar.org"
export DATABASE_PATH="./4evergent-tutorial.db"   # persist records across restarts
export PORT="3000"
export LIVE_SUBMIT="1"                            # opt in to real Testnet submission
pnpm --filter @4evergent/api start
```

What the settings do:

- `STELLAR_HORIZON_URL` must contain `testnet`; startup refuses mainnet.
- `DATABASE_PATH` persists agents, activity, approvals, and executions. Without
  it, the API uses in-memory stores and everything is lost on restart.
- `LIVE_SUBMIT=1` is the explicit gate for signing and submitting. If you leave
  it unset, policy decisions and approvals behave exactly the same, but an
  allowed intent stops at the submission gate (`403` with
  `status: "rejected"` and `error` mentioning that live submission is
  disabled) and nothing is sent on-chain.

The startup log reports the network, signer **public** account, database, and
whether live submission is enabled. The server is a long-running, single
instance process.

In a second terminal, check it:

```bash
curl -sS "$API_URL/health" | jq .
```

Real response:

```json
{
  "status": "ok",
  "signerAccountId": "<YOUR_TESTNET_PUBLIC_KEY>"
}
```

---

## 4. Create an agent

```bash
curl -sS -X POST "$API_URL/agents" \
  -H "Content-Type: application/json" \
  -d @- > /tmp/agent.json <<JSON
{
  "displayName": "first-agent",
  "description": "Walkthrough agent",
  "capabilities": ["pay"],
  "stellarAddress": "$STELLAR_PUBLIC_KEY"
}
JSON

export AGENT_ID="$(jq -r '.agent.id' /tmp/agent.json)"
echo "$AGENT_ID"
```

`201 Created` â€” real response shape (ids and timestamps vary):

```json
{
  "agent": {
    "id": "<agent-id>",
    "displayName": "first-agent",
    "description": "Walkthrough agent",
    "ownerId": "operator",
    "stellarAddress": "<YOUR_TESTNET_PUBLIC_KEY>",
    "capabilities": ["pay"],
    "status": "active",
    "createdAt": "<ISO-8601>",
    "updatedAt": "<ISO-8601>",
    "active": true,
    "metadata": {}
  }
}
```

> `capabilities` is descriptive metadata declared by the agent. It does not
> grant spending authority: the **policy** set in the next step is what the
> pipeline enforces. In development auth mode the owner is `operator`; with
> `API_KEYS` the owner comes from the server-side key configuration, never from
> the request body.

Check it from the CLI too (source checkout, no global install needed):

```bash
npx tsx apps/cli/src/cli.ts agent get "$AGENT_ID"
```

---

## 5. Set the policy

This policy produces all three outcomes in the next step:

- allowed: `1 XLM` (below the approval threshold)
- requires approval: `25 XLM` (at or above the threshold `10`, below `maxTxAmount`)
- denied: `150 XLM` (above `maxTxAmount`)

```bash
curl -sS -X PUT "$API_URL/agents/$AGENT_ID/policy" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON' | jq .
{
  "maxTxAmount": { "XLM": "100" },
  "dailySpendingLimit": { "XLM": "500" },
  "allowedAssets": ["XLM"],
  "requireHumanApprovalForAmountAbove": "10"
}
JSON
```

`200 OK` â€” real response (omitted fields are filled from `DEFAULT_RULES`):

```json
{
  "agentId": "<agent-id>",
  "policy": {
    "maxTxAmount": { "XLM": "100" },
    "dailySpendingLimit": { "XLM": "500" },
    "allowedAssets": ["XLM"],
    "allowedDestinations": [],
    "allowedContractIds": [],
    "txTypeRestrictions": {
      "payment": true,
      "trustline": true,
      "contract_call": false,
      "account_settings": false
    },
    "approvalThreshold": "10",
    "requireHumanApprovalForAmountAbove": "10"
  },
  "version": 1
}
```

The rules that matter here (full table in [`api.md`](api.md#policyrules)):

| Rule | Value | Effect |
|---|---|---|
| `maxTxAmount.XLM` | `100` | a single payment above `100 XLM` is denied |
| `dailySpendingLimit.XLM` | `500` | the agent's UTC-day ceiling |
| `requireHumanApprovalForAmountAbove` | `10` | `>= 10 XLM` queues for human approval |
| `allowedAssets` | `["XLM"]` | any other asset is denied |
| `allowedDestinations` | `[]` | empty list disables the destination allowlist |
| `allowedContractIds` | `[]` | contract calls are still denied by `txTypeRestrictions` |

---

## 6. Submit the three policy outcomes

### 6a. Allowed â€” `1 XLM`

```bash
curl -sS -X POST "$API_URL/agents/$AGENT_ID/intents" \
  -H "Content-Type: application/json" \
  -d @- <<JSON | tee /tmp/allow.json | jq .
{
  "type": "payment",
  "asset": "XLM",
  "destination": "$DESTINATION",
  "amount": "1",
  "reason": "walkthrough: policy-allowed payment"
}
JSON
```

`200 OK` and `status: "submitted"` â€” real response, abridged
(`policyDecision.intent` repeats the request):

```json
{
  "activityId": "<activity-id>",
  "agentId": "<agent-id>",
  "status": "submitted",
  "policyDecision": {
    "result": "allow",
    "reason": "All policy checks passed",
    "rule": "default"
  },
  "authorizationStatus": "approved",
  "simulationResult": {
    "success": true,
    "fee": "100000",
    "operations": 1,
    "warnings": []
  },
  "txHash": "<64-hex-transaction-hash>",
  "error": null
}
```

The pipeline validated the intent, evaluated policy, simulated against
Testnet Horizon, signed, and submitted. Look the hash up at
`https://stellar.expert/explorer/testnet/tx/<tx-hash>`.

> With `LIVE_SUBMIT` unset, this call returns `403` with
> `status: "rejected"` and an `error` starting
> `Submission failed: StellarSubmitter: live submission is disabled` â€” the
> policy and simulation still ran, but nothing was sent.

### 6b. Requires approval â€” `25 XLM`

```bash
curl -sS -X POST "$API_URL/agents/$AGENT_ID/intents" \
  -H "Content-Type: application/json" \
  -d @- <<JSON | tee /tmp/approval.json | jq .
{
  "type": "payment",
  "asset": "XLM",
  "destination": "$DESTINATION",
  "amount": "25",
  "reason": "walkthrough: approval-threshold payment"
}
JSON

export APPROVAL_ID="$(jq -r '.approvalId' /tmp/approval.json)"
echo "$APPROVAL_ID"
```

`202 Accepted` â€” real response:

```json
{
  "activityId": "<activity-id>",
  "agentId": "<agent-id>",
  "status": "requires_approval",
  "policyDecision": {
    "result": "requires_approval",
    "reason": "Amount 25 XLM requires human approval (>= 10)",
    "rule": "approvalThreshold"
  },
  "authorizationStatus": "pending_approval",
  "simulationResult": null,
  "txHash": null,
  "error": null,
  "approvalId": "<approval-id>"
}
```

Nothing was signed: approval is decided **before** simulation, and the
`approvalId` is what a human acts on. The approval expires after the server's
approval TTL (24 hours by default).

### 6c. Denied â€” `150 XLM`

```bash
curl -sS -o /tmp/deny.json -w 'HTTP %{http_code}\n' \
  -X POST "$API_URL/agents/$AGENT_ID/intents" \
  -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "type": "payment",
  "asset": "XLM",
  "destination": "$DESTINATION",
  "amount": "150",
  "reason": "walkthrough: over per-transaction limit"
}
JSON

jq . /tmp/deny.json
```

`403 Forbidden` â€” real response:

```json
{
  "activityId": "<activity-id>",
  "agentId": "<agent-id>",
  "status": "rejected",
  "policyDecision": {
    "result": "deny",
    "reason": "Amount 150 XLM exceeds max_tx_amount 100",
    "rule": "maxTxAmount"
  },
  "authorizationStatus": "denied_by_policy",
  "simulationResult": null,
  "txHash": null,
  "error": "Amount 150 XLM exceeds max_tx_amount 100"
}
```

The denial is still recorded as an activity, so the audit trail explains why
the payment did not happen.

---

## 7. Inspect the approval queue

```bash
curl -sS "$API_URL/approvals?status=pending_approval" | jq .
```

Real response, abridged:

```json
{
  "approvals": [
    {
      "id": "<approval-id>",
      "activityId": "<activity-id>",
      "agentId": "<agent-id>",
      "intent": {
        "type": "payment",
        "asset": "XLM",
        "destination": "<YOUR_TESTNET_PUBLIC_KEY>",
        "amount": "25",
        "reason": "walkthrough: approval-threshold payment"
      },
      "policyDecision": { "result": "requires_approval" },
      "status": "pending_approval",
      "expiresAt": "<ISO-8601>"
    }
  ],
  "hasMore": false,
  "truncated": false,
  "total": 1
}
```

Equivalent CLI:

```bash
npx tsx apps/cli/src/cli.ts approval list
npx tsx apps/cli/src/cli.ts approval get "$APPROVAL_ID"
```

---

## 8. Approve and read the execution record

```bash
curl -sS -X POST "$API_URL/approvals/$APPROVAL_ID/approve" | jq .
```

`200 OK` â€” real response:

```json
{
  "approvalId": "<approval-id>",
  "activityId": "<activity-id>",
  "agentId": "",
  "status": "approved",
  "message": "approval accepted; transaction queued for execution"
}
```

Approval re-evaluates the current policy, then enqueues a **persistent
execution**. The queue polls every 10 seconds (`EXECUTION_QUEUE_INTERVAL_MS`),
and the status reconciler polls Horizon every 30 seconds
(`RECONCILIATION_INTERVAL_MS`). Give it a few seconds, then read the record:

```bash
sleep 20
curl -sS "$API_URL/agents/$AGENT_ID/executions" | tee /tmp/executions.json | jq .
export EXECUTION_ID="$(jq -r '.executions[0].id' /tmp/executions.json)"
curl -sS "$API_URL/executions/$EXECUTION_ID" | jq .
```

`200 OK` â€” real execution record, abridged (`status` ends at `confirmed` once
the reconciler sees the transaction; `submitted` is the intermediate state):

```json
{
  "agentId": "<agent-id>",
  "executions": [
    {
      "id": "<execution-id>",
      "ownerId": "operator",
      "agentId": "<agent-id>",
      "approvalId": "<approval-id>",
      "activityId": "<activity-id>",
      "intent": {
        "type": "payment",
        "asset": "XLM",
        "destination": "<YOUR_TESTNET_PUBLIC_KEY>",
        "amount": "25",
        "reason": "walkthrough: approval-threshold payment"
      },
      "status": "confirmed",
      "policyDecision": { "result": "requires_approval" },
      "txHash": "<64-hex-transaction-hash>",
      "submittedHash": "<64-hex-transaction-hash>",
      "error": null,
      "attempt": 0,
      "startedAt": "<ISO-8601>",
      "completedAt": "<ISO-8601>"
    }
  ],
  "hasMore": false
}
```

Execution lifecycle: `queued â†’ executing â†’ submitted â†’ confirmed`, with
`failed`/`dead_letter` for terminal errors and `cancelled` for an operator stop.
`POST /executions/:id/cancel` (queued/executing) and
`POST /executions/:id/retry` (failed/dead_letter) are owner-scoped. With
`LIVE_SUBMIT` unset, the execution record still appears and ends `failed` with
the submission-gate error.

CLI equivalents:

```bash
npx tsx apps/cli/src/cli.ts execution list
npx tsx apps/cli/src/cli.ts execution get "$EXECUTION_ID"
```

---

## 9. Read the activity trail

```bash
curl -sS "$API_URL/agents/$AGENT_ID/activity?limit=10" | jq \
  '[.activity[] | {status, result: .policyDecision.result, rule: .policyDecision.rule, txHash}]'
```

Real result for this walkthrough (newest first):

```json
[
  { "status": "rejected", "result": "deny", "rule": "maxTxAmount", "txHash": null },
  { "status": "submitted", "result": "requires_approval", "rule": "approvalThreshold", "txHash": "<hash>" },
  { "status": "submitted", "result": "allow", "rule": "default", "txHash": "<hash>" }
]
```

Every record keeps the intent, the policy decision, the simulation result, the
authorization status, and the transaction hash. Nothing secret is stored.

CLI:

```bash
npx tsx apps/cli/src/cli.ts activity list "$AGENT_ID" 10
```

---

## 10. The on-chain identity side

The `agent-registry` Soroban contract is deployed on Testnet. It is the
**identity** half of an agent; the API's intent pipeline does not invoke it yet
(see [`soroban-integration.md`](soroban-integration.md#status-pipeline-does-not-invoke-contracts-yet)).
Use the same `AGENT_ID` you created above to bind an on-chain record.

| Field | Value |
|---|---|
| Network | Stellar Testnet (`Test SDF Network ; September 2015`) |
| Contract ID | `CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7` |
| Explorer | <https://stellar.expert/explorer/testnet/contract/CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7> |
| Stellar Lab | <https://lab.stellar.org/r/testnet/contract/CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7> |

Read-only query (no submission, safe to repeat):

```bash
export CONTRACT_ID="CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7"

stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source deployer --network testnet --send=no \
  -- query --id "$AGENT_ID"
```

Register the identity (writes to Testnet; `--caller` becomes the on-chain
owner, and `stellar_address` must authenticate too when it differs from the
caller):

```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source deployer --network testnet \
  -- register \
    --caller "$(stellar keys address deployer)" \
    --id "$AGENT_ID" \
    --display_name "first-agent" \
    --stellar_address "$STELLAR_PUBLIC_KEY" \
    --capabilities '["pay"]'
```

`stellar keys generate deployer --network testnet --fund` creates the source
identity if you do not have one; the secret stays in the local Stellar CLI
config. Install the CLI with `cargo install --locked stellar-cli` (see
[`testnet.md`](testnet.md#prerequisites-1)) if the `stellar` command is
missing. Contract id rules, errors, and the full `AgentInfo` shape are in
[`soroban-integration.md`](soroban-integration.md).

---

## 11. Stop and clean up

Stop the API with `Ctrl-C`. Records are kept in `./4evergent-tutorial.db` if
you set `DATABASE_PATH`; delete that file to start over:

```bash
rm -f ./4evergent-tutorial.db
```

Never commit the database, `.env`, or your secret key. `.gitignore` already
covers `.env*`.

---

## Same flow with the operator CLI

The CLI is an HTTP client for the same API (it never signs or submits on its
own). From a source checkout:

```bash
# Point the CLI at the running API
export FOREGENT_API_URL="$API_URL"

npx tsx apps/cli/src/cli.ts health
npx tsx apps/cli/src/cli.ts agent list
npx tsx apps/cli/src/cli.ts agent get "$AGENT_ID"
npx tsx apps/cli/src/cli.ts policy get "$AGENT_ID"
npx tsx apps/cli/src/cli.ts intent submit "$AGENT_ID" payment XLM 1 "$DESTINATION" "walkthrough: policy-allowed payment"
npx tsx apps/cli/src/cli.ts intent submit "$AGENT_ID" payment XLM 25 "$DESTINATION" "walkthrough: approval-threshold payment"
npx tsx apps/cli/src/cli.ts approval list
npx tsx apps/cli/src/cli.ts approval approve "$APPROVAL_ID"
npx tsx apps/cli/src/cli.ts execution list
npx tsx apps/cli/src/cli.ts activity list "$AGENT_ID"
```

Agent creation and policy updates are API-only today; the CLI covers agent
lifecycle (`list` / `get` / `pause` / `resume` / `disable`), approvals,
executions, policy reads, activity, schedules, and intent submission. See
[`cli.md`](cli.md) for the full command reference and exit codes.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `FATAL: ... STELLAR_TESTNET_SECRET_KEY` at startup | Export the secret key in the server's shell, or put it in `.env` (gitignored) |
| `FATAL` about `HOST` / `API_KEYS` | You bound a non-loopback host without API keys; use `127.0.0.1` locally or configure `API_KEYS` |
| Allow intent returns `403` with a `Submission failed` error | `LIVE_SUBMIT` is unset; restart with `LIVE_SUBMIT=1` |
| `409 agent is paused; new intents are rejected` | Resume the agent (`PATCH /agents/:id/status` or `4evergent agent resume`) |
| Approval `409 cannot approve: ...` | It was already approved/rejected; list approvals for the current state |
| `422` from an allowed intent | Simulation rejected the transaction (for example an unfunded or missing destination); check the `simulationResult.error` |
| `Cannot connect to API` from the CLI | The server is not running at `FOREGENT_API_URL` |

More in [`troubleshooting.md`](troubleshooting.md).

---

## What just happened

```
Agent created â”€â”€â–º Policy stored (maxTx 100 / daily 500 / approval >= 10)
      â”‚
      â”œâ”€ 1 XLM   â†’ validate â†’ policy allow   â†’ simulate â†’ sign â†’ submit â†’ activity
      â”œâ”€ 25 XLM  â†’ validate â†’ policy requires_approval â†’ approval queue
      â”‚                                              â””â”€ human approve â†’ execution queue
      â”‚                                                               â†’ simulate â†’ sign â†’ submit â†’ confirmed
      â””â”€ 150 XLM â†’ validate â†’ policy deny    â†’ 403 + rejected activity
```

Every step is recorded, independently of the LLM, and no step hands the model a
signer. Continue with:

- [`capabilities.md`](capabilities.md) â€” intent types and asset representation
- [`security-model.md`](security-model.md) â€” threat model and approval flow
- [`api.md`](api.md) â€” schedules, executions, dashboard endpoints
- [`cli.md`](cli.md) â€” operator commands and exit codes
