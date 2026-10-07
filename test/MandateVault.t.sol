// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {MockUSD} from "../src/MockUSD.sol";

/// @dev Recipient that re-enters `execute` while the vault is mid-transfer, to prove the
///      request cannot be settled twice.
contract ReentrantTarget {
    MandateVault public immutable vault;
    address public immutable token;
    bool public armed;
    bool public reentrySucceeded;

    constructor(MandateVault _vault, address _token) {
        vault = _vault;
        token = _token;
    }

    function arm() external {
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        try vault.execute(0) {
            reentrySucceeded = true;
        } catch {
            reentrySucceeded = false;
        }
    }

    function balance() external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}

contract MandateVaultTest is Test {
    MandateVault vault;
    MockUSD usdt;

    address org = makeAddr("org");
    address executor = makeAddr("executor");
    address agent = makeAddr("agent");
    address agent2 = makeAddr("agent2");
    address recipient = makeAddr("recipient");
    address approverA = makeAddr("approverA");
    address approverB = makeAddr("approverB");
    address stranger = makeAddr("stranger");

    uint256 constant MAX_TX = 100e6;
    uint256 constant DAILY = 500e6;
    uint256 constant START = 1_700_000_000;

    function setUp() public {
        vm.warp(START);
        usdt = new MockUSD();
        vm.prank(org);
        vault = new MandateVault(org, executor, address(usdt), 0, 0, 0, 0);
        usdt.mint(address(vault), 10_000e6);

        vm.startPrank(org);
        vault.setAgent(agent, true);
        vault.setAgent(agent2, true);
        vault.setApprover(approverA, true);
        vault.setApprover(approverB, true);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 1, true);
        vault.setAgentPolicy(agent2, MAX_TX, DAILY, 0, 1, true);
        vault.setAllowedToken(agent, address(usdt), true);
        vault.setAllowedToken(agent2, address(usdt), true);
        vault.setAllowedService(agent, recipient, "vendor", 0, 0, 0, true);
        vault.setAllowedService(agent2, recipient, "vendor", 0, 0, 0, true);
        vm.stopPrank();
    }

    function test_ConstructorWiresSettlementToken() public {
        assertEq(vault.settlementToken(), address(usdt));
        assertTrue(vault.allowedTokens(org, address(usdt)), "first agent spends tUSDT with no allow step");
    }

    // ------------------------------------------------------------------ helpers

    function request(address caller, address who, address to, uint256 amount, bytes32 key) internal returns (bytes32) {
        vm.prank(caller);
        return vault.requestSpend(who, address(usdt), to, amount, key, 0);
    }

    function requestToken(address caller, address who, address token, address to, uint256 amount, bytes32 key)
        internal
        returns (bytes32)
    {
        vm.prank(caller);
        return vault.requestSpend(who, token, to, amount, key, 0);
    }

    function approve(address approver, bytes32 id) internal {
        vm.prank(approver);
        vault.approve(id);
    }

    function execute(address caller, bytes32 id) internal {
        vm.prank(caller);
        vault.execute(id);
    }

    // ------------------------------------------------------- construction / roles

    function test_OrgIsFirstAgentAndExecutorPreAuthorized() public {
        assertEq(vault.owner(), org, "owner");
        assertTrue(vault.agents(org), "org registered as agent");
        assertTrue(vault.executors(executor), "executor preauthorized");
        assertFalse(vault.executors(stranger), "stranger not executor");
    }

    function test_Revert_OnlyOwnerConfiguresRoles() public {
        vm.startPrank(stranger);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.setAgent(stranger, true);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.setApprover(stranger, true);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.setExecutor(stranger, true);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.setAgentPolicy(agent, 1, 1, 0, 0, true);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.setAllowedService(agent, stranger, "x", 0, 0, 0, true);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.setAllowedToken(agent, address(usdt), true);
        vm.stopPrank();
    }

    function test_NewAgentDefaultsToNoAllowance() public {
        address fresh = makeAddr("fresh");
        vm.prank(org);
        vault.setAgent(fresh, true);

        vm.prank(fresh);
        vm.expectRevert(MandateVault.NotRegistered.selector);
        vault.requestSpend(fresh, address(usdt), recipient, 1e6, keccak256("fresh"), 0);

        assertEq(vault.remainingDailyCap(fresh), 0, "fresh agent cannot spend");
    }

    // ------------------------------------------------------------- approval gate

    function test_PendingRequest_CannotExecuteBeforeApproval() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));

        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Pending));

        vm.prank(executor);
        vm.expectRevert(MandateVault.RequestNotApproved.selector);
        vault.execute(id);

        assertEq(usdt.balanceOf(recipient), 0, "no funds moved");
    }

    function test_ApprovedRequest_ExecutesAndMovesFunds() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);

        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Approved));
        assertTrue(vault.hasApproved(id, approverA), "approval recorded");

        execute(executor, id);

        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Executed));
        assertEq(usdt.balanceOf(recipient), 10e6, "recipient paid");
        assertEq(vault.getPolicy(agent).spentToday, 10e6, "budget charged once");
    }

    function test_ThresholdTwo_RequiresTwoDistinctApprovers() public {
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 2, true);

        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);

        assertEq(
            uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Pending), "still pending after one"
        );

        vm.prank(executor);
        vm.expectRevert(MandateVault.RequestNotApproved.selector);
        vault.execute(id);

        approve(approverB, id);
        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Approved));

        execute(executor, id);
        assertEq(usdt.balanceOf(recipient), 10e6, "paid after second approval");
    }

    function test_Revert_ApproverCannotApproveTwice() public {
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 2, true);

        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);
        vm.prank(approverA);
        vm.expectRevert(MandateVault.AlreadyApproved.selector);
        vault.approve(id);
    }

    function test_Revert_NonApproverCannotApprove() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));

        vm.prank(stranger);
        vm.expectRevert(MandateVault.NotApprover.selector);
        vault.approve(id);

        vm.prank(agent);
        vm.expectRevert(MandateVault.NotApprover.selector);
        vault.approve(id);
    }

    function test_OrgOwnerMayApprove() public {
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 1, true);
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        vm.prank(org);
        vault.approve(id);
        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Approved));
    }

    function test_Revert_ApproveUnknownRequest() public {
        vm.prank(approverA);
        vm.expectRevert(MandateVault.UnknownRequest.selector);
        vault.approve(keccak256("nope"));
    }

    function test_Revert_ApproveAfterExecution() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);
        execute(executor, id);

        vm.prank(approverB);
        vm.expectRevert(MandateVault.RequestFinalized.selector);
        vault.approve(id);
    }

    // -------------------------------------------- auto-approval cannot be bypassed

    function test_AutoApprovedPolicy_ExecutesWithoutHuman() public {
        vm.prank(org);
        vault.setAgentPolicy(agent2, MAX_TX, DAILY, 0, 0, true);

        bytes32 id = request(agent2, agent2, recipient, 10e6, keccak256("auto"));
        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Approved), "auto-approved");

        execute(executor, id);
        assertEq(usdt.balanceOf(recipient), 10e6);
    }

    function test_Revert_RequestAndExecuteBlockedWhenApprovalRequired() public {
        // agent has threshold 1, so the one-shot path must be refused outright.
        vm.prank(agent);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.requestAndExecute(agent, address(usdt), recipient, 10e6, keccak256("sneaky"), 0);

        assertEq(usdt.balanceOf(recipient), 0, "no funds moved");
        assertEq(
            uint8(vault.getRequestStatus(vault.computeRequestId(keccak256("sneaky")))),
            uint8(MandateVault.RequestStatus.None)
        );
    }

    function test_RaisingThresholdAfterRequestBlocksUnapprovedSettlement() public {
        vm.prank(org);
        vault.setAgentPolicy(agent2, MAX_TX, DAILY, 0, 0, true);

        // Filed under a threshold of 0, so it auto-approved on arrival.
        bytes32 id = request(agent2, agent2, recipient, 10e6, keccak256("racy"));
        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Approved));
        assertTrue(vault.isExecutable(id));

        // The org now requires a human signature.
        vm.prank(org);
        vault.setAgentPolicy(agent2, MAX_TX, DAILY, 0, 1, true);

        assertFalse(vault.isExecutable(id), "no longer executable under the tightened policy");
        vm.prank(executor);
        vm.expectRevert(MandateVault.RequestNotApproved.selector);
        vault.execute(id);

        assertEq(usdt.balanceOf(recipient), 0, "tightened policy binds the in-flight request");
    }

    function test_RaisingThresholdAboveRecordedApprovalsBlocksSettlement() public {
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 1, true);

        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("partial"));
        approve(approverA, id);
        assertTrue(vault.isExecutable(id));

        // Two signatures are now required, but only one was ever collected.
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 2, true);

        assertFalse(vault.isExecutable(id));
        vm.prank(executor);
        vm.expectRevert(MandateVault.RequestNotApproved.selector);
        vault.execute(id);
    }

    function test_LoweringThresholdDoesNotRetroactivelyApproveAPendingRequest() public {
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 2, true);

        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("relaxed"));
        approve(approverA, id);
        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Pending));

        // Relaxing the threshold does not rewrite history: the request is still Pending, so the
        // status machine must not treat it as executable.
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 1, true);
        assertFalse(vault.isExecutable(id));

        vm.prank(executor);
        vm.expectRevert(MandateVault.RequestNotApproved.selector);
        vault.execute(id);

        // The recovery path is an explicit cancel and refile, which is auditable on-chain.
        vm.prank(org);
        vault.cancel(id);
        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Cancelled));

        bytes32 refiled = request(agent, agent, recipient, 10e6, keccak256("relaxed-2"));
        assertEq(uint8(vault.getRequestStatus(refiled)), uint8(MandateVault.RequestStatus.Pending));
        approve(approverA, refiled);
        execute(executor, refiled);
        assertEq(usdt.balanceOf(recipient), 10e6);
    }

    function test_RequestAndExecute_WorksForZeroThresholdPolicy() public {
        vm.prank(org);
        vault.setAgentPolicy(agent2, MAX_TX, DAILY, 0, 0, true);

        vm.prank(agent2);
        bytes32 id = vault.requestAndExecute(agent2, address(usdt), recipient, 5e6, keccak256("onecall"), 0);

        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Executed));
        assertEq(usdt.balanceOf(recipient), 5e6);
        assertEq(vault.getPolicy(agent2).spentToday, 5e6);
    }

    function test_Revert_ApproveRejectedByZeroThresholdGuard() public {
        bytes32 id = request(agent, agent, recipient, 1e6, keccak256("pending"));

        // Org drops the threshold to 0 after the request was filed, so the request is still
        // Pending while the policy no longer admits a human approval.
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 0, true);

        vm.prank(approverA);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.approve(id);
    }

    // --------------------------------------------------------------- rejection

    function test_RejectedRequest_NeverSettlesAndIsTerminal() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));

        vm.prank(approverA);
        vault.reject(id, "not authorized vendor");

        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Rejected));

        vm.prank(executor);
        vm.expectRevert(MandateVault.RequestNotApproved.selector);
        vault.execute(id);

        vm.prank(approverB);
        vm.expectRevert(MandateVault.RequestFinalized.selector);
        vault.approve(id);

        vm.prank(approverB);
        vm.expectRevert(MandateVault.RequestFinalized.selector);
        vault.reject(id, "still rejected");

        assertEq(usdt.balanceOf(recipient), 0, "no transaction for a rejected payment");
    }

    function test_Revert_NonApproverCannotReject() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        vm.prank(agent);
        vm.expectRevert(MandateVault.NotApprover.selector);
        vault.reject(id, "i changed my mind");
    }

    function test_CancelByAgent() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        vm.prank(agent);
        vault.cancel(id);
        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Cancelled));

        vm.prank(approverA);
        vm.expectRevert(MandateVault.RequestFinalized.selector);
        vault.approve(id);

        vm.prank(executor);
        vm.expectRevert(MandateVault.RequestNotApproved.selector);
        vault.execute(id);
    }

    function test_CancelAfterApproval_BlocksExecution() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);
        vm.prank(org);
        vault.cancel(id);

        vm.prank(executor);
        vm.expectRevert(MandateVault.RequestNotApproved.selector);
        vault.execute(id);
        assertEq(usdt.balanceOf(recipient), 0);
    }

    function test_Revert_CannotCancelExecutedRequest() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);
        execute(executor, id);

        vm.prank(agent);
        vm.expectRevert(MandateVault.RequestFinalized.selector);
        vault.cancel(id);
    }

    // ------------------------------------------------------------------ expiry

    function test_ExpiredRequest_CannotExecuteEvenAfterApproval() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);

        vm.warp(START + 1 days + 1);

        vm.prank(executor);
        vm.expectRevert(MandateVault.DeadlinePassed.selector);
        vault.execute(id);

        assertFalse(vault.isExecutable(id), "lapsed deadline is not executable");
        assertEq(usdt.balanceOf(recipient), 0, "funds never moved");
    }

    function test_ExpiredRequest_CannotBeApprovedLate() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));

        vm.warp(START + 1 days + 1);

        vm.prank(approverA);
        vm.expectRevert(MandateVault.DeadlinePassed.selector);
        vault.approve(id);
    }

    function test_ExpireRequestMarksTerminal() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        vm.warp(START + 1 days + 1);

        vm.prank(executor);
        vault.expireRequest(id);
        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Expired));

        // A fresh key lets the agent retry.
        bytes32 retry = request(agent, agent, recipient, 10e6, keccak256("k2"));
        assertEq(uint8(vault.getRequestStatus(retry)), uint8(MandateVault.RequestStatus.Pending));
    }

    function test_Revert_ExpireBeforeDeadline() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        vm.prank(executor);
        vm.expectRevert(MandateVault.InvalidPolicy.selector);
        vault.expireRequest(id);
    }

    function test_Revert_RequestWithPastDeadline() public {
        vm.prank(agent);
        vm.expectRevert(MandateVault.DeadlinePassed.selector);
        vault.requestSpend(agent, address(usdt), recipient, 1e6, keccak256("past"), uint64(START - 1));
    }

    // ------------------------------------------------------------ idempotency

    function test_IdempotentReplayReturnsSameRequest() public {
        bytes32 id1 = request(agent, agent, recipient, 10e6, keccak256("same"));
        bytes32 id2 = request(agent, agent, recipient, 10e6, keccak256("same"));

        assertEq(id1, id2, "same request id");
        assertEq(vault.getRequest(id1).amount, 10e6);
        assertEq(uint8(vault.getRequestStatus(id1)), uint8(MandateVault.RequestStatus.Pending));
    }

    function test_Revert_SameKeyDifferentAmountConflicts() public {
        request(agent, agent, recipient, 10e6, keccak256("same"));
        vm.prank(agent);
        vm.expectRevert(MandateVault.IdempotencyConflict.selector);
        vault.requestSpend(agent, address(usdt), recipient, 99e6, keccak256("same"), 0);
    }

    function test_Revert_SameKeyDifferentRecipientConflicts() public {
        request(agent, agent, recipient, 10e6, keccak256("same"));
        vm.prank(agent);
        vm.expectRevert(MandateVault.IdempotencyConflict.selector);
        vault.requestSpend(agent, address(usdt), stranger, 10e6, keccak256("same"), 0);
    }

    function test_Revert_DoubleExecuteSameRequest() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);
        execute(executor, id);

        vm.prank(executor);
        vm.expectRevert(MandateVault.RequestFinalized.selector);
        vault.execute(id);

        assertEq(usdt.balanceOf(recipient), 10e6, "paid exactly once");
        assertEq(vault.getPolicy(agent).spentToday, 10e6, "charged exactly once");
    }

    // ------------------------------------------------------------------ policy

    function test_Revert_ZeroAmount() public {
        vm.prank(agent);
        vm.expectRevert(MandateVault.ZeroAmount.selector);
        vault.requestSpend(agent, address(usdt), recipient, 0, keccak256("zero"), 0);
    }

    function test_Revert_ExceedsPerTx() public {
        vm.prank(agent);
        vm.expectRevert(MandateVault.InvalidPolicy.selector);
        vault.requestSpend(agent, address(usdt), recipient, MAX_TX + 1, keccak256("big"), 0);
    }

    function test_Revert_ExceedsDailyCap() public {
        vm.prank(org);
        vault.setAllowedService(agent, recipient, "vendor", 0, 0, 0, true);

        // Drain the daily cap in five per-tx-limit requests.
        for (uint256 i = 0; i < 5; i++) {
            bytes32 id = request(agent, agent, recipient, MAX_TX, keccak256(abi.encode("fill", i)));
            approve(approverA, id);
            execute(executor, id);
        }
        assertEq(usdt.balanceOf(recipient), 5 * MAX_TX);
        assertEq(vault.remainingDailyCap(agent), 0, "cap exhausted");

        vm.prank(agent);
        vm.expectRevert(MandateVault.InvalidPolicy.selector);
        vault.requestSpend(agent, address(usdt), recipient, 1e6, keccak256("over"), 0);
    }

    function test_DailyCapResetsAfterWindow() public {
        bytes32 id = request(agent, agent, recipient, 100e6, keccak256("k1"));
        approve(approverA, id);
        execute(executor, id);
        assertEq(vault.remainingDailyCap(agent), DAILY - 100e6);

        vm.warp(START + 1 days + 1);
        assertEq(vault.remainingDailyCap(agent), DAILY, "window rolled");

        bytes32 id2 = request(agent, agent, recipient, 100e6, keccak256("k2"));
        approve(approverA, id2);
        execute(executor, id2);

        assertEq(vault.getPolicy(agent).spentToday, 100e6, "counter reset before recharge");
        assertEq(usdt.balanceOf(recipient), 200e6);
    }

    function test_Revert_ExpiredPolicy() public {
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, uint64(START + 100), 1, true);

        vm.warp(START + 101);
        vm.prank(agent);
        vm.expectRevert(MandateVault.DeadlinePassed.selector);
        vault.requestSpend(agent, address(usdt), recipient, 1e6, keccak256("expired"), 0);
    }

    function test_Revert_InactivePolicy() public {
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 1, false);

        vm.prank(agent);
        vm.expectRevert(MandateVault.NotRegistered.selector);
        vault.requestSpend(agent, address(usdt), recipient, 1e6, keccak256("inactive"), 0);
    }

    function test_Revert_UnregisteredAgentCannotRequest() public {
        address rogue = makeAddr("rogue");
        vm.prank(rogue);
        vm.expectRevert(MandateVault.NotRegistered.selector);
        vault.requestSpend(rogue, address(usdt), recipient, 1e6, keccak256("rogue"), 0);
    }

    function test_Revert_TokenNotAllowlisted() public {
        MockUSD other = new MockUSD();
        vm.prank(agent);
        vm.expectRevert(MandateVault.NotAuthorized.selector);
        vault.requestSpend(agent, address(other), recipient, 1e6, keccak256("tok"), 0);
    }

    function test_Revert_RecipientNotAllowlisted() public {
        vm.prank(agent);
        vm.expectRevert(MandateVault.NotAuthorized.selector);
        vault.requestSpend(agent, address(usdt), stranger, 1e6, keccak256("rec"), 0);
    }

    function test_RemoveRecipientAllowlist_BlocksFutureSpends() public {
        vm.prank(org);
        vault.setAllowedService(agent, recipient, "vendor", 0, 0, 0, false);

        vm.prank(agent);
        vm.expectRevert(MandateVault.NotAuthorized.selector);
        vault.requestSpend(agent, address(usdt), recipient, 1e6, keccak256("gone"), 0);
    }

    function test_ApprovalDoesNotSurvivePolicyRemoval() public {
        // Approve first, then have the org revoke the agent before execution.
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);

        vm.prank(org);
        vault.setAllowedService(agent, recipient, "vendor", 0, 0, 0, false);

        vm.prank(executor);
        vm.expectRevert(MandateVault.NotAuthorized.selector);
        vault.execute(id);

        assertEq(usdt.balanceOf(recipient), 0, "stale approval cannot settle a de-allowlisted recipient");
    }

    function test_ApprovalCannotExceedCapsAddedAfterApproval() public {
        bytes32 id = request(agent, agent, recipient, 60e6, keccak256("k1"));
        approve(approverA, id);

        // Org tightens the leash between approval and execution.
        vm.prank(org);
        vault.setAgentPolicy(agent, 10e6, DAILY, 0, 1, true);

        vm.prank(executor);
        vm.expectRevert(MandateVault.InvalidPolicy.selector);
        vault.execute(id);
        assertEq(usdt.balanceOf(recipient), 0);
    }

    // ------------------------------------------------------- recipient budgets

    function test_RecipientPerTxCap() public {
        vm.prank(org);
        vault.setAllowedService(agent, recipient, "vendor", 20e6, 0, 0, true);

        vm.prank(agent);
        vm.expectRevert(MandateVault.InvalidPolicy.selector);
        vault.requestSpend(agent, address(usdt), recipient, 21e6, keccak256("over"), 0);

        bytes32 id = request(agent, agent, recipient, 20e6, keccak256("ok"));
        approve(approverA, id);
        execute(executor, id);
        assertEq(usdt.balanceOf(recipient), 20e6);
    }

    function test_RecipientDailyCap() public {
        vm.prank(org);
        vault.setAllowedService(agent, recipient, "vendor", 30e6, 50e6, 0, true);

        bytes32 first = request(agent, agent, recipient, 30e6, keccak256("fill0"));
        approve(approverA, first);
        execute(executor, first);
        assertEq(vault.remainingRecipientDailyCap(agent, recipient), 20e6);

        // 30 + 30 would cross the 50 recipient cap, so it is refused at request time.
        vm.prank(agent);
        vm.expectRevert(MandateVault.InvalidPolicy.selector);
        vault.requestSpend(agent, address(usdt), recipient, 30e6, keccak256("fill1"), 0);

        // A request that fits the remaining recipient budget still settles.
        bytes32 fits = request(agent, agent, recipient, 20e6, keccak256("fill2"));
        approve(approverA, fits);
        execute(executor, fits);
        assertEq(vault.remainingRecipientDailyCap(agent, recipient), 0, "recipient cap exhausted");
        assertEq(usdt.balanceOf(recipient), 50e6);
    }

    function test_RecipientWithoutDailyCapIsBoundedOnlyByAgentPolicy() public {
        vm.prank(org);
        vault.setAllowedService(agent, recipient, "vendor", 20e6, 0, 0, true);
        assertEq(vault.remainingRecipientDailyCap(agent, recipient), type(uint256).max, "no recipient daily ceiling");

        // The recipient has no daily cap, so only the agent's global 500 daily cap applies.
        for (uint256 i = 0; i < 5; i++) {
            bytes32 id = request(agent, agent, recipient, 20e6, keccak256(abi.encode("fill", i)));
            approve(approverA, id);
            execute(executor, id);
        }
        assertEq(usdt.balanceOf(recipient), 100e6);
        assertEq(vault.remainingDailyCap(agent), DAILY - 100e6);
    }

    function test_RecipientBudgetsArePerRecipient() public {
        address other = makeAddr("other");
        vm.startPrank(org);
        vault.setAllowedService(agent, recipient, "vendor", 30e6, 50e6, 0, true);
        vault.setAllowedService(agent, other, "other", 30e6, 50e6, 0, true);
        vm.stopPrank();

        bytes32 id = request(agent, agent, recipient, 30e6, keccak256("a"));
        approve(approverA, id);
        execute(executor, id);

        assertEq(vault.remainingRecipientDailyCap(agent, recipient), 20e6);
        assertEq(vault.remainingRecipientDailyCap(agent, other), 50e6, "other recipient untouched");
    }

    function test_Revert_RecipientCapsInconsistent() public {
        vm.prank(org);
        vm.expectRevert(MandateVault.InvalidPolicy.selector);
        vault.setAllowedService(agent, recipient, "vendor", 60e6, 10e6, 0, true);
    }

    function test_Revert_ExpiredRecipientAllowlist() public {
        vm.prank(org);
        vault.setAllowedService(agent, recipient, "vendor", 0, 0, uint64(START + 100), true);

        vm.warp(START + 101);
        vm.prank(agent);
        vm.expectRevert(MandateVault.DeadlinePassed.selector);
        vault.requestSpend(agent, address(usdt), recipient, 1e6, keccak256("exp"), 0);
    }

    function test_RecipientCapNotRequiredForUnlimitedRecipient() public {
        assertEq(vault.remainingRecipientDailyCap(agent, recipient), type(uint256).max, "uncapped recipient");
        assertEq(vault.remainingRecipientDailyCap(agent, stranger), 0, "not allowed recipient");
    }

    // ---------------------------------------------------------- balance / funding

    function test_Revert_InsufficientVaultBalance() public {
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, 50_000e6, 0, 1, true);

        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);

        // Drain the treasury below the request amount.
        vm.prank(org);
        vault.withdrawToken(address(usdt), org, 10_000e6);

        vm.prank(executor);
        vm.expectRevert(MandateVault.InsufficientBalance.selector);
        vault.execute(id);
    }

    function test_DepositPullsTokens() public {
        vm.prank(org);
        usdt.mint(org, 500e6);
        vm.prank(org);
        usdt.approve(address(vault), 500e6);
        vm.prank(org);
        vault.deposit(address(usdt), 500e6);

        assertEq(usdt.balanceOf(address(vault)), 10_500e6);
    }

    function test_NativeSpendPath() public {
        address payable payee = payable(makeAddr("payee"));
        vm.deal(address(vault), 1 ether);

        vm.startPrank(org);
        vault.setAgentPolicy(agent, 1 ether, 1 ether, 0, 1, true);
        vault.setAllowedToken(agent, vault.NATIVE(), true);
        vault.setAllowedService(agent, payee, "native-target", 0, 0, 0, true);
        vm.stopPrank();

        bytes32 id = requestToken(agent, agent, vault.NATIVE(), payee, 0.5 ether, keccak256("native"));
        approve(approverA, id);
        execute(executor, id);

        assertEq(payee.balance, 0.5 ether, "native moved");
        assertEq(address(vault).balance, 0.5 ether, "vault debited");
        assertEq(vault.getPolicy(agent).spentToday, 0.5 ether);
    }

    function test_LargeSpendIsNotTruncatedByNarrowingCast() public {
        // A per-tx cap far above 2^128 must not truncate the running total.
        uint256 huge = 1e30;
        vm.deal(address(vault), huge * 3);

        vm.startPrank(org);
        vault.setAgentPolicy(agent, huge, huge * 2, 0, 1, true);
        vault.setAllowedToken(agent, vault.NATIVE(), true);
        vault.setAllowedService(agent, address(vault), "native-target", 0, 0, 0, true);
        vm.stopPrank();

        bytes32 id = requestToken(agent, agent, vault.NATIVE(), address(vault), huge, keccak256("huge"));
        approve(approverA, id);
        execute(executor, id);

        assertEq(vault.getPolicy(agent).spentToday, huge, "full precision retained");
        assertEq(vault.remainingDailyCap(agent), huge);
    }

    // ---------------------------------------------------------------- custody

    function test_Revert_OnlyOwnerWithdraws() public {
        vm.startPrank(agent);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.withdrawToken(address(usdt), agent, 1e6);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.withdrawToken(address(usdt), agent, 1e6);
        vm.stopPrank();

        vm.prank(approverA);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.withdrawToken(address(usdt), approverA, 1e6);

        vm.prank(executor);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.withdrawToken(address(usdt), executor, 1e6);
    }

    function test_OwnerWithdraws() public {
        vm.prank(org);
        vault.withdrawToken(address(usdt), org, 1_000e6);
        assertEq(usdt.balanceOf(org), 1_000e6);
    }

    function test_Revert_StrangerCannotExecute() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);

        vm.prank(stranger);
        vm.expectRevert(MandateVault.NotAuthorized.selector);
        vault.execute(id);
    }

    function test_AgentMayExecuteItsOwnApprovedRequest() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);
        execute(agent, id);
        assertEq(usdt.balanceOf(recipient), 10e6);
    }

    function test_RevokedExecutorCannotExecute() public {
        vm.prank(org);
        vault.setExecutor(executor, false);

        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);

        vm.prank(executor);
        vm.expectRevert(MandateVault.NotAuthorized.selector);
        vault.execute(id);
    }

    function test_DeregisteredAgentCannotExecute() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);

        vm.prank(org);
        vault.setAgent(agent, false);

        vm.prank(agent);
        vm.expectRevert(MandateVault.NotAuthorized.selector);
        vault.execute(id);
    }

    // ------------------------------------------------------------------- pause

    function test_PauseBlocksNewRequestsAndExecution() public {
        bytes32 id = request(agent, agent, recipient, 1e6, keccak256("k1"));
        approve(approverA, id);

        vm.prank(org);
        vault.setPaused(true);

        vm.prank(agent);
        vm.expectRevert(MandateVault.Paused.selector);
        vault.requestSpend(agent, address(usdt), recipient, 1e6, keccak256("k2"), 0);

        vm.prank(executor);
        vm.expectRevert(MandateVault.Paused.selector);
        vault.execute(id);

        assertEq(usdt.balanceOf(recipient), 0, "paused execution moved no funds");

        // Unpausing releases the already-approved request without needing a new approval.
        vm.prank(org);
        vault.setPaused(false);
        execute(executor, id);
        assertEq(usdt.balanceOf(recipient), 1e6);
    }

    function test_PauseDoesNotLockOrgTreasury() public {
        vm.prank(org);
        vault.setPaused(true);
        vm.prank(org);
        vault.withdrawToken(address(usdt), org, 1_000e6);
        assertEq(usdt.balanceOf(org), 1_000e6, "org keeps treasury access while paused");
    }

    // -------------------------------------------------------------- reentrancy

    function test_ReentrantExecute_CannotDoubleSpend() public {
        ReentrantTarget attacker = new ReentrantTarget(vault, address(usdt));
        vm.deal(address(attacker), 0);

        vm.startPrank(org);
        vault.setExecutor(address(attacker), true);
        vault.setAllowedService(agent, address(attacker), "attacker", 0, 0, 0, true);
        vm.stopPrank();

        bytes32 id = request(agent, agent, address(attacker), 10e6, keccak256("reent"));
        approve(approverA, id);
        attacker.arm();

        execute(executor, id);

        assertFalse(attacker.reentrySucceeded(), "re-entrant execute rejected");
        assertEq(attacker.balance(), 10e6, "paid exactly once");
        assertEq(vault.getPolicy(agent).spentToday, 10e6, "charged exactly once");
        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Executed));
    }

    // -------------------------------------------------------------- multi-agent

    function test_AgentsHaveIsolatedBudgetsOnOneTreasury() public {
        bytes32 a = request(agent, agent, recipient, 100e6, keccak256("a"));
        approve(approverA, a);
        execute(executor, a);

        assertEq(vault.getPolicy(agent).spentToday, 100e6);
        assertEq(vault.getPolicy(agent2).spentToday, 0, "agent2 unaffected");

        // agent2 still has its own full allowance
        assertEq(vault.remainingDailyCap(agent2), DAILY);
        bytes32 b = request(agent2, agent2, recipient, 100e6, keccak256("b"));
        approve(approverA, b);
        execute(executor, b);
        assertEq(usdt.balanceOf(recipient), 200e6);
    }

    function test_OneRequestCannotBeFiledByAnotherAgentsKey() public {
        vm.prank(agent2);
        vm.expectRevert(MandateVault.NotAuthorized.selector);
        vault.requestSpend(agent, address(usdt), recipient, 1e6, keccak256("spoof"), 0);
    }

    function test_ExecutorMayFileOnBehalfOfAgent() public {
        bytes32 id = request(executor, agent, recipient, 10e6, keccak256("k1"));
        approve(approverA, id);
        execute(executor, id);
        assertEq(usdt.balanceOf(recipient), 10e6);
    }

    // ----------------------------------------------------------------- views

    function test_IsExecutableReflectsState() public {
        bytes32 id = request(agent, agent, recipient, 10e6, keccak256("k1"));
        assertFalse(vault.isExecutable(id), "pending is not executable");

        approve(approverA, id);
        assertTrue(vault.isExecutable(id), "approved is executable");

        execute(executor, id);
        assertFalse(vault.isExecutable(id), "executed is not executable");
    }

    function test_ComputeRequestIdIsPureAndVaultScoped() public {
        bytes32 key = keccak256("shared");
        bytes32 id = vault.computeRequestId(key);
        assertEq(id, keccak256(abi.encode(address(vault), key)));

        request(agent, agent, recipient, 1e6, key);
        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Pending));
    }
}

