# Adversarial testing

[← README](./README.md) · [Architecture](./architecture.md) · [Security](./security.md)

Every claim in [security.md](./security.md) is backed by a test. The strategy runs from hermetic units up
to live on-chain acceptance, deliberately trying to break each fence.

---

## Layers

| Layer | What it proves | Where |
|-------|----------------|-------|
| Unit (Foundry) | Every policy branch + safety revert | `test/SpendArcVault.t.sol`, `test/SpendArcVaultFactory.t.sol` |
| Live simulation gate | Factory deploy + vault spend trace cleanly | `web/sim-visitor.mjs` (e2e against the deployment) |
| On-chain acceptance | Approved + blocked, live, with tx hashes | Arc testnet |

**Solidity: 23 tests.**

## Vault — the policy surface (PRD scenarios 1–10 + more)

`test/SpendArcVault.t.sol` isolates each blocked *reason* so the ordering can't mask a bug:

- Approved spend → `AgentActionApproved` + `ReceiptIssued`, funds move, `spentToday` advances.
- Blocked, one per reason: **exceeds global maxPerTx**, **service not allowlisted**, **token not
  allowlisted**, **exceeds global dailyCap**, **exceeds service maxPerTx**, **exceeds service dailyCap**,
  **agent not active** (revoked), **policy expired**, **service allowlist expired**, **duplicate action**
  (replay).
- **Per-service budget isolation:** a per-service daily cap on one target does not bind another target
  (`test_PerServiceBudgetDoesNotBindOtherTargets`), and the per-service daily budget resets on its own
  24h window (`test_ServiceDailyCapResets_AfterWindow`).
- **Invariant enforcement:** `setAllowedService` with `maxPerTx > dailyCap` reverts
  (`test_Revert_ServiceMaxPerTxExceedsDailyCap`).
- **Reentrancy attempt:** a malicious ERC20 re-enters `executeSpend` during its transfer; the `nonReentrant`
  guard fires (the nested call reverts) while the legitimate outer spend completes and no double-spend
  occurs.
- Native path (success + `NativeTransferFailed` safety revert), owner-guard reverts, rolling-24h daily
  reset, unregistered-agent default-inactive.

Each asserts **events + state + balances**, not just a return value.

## Factory layer

`test/SpendArcVaultFactory.t.sol` proves the counterfactual contract: one vault per owner
(`vaultOf`/`vaultByAgent`), the constructor seeds the owner as the single active agent
(`getService(owner, owner).allowed` with `label == "self"`), an unregistered address is **not** the
vault's agent (`getService(bob, bob).allowed == false`), and `createVault` enforces `maxPerTx <= dailyCap`.

## The live simulation gate

`web/sim-visitor.mjs` drives the full flow against the **live deployment** (Arc testnet): funds a fresh
wallet, creates a vault via the factory, deposits, registers an agent, introspects the leash, makes an
approved payment, allowlists a third-party service and pays it (verifying `getService` on-chain), edits
the leash down, then proves an overspend is blocked. Every step resolves against the **actual emitted
events and balances** (never optimistically).

## On-chain acceptance (live, Arc testnet)

The fences are exercised for real, with matching before/after deltas:

- **Approved `executeSpendFor`** — a real transfer, `spentToday` advances, `AgentActionApproved` +
  `ReceiptIssued` emitted, recipient's balance grows by exactly the amount.
- **Blocked over-cap call** — `AgentActionBlocked` with the exact reason, **no** `Transfer`, both
  balances unchanged, the block artifact is a permanent on-chain record.
- **Allowlist sync** — the DB ledger is reconciled against `getService`/`remainingServiceDailyCap`
  before the vault will pay a third-party service.

### Failure modes are treated as first-class

`success == false` is investigated, not shipped. Idempotency is respected throughout: `actionId` dedup
is on-chain, so retries can't double-spend; outcomes are read from emitted events and chain state, never
from optimistic client state.

See [security.md](./security.md) for what each of these guarantees, and [architecture.md](./architecture.md)
for the design under test.