# 4evergent HTTP API Reference

Current API surface of `apps/api`, accurate to the source at
`apps/api/src/index.ts`. All examples use placeholders — never real
credentials.

## Authentication

All endpoints except `GET /health` require authentication.

- **Development mode** (default): `DevAuthProvider` authenticates every
  request as the development owner (`DEV_OWNER_ID`, default `operator`).
  No `Authorization` header needed.
- **Production mode**: set `API_KEYS` (format
  `key:ownerId[:subject]`, comma-separated). Requests must send
  `Authorization: Bearer <key>`. Invalid/missing credentials → `401`.
  See [security-model.md](security-model.md) — API Authentication.

Unauthenticated requests to protected endpoints return
`{"code":"UNAUTHORIZED","error":"unauthorized"}` with status `401`.

## User Authentication (Browser Sessions)

In addition to API-key auth for machine clients, the API supports
browser-based user sessions for humans. Sessions live in an HttpOnly,
SameSite=Lax cookie named `four_eg_session`. Three login methods are
supported: email+password, Google OAuth, and Stellar wallet signature.

CSRF protection: cookie-authenticated state-changing requests must carry
the `X-Requested-With` header. Bearer/API-key requests are unaffected.

### GET /auth/config

Public. Returns which login methods the server has enabled:

```json
{
  "email": true,
  "google": true,
  "stellar": true,
  "allowRegistration": true
}
```

### POST /auth/register

Create a new email+password account. Only available when
`allowRegistration` is `true`.

Body: `{ "email": string (required), "password": string (required, min 8 chars), "displayName"?: string }`

- `201` → `{ "user": { "id", "email", "displayName" } }` — session cookie is set
- `400` → invalid JSON / missing fields / password too short
- `409` → email already registered
- `403` → registration disabled

### POST /auth/login/email

Login with email+password.

Body: `{ "email": string (required), "password": string (required) }`

- `200` → `{ "user": { "id", "email", "displayName" } }` — session cookie is set
- `401` → invalid email or password

### GET /auth/me
Get the current logged-in user (from session cookie).

- `200` → `{ "user": { "id", "email", "displayName", "stellarPublicKey" } }`
- `401` → not logged in

### POST /auth/logout

Invalidate the current session.

- `200` → `{ "ok": true }` — session cookie is cleared

### GET /auth/google/start

Start Google OAuth flow. Redirects to Google's authorization endpoint.

### GET /auth/google/callback

Google OAuth callback. Exchanges the authorization code for a token,
creates/fetches the user, and sets the session cookie.

### POST /auth/stellar/challenge

Request a Stellar signature challenge.

Body: `{ "publicKey": string (required, Stellar address) }`

- `200` → `{ "challenge": string }` — the user signs this with their wallet
- `400` → invalid Stellar address

### POST /auth/stellar/verify

Verify a Stellar signature and log the user in.

Body: `{ "publicKey": string (required), "signature": string (required), "challenge": string (required) }`

- `200` → `{ "user": { "id", "stellarPublicKey", "displayName" } }` — session cookie is set
- `400` → invalid signature / expired challenge

## Ownership

