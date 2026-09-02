// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpendArcVault} from "../src/SpendArcVault.sol";
import {SpendArcVaultFactory} from "../src/SpendArcVaultFactory.sol";
import {MockUSD} from "../src/MockUSD.sol";

contract SpendArcVaultFactoryTest is Test {
    SpendArcVaultFactory factory;
    MockUSD usdc;

    address executor = makeAddr("executor");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    function setUp() public {
        usdc = new MockUSD();
        factory = new SpendArcVaultFactory(address(usdc), executor);
    }

    function test_CreatesIsolatedVault() public {
        vm.prank(alice);
        address vaultAddr = factory.createVault(100e6, 500e6, 0);
        SpendArcVault vault = SpendArcVault(payable(vaultAddr));

        assertEq(vault.owner(), alice);
        assertEq(factory.vaultOf(alice), vaultAddr);
        assertEq(factory.vaultByAgent(alice), vaultAddr);
        assertTrue(vault.executors(executor));
        assertEq(vault.usdc(), address(usdc));
        SpendArcVault.Policy memory p = vault.getPolicy(alice);
        assertEq(p.maxPerTx, 100e6);
        assertEq(p.dailyCap, 500e6);
        assertTrue(p.lastResetTime > 0);
        assertTrue(p.active);
        assertTrue(vault.allowedToken(alice, address(usdc)));
        SpendArcVault.ServiceAllowlist memory s = vault.getService(alice, alice);
        assertTrue(s.allowed);
        assertEq(s.label, "self");
    }

    function test_VaultsAreIsolated() public {
        vm.prank(alice);
        address a = factory.createVault(100e6, 500e6, 0);
        vm.prank(bob);
        address b = factory.createVault(50e6, 200e6, 0);

        assertTrue(a != b);
        assertEq(SpendArcVault(payable(a)).owner(), alice);
        assertEq(SpendArcVault(payable(b)).owner(), bob);
        assertFalse(SpendArcVault(payable(a)).getService(bob, bob).allowed);
        assertEq(factory.vaultCount(), 2);
    }

    function test_Revert_AlreadyHasVault() public {
        vm.prank(alice);
        factory.createVault(100e6, 500e6, 0);
        vm.prank(alice);
        vm.expectRevert("already has vault");
        factory.createVault(100e6, 500e6, 0);
    }

    function test_Revert_InconsistentLeash() public {
        vm.prank(alice);
        vm.expectRevert("maxPerTx exceeds dailyCap");
        factory.createVault(500e6, 100e6, 0);
    }

    function test_ExecutorCannotChangePolicyInUserVault() public {
        vm.prank(alice);
        address vaultAddr = factory.createVault(100e6, 500e6, 0);
        vm.prank(executor);
        vm.expectRevert(SpendArcVault.NotOwner.selector);
        SpendArcVault(payable(vaultAddr)).setAgentPolicy(alice, 10e6, 20e6, 0, true);
    }

    function test_ExecutorCannotWithdraw() public {
        vm.prank(alice);
        address vaultAddr = factory.createVault(100e6, 500e6, 0);
        vm.prank(executor);
        vm.expectRevert(SpendArcVault.NotOwner.selector);
        SpendArcVault(payable(vaultAddr)).withdrawTokens(address(usdc), executor, 1e6);
    }

    function test_DepositFundsVault() public {
        vm.prank(alice);
        address vaultAddr = factory.createVault(100e6, 500e6, 0);
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(vaultAddr, 1_000e6);
        vm.prank(alice);
        SpendArcVault(payable(vaultAddr)).deposit(300e6);
        assertEq(usdc.balanceOf(vaultAddr), 300e6);
        assertEq(usdc.balanceOf(alice), 700e6);
    }

    function test_ExecutorSpendsOnlyWithinLeash() public {
        vm.prank(alice);
        address vaultAddr = factory.createVault(100e6, 500e6, 0);
        SpendArcVault vault = SpendArcVault(payable(vaultAddr));

        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(vaultAddr, 1_000e6);
        vm.prank(alice);
        vault.deposit(1_000e6);

        // executor spends within policy -> approved, funds move to the agent's wallet
        vm.prank(executor);
        bool ok = vault.executeSpendFor(alice, address(usdc), alice, 25e6, "", keccak256("ok"));
        assertTrue(ok);
        assertEq(usdc.balanceOf(alice), 25e6);

        // over per-tx cap -> blocked on-chain, no transfer
        uint256 vaultBefore = usdc.balanceOf(vaultAddr);
        vm.prank(executor);
        bool blocked = vault.executeSpendFor(alice, address(usdc), alice, 101e6, "", keccak256("over"));
        assertFalse(blocked);
        assertEq(usdc.balanceOf(vaultAddr), vaultBefore);
    }
}
