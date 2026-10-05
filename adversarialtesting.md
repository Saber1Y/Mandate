# Adversarial testing

[← README](./README.md) · [Architecture](./architecture.md) · [Security](./security.md)

Every claim in [security.md](./security.md) is backed by a test or a live transaction.
The strategy runs from hermetic units up to live on-chain acceptance, deliberately trying to break
each fence and each assumption in it.

---

## Layers

| Layer | What it proves | Where |
|-------|----------------|-------|
| Unit + integration (Foundry) | Every policy branch, every safety revert, every authority boundary | `test/MandateVault.t.sol` (69), `test/MandateVaultFactory.t.sol` (14) |
| ABI freshness | The frontend cannot drift from the deployed interface | `web` → `npm run check:abi` |
| Type safety | No untyped contract surface reaches the UI | `web` → `npm run typecheck` |
| Live API QA | Auth, validation, and on-chain rejection through the real HTTP surface | `web/scripts/qa-agent.mjs` |
| On-chain acceptance | Full request → approval → settlement, with balance deltas | BOT Chain Bohr testnet, chain 968 |

**Solidity: 83 tests, 0 failing, 0 skipped.**

## Vault — the policy surface

`test/MandateVault.t.sol` isolates each blocked *reason* so ordering cannot mask a bug:

- **Settlement:** `test_ApprovedRequest_ExecutesAndMovesFunds`,
  `test_PendingRequest_CannotExecuteBeforeApproval`,
  `test_RejectedRequest_NeverSettlesAndIsTerminal`.
- **Caps, one revert per reason:** `test_Revert_ExceedsPerTx`, `test_Revert_ExceedsDailyCap`,
  `test_DailyCapResetsAfterWindow`, `test_Revert_ExpiredPolicy`, `test_Revert_ZeroAmount`,
  `test_Revert_TokenNotAllowlisted`, `test_Revert_UnregisteredAgentCannotRequest`.
- **Per-recipient budgets:** `test_RecipientPerTxCap`, `test_RecipientDailyCap`,
  `test_RecipientBudgetsArePerRecipient`, `test_RecipientCapNotRequiredForUnlimitedRecipient`,
  `test_RecipientWithoutDailyCapIsBoundedOnlyByAgentPolicy`,
  `test_RemoveRecipientAllowlist_BlocksFutureSpends`.
- **Multi-agent isolation on one treasury:** `test_AgentsHaveIsolatedBudgetsOnOneTreasury`,
  `test_NewAgentDefaultsToNoAllowance`,
  `test_OneRequestCannotBeFiledByAnotherAgentsKey`.
- **Approval integrity:** `test_RaisingThresholdAfterRequestBlocksUnapprovedSettlement`,
  `test_RaisingThresholdAboveRecordedApprovalsBlocksSettlement`,
  `test_LoweringThresholdDoesNotRetroactivelyApproveAPendingRequest`,
  `test_Revert_ApproverCannotApproveTwice`,
  `test_Revert_ApproveAfterExecution`,
  `test_ThresholdTwo_RequiresTwoDistinctApprovers`,
  `test_Revert_ApproveRejectedByZeroThresholdGuard`.
- **Approvals are not a free pass:** `test_ApprovalDoesNotSurvivePolicyRemoval` and
  `test_ApprovalCannotExceedCapsAddedAfterApproval` prove the caps are re-read at execution time, so
  tightening a leash after an approval still blocks the spend.
- **Expiry and cancellation:** `test_ExpiredRequest_CannotExecuteEvenAfterApproval`,
  `test_ExpiredRequest_CannotBeApprovedLate`, `test_ExpireRequestMarksTerminal`,
  `test_CancelAfterApproval_BlocksExecution`, `test_CancelByAgent`,
  `test_Revert_CannotCancelExecutedRequest`.
- **Idempotency:** `test_IdempotentReplayReturnsSameRequest`,
  `test_Revert_SameKeyDifferentAmountConflicts`, `test_Revert_SameKeyDifferentRecipientConflicts`,
  `test_ComputeRequestIdIsPureAndVaultScoped`, `test_Revert_DoubleExecuteSameRequest`.
- **Reentrancy:** `test_ReentrantExecute_CannotDoubleSpend` uses a malicious ERC20 that re-enters
  `execute` during its transfer; the `nonReentrant` guard fires and no double-spend occurs.
