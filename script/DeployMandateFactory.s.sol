// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MandateVaultFactory} from "../src/MandateVaultFactory.sol";

/// @notice Deploy the MandateVaultFactory on BOT Chain Bohr Testnet.
///
/// @dev Usage:
///        export PRIVATE_KEY=0x...
///        export MANDATE_EXECUTOR_ADDRESS=0x...      # optional, defaults to the deployer
///        export MANDATE_SETTLEMENT_TOKEN=0x...tUSDT # optional, defaults to tUSDT on Bohr
///        forge script script/DeployMandateFactory.s.sol \
///          --rpc-url https://rpc.bohr.life --broadcast
///
///      The chain id is asserted before broadcasting so a misconfigured RPC can never publish a
///      factory to the wrong network. The executor is a gas-only relayer: it can settle approved
///      requests and nothing else, and each org can revoke or rotate it on its own vault through
///      `setExecutor`, which is owner-only.
contract DeployMandateFactory is Script {
    uint256 internal constant BOT_CHAIN_ID = 968;

    /// @notice tUSDT on BOT Chain Bohr Testnet.
    address internal constant TUSDT = 0x75edC9335175Fc0552D51D48439F229c10420fe3;

    error WrongChain(uint256 actual);

    function run() external returns (MandateVaultFactory factory) {
        if (block.chainid != BOT_CHAIN_ID) revert WrongChain(block.chainid);

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address executor = vm.envOr("MANDATE_EXECUTOR_ADDRESS", deployer);
        address token = vm.envOr("MANDATE_SETTLEMENT_TOKEN", TUSDT);

        vm.startBroadcast(deployerKey);
        factory = new MandateVaultFactory(executor, token);
        vm.stopBroadcast();

        console2.log("MandateVaultFactory    :", address(factory));
        console2.log("deployer               :", deployer);
        console2.log("executor (gas-only)    :", executor);
        console2.log("settlement token       :", token);
        console2.log("chainid                :", block.chainid);
    }
}