All data is owner-scoped. Requests only see records owned by the
authenticated `ownerId`. Access to another owner's resource returns
d404` (not `403`) to avoid leaking existence.

## General error behavior

Errors are JSON objects that carry a machine-readable `code` alongside a
human-readable `error` message: `{ "code": "<CODE>", "error": "<message>" }`.
The code is the stable contract; the message is human-readable and may
change. Some endpoints return message-shaped bodies (noted where they
differ). Unknown paths return
`{"code":"NOT_FOUND","error":"not found"}` with `404`. Request bodies are limited to 1 MB.

### Error codes

The following codes are returned in the `code` field of error responses.
The set is defined in `apps/api/src/index.ts` as the single source of
truth.

| Code | HTTP status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Request is missing valid credentials. |
| `NOT_FOUND` | 404 | The requested route or resource does not exist. |
| `AGENT_NOT_FOUND` | 404 | The agent does not exist or is not owned by the caller. |
| `APPROVAL_NOT_FOUND` | 404 | The approval does not exist or is not owned by the caller. |
| `EXECUTION_NOT_FOUND` | 404 | The execution does not exist or is not owned by the caller. |
| `SCHEDULE_NOT_FOUND` | 404 | The schedule does not exist or is not owned by the caller. |
| `INVALID_PATH_PARAM` | 400 | A path parameter is missing or malformed. |
| `INVALID_JSON` | 400 | The request body is not valid JSON. |
| `VALIDATION_ERROR` | 400 | A field failed validation; see `details`. |
| `CONFLICT` | 409 | The request conflicts with the current state. |
| `APPROVAL_EXPIRED` | 410 | The approval has expired. |
| `REGISTRATION_DISABLED` | 403 | New account registration is disabled. |
| `EMAIL_ALREADY_REGISTERED` | 409 | The email is already registered. |
| `INTERNAL_ERROR` | 500 | An unexpected server error occurred. |

Error responses that fail field validation include a `details` array of
per-field messages, notably for `VALIDATION_ERROR`:

```json
{
  "code": "VALIDATION_ERROR",
  "error": "invalid request body",
  "details": [
    { "field": "displayName", "message": "is required" }
  ]
}
```

---

## Health

### GET /health

Public (no authentication). Returns `{"status":"ok","signerAccountId":"G..."}`.

---

## Agents

### POST /agents

Create an agent. Auth: any authenticated owner.

Body: `{ "displayName": string (required, ≤100 chars, trimmed), "description"?: string (optional, ≤500 chars), "capabilities"?: string[] (optional, ≤32 entries, each ≤32 chars, trimmed, non-empty, unique), "stellarAddress"?: string }`

- `201` → `{ "agent": AgentRecord }` (bound to caller's `ownerId`)
- `400` → invalid JSON / missing `displayName` / `displayName` too long (>100 chars) / `description` not a string or too long (>500 chars) / `capabilities` not string array, too many entries (>32), entry too long (>32 chars), empty entry after trimming, or duplicate entries / `stellarAddress` not a string

### GET /agents

List caller's agents. Returns `{ "agents": AgentRecord[] }`.

### GET /agents/:id

Get one agent (owner-scoped). `404` if not found or not owned.

### PATCH /agents/:id/status

Body: `{ "status": "active" | "paused" | "disabled" }`

- `200` → `{ "id", "status" }`
- `400` → invalid status / invalid JSON
- `404` → not found or not owned

---

## Intents

### POST /agents/:id/intents

Submit a typed intent for execution. The core endpoint.

Body: an `AgentIntent` union member (`packages/shared/src/types.ts`):

- `payment`: `{ type, asset, assetDetails?, destination, amount, reason, memo? }`
- `trustline`: `{ type, assetCode, issuer, limit?, reason }`
- `contract_call`: `{ type, contractId, function, args, reason }`
- `account_settings`: `{ type, setting, value, reason }`

Headers: optional `Idempotency-Key` (≤256 chars, scoped to owner+agent).
Same key + same intent → returns the original activity (`200` ).
Same key + different intent → `409`.

Agent status admission: the agent must be `active`. A paused on
disabled agent rejects new intents before any activity, approval,
execution, or queue record is created:

- `409` → `{ "code": "CONFLICT", "error": "agent is paused; new intents are rejected" }`
- `409` → `{ "code": "CONFLICT", "error": "agent is disabled; new intents are rejected" }`

Existing approvals and in-flight executions are unaffected by a status
change — the gate applies to new intents only.

Behavior (policy decision):

- Policy `deny` → `403` with intent response recording the denial
- Policy `requires_approval` → `202` with `approvalId` in the response
- Policy `allow` → executes: `200` (submitted, includes `txHash`),
  `422` (simulation failed), `502` (source account load failed),
  `403` (rejected)

Response (success/denied): `{ "activityId", "agentId", "status",
"policyDecision", "authorizationStatus", "simulationResult",
"txHash", "error" }`

Raw XDR / transaction blobs in the body are rejected with `400`(typed intents only — no raw transaction acceptance by design).

---

## Approvals

### POST /approvals/:id/approve

Approve a pending approval. Owner-scoped (`canApprove`). The approver
identity is taken from the authenticated principal's `subject`.

- `200` → `{ approvalId, activityId, agentId:"", status:"approved",
  message }` — execution is enqueued (persistent queue) or deferred
- `409` → invalid state transition (e.g. already approved)
- `410` → approval expired
- `404` → not found or not owned (response body is approval-response
  shaped with status `rejected`, not `{"error"}`)

Raw XDR in body → `400` with `{"message": ...}` (message-shaped).

### POST /approvals/:id/reject

Reject a pending approval. Owner-scoped (`canReject`).

- `200` → approval-response shaped, status `rejected`- `409` → invalid state transition
- `404` → not found or not owned (approval-response shaped)

Raw XDR in body → `400` with `{"message": ...}`.

### GET /approvals

List caller's approvals (most recent 50). Query: `?status=<status>`
foptional filter. Returns `{ "approvals": ApprovalRecord[] }`.

### GET /agents/:id/approvals

List approvals for one agent (owner-scoped). Query: `?status=` filter.
Returns `{ "agentId", "approvals": ApprovalRecord[] }`.

---

## Activity

### GET /agents/:id/activity

List activity records for an agent (owner-scoped).
Query: `?limit=` (default 50, clamped 1–100).
Returns `{ "agentId", "activity": ActivityRecord[] }`.

### GET /agents/:id/activity/:activityId

Single activity record (owner-scoped). `404` if not found/not owned.
Returns `{ "activity": ActivityRecord }`.

---

## Policy

### `PolicyRules`

`PolicyRules` is the complete policy shape returned by `GET /agents/:id/policy`.
`PUT /agents/:id/policy` may omit fields: the API validates the supplied values
and fills omitted fields from `DEFAULT_RULES` before storing them. The
[policy limits table](security-model.md#spending-limits) summarizes the spending
limits; the details below define the request fields.

Amounts in `maxTxAmount`, `dailySpendingLimit`, `approvalThreshold`, and
`requireHumanApprovalForAmountAbove` are JSON strings in the TypeScript type.
The validator also accepts JSON numbers for these fields. Amounts must be finite;
`maxTxAmount` entries must be greater than zero, while daily limits and approval
thresholds may be zero or greater.

| Field | Type | Meaning and format | Default |
|-------|------|-------------------|---------|
| `maxTxAmount` | `Record<string, string>` | Per-transaction maximum, keyed by policy asset identifier. Each configured value must be positive. | `{ "XLM": "100" }` |
| `dailySpendingLimit` | `Record<string, string>` | Per-agent daily limit, keyed by policy asset identifier. Each value must be non-negative. | `{ "XLM": "500" }` |
| `allowedAssets` | `string[]` | Asset identifiers permitted by the policy. An empty array disables this allowlist check. | `["XLM"]` |
| `allowedDestinations` | `string[]` | Payment destination account IDs. Entries must be 56-character strings beginning with `G`; an empty array disables the destination check. | `[]` |
| `allowedContractIds` | `string[]` | Contract IDs permitted for contract calls. Entries must be non-empty strings; an empty array disables this allowlist check. | `[]` |
| `txTypeRestrictions` | `Record<string, boolean>` | Supported keys are `payment`, `trustline`, `contract_call`, and `account_settings`. A type is permitted only when its value is `true`; unknown keys are invalid. | `{ "payment": true, "trustline": true, "contract_call": false, "account_settings": false }` |
| `approvalThreshold` | `string` | Compatibility alias for the human-approval amount gate. If the canonical field below is omitted, normalization uses this value for it. | `.50` |
| `require
