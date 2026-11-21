# Policy asset identities

Policy limits and allowlists use one identity per asset everywhere policy is
written, enforced, and reported. This is the key namespace behind
`maxTxAmount`, `dailySpendingLimit`, and `allowedAssets`; see the
[`PolicyRules` field reference](api.md#policyrules) for the surrounding shape.

## Canonical forms

| Intent / key | Canonical form | Example |
|---|---|---|
| Native XLM | `XLM` | `XLM` |
| Issued asset (payment) | `CODE:ISSUER` | `USDC:GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U` |
| Trustline allowlist / limit | `trustline:CODE:ISSUER` | `trustline:USDC:GDI73...T75U` |

- `CODE` is a 1–12 character Stellar asset code (`A-Z`, `a-z`, `0-9`, `_`).
- `ISSUER` is a 56-character StrKey `G...` Stellar account.
- `XLM` has no issuer. An issued asset is identified by its code **and**
  issuer; two issuers' USDC are different assets.

`allowedAssets` accepts `XLM`, `CODE:ISSUER`, and
`trustline:CODE:ISSUER`. It applies to payments and trustlines: a trustline is
matched by its `trustline:CODE:ISSUER` identity, while a payment of the same
asset is matched by `CODE:ISSUER`.

Contract calls and account settings carry no asset. They are governed by
`txTypeRestrictions` (and `allowedContractIds` for contract calls), never by a
fabricated `native` allowlist entry.

## Payments without `assetDetails`

A payment with `assetDetails` uses its `code` and `issuer`. A payment without
`assetDetails` must use `XLM` or an `asset` string already in `CODE:ISSUER`
form. A bare non-native code (for example `USDC`) is resolved only when the
policy names exactly one issuer for that code; otherwise the intent is denied
as ambiguous instead of bypassing the per-asset limits.

## Legacy `native` key

`native` is accepted in `maxTxAmount` and `dailySpendingLimit` as a legacy
fallback lookup key. It is not an asset identity and is not accepted in
`allowedAssets`.

## Validation

`validatePolicyRules` rejects any other limit or allowlist key with an error
naming the expected form. For example, a `dailySpendingLimit` keyed `USDC` is
rejected; use `USDC:<issuer>` instead.

## Enforcement and reporting

The policy engine resolves an intent to its canonical identity before applying
`maxTxAmount`, `allowedAssets`, and `dailySpendingLimit`. A successful daily
reservation is written under that same identity, and
`GET /agents/:id/spending` reads the configured key from the same reservation
table, so a non-native asset's `used` matches what the engine enforced.

The implementation lives in
[`packages/policy/src/asset-identity.ts`](../packages/policy/src/asset-identity.ts);
the checks are in [`engine.ts`](../packages/policy/src/engine.ts) and
[`validation.ts`](../packages/policy/src/validation.ts).
