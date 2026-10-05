# Security model

[← README](./README.md) · [Architecture](./architecture.md) · [Adversarial Testing](./adversarialtesting.md)

Mandate's safety rests on two independent fences and a set of invariants that keep them independent.
This document states the guarantees, the deliberate tradeoffs, and the known limitations - honestly.

---

## Guarantees

1. **The server cannot authorize a spend.** `EXECUTOR_PRIVATE_KEY` may relay exactly two calls:
   `requestSpend` and `execute`. It cannot approve, cannot change policy, cannot allowlist a
   recipient, cannot withdraw, and cannot pause. Approval requires the organization wallet's
   signature on-chain.
2. **Value only moves inside policy.** `MandateVault._execute` checks request status, approval
   threshold, agent activity and expiry, token allowlist, per-service allowlist (label, per-tx cap,
   daily cap, expiry), global per-tx cap, and rolling daily cap **before** the transfer
   (checks-effects-interactions).
3. **Every decision is on-chain.** `SpendRequested`, `RequestApproved`, `RequestRejected`,
   `RequestCancelled`, `RequestExpired`, `RequestExecuted`, and `ReceiptIssued` reconstruct the full
   history from logs. The server resolves outcomes by reading the chain, never optimistically.
4. **Retries cannot double-spend.** `requestId` derives from `idempotencyKey`. The same key with the
   same parameters returns the same request; with different parameters it reverts
   `IdempotencyConflict`. A terminal request cannot be re-executed (`RequestFinalized`).
5. **A leaked agent key cannot drain the vault.** The key only proposes spends. Each one still passes
   the on-chain leash and still needs `approvalThreshold` human approvals.
6. **A compromised server cannot widen policy.** All policy setters are `onlyOwner`.

## Reverts, not silent failures

Policy violations **revert with a named custom error** (`InvalidPolicy`, `NotAuthorized`,
`TokenNotAllowed`, `RequestNotApproved`, `RequestFinalized`, `IdempotencyConflict`, `DeadlinePassed`).
This differs from a log-and-return-false design, and it is deliberate here: the request lifecycle has
explicit terminal states, so a rejected request is an error the caller must handle, not a value to
inspect.
The tradeoff is that the rejection leaves no event - the permanence of a blocked attempt comes from
the fact that it never entered a request at all, and the revert reason is available to the caller.
Genuine safety failures use the same mechanism: `NotOwner`, `NotAuthorized`, `Reentrancy`,
`NativeTransferFailed`.

## Contract-layer safety

- **Reentrancy:** a hand-rolled `nonReentrant` guard on every state-changing entry point. Budget
  consumption (`spentToday`) is written **before** the external transfer, so a malicious token that
  re-enters hits the guard and the nested call reverts.
- **CEI:** effects precede interactions; a failed transfer reverts the whole call, so nothing settles
  partially.
- **Owner controls:** `setAgent`, `setApprover`, `setExecutor`, `setAgentPolicy`, `setAllowedService`,
  `setAllowedToken`, `setPaused`, and `withdrawToken` are all `onlyOwner`.
- **Per-service caps are validated:** `setAllowedService` requires
  `dailyCap == 0 || maxPerTx <= dailyCap`, and the constructor requires `maxPerTx <= dailyCap`.
- **Auto-approval cannot be smuggled:** `requestAndExecute` reverts `InvalidApproval` whenever the
  agent's `approvalThreshold != 0`.
- **Approval integrity:** approvals are recorded per address, so one approver cannot satisfy a
  threshold of two, and `AlreadyApproved` blocks double counting.

## Server-side defenses

- **Bearer keys are stored as `sha256` hashes.** The plaintext exists exactly once, in the response
  that mints it. There is no read-back path, and key material is never logged.
- **One active key per agent address.** `issue` fails closed when a live key exists; `rotate` revokes
  first, and `revoke` is immediate - a revoked key returns HTTP 403 on its very next request.
- **Credential mutations require an owner signature** over a canonical payload binding action, agent
  id, agent address, chain id, vault, timestamp, and nonce. The server verifies against the **live
  on-chain owner**, not a cached address, and confirms the agent is registered in the vault.
- **Authorization nonces are single-use.** A consumed `sha256(nonce:action:agentId)` is recorded, so a
  captured signature returns HTTP 409 instead of rotating the key the owner just issued.
- **The agent address comes from the credential, never the request body**, so one agent cannot request
  against another agent's policy.
- **No policy mirror.** The server holds no balances, caps, or allowlists. Every displayed number is
  read from the vault, so a stale server can fail to relay but cannot authorize.

## Key management

- `EXECUTOR_PRIVATE_KEY` is read only in server code (`web/lib/relayer.ts`). It is never
  `NEXT_PUBLIC_`, never shipped to the client, and never committed.
- Owner-signed actions go through Privy and `viem` in the browser; the private key never leaves the
  wallet.
- `web/.env.local`, `web/data/`, and Foundry `cache/` are gitignored. Test material lives under
  `/tmp`, outside the repository.
- The relayer re-checks `executors[executorKey]` on-chain before relaying, so a revoked executor is
  reported as a configuration error instead of burning gas on a revert.

## Known limitations (stated plainly)

1. **The testnet deployment uses one EOA as both owner and executor.** That collapses the two-fence
   separation: a compromise of that single key yields both relay and policy authority. Production must
   use an organization smart account or multisig as owner and a **distinct** gas-only executor, and the
   app must verify Privy's actual controlling address matches the on-chain owner.
2. **A single executor key is a single point of failure.** The intended hardening is threshold signing
   or a multisig operator, plus a timelock on policy changes so a live policy cannot be silently
   weakened in one transaction.
3. **Approvals are off-chain-owner-signed but on-chain-recorded.** A compromised owner wallet can
   approve anything inside policy. That is the intended trust model: the organization is the authority.
4. **Daily caps roll on a wall-clock window**, not a sliding one. An agent can spend near the cap at the
   end of one window and again at the start of the next.
5. **Marketplace-style `transferFrom` settlement is unproven.** Settlement today is a direct
   `safeTransfer` from the vault, so an external protocol cannot pull funds with an allowance.
6. **No rate limiting on the API.** Brute-forcing a `mdt_` key is impractical at 256 bits of entropy,
   but the deployment should sit behind a WAF or rate limiter in production.

## Responsible disclosure

The live deployment is a testnet vault holding test tokens only - no real funds are at risk.
Issues can be raised on the repository.