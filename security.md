# Security model

[← README](./README.md) · [Architecture](./architecture.md) · [Adversarial Testing](./adversarialtesting.md)

SpendArc's safety rests on two independent fences and a set of invariants that keep them independent.
This document states the guarantees, the deliberate tradeoffs, and the known v1 limitations — honestly.

---

## Guarantees

1. **An off-policy action can't be broadcast.** The executor's private key lives only on the server and
   only ever signs `SpendArcVault.executeSpendFor` after `evaluatePolicy` approves the request
   (service allowlist + per-tx cap + daily cap + dedup against the server ledger). No signature → the
   call is never broadcast.
2. **Value only moves inside policy.** For any executed call, `SpendArcVault._executeSpend` checks
   active/expiry, token allowlist, per-service allowlist (label, per-tx cap, daily cap, expiry),
   global per-tx cap, rolling-24h daily cap, and `actionId` dedup **before** the transfer
   (checks-effects-interactions).
3. **Every decision is on-chain.** Blocked actions emit `AgentActionBlocked(agent, target, token, amount,
   reason)` and return `false` — they never revert. Approved actions emit `AgentActionApproved` +
   `ReceiptIssued`. The dashboard and any auditor reconstruct the full history from events.
4. **The executor is spend-within-policy only.** The executor role (`executeSpendFor`) cannot change
   policy, cannot deposit, and cannot withdraw. Only the vault owner holds those powers.

## The no-revert-on-policy design

Policy violations **emit + return false**; they do not revert. A revert would erase the event and the
audit trail. Reverts are reserved for **genuine safety**: `NotOwner()`, `NotAuthorized()`, `Reentrancy()`,
`NativeTransferFailed()` (native-transfer atomicity), and constructor-invariant failures. The tradeoff — a
caller could ignore the returned `approved` bool — is closed by the server resolving outcomes from the
emitted events (never optimistically), and by the fact that a blocked action moves nothing regardless.

## Contract-layer safety

- **Reentrancy:** hand-rolled `nonReentrant` guard on `executeSpend`/`executeSpendFor`; state
  (`usedAction`, `spentToday`) updates **before** the external transfer/call. A malicious token that
  re-enters hits the guard and the nested call reverts — proven by an explicit attacker test.
- **CEI:** effects precede interactions; a failed transfer reverts the whole call (nothing partial).
- **Owner controls:** `setAgentPolicy`, `setAllowedService`, `setAllowedToken`, `revokeAgent` (hard
  off-switch), `withdrawTokens`, and `setExecutor` are all `onlyOwner`.
- **Per-service caps are validated:** `setAllowedService` requires `dailyCap == 0 || maxPerTx <= dailyCap`,
  mirroring the same invariant the factory enforces on the global leash.

## Fence 1 stays cheap and safe (server policy gate)

Fence 1 is now a **server-side gate**, not a paymaster:

- Policy evaluation reads the DB ledger (allowlist entries + budget rows) and the agent's requested
  spend, performs the same allowlist/dedup checks the vault enforces, and refuses cleanly with a
  structured JSON error when off-policy — it never throws, never partial-submits, and never signs.
- The `sync` flow reconciles the DB against **actual on-chain vault state** (`getService`,
  `remainingServiceDailyCap`, etc.) and returns `409 ONCHAIN_MISMATCH` when they disagree, so a stale
  ledger can't silently drift further from the on-chain truth.
- Because Fence 2 (the vault) re-checks everything on-chain anyway, a Fence 1 failure cannot move money:
  at worst it signs a call the vault rejects — which emits a permanent `AgentActionBlocked` artifact.

## Key management

- The **executor private key** lives **only** in server env (the API routes run on the Node runtime).
  It is never `NEXT_PUBLIC_`, never shipped to the client, and never committed. The client bundle was
  grep-verified to contain zero key material and none of the server-only signer/send code.
- The public endpoints are bounded (only `executeSpendFor` within an agent's policy) and the executor
  holds no other power on any vault.
- Repo hygiene: `internal/` (PRD + `keys.json`) and Foundry `cache/` (which holds forge-script "sensitive
  values") are gitignored. No private key is committed.

## Known v1 limitations (stated plainly)

1. **The server gate is trust** — it is not a cryptographic guarantee. A compromised server could sign
   an on-policy-shaped call for any agent's vault (bounded by that vault's on-chain policy) or simply
   refuse to serve. The on-chain vault is the hard safety boundary; the server gate is the convenience
   + first-line filter. Per-user self-custodied vaults mean compromise of the executor cannot move funds
   off-policy, but a fully compromised server is still a liveness and policy-integrity risk.
2. **The executor is a single signing key.** It is one point of failure and one attack surface. The
   intended hardening is a **multisig + timelock operator** (or threshold signing) so no single key can
   sign, plus immutable/ratchet-only policy so a live policy can never be silently weakened.
3. **`MockUSD` is a test asset.** No real funds are at risk in the hackathon deployment.

## Responsible disclosure

This is a hackathon testnet deployment using a `MockUSD` test asset — no real funds at risk.
Issues can be raised on the repository.