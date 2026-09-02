// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpendArcVault} from "../src/SpendArcVault.sol";
import {MockUSD} from "../src/MockUSD.sol";

contract SpendArcVaultTest is Test {
    SpendArcVault vault;
    MockUSD usdc;

    address owner = makeAddr("owner");
    address executor = makeAddr("executor");
    address stranger = makeAddr("stranger");
    address agent = makeAddr("agent");
    address target = makeAddr("target");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSD();
        vm.prank(owner);
        vault = new SpendArcVault(owner, address(0), agent, 0, 0, 0, address(usdc), target);
        usdc.mint(address(vault), 1_000_000e6);
        vm.prank(owner);
        vault.setAgentPolicy(agent, 100e6, 500e6, 0, true);
        vm.prank(owner);
        vault.setExecutor(executor, true);
    }

    function test_DepositPullsUSDCFromCaller() public {
        usdc.mint(stranger, 1_000e6);
        vm.prank(stranger);
        usdc.approve(address(vault), 1_000e6);
        uint256 before = usdc.balanceOf(address(vault));
        vm.prank(stranger);
        vault.deposit(250e6);
        assertEq(usdc.balanceOf(address(vault)), before + 250e6);
        assertEq(usdc.balanceOf(stranger), 750e6);
    }

    function test_ExecutorCanSpendForAgent() public {
        uint256 before = usdc.balanceOf(target);
        bytes32 actionId = keccak256("approved");

        vm.prank(executor);
        bool approved = vault.executeSpendFor(agent, address(usdc), target, 25e6, "", actionId);

        assertTrue(approved);
        assertEq(usdc.balanceOf(target), before + 25e6);
    }

    function test_OwnerCanSpendForAgent() public {
        bytes32 actionId = keccak256("owner-spend");
        vm.prank(owner);
        bool approved = vault.executeSpendFor(agent, address(usdc), target, 10e6, "", actionId);
        assertTrue(approved);
    }

    function test_Revert_NonAuthorizedCannotSpendFor() public {
        vm.prank(stranger);
        vm.expectRevert(SpendArcVault.NotAuthorized.selector);
        vault.executeSpendFor(agent, address(usdc), target, 1e6, "", keccak256("x"));
    }

    function test_Blocked_OverMaxPerTx_NoTransfer() public {
        uint256 before = usdc.balanceOf(target);
        vm.prank(executor);
        bool approved = vault.executeSpendFor(agent, address(usdc), target, 101e6, "", keccak256("too-big"));
        assertFalse(approved);
        assertEq(usdc.balanceOf(target), before);
    }

    function test_Blocked_TargetNotAllowlisted() public {
        address other = makeAddr("other");
        vm.prank(executor);
        bool approved = vault.executeSpendFor(agent, address(usdc), other, 1e6, "", keccak256("unlisted"));
        assertFalse(approved);
    }

    function test_Blocked_InactiveAgent() public {
        address inactive = makeAddr("inactive");
        vm.prank(owner);
        vault.setAgentPolicy(inactive, 100e6, 500e6, 0, false);
        vm.prank(owner);
        vault.setAllowedToken(inactive, address(usdc), true);
        vm.prank(owner);
        vault.setAllowedService(inactive, target, "inactive-svc", 0, 0, 0, true);

        vm.prank(executor);
        bool approved = vault.executeSpendFor(inactive, address(usdc), target, 1e6, "", keccak256("inactive"));
        assertFalse(approved);
    }

    function test_Blocked_DuplicateActionId() public {
        bytes32 actionId = keccak256("dup");
        vm.prank(executor);
        vault.executeSpendFor(agent, address(usdc), target, 1e6, "", actionId);
        vm.prank(executor);
        bool approved = vault.executeSpendFor(agent, address(usdc), target, 1e6, "", actionId);
        assertFalse(approved);
    }

    function test_SpendFor_DoesNotUseCallerPolicy() public {
        vm.prank(owner);
        vault.setExecutor(stranger, true);
        vm.prank(stranger);
        bool approved = vault.executeSpendFor(agent, address(usdc), target, 50e6, "", keccak256("caller-policy"));
        assertTrue(approved);
        assertEq(usdc.balanceOf(target), 50e6);
    }

    function test_Blocked_ExceedsServiceMaxPerTx() public {
        vm.prank(owner);
        vault.setAllowedService(agent, target, "backend", 10e6, 0, 0, true);
        uint256 before = usdc.balanceOf(target);
        vm.prank(executor);
        bool approved = vault.executeSpendFor(agent, address(usdc), target, 11e6, "", keccak256("svc-big"));
        assertFalse(approved);
        assertEq(usdc.balanceOf(target), before);
    }

    function test_Blocked_ExceedsServiceDailyCap() public {
        vm.prank(owner);
        vault.setAllowedService(agent, target, "backend", 0, 30e6, 0, true);
        spend(target, 20e6, keccak256("svc-1"));
        vm.prank(executor);
        bool approved = vault.executeSpendFor(agent, address(usdc), target, 15e6, "", keccak256("svc-2"));
        assertFalse(approved);
        assertEq(usdc.balanceOf(target), 20e6);
    }

    function test_ServiceDailyCapResets_AfterWindow() public {
        vm.prank(owner);
        vault.setAllowedService(agent, target, "backend", 0, 30e6, 0, true);
        spend(target, 30e6, keccak256("svc-window-1"));
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(executor);
        bool approved = vault.executeSpendFor(agent, address(usdc), target, 10e6, "", keccak256("svc-window-2"));
        assertTrue(approved);
        assertEq(usdc.balanceOf(target), 40e6);
    }

    function test_PerServiceBudgetDoesNotBindOtherTargets() public {
        address other = makeAddr("other");
        vm.prank(owner);
        vault.setAllowedService(agent, other, "limited", 10e6, 0, 0, true);
        vm.prank(executor);
        bool approved = vault.executeSpendFor(agent, address(usdc), target, 90e6, "", keccak256("other-target"));
        assertTrue(approved);
    }

    function test_Blocked_ServiceAllowlistExpired() public {
        vm.prank(owner);
        vault.setAllowedService(agent, target, "backend", 0, 0, uint64(block.timestamp - 1), true);
        vm.prank(executor);
        bool approved = vault.executeSpendFor(agent, address(usdc), target, 1e6, "", keccak256("expired-svc"));
        assertFalse(approved);
    }

    function test_Revert_ServiceMaxPerTxExceedsDailyCap() public {
        vm.prank(owner);
        vm.expectRevert("maxPerTx exceeds dailyCap");
        vault.setAllowedService(agent, target, "bad", 50e6, 10e6, 0, true);
    }

    function spend(address to, uint128 amount, bytes32 actionId) internal {
        vm.prank(executor);
        vault.executeSpendFor(agent, address(usdc), to, amount, "", actionId);
    }
}
