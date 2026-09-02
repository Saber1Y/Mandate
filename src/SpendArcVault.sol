// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title SpendArcVault
/// @notice Policy-enforcing spend vault for autonomous AI agents on Arc.
///         The vault holds USDC; a registered agent (or authorized executor) can only call
///         `executeSpend`, which moves value strictly inside its policy (active/expiry,
///         token + per-service target allowlists with per-service budgets, per-tx cap,
///         daily cap, actionId dedup).
///         The owner configures the policy. An authorized executor (e.g. server key) can
///         call `executeSpend` on behalf of agents but cannot change policy or withdraw funds.
contract SpendArcVault {
    using SafeERC20 for IERC20;

    address public constant NATIVE = address(0);

    uint256 private constant DAY = 1 days;

    struct Policy {
        uint128 maxPerTx;
        uint128 dailyCap;
        uint128 spentToday;
        uint64 lastResetTime;
        uint64 expiry;
        bool active;
    }

    /// @notice Per-target (per-service) allowlist policy, mirroring the server-side
    ///         control plane so both fences enforce the same per-service budget.
    ///         `maxPerTx`/`dailyCap` of 0 mean no per-service limit; the global
    ///         agent leash still backstops.
    struct ServiceAllowlist {
        bool allowed;
        string label;
        uint128 maxPerTx;
        uint128 dailyCap;
        uint128 spentToday;
        uint64 lastResetTime;
        uint64 expiry;
    }

    address public immutable owner;
    address public immutable usdc;
    bool internal _locked;

    mapping(address agent => Policy) public policies;
    mapping(address agent => mapping(address target => ServiceAllowlist)) public serviceAllowlist;
    mapping(address agent => mapping(address token => bool)) public allowedToken;
    mapping(bytes32 actionId => bool used) public usedAction;
    mapping(address executor => bool) public executors;

    event VaultFunded(address indexed from, uint256 amount);
    event PolicyCreated(address indexed agent, uint128 maxPerTx, uint128 dailyCap, uint64 expiry, bool active);
    event PolicyUpdated(address indexed agent, uint128 maxPerTx, uint128 dailyCap, uint64 expiry, bool active);
    event ServiceAllowlisted(
        address indexed agent,
        address indexed target,
        string label,
        uint128 maxPerTx,
        uint128 dailyCap,
        uint64 expiry,
        bool allowed
    );
    event TokenAllowlisted(address indexed agent, address indexed token, bool allowed);
    event AgentRevoked(address indexed agent);
    event ExecutorSet(address indexed executor, bool enabled);
    event AgentActionApproved(
        address indexed agent, address indexed target, address indexed token, uint256 amount, bytes32 actionId
    );
    event AgentActionBlocked(
        address indexed agent, address indexed target, address indexed token, uint256 amount, string reason
    );
    event ReceiptIssued(
        address indexed agent,
        address indexed target,
        address token,
        uint256 amount,
        bytes32 actionId,
        uint256 timestamp
    );

    error NotOwner();
    error NotAuthorized();
    error Reentrancy();
    error NativeTransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    /// @notice Fully self-configuring constructor. Deploys an isolated vault owned by `owner_`
    ///         with the platform executor pre-authorized (spend-within-policy only) and the owner's
    ///         wallet pre-registered as the single agent (policy + USDC token + self target).
    constructor(
        address owner_,
        address executor_,
        address agent_,
        uint128 maxPerTx_,
        uint128 dailyCap_,
        uint64 expiry_,
        address usdc_,
        address target_
    ) {
        owner = owner_;
        usdc = usdc_;
        if (executor_ != address(0)) executors[executor_] = true;
        if (usdc_ != address(0)) allowedToken[agent_][usdc_] = true;
        if (target_ != address(0)) {
            serviceAllowlist[agent_][target_] = ServiceAllowlist({
                allowed: true,
                label: "self",
                maxPerTx: 0,
                dailyCap: 0,
                spentToday: 0,
                lastResetTime: uint64(block.timestamp),
                expiry: 0
            });
        }
        policies[agent_] = Policy({
            maxPerTx: maxPerTx_,
            dailyCap: dailyCap_,
            spentToday: 0,
            lastResetTime: uint64(block.timestamp),
            expiry: expiry_,
            active: true
        });
    }

    receive() external payable {
        emit VaultFunded(msg.sender, msg.value);
    }

    /// @notice Fund the vault. Pulls `amount` USDC from the caller into the vault.
    function deposit(uint256 amount) external {
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
    }

    // ---------------------------------------------------------------------
    // Owner configuration
    // ---------------------------------------------------------------------

    function setAgentPolicy(address agent, uint128 maxPerTx, uint128 dailyCap, uint64 expiry, bool active)
        external
        onlyOwner
    {
        Policy storage p = policies[agent];
        bool creating = p.lastResetTime == 0;

        p.maxPerTx = maxPerTx;
        p.dailyCap = dailyCap;
        p.expiry = expiry;
        p.active = active;

        if (creating) {
            p.lastResetTime = uint64(block.timestamp);
            emit PolicyCreated(agent, maxPerTx, dailyCap, expiry, active);
        } else {
            emit PolicyUpdated(agent, maxPerTx, dailyCap, expiry, active);
        }
    }

    /// @notice Set (or clear) a per-service allowlist policy for an agent. `maxPerTx_`/`dailyCap_`
    ///         of 0 mean no per-service limit; the agent's global leash still applies. Setting
    ///         `allowed = false` removes the service from the allowlist.
    function setAllowedService(
        address agent,
        address target,
        string calldata label,
        uint128 maxPerTx,
        uint128 dailyCap,
        uint64 expiry,
        bool allowed
    ) external onlyOwner {
        require(dailyCap == 0 || maxPerTx <= dailyCap, "maxPerTx exceeds dailyCap");
        ServiceAllowlist storage s = serviceAllowlist[agent][target];
        s.allowed = allowed;
        s.label = label;
        s.maxPerTx = maxPerTx;
        s.dailyCap = dailyCap;
        s.expiry = expiry;
        s.lastResetTime = uint64(block.timestamp);
        if (!allowed) {
            s.spentToday = 0;
            s.lastResetTime = uint64(block.timestamp);
        }
        emit ServiceAllowlisted(agent, target, label, maxPerTx, dailyCap, expiry, allowed);
    }

    function setAllowedToken(address agent, address token, bool allowed) external onlyOwner {
        allowedToken[agent][token] = allowed;
        emit TokenAllowlisted(agent, token, allowed);
    }

    function revokeAgent(address agent) external onlyOwner {
        policies[agent].active = false;
        emit AgentRevoked(agent);
    }

    /// @notice Authorize a server executor to call `executeSpendFor` on behalf of agents.
    function setExecutor(address executor, bool enabled) external onlyOwner {
        executors[executor] = enabled;
        emit ExecutorSet(executor, enabled);
    }

    // ---------------------------------------------------------------------
    // Agent action
    // ---------------------------------------------------------------------

    /// @notice Agent (or anyone holding the agent key) spends directly from its own policy.
    function executeSpend(address token, address target, uint256 amount, bytes calldata data, bytes32 actionId)
        external
        nonReentrant
        returns (bool approved)
    {
        return _executeSpend(msg.sender, token, target, amount, data, actionId);
    }

    /// @notice Owner or an authorized executor spends on behalf of an agent.
    ///         The agent's own policy (not the caller's) is enforced.
    function executeSpendFor(address agent, address token, address target, uint256 amount, bytes calldata data, bytes32 actionId)
        external
        nonReentrant
        returns (bool approved)
    {
        if (msg.sender != owner && !executors[msg.sender]) revert NotAuthorized();
        return _executeSpend(agent, token, target, amount, data, actionId);
    }

    function _executeSpend(address agent, address token, address target, uint256 amount, bytes calldata data, bytes32 actionId)
        internal
        returns (bool approved)
    {
        Policy storage p = policies[agent];

        if (!p.active) {
            emit AgentActionBlocked(agent, target, token, amount, "agent not active");
            return false;
        }
        if (p.expiry != 0 && block.timestamp > p.expiry) {
            emit AgentActionBlocked(agent, target, token, amount, "policy expired");
            return false;
        }
        if (!allowedToken[agent][token]) {
            emit AgentActionBlocked(agent, target, token, amount, "token not allowlisted");
            return false;
        }
        ServiceAllowlist storage s = serviceAllowlist[agent][target];
        if (!s.allowed) {
            emit AgentActionBlocked(agent, target, token, amount, "target not allowlisted");
            return false;
        }
        if (s.expiry != 0 && block.timestamp > s.expiry) {
            emit AgentActionBlocked(agent, target, token, amount, "service allowlist expired");
            return false;
        }
        if (s.maxPerTx != 0 && amount > s.maxPerTx) {
            emit AgentActionBlocked(agent, target, token, amount, "exceeds service maxPerTx");
            return false;
        }
        if (amount > p.maxPerTx) {
            emit AgentActionBlocked(agent, target, token, amount, "exceeds maxPerTx");
            return false;
        }

        uint256 spent = p.spentToday;
        uint64 resetTime = p.lastResetTime;
        if (block.timestamp >= uint256(resetTime) + DAY) {
            spent = 0;
            resetTime = uint64(block.timestamp);
        }
        if (spent + amount > p.dailyCap) {
            emit AgentActionBlocked(agent, target, token, amount, "exceeds dailyCap");
            return false;
        }

        // Per-service daily budget (rolling 24h), mirroring the server fence.
        uint256 sSpent = s.spentToday;
        uint64 sReset = s.lastResetTime;
        if (s.dailyCap != 0) {
            if (block.timestamp >= uint256(sReset) + DAY) {
                sSpent = 0;
                sReset = uint64(block.timestamp);
            }
            if (sSpent + amount > s.dailyCap) {
                emit AgentActionBlocked(agent, target, token, amount, "exceeds service dailyCap");
                return false;
            }
        }
        if (usedAction[actionId]) {
            emit AgentActionBlocked(agent, target, token, amount, "duplicate action");
            return false;
        }

        usedAction[actionId] = true;
        p.spentToday = uint128(spent + amount);
        p.lastResetTime = resetTime;
        s.spentToday = uint128(sSpent + amount);
        s.lastResetTime = sReset;

        if (token == NATIVE) {
            (bool ok,) = target.call{value: amount}(data);
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(target, amount);
        }

        emit AgentActionApproved(agent, target, token, amount, actionId);
        emit ReceiptIssued(agent, target, token, amount, actionId, block.timestamp);
        return true;
    }

    // ---------------------------------------------------------------------
    // Owner withdrawal
    // ---------------------------------------------------------------------

    /// @notice Owner can withdraw any ERC20 token held by the vault.
    function withdrawTokens(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getPolicy(address agent) external view returns (Policy memory) {
        return policies[agent];
    }

    function remainingDailyCap(address agent) external view returns (uint256) {
        Policy memory p = policies[agent];
        uint256 spent = p.spentToday;
        if (block.timestamp >= uint256(p.lastResetTime) + DAY) {
            spent = 0;
        }
        if (spent >= p.dailyCap) {
            return 0;
        }
        return p.dailyCap - spent;
    }

    function getService(address agent, address target) external view returns (ServiceAllowlist memory) {
        return serviceAllowlist[agent][target];
    }

    function remainingServiceDailyCap(address agent, address target) external view returns (uint256) {
        ServiceAllowlist memory s = serviceAllowlist[agent][target];
        if (s.dailyCap == 0) return type(uint256).max;
        uint256 spent = s.spentToday;
        if (block.timestamp >= uint256(s.lastResetTime) + DAY) {
            spent = 0;
        }
        if (spent >= s.dailyCap) {
            return 0;
        }
        return s.dailyCap - spent;
    }

    function isAllowed(address agent, address target, address token) external view returns (bool) {
        return serviceAllowlist[agent][target].allowed && allowedToken[agent][token];
    }
}
