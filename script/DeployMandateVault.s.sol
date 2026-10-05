// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MandateVaultFactory} from "../src/MandateVaultFactory.sol";

/// @notice Create one org's treasury through an already-deployed MandateVaultFactory.
///
/// @dev Usage:
///        export PRIVATE_KEY=0x...
///        export MANDATE_FACTORY_ADDRESS=0x...
///        forge script script/DeployMandateVault.s.sol \
///          --rpc-url https://rpc.bohr.life --broadcast
///
///      The org is whoever signs this transaction, because `createVault` keys the treasury to
///      `msg.sender` and that address becomes the vault owner and first agent. For an ERC-4337
///      smart account, send the same call from the account itself rather than relaying it, so the
///      account - not the platform - ends up holding owner authority.
///
///      Caps are in base units of the settlement token. tUSDT has 6 decimals, so 100_000_000 is
///      100 tUSDT per transaction and 500_000_000 is a 500 tUSDT daily ceiling.
contract DeployMandateVault is Script {
    uint256 internal constant BOT_CHAIN_ID = 968;

    error WrongChain(uint256 actual);
    error OrgIsNotBroadcaster(address org, address broadcaster);

    function run() external returns (address vault) {
        if (block.chainid != BOT_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 orgKey = vm.envUint("PRIVATE_KEY");
        address org = vm.addr(orgKey);

        // Optional override that only asserts intent: it fails loudly rather than silently
        // creating a treasury owned by the wrong account.
        address declaredOrg = vm.envOr("MANDATE_ORG_ADDRESS", org);
        if (declaredOrg != org) revert OrgIsNotBroadcaster(declaredOrg, org);

        MandateVaultFactory factory = MandateVaultFactory(vm.envAddress("MANDATE_FACTORY_ADDRESS"));

        uint256 maxPerTx = vm.envOr("MANDATE_MAX_PER_TX", uint256(100_000_000));
        uint256 dailyCap = vm.envOr("MANDATE_DAILY_CAP", uint256(500_000_000));
        uint64 expiry = uint64(vm.envOr("MANDATE_EXPIRY", uint256(0)));
        uint8 approvalThreshold = uint8(vm.envOr("MANDATE_APPROVAL_THRESHOLD", uint256(1)));

        vm.broadcast(orgKey);
        vault = factory.createVault(maxPerTx, dailyCap, expiry, approvalThreshold);

        console2.log("MandateVault       :", vault);
        console2.log("org / owner        :", org);
        console2.log("maxPerTx           :", maxPerTx);
        console2.log("dailyCap           :", dailyCap);
        console2.log("approvalThreshold  :", uint256(approvalThreshold));
        console2.log("chainid            :", block.chainid);
    }
}