- **Arithmetic:** `test_LargeSpendIsNotTruncatedByNarrowingCast` guards the uint256 → uint128 casts
  in the budget path.
- **Pause scope:** `test_PauseBlocksNewRequestsAndExecution` and `test_PauseDoesNotLockOrgTreasury`
  prove pausing stops agent spend without trapping the org's own funds.
- **Auto-approval boundary:** `test_RequestAndExecute_WorksForZeroThresholdPolicy` and
  `test_AutoApprovedPolicy_ExecutesWithoutHuman`, with the factory suite proving a non-zero threshold
  cannot be short-circuited.

Each test asserts **events + state + balances**, not just a return value.

## Factory layer

`test/MandateVaultFactory.t.sol` proves the counterfactual: one vault per org
(`test_Revert_OneVaultPerOrg`), immutable deployer and executor
(`test_DeployerAndExecutorAreImmutable`), role wiring (`test_CreateVaultWiresRolesToOrg`),
full isolation between orgs (`test_OrgsGetFullyIsolatedVaults`,
`test_OrgACannotConfigureOrgBTreasury`), and the executor's authority ceiling —
`test_ExecutorCannotWithdrawOrgFunds`, `test_ExecutorCannotReconfigurePolicy`,
`test_ExecutorCannotApprove`. It closes with a full factory-to-settlement path
(`test_EndToEndApprovedSpendThroughFactory`) and confirms request ids are scoped per vault.

## ABI and build integrity

`npm run check:abi` regenerates `web/lib/abi/mandate.ts` from `src/` and fails if it differs, so a
frontend built against a stale interface cannot ship silently.
`npm run typecheck` covers the contract-facing TypeScript surface.

## Live API QA

`web/scripts/qa-agent.mjs` exercises the real HTTP surface a third-party agent uses, asserting HTTP
status **and** decoded contract error names - because the contract is the only authority, and a cache
agreeing with itself proves nothing:

- Auth: health responds unauthenticated; `/api/agents/me` requires a bearer key; a valid key returns
  the on-chain policy.
- Validation: non-address recipient, float amount, zero amount, malformed token, and missing
  idempotency key each return 400 with a specific message.
- On-chain policy: an over-cap amount reverts `InvalidPolicy`; an unallowlisted recipient reverts
  `NotAuthorized`. Neither is decided by the server.
- `--settle` creates a real request, proves `execute` reverts `RequestNotApproved` before approval,
  and prints the exact owner `approve` and agent `execute` commands.

Current run: **11 passed, 0 failed.**

## On-chain acceptance (live, BOT Chain Bohr testnet 968)

A separate agent address, a separate API key, and an owner-signed approval - with matching balance
deltas read from the token contract:

- **`requestSpend`** → `SpendRequested`, status `Pending`, request id
  `0x33b66135…`. Tx
  [`0xd5e65dfe…`](https://scan.bohr.life/tx/0xd5e65dfe63ea2fb3de758fdf81636ce52faa7d7186eba359344624fd3ae0ff5b)
- **Early execute** → reverts `RequestNotApproved`. No transfer.
- **Owner `approve`** → threshold of 1 reached, status `Approved`.
- **`execute`** → `RequestExecuted` + `ReceiptIssued`, status `Executed`. Tx
  [`0xd76b5c7b…`](https://scan.bohr.life/tx/0xd76b5c7bb9d1cb3a13dd00db26248c292f76606c45ed1be87bfefb643679d38a)
  Vault `-1,000,000` base units, recipient `+1,000,000`.
- **Double execute** → reverts `RequestFinalized`.
- **Over service cap** → reverts `InvalidPolicy`, nothing moves.
- **Credential lifecycle** → issue, rotate, and revoke all owner-signed; the replayed signature
  returned 409, an expired signature 401, and an action-mismatched payload 401; a revoked key returned
  403 on its next request.

### Failure modes are treated as first-class

A failing `success == false` is investigated, not shipped.
Two real bugs were found and fixed this way: the web `RequestStatus` enum was ordered differently
from the contract, so a settled request reported as `Rejected`; and malformed input escaped the request
handler as an empty HTTP 500.
Outcomes are read from chain state and emitted events, never from optimistic client state.

See [security.md](./security.md) for what each guarantee provides, and [architecture.md](./architecture.md)
for the design under test.