// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MandateVault} from "./MandateVault.sol";

/// @title MandateVaultFactory
/// @notice Deploys one isolated treasury vault per organization on BOT Chain.
/// @dev    Unlike a per-wallet vault, the org is the vault owner and may register any number of
///         agents against that single treasury. Each org gets exactly one vault, which keeps
///         org-level accounting, pause, and withdrawal authority unambiguous.
///         The platform `executor` is pre-authorized on every vault for gas only: it can settle
///         approved requests and nothing else.
contract MandateVaultFactory {
    address public immutable executor;
    address public immutable deployer;

    address[] public vaults;
    mapping(address org => address vault) public vaultOf;

    event VaultCreated(
        address indexed org, address indexed vault, uint256 maxPerTx, uint256 dailyCap, uint8 approvalThreshold
    );

    error VaultAlreadyExists();
    error InvalidLeash();

    constructor(address executor_) {
        executor = executor_;
        deployer = msg.sender;
    }

    /// @notice Create this org's treasury. The caller becomes the vault owner and its first agent.
    function createVault(uint256 maxPerTx, uint256 dailyCap, uint64 expiry, uint8 approvalThreshold)
        external
        returns (address vault)
    {
        if (vaultOf[msg.sender] != address(0)) revert VaultAlreadyExists();
        if (maxPerTx > dailyCap) revert InvalidLeash();

        vault = address(new MandateVault(msg.sender, executor, maxPerTx, dailyCap, expiry, approvalThreshold));
        vaultOf[msg.sender] = vault;
        vaults.push(vault);

        emit VaultCreated(msg.sender, vault, maxPerTx, dailyCap, approvalThreshold);
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    function vaultAt(uint256 index) external view returns (address) {
        return vaults[index];
    }
}
