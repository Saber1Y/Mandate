// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {MandateVaultFactory} from "../src/MandateVaultFactory.sol";
import {MockUSD} from "../src/MockUSD.sol";

/// @notice Minimal ERC-4337-shaped account: the owner is a contract, not an EOA.
///
/// @dev     Stands in for a Privy smart account so the contract-owned-vault path is testable without
///          a browser. It is deliberately dumb - a fixed owner plus a `execute` that forwards an
///          arbitrary call - because the property under test is not the account implementation. It
///          is that Mandate treats a contract owner as a first-class owner: it can create a vault,
///          holds `owner()`, sets policy, signs nothing it should not, and cannot be impersonated.
contract SmartAccountStub {
    address public immutable owner;
    uint256 public nonce;

    error NotEntryPoint();
    error Unauthorized();

    constructor(address owner_) {
        owner = owner_;
    }

    /// @dev Mirrors an account's validateUserOp guard: only the owner may drive execution.
    function execute(address to, uint256 value, bytes calldata data) external payable returns (bytes memory) {
        if (msg.sender != owner) revert Unauthorized();
        nonce++;
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    receive() external payable {}
}

/// @notice Owner = deployer != executor, and a contract-owned vault behaves exactly like an EOA one.
///
/// @dev     Covers two of the mainnet blockers that are reachable from deployment configuration
///          rather than from code:
///
///          1. Separation of powers. When the factory's executor is the same key as the org owner, one
///             key can both approve a spend and broadcast it. The factory takes the executor as a
///             constructor argument, so this is a deployment decision - and the thing that has to be
///             asserted is that the *capability* separation holds, not merely that the addresses
///             differ.
///
///          2. Smart-account ownership. A production org is expected to be a Privy smart account, so
///             owner-as-contract must be fully supported: create a vault, own it, set policy,
///             withdraw, and be the only party able to do those things.
contract MandateOwnerSeparationTest is Test {
    MandateVaultFactory factory;
    MockUSD usdt;

    /// @dev A dedicated gas-only key, distinct from any org. This is the whole point of the fixture.
    address gasOnlyExecutor = makeAddr("gasOnlyExecutor");
    address orgOwner = makeAddr("orgOwner");
    address stranger = makeAddr("stranger");
    address recipient = makeAddr("recipient");

    uint256 constant MAX_TX = 100e6;
    uint256 constant DAILY = 500e6;
    uint256 constant START = 1_700_000_000;

    function setUp() public {
        vm.warp(START);
        usdt = new MockUSD();
        factory = new MandateVaultFactory(gasOnlyExecutor);
    }

    /// @dev A vault an org's first agent can actually spend from: token and recipient allowlisted.
    ///      createVault only registers the caller and sets caps; without these two allowlists
    ///      _validate reverts NotAuthorized before any cap is even considered.
    function _configuredVault(uint8 threshold) internal returns (MandateVault vault) {
        return _configuredVaultFor(orgOwner, threshold);
    }

    /// @dev One vault per org is the whole point of the factory, so the org has to be a parameter:
    ///      a helper that always used `orgOwner` could only ever build a single vault.
    function _configuredVaultFor(address org, uint8 threshold) internal returns (MandateVault vault) {
        vm.prank(org);
        vault = MandateVault(payable(factory.createVault(MAX_TX, DAILY, 0, threshold)));
        vm.startPrank(org);
        vault.setAllowedToken(org, address(usdt), true);
        vault.setAllowedService(org, recipient, "vendor", 0, 0, 0, true);
        vm.stopPrank();
        usdt.mint(address(vault), 1_000e6);
        // `org` has already acted here, so the caller's next vm.prank must not collide with a
        // broadcast prank still open from this helper.
    }

    // ---------------------------------------------------------------- separation of powers

    function test_ExecutorIsDistinctFromOrgOwner() public {
        vm.prank(orgOwner);
        MandateVault vault = MandateVault(payable(factory.createVault(MAX_TX, DAILY, 0, 1)));

        assertEq(vault.owner(), orgOwner, "org must own its vault");
        assertTrue(vault.executors(gasOnlyExecutor), "gas-only executor must be pre-authorized");
        assertFalse(
            vault.executors(orgOwner),
            "the owner must not also be an executor, or one key can approve and settle"
        );
    }

    /// @dev The executor may relay and settle, and nothing else. This is the capability assertion
    ///      that matters - an address comparison alone would pass even if the roles were equivalent.
    function test_ExecutorCanSettleButCannotApproveOrWithdraw() public {
        MandateVault vault = _configuredVault(0);

        // Auto-approved at threshold 0, so the executor settles.
        vm.prank(gasOnlyExecutor);
        bytes32 id = vault.requestSpend(orgOwner, address(usdt), recipient, 1e6, keccak256("k"), 0);

        vm.prank(gasOnlyExecutor);
        vault.execute(id);

        assertEq(uint8(vault.getRequestStatus(id)), uint8(MandateVault.RequestStatus.Executed));

        // Settling is the executor's ceiling: it cannot approve.
        vm.prank(gasOnlyExecutor);
        vm.expectRevert(MandateVault.NotApprover.selector);
        vault.approve(keccak256("other"));

        // Nor cancel a real pending request: cancellation is owner, the requesting agent, or an
        // approver. An executor that can also kill requests is a participant, not a relay. Probing
        // with a made-up id proves nothing, because cancel checks existence before authorization.
        // Threshold 1 needs a second org, since an org may only ever have one vault.
        address org2 = makeAddr("org2");
        MandateVault supervised = _configuredVaultFor(org2, 1);
        vm.prank(gasOnlyExecutor);
        bytes32 pending = supervised.requestSpend(org2, address(usdt), recipient, 1e6, keccak256("p"), 0);
        assertEq(uint8(supervised.getRequestStatus(pending)), uint8(MandateVault.RequestStatus.Pending));

        vm.prank(gasOnlyExecutor);
        vm.expectRevert(MandateVault.NotAuthorized.selector);
        supervised.cancel(pending);

        // Nor withdraw, nor rewrite policy: those are owner-only.
        vm.prank(gasOnlyExecutor);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.withdrawToken(address(usdt), gasOnlyExecutor, 1);

        vm.prank(gasOnlyExecutor);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.setAgentPolicy(orgOwner, MAX_TX, DAILY, 0, 0, true);
    }

    function test_StrangerCanDoNothing() public {
        vm.prank(orgOwner);
        MandateVault vault = MandateVault(payable(factory.createVault(MAX_TX, DAILY, 0, 0)));

        vm.prank(stranger);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.setAgentPolicy(orgOwner, MAX_TX, DAILY, 0, 0, true);

        vm.prank(stranger);
        vm.expectRevert(MandateVault.NotApprover.selector);
        vault.approve(keccak256("nope"));

        vm.prank(stranger);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.withdrawToken(address(usdt), stranger, 1);

        // And cannot front-run someone else's request.
        vm.prank(stranger);
        vm.expectRevert(MandateVault.NotAuthorized.selector);
        vault.execute(keccak256("nope"));
    }

    // ---------------------------------------------------------------- smart account as owner

    function test_SmartAccountCanOwnAVault() public {
        SmartAccountStub account = new SmartAccountStub(orgOwner);

        // The account itself calls createVault, so the account is msg.sender and therefore owner.
        vm.prank(address(account));
        address vaultAddr = factory.createVault(MAX_TX, DAILY, 0, 1);
        MandateVault vault = MandateVault(payable(vaultAddr));

        assertEq(vault.owner(), address(account), "the account, not its EOA, must own the vault");
        assertEq(factory.vaultOf(address(account)), vaultAddr, "vaultOf must resolve by account address");
        assertEq(
            factory.vaultOf(orgOwner), address(0), "the controlling EOA must not resolve to the vault"
        );
    }

    /// @dev Drives policy through the account's execute path, the way a real ERC-4337 account does.
    function test_SmartAccountCanSetPolicyThroughExecute() public {
        SmartAccountStub account = new SmartAccountStub(orgOwner);
        vm.prank(address(account));
        MandateVault vault = MandateVault(payable(factory.createVault(0, 0, 0, 0)));

        vm.prank(orgOwner);
        account.execute(
            address(vault),
            0,
            abi.encodeCall(MandateVault.setAgentPolicy, (orgOwner, MAX_TX, DAILY, 0, 0, true))
        );

        MandateVault.Policy memory p = vault.getPolicy(orgOwner);
        assertEq(p.maxPerTx, MAX_TX);
        assertEq(p.dailyCap, DAILY);
        assertEq(p.approvalThreshold, 0, "account-held policy must persist");
        assertTrue(p.active);
    }

    function test_SmartAccountCanWithdrawAndEOACannot() public {
        SmartAccountStub account = new SmartAccountStub(orgOwner);
        vm.prank(address(account));
        MandateVault vault = MandateVault(payable(factory.createVault(MAX_TX, DAILY, 0, 0)));

        usdt.mint(address(vault), 500e6);

        vm.prank(orgOwner);
        account.execute(
            address(vault), 0, abi.encodeCall(MandateVault.withdrawToken, (address(usdt), orgOwner, 100e6))
        );
        assertEq(usdt.balanceOf(orgOwner), 100e6, "account must be able to move its own funds");

        // The EOA that controls the account is not the owner and cannot withdraw directly. This is
        // the property that makes an account meaningful: authority lives with the account.
        vm.prank(orgOwner);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vault.withdrawToken(address(usdt), orgOwner, 1e6);
    }

    function test_SmartAccountRejectsNonOwnerCaller() public {
        SmartAccountStub account = new SmartAccountStub(orgOwner);
        vm.prank(address(account));
        MandateVault vault = MandateVault(payable(factory.createVault(MAX_TX, DAILY, 0, 0)));

        vm.prank(stranger);
        vm.expectRevert(SmartAccountStub.Unauthorized.selector);
        account.execute(
            address(vault),
            0,
            abi.encodeCall(MandateVault.setAgentPolicy, (stranger, MAX_TX, DAILY, 0, 0, true))
        );
    }

    /// @dev Two smart accounts are two orgs. The isolating property is that neither can touch the
    ///      other's vault, which is what makes one-agent-per-tenant meaningful.
    function test_TwoSmartAccountOrgsAreIsolated() public {
        SmartAccountStub orgA = new SmartAccountStub(orgOwner);
        SmartAccountStub orgB = new SmartAccountStub(stranger);

        vm.prank(address(orgA));
        MandateVault vaultA = MandateVault(payable(factory.createVault(MAX_TX, DAILY, 0, 0)));
        vm.prank(address(orgB));
        MandateVault vaultB = MandateVault(payable(factory.createVault(MAX_TX, DAILY, 0, 0)));
        usdt.mint(address(vaultA), 1_000e6);
        usdt.mint(address(vaultB), 1_000e6);

        assertTrue(address(vaultA) != address(vaultB), "each org must get its own vault");

        // The two accounts each control one vault and only that one.
        assertEq(vaultA.owner(), address(orgA));
        assertEq(vaultB.owner(), address(orgB));

        // B drives its own account correctly - the call is forwarded - and A's vault refuses it,
        // because B's account is not A's owner. A legitimate account owner still cannot reconfigure
        // a foreign treasury, which is the fence that makes one-vault-per-org mean anything.
        vm.prank(stranger);
        vm.expectRevert(MandateVault.NotOwner.selector);
        orgB.execute(
            address(vaultA),
            0,
            abi.encodeCall(MandateVault.setAgentPolicy, (stranger, MAX_TX, DAILY, 0, 0, true))
        );

        // B cannot register itself in A's vault either.
        vm.prank(stranger);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vaultA.setAgent(stranger, true);

        // Nor approve inside A's vault.
        vm.prank(stranger);
        vm.expectRevert(MandateVault.NotApprover.selector);
        vaultA.approve(keccak256("cross"));

        // Nor withdraw A's funds. A is funded here specifically so a passing test means the fence
        // held, not that there was nothing to take.
        vm.prank(stranger);
        vm.expectRevert(MandateVault.NotOwner.selector);
        vaultA.withdrawToken(address(usdt), stranger, 1e6);
        assertEq(usdt.balanceOf(stranger), 0, "B must have taken nothing from A");

        // Nor spend them. B is not an agent in A's vault, and registration is checked before the
        // caller is, so this fails with NotRegistered rather than NotAuthorized - the stronger of the
        // two, since B would need to already be a registered agent in A's vault to get further.
        vm.prank(stranger);
        vm.expectRevert(MandateVault.NotRegistered.selector);
        vaultA.requestSpend(stranger, address(usdt), recipient, 1e6, keccak256("cross"), 0);

        // Same for the factory's gas-only executor: pre-authorised on every vault, but it may only
        // relay for an agent that exists on the vault being called, so it cannot spend A's treasury
        // on B's behalf either.
        vm.prank(gasOnlyExecutor);
        vm.expectRevert(MandateVault.NotRegistered.selector);
        vaultA.requestSpend(stranger, address(usdt), recipient, 1e6, keccak256("cross2"), 0);

        // A's own account can still spend from A, so the fences above are refusals and not a
        // vault that is simply broken.
        vm.startPrank(address(orgA));
        vaultA.setAllowedToken(address(orgA), address(usdt), true);
        vaultA.setAllowedService(address(orgA), recipient, "vendor", 0, 0, 0, true);
        vm.stopPrank();

        vm.prank(address(orgA));
        bytes32 own = vaultA.requestSpend(address(orgA), address(usdt), recipient, 1e6, keccak256("own"), 0);
        vm.prank(gasOnlyExecutor);
        vaultA.execute(own);
        assertEq(usdt.balanceOf(recipient), 1e6, "A's own spend must still settle");

        // B is untouched by all of it, and still in control of its own vault.
        vm.prank(stranger);
        orgB.execute(
            address(vaultB),
            0,
            abi.encodeCall(MandateVault.setAgentPolicy, (stranger, MAX_TX, DAILY, 0, 0, true))
        );
        assertEq(vaultB.getPolicy(stranger).maxPerTx, MAX_TX);
        assertEq(vaultA.getPolicy(stranger).maxPerTx, 0, "A must be untouched by B");
    }

    /// @dev A vault created through a smart account must still auto-register that account as its
    ///      first agent, since the constructor keys the policy to the caller.
    function test_SmartAccountIsFirstAgentOfItsOwnVault() public {
        SmartAccountStub account = new SmartAccountStub(orgOwner);
        vm.prank(address(account));
        MandateVault vault = MandateVault(payable(factory.createVault(MAX_TX, DAILY, 0, 0)));

        assertTrue(vault.agents(address(account)), "the creating account is registered as an agent");
        assertEq(vault.getPolicy(address(account)).maxPerTx, MAX_TX);
    }
}