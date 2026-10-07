// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {MandateVaultFactory} from "../src/MandateVaultFactory.sol";
import {MockUSD} from "../src/MockUSD.sol";

contract MandateVaultFactoryTest is Test {
    MandateVaultFactory factory;
    MockUSD usdt;

    address executor = makeAddr("executor");
    address orgA = makeAddr("orgA");
    address orgB = makeAddr("orgB");
    address agentA = makeAddr("agentA");
    address recipient = makeAddr("recipient");
    address approver = makeAddr("approver");

    uint256 constant MAX_TX = 100e6;
    uint256 constant DAILY = 500e6;
    uint256 constant START = 1_700_000_000;

    function setUp() public {
        vm.warp(START);
        usdt = new MockUSD();
        factory = new MandateVaultFactory(executor, address(usdt));
    }

    function create(address org, uint8 threshold) internal returns (address vault) {
        vm.prank(org);
        vault = address(factory.createVault(MAX_TX, DAILY, 0, threshold));
    }

    function test_DeployerAndExecutorAreImmutable() public {
        assertEq(factory.deployer(), address(this));
        assertEq(factory.executor(), executor);
    }

    function test_CreateVaultWiresRolesToOrg() public {
        address vaultAddr = create(orgA, 1);
        MandateVault vault = MandateVault(payable(vaultAddr));

        assertEq(vault.owner(), orgA, "org owns its treasury");
        assertTrue(vault.agents(orgA), "org registered as first agent");
        assertTrue(vault.executors(executor), "platform executor preauthorized");
        assertFalse(vault.executors(orgB), "no cross-org executor leakage");

        assertEq(factory.vaultOf(orgA), vaultAddr);
        assertEq(factory.vaultCount(), 1);
        assertEq(factory.vaultAt(0), vaultAddr);
    }

    function test_NewVaultStartsFundedWithPolicy() public {
        MandateVault vault = MandateVault(payable(create(orgA, 1)));

        MandateVault.Policy memory p = vault.getPolicy(orgA);
        assertEq(p.maxPerTx, MAX_TX);
        assertEq(p.dailyCap, DAILY);
        assertEq(p.approvalThreshold, 1);
        assertTrue(p.active);
        assertEq(p.spentToday, 0);
        assertEq(vault.paused(), false);
    }

    function test_NewVaultDefaultsToSettlementToken() public {
        MandateVault vault = MandateVault(payable(create(orgA, 1)));

        assertEq(vault.settlementToken(), address(usdt), "factory settlement token wired");
        assertTrue(vault.allowedTokens(orgA, address(usdt)), "first agent can already spend tUSDT");
    }

    function test_NewlyRegisteredAgentDefaultsToSettlementToken() public {
        MandateVault vault = MandateVault(payable(create(orgA, 1)));

        vm.prank(orgA);
        vault.setAgent(agentA, true);

        assertTrue(vault.agents(agentA));
        assertTrue(vault.allowedTokens(agentA, address(usdt)), "no manual allow step for a new agent");
    }

    function test_RevokedSettlementTokenSurvivesReenable() public {
        MandateVault vault = MandateVault(payable(create(orgA, 1)));

        vm.startPrank(orgA);
        vault.setAgent(agentA, true);
        assertTrue(vault.allowedTokens(agentA, address(usdt)), "granted by default");

        // A deliberate revocation sticks: disabling and re-enabling the agent must not resurrect it.
        vault.setAllowedToken(agentA, address(usdt), false);
        assertFalse(vault.allowedTokens(agentA, address(usdt)));
        vault.setAgent(agentA, false);
        vm.stopPrank();

        vm.prank(orgA);
        vault.setAgent(agentA, true);
        assertTrue(vault.agents(agentA));
        assertFalse(vault.allowedTokens(agentA, address(usdt)), "revocation is not undone by re-enable");
    }

    function test_Revert_OneVaultPerOrg() public {
        create(orgA, 1);
        vm.prank(orgA);
        vm.expectRevert(MandateVaultFactory.VaultAlreadyExists.selector);
        factory.createVault(MAX_TX, DAILY, 0, 1);

        assertEq(factory.vaultCount(), 1, "no second treasury");
    }

    function test_OrgsGetFullyIsolatedVaults() public {
        address a = create(orgA, 1);
        address b = create(orgB, 1);

        assertTrue(a != b, "distinct vaults");
        assertEq(factory.vaultCount(), 2);

        MandateVault va = MandateVault(payable(a));
        MandateVault vb = MandateVault(payable(b));

        // A treasury funded for org A is invisible to org B.
        usdt.mint(a, 1_000e6);
        assertEq(usdt.balanceOf(a), 1_000e6);
        assertEq(usdt.balanceOf(b), 0, "org B treasury empty");

        vm.prank(orgA);
        va.setAgent(agentA, true);
        assertTrue(va.agents(agentA));
        assertFalse(vb.agents(agentA), "agent registration does not leak across orgs");
    }

    function test_OrgACannotConfigureOrgBTreasury() public {
        address a = create(orgA, 1);
        address b = create(orgB, 1);

        vm.prank(orgA);
        vm.expectRevert(MandateVault.NotOwner.selector);
        MandateVault(payable(b)).setAgent(agentA, true);

        vm.prank(orgA);
        vm.expectRevert(MandateVault.NotOwner.selector);
        MandateVault(payable(b)).withdrawToken(address(usdt), orgA, 1);

        assertFalse(MandateVault(payable(a)).agents(agentA));
    }

    function test_Revert_InconsistentCapsAtDeployment() public {
        vm.prank(orgA);
        vm.expectRevert(MandateVaultFactory.InvalidLeash.selector);
        factory.createVault(DAILY, MAX_TX, 0, 1);
    }

    function test_DeployWithZeroCapsStartsDenyAll() public {
        vm.prank(orgA);
        address vaultAddr = address(factory.createVault(0, 0, 0, 1));
        MandateVault vault = MandateVault(payable(vaultAddr));

        assertEq(vault.remainingDailyCap(orgA), 0, "cannot spend until the org sets a leash");

        vm.startPrank(orgA);
        vault.setAllowedToken(orgA, address(usdt), true);
        vault.setAllowedService(orgA, recipient, "vendor", 0, 0, 0, true);
        vm.stopPrank();

        vm.prank(orgA);
        vm.expectRevert(MandateVault.InvalidPolicy.selector);
        vault.requestSpend(orgA, address(usdt), recipient, 1e6, keccak256("k1"), 0);
    }

    function test_EndToEndApprovedSpendThroughFactory() public {
        address vaultAddr = create(orgA, 1);
        MandateVault vault = MandateVault(payable(vaultAddr));

        usdt.mint(address(vault), 1_000e6);

        vm.startPrank(orgA);
        vault.setAgent(agentA, true);
        vault.setApprover(approver, true);
        vault.setAgentPolicy(agentA, MAX_TX, DAILY, 0, 1, true);
        vault.setAllowedToken(agentA, address(usdt), true);
        vault.setAllowedService(agentA, recipient, "vendor", 0, 0, 0, true);
        vm.stopPrank();

        vm.prank(agentA);
        bytes32 id = vault.requestSpend(agentA, address(usdt), recipient, 50e6, keccak256("invoice-1"), 0);
        assertFalse(vault.isExecutable(id));

        vm.prank(approver);
        vault.approve(id);
        assertTrue(vault.isExecutable(id));

        vm.prank(executor);
        vault.execute(id);

        assertEq(usdt.balanceOf(recipient), 50e6);
        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Executed));
    }

    function test_Revert_AgentCannotSelfApproveThroughFactoryVault() public {
        MandateVault vault = MandateVault(payable(create(orgA, 1)));
        usdt.mint(address(vault), 1_000e6);

        vm.startPrank(orgA);
        vault.setAgent(agentA, true);
        vault.setAgentPolicy(agentA, MAX_TX, DAILY, 0, 1, true);
        vault.setAllowedToken(agentA, address(usdt), true);
        vault.setAllowedService(agentA, recipient, "vendor", 0, 0, 0, true);
        vm.stopPrank();

        vm.prank(agentA);
        bytes32 id = vault.requestSpend(agentA, address(usdt), recipient, 50e6, keccak256("invoice-1"), 0);

        vm.prank(agentA);
        vm.expectRevert(MandateVault.NotApprover.selector);
        vault.approve(id);

        vm.prank(agentA);
        vm.expectRevert(MandateVault.RequestNotApproved.selector);
        vault.execute(id);

        assertEq(usdt.balanceOf(recipient), 0);
    }

    function test_ExecutorCannotWithdrawOrgFunds() public {
        MandateVault vault = MandateVault(payable(create(orgA, 1)));
        usdt.mint(address(vault), 1_000e6);

        vm.prank(executor);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.withdrawToken(address(usdt), executor, 1_000e6);

        assertEq(usdt.balanceOf(address(vault)), 1_000e6, "treasury untouched");
    }

    function test_ExecutorCannotReconfigurePolicy() public {
        MandateVault vault = MandateVault(payable(create(orgA, 1)));

        vm.startPrank(executor);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.setAgentPolicy(orgA, type(uint256).max, type(uint256).max, 0, 0, true);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.setAllowedToken(orgA, address(usdt), true);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.setPaused(true);
        vm.stopPrank();

        assertFalse(vault.paused());
        assertEq(vault.getPolicy(orgA).maxPerTx, MAX_TX, "leash unchanged");
    }

    function test_ExecutorCannotApprove() public {
        MandateVault vault = MandateVault(payable(create(orgA, 1)));
        usdt.mint(address(vault), 1_000e6);

        vm.startPrank(orgA);
        vault.setAgent(agentA, true);
        vault.setAgentPolicy(agentA, MAX_TX, DAILY, 0, 1, true);
        vault.setAllowedToken(agentA, address(usdt), true);
        vault.setAllowedService(agentA, recipient, "vendor", 0, 0, 0, true);
        vm.stopPrank();

        vm.prank(agentA);
        bytes32 id = vault.requestSpend(agentA, address(usdt), recipient, 50e6, keccak256("invoice-1"), 0);

        vm.prank(executor);
        vm.expectRevert(MandateVault.NotApprover.selector);
        vault.approve(id);
    }

    function test_RequestIdsAreScopedPerVault() public {
        MandateVault va = MandateVault(payable(create(orgA, 1)));
        MandateVault vb = MandateVault(payable(create(orgB, 1)));

        bytes32 shared = keccak256("same-key");
        assertTrue(va.computeRequestId(shared) != vb.computeRequestId(shared), "keys never collide across orgs");
    }
}