/// @notice Expiry validation: a policy or recipient entry must not be written already elapsed.
///
/// @dev    The bug this covers was reachable only from the owner, so it was never a security hole -
///         but it bricked an agent silently. A vault configured with a past expiry looks complete
///         and refuses every request with DeadlinePassed, and the owner has to notice that before
///         they can work out why an agent that "has a policy" cannot spend.
contract MandateVaultExpiryTest is Test {
    MandateVault vault;
    MockUSD usdt;

    address org = makeAddr("org");
    address executor = makeAddr("executor");
    address agent = makeAddr("agent");
    address recipient = makeAddr("recipient");
    address stranger = makeAddr("stranger");

    uint256 constant MAX_TX = 100e6;
    uint256 constant DAILY = 500e6;
    uint256 constant START = 1_700_000_000;
    uint256 constant DAY = 86_400;

    function setUp() public {
        vm.warp(START);
        usdt = new MockUSD();
        vm.prank(org);
        vault = new MandateVault(org, executor, address(usdt), 0, 0, 0, 0);

        vm.startPrank(org);
        vault.setAgent(agent, true);
        vault.setAllowedToken(agent, address(usdt), true);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 1, true);
        vault.setAllowedService(agent, recipient, "vendor", 0, 0, 0, true);
        vm.stopPrank();

        usdt.mint(address(vault), 10_000e6);
    }

    function test_Revert_SetAgentPolicy_PastExpiry() public {
        vm.prank(org);
        vm.expectRevert(MandateVault.ExpiryInPast.selector);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, uint64(block.timestamp - 1), 1, true);
    }

    function test_Revert_SetAllowedService_PastExpiry() public {
        vm.prank(org);
        vm.expectRevert(MandateVault.ExpiryInPast.selector);
        vault.setAllowedService(agent, recipient, "vendor", 0, 0, uint64(block.timestamp - 1), true);
    }

    function test_Revert_Constructor_PastExpiry() public {
        vm.prank(org);
        vm.expectRevert(MandateVault.ExpiryInPast.selector);
        new MandateVault(org, executor, address(usdt), MAX_TX, DAILY, uint64(block.timestamp - 1), 1);
    }

    /// @dev 0 still means "never", including at the current block timestamp, so existing
    ///      deployments and the default path are unaffected.
    function test_Expiry_ZeroIsNeverAndAllowed() public {
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 1, true);
        MandateVault.Policy memory p = vault.getPolicy(agent);
        assertEq(p.expiry, 0, "zero expiry must stay zero");
        assertEq(p.active, true);
    }

    function test_Expiry_FutureIsAccepted() public {
        uint64 future = uint64(block.timestamp + 30 * DAY);
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, future, 1, true);

        MandateVault.Policy memory p = vault.getPolicy(agent);
        assertEq(p.expiry, future, "future expiry must be stored verbatim");
    }

    /// @dev The timestamp equal to now is not yet past; rejecting it would break the legitimate
    ///      case of a policy that expires at the end of the current block.
    function test_Expiry_CurrentBlockIsAccepted() public {
        uint64 nowTs = uint64(block.timestamp);
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, nowTs, 1, true);

        MandateVault.Policy memory p = vault.getPolicy(agent);
        assertEq(p.expiry, nowTs);
    }

    /// @dev Only the owner can write policy, so a non-owner must still fail with NotOwner rather
    ///      than reaching the expiry check.
    function test_Revert_NonOwnerCannotWriteExpiredPolicy() public {
        vm.prank(stranger);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, uint64(block.timestamp - 1), 1, true);
    }

    /// @dev Revoking and re-adding is how an owner recovers, and it must still work while the
    ///      existing policy is live.
    function test_Expiry_CanBeTightenedAfterRevocation() public {
        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, uint64(block.timestamp + 10 * DAY), 1, false);

        assertEq(vault.getPolicy(agent).active, false, "policy must be inactive after revoke");

        vm.prank(org);
        vault.setAgentPolicy(agent, MAX_TX, DAILY, 0, 1, true);
        assertEq(vault.getPolicy(agent).active, true, "policy must be restorable");
    }
}
