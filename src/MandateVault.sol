// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MandateVault
/// @notice Org-level treasury vault for AI agents on BOT Chain.
/// @dev    One vault holds one org's funds and serves N registered agents. Every agent has its
///         own policy (per-tx cap, daily cap, expiry, approval threshold, active flag) and its
///         own recipient allowlist with optional per-recipient budgets.
///
///         Spend lifecycle is request -> approve -> execute. A spend is never a single
///         agent-signed transaction:
///           1. an agent (or the org's executor) calls `requestSpend`, which validates the
///              policy and parks a request with a caller-supplied idempotency key;
///           2. `approvalThreshold` distinct approvers sign `approve(requestId)` on-chain;
///           3. anyone holding the executor role calls `execute(requestId)`, which re-checks
///              the whole policy atomically before moving funds.
///
///         Because approval is an on-chain state transition and `execute` refuses anything not
///         `Approved`, no off-plane component - including this project's own backend - can
///         skip or forge approval. Executors hold gas, never custody.
///
///         Accounting is uint256 throughout so no spend total can be truncated by a narrowing
///         cast, and `maxPerTx`/`dailyCap` of 0 means "cannot spend" rather than "unlimited".
contract MandateVault {
    using SafeERC20 for IERC20;

    /// @dev Sentinel token address representing the chain's native asset (tBOT on BOT Chain).
    address public constant NATIVE = address(0);

    uint256 public constant DAY = 1 days;

    enum RequestStatus {
        None,
        Pending,
        Approved,
        Rejected,
        Executed,
        Cancelled,
        Expired
    }

    struct Policy {
        uint256 maxPerTx;
        uint256 dailyCap;
        uint256 spentToday;
        uint64 lastResetTime;
        uint64 expiry;
        uint8 approvalThreshold;
        bool active;
    }

    /// @dev Per-recipient budget. Caps apply only when `maxPerTx != 0`; `dailyCap` is then
    ///      either 0 (no per-recipient daily cap) or >= maxPerTx. The agent's global policy
    ///      always backstops a recipient entry, including when its own caps are unset.
    struct ServicePolicy {
        bool allowed;
        string label;
        uint256 maxPerTx;
        uint256 dailyCap;
        uint256 spentToday;
        uint64 lastResetTime;
        uint64 expiry;
    }

    struct Request {
        address agent;
        address token;
        address target;
        uint256 amount;
        uint64 requestedAt;
        uint64 expiresAt;
        uint8 approvals;
        RequestStatus status;
    }

    /// @notice Org controller. May be an EOA, a multisig, or an ERC-4337 smart account.
    address public immutable owner;

    bool internal _locked;
    bool public paused;

    mapping(address agent => bool) public agents;
    mapping(address approver => bool) public approvers;
    mapping(address executor => bool) public executors;
    mapping(address agent => Policy) public policies;
    mapping(address agent => mapping(address target => ServicePolicy)) public services;
    mapping(address agent => mapping(address token => bool)) public allowedTokens;
    mapping(bytes32 requestId => Request) public requests;
    mapping(bytes32 requestId => mapping(address approver => bool)) public approvedBy;

    event VaultFunded(address indexed from, address indexed token, uint256 amount);
    event AgentSet(address indexed agent, bool enabled);
    event ApproverSet(address indexed approver, bool enabled);
    event ExecutorSet(address indexed executor, bool enabled);
    event PausedSet(bool paused);

    event PolicyUpdated(
        address indexed agent, uint256 maxPerTx, uint256 dailyCap, uint64 expiry, uint8 approvalThreshold, bool active
    );

    event ServiceAllowlisted(
        address indexed agent,
        address indexed target,
        string label,
        uint256 maxPerTx,
        uint256 dailyCap,
        uint64 expiry,
        bool allowed
    );

    event TokenAllowlisted(address indexed agent, address indexed token, bool allowed);
    event TokensWithdrawn(address indexed token, address indexed to, uint256 amount);

    event SpendRequested(
        bytes32 indexed requestId,
        address indexed agent,
        address indexed target,
        address token,
        uint256 amount,
        uint64 expiresAt,
        bool autoApproved
    );

    event RequestApproved(bytes32 indexed requestId, address indexed approver, uint8 approvals, uint8 threshold);
    event RequestRejected(bytes32 indexed requestId, address indexed approver, string reason);
    event RequestCancelled(bytes32 indexed requestId, address indexed by);
    event RequestExpired(bytes32 indexed requestId);

    event RequestExecuted(
        bytes32 indexed requestId,
        address indexed agent,
        address indexed target,
        address token,
        uint256 amount,
        address executor
    );

    event ReceiptIssued(
        bytes32 indexed requestId,
        address indexed agent,
        address indexed target,
        address token,
        uint256 amount,
        uint256 timestamp
    );

    error NotOwner();
    error NotAgent();
    error NotApprover();
    error NotAuthorized();
    error NotRegistered();
    error Reentrancy();
    error Paused();
    error ZeroAmount();
    error InvalidPolicy();
    error InvalidApproval();
    error UnknownRequest();
    error RequestNotPending();
    error RequestNotApproved();
    error RequestFinalized();
    error DeadlinePassed();
    error IdempotencyConflict();
    error AlreadyApproved();
    error NativeTransferFailed();
    error InsufficientBalance();
    /// @notice A policy or recipient expiry was set to a moment already in the past.
    error ExpiryInPast();

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

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    /// @dev Reject an expiry that has already elapsed.
    ///
    ///      0 means "never" and is always allowed. Anything else must be in the future: writing a
    ///      past timestamp produces a policy that silently refuses every future request with
    ///      DeadlinePassed, so the owner sees an agent that looks configured and cannot spend, and
    ///      the only symptom is a failing request. Catching it at write time turns a confusing
    ///      runtime failure into an immediate, named error.
    function _requireFutureExpiry(uint64 expiry) internal view {
        if (expiry != 0 && expiry < block.timestamp) revert ExpiryInPast();
    }

    /// @param maxPerTx Per-transaction cap in base units (6 decimals for tUSDT). 0 denies spends.
    /// @param approvalThreshold Distinct approvers required before a request can execute.
    ///                         0 means auto-approve on request.
    constructor(
        address owner_,
        address executor_,
        uint256 maxPerTx,
        uint256 dailyCap,
        uint64 expiry,
        uint8 approvalThreshold
    ) {
        if (owner_ == address(0)) revert NotOwner();
        if (maxPerTx > dailyCap) revert InvalidPolicy();
        _requireFutureExpiry(expiry);

        owner = owner_;
        if (executor_ != address(0)) executors[executor_] = true;

        // The org wallet doubles as the first agent so a treasury is usable immediately.
        agents[owner_] = true;
        policies[owner_] = Policy({
            maxPerTx: maxPerTx,
            dailyCap: dailyCap,
            spentToday: 0,
            lastResetTime: uint64(block.timestamp),
            expiry: expiry,
            approvalThreshold: approvalThreshold,
            active: true
        });
    }

    receive() external payable {
        emit VaultFunded(msg.sender, NATIVE, msg.value);
    }

    /// @notice Pull `amount` of `token` from the caller into the vault.
    function deposit(address token, uint256 amount) external whenNotPaused {
        if (token == NATIVE) revert InvalidPolicy();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit VaultFunded(msg.sender, token, amount);
    }

    // ---------------------------------------------------------------------
    // Configuration (org only)
    // ---------------------------------------------------------------------

    /// @notice Register or deregister an agent. A deregistered agent keeps its history but can
    ///         neither request nor execute spends.
    function setAgent(address agent, bool enabled) external onlyOwner {
        if (agent == address(0)) revert NotAgent();
        agents[agent] = enabled;
        emit AgentSet(agent, enabled);
    }

    function setApprover(address approver, bool enabled) external onlyOwner {
        if (approver == address(0)) revert NotApprover();
        approvers[approver] = enabled;
        emit ApproverSet(approver, enabled);
    }

    /// @notice Executor role pays gas for `execute`. It cannot change policy, approve, or
    ///         withdraw: it can only execute requests the approvers already authorised.
    function setExecutor(address executor, bool enabled) external onlyOwner {
        if (executor == address(0)) revert NotAuthorized();
        executors[executor] = enabled;
        emit ExecutorSet(executor, enabled);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    /// @notice Update an agent's leash. `maxPerTx` and `dailyCap` are in base units of the
    ///         settlement token (6 for tUSDT). A zero cap denies all spends, which is the safe
    ///         default for a newly registered agent.
    function setAgentPolicy(
        address agent,
        uint256 maxPerTx,
        uint256 dailyCap,
        uint64 expiry,
        uint8 approvalThreshold,
        bool active
    ) external onlyOwner {
        if (agent == address(0)) revert NotAgent();
        if (maxPerTx > dailyCap) revert InvalidPolicy();
        _requireFutureExpiry(expiry);

        Policy storage p = policies[agent];
        p.maxPerTx = maxPerTx;
        p.dailyCap = dailyCap;
        p.expiry = expiry;
        p.approvalThreshold = approvalThreshold;
        p.active = active;
        if (p.lastResetTime == 0) p.lastResetTime = uint64(block.timestamp);

        emit PolicyUpdated(agent, maxPerTx, dailyCap, expiry, approvalThreshold, active);
    }

    /// @notice Allow or remove a recipient for an agent. Caps apply only when `maxPerTx != 0`.
    function setAllowedService(
        address agent,
        address target,
        string calldata label,
        uint256 maxPerTx,
        uint256 dailyCap,
        uint64 expiry,
        bool allowed
    ) external onlyOwner {
        if (agent == address(0)) revert NotAgent();
        if (target == address(0)) revert InvalidPolicy();
        if (maxPerTx != 0 && dailyCap != 0 && maxPerTx > dailyCap) revert InvalidPolicy();
        _requireFutureExpiry(expiry);

        ServicePolicy storage s = services[agent][target];
        s.allowed = allowed;
        s.label = label;
        s.maxPerTx = maxPerTx;
        s.dailyCap = dailyCap;
        s.expiry = expiry;
        s.lastResetTime = uint64(block.timestamp);
        if (!allowed) s.spentToday = 0;

        emit ServiceAllowlisted(agent, target, label, maxPerTx, dailyCap, expiry, allowed);
    }

    function setAllowedToken(address agent, address token, bool allowed) external onlyOwner {
        if (agent == address(0)) revert NotAgent();
        allowedTokens[agent][token] = allowed;
        emit TokenAllowlisted(agent, token, allowed);
    }

    /// @notice Org treasury withdrawal. Not reachable by agents, approvers, or executors.
    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidPolicy();
        if (token == NATIVE) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit TokensWithdrawn(token, to, amount);
    }

    // ---------------------------------------------------------------------
    // Spend lifecycle
    // ---------------------------------------------------------------------

    /// @notice Park a spend request for human approval.
    /// @param agent          Registered agent the spend belongs to.
    /// @param token          Settlement token, or NATIVE for tBOT.
    /// @param target         Recipient.
    /// @param amount         Amount in base units. Must be strictly positive.
    /// @param idempotencyKey Caller-supplied unique key. Replaying with identical parameters
    ///                       returns the same `requestId` instead of duplicating; replaying
    ///                       with different parameters reverts with `IdempotencyConflict`.
    ///                       Once a request is terminal, the same key keeps returning that same
    ///                       terminal request, so a retry meant to be reconsidered must use a
    ///                       new key.
    /// @param expiresAt      Unix deadline for approval and execution, or 0 for the default
    ///                       24h window.
    /// @return requestId     Deterministic id derived from the parameters and key.
    function requestSpend(
        address agent,
        address token,
        address target,
        uint256 amount,
        bytes32 idempotencyKey,
        uint64 expiresAt
    ) external nonReentrant whenNotPaused returns (bytes32 requestId) {
        return _request(agent, token, target, amount, idempotencyKey, expiresAt);
    }

    /// @notice Request and execute in one call, but only for agents whose policy requires no
    ///         approval. Reverts for any agent with `approvalThreshold != 0`, so auto-approval
    ///         can never be smuggled past a required human sign-off.
    function requestAndExecute(
        address agent,
        address token,
        address target,
        uint256 amount,
        bytes32 idempotencyKey,
        uint64 expiresAt
    ) external nonReentrant whenNotPaused returns (bytes32 requestId) {
        if (policies[agent].approvalThreshold != 0) revert InvalidApproval();
        requestId = _request(agent, token, target, amount, idempotencyKey, expiresAt);
        _execute(requestId);
    }

    /// @notice Record one human approval. When the configured threshold is reached the request
    ///         becomes executable. Per-address and idempotent.
    function approve(bytes32 requestId) external nonReentrant {
        if (msg.sender != owner && !approvers[msg.sender]) revert NotApprover();

        Request storage r = requests[requestId];
        if (r.status == RequestStatus.None) revert UnknownRequest();
        if (r.status != RequestStatus.Pending) {
            if (_isTerminal(r.status)) revert RequestFinalized();
            revert RequestNotPending();
        }
        if (r.expiresAt != 0 && block.timestamp > r.expiresAt) revert DeadlinePassed();
        if (approvedBy[requestId][msg.sender]) revert AlreadyApproved();

        uint8 threshold = policies[r.agent].approvalThreshold;
        if (threshold == 0) revert InvalidApproval();

        approvedBy[requestId][msg.sender] = true;
        r.approvals = r.approvals + 1;
        if (r.approvals >= threshold) r.status = RequestStatus.Approved;

        emit RequestApproved(requestId, msg.sender, r.approvals, threshold);
    }

    /// @notice Reject a pending request. Terminal.
    function reject(bytes32 requestId, string calldata reason) external nonReentrant {
        if (msg.sender != owner && !approvers[msg.sender]) revert NotApprover();

        Request storage r = requests[requestId];
        if (r.status == RequestStatus.None) revert UnknownRequest();
        if (r.status != RequestStatus.Pending) revert RequestFinalized();

        r.status = RequestStatus.Rejected;
        emit RequestRejected(requestId, msg.sender, reason);
    }

    /// @notice Withdraw a request that is Pending or Approved but no longer wanted.
    function cancel(bytes32 requestId) external nonReentrant {
        Request storage r = requests[requestId];
        if (r.status == RequestStatus.None) revert UnknownRequest();
        if (r.status == RequestStatus.Executed || r.status == RequestStatus.Rejected) revert RequestFinalized();

        if (msg.sender != owner && msg.sender != r.agent && !approvers[msg.sender]) revert NotAuthorized();

        r.status = RequestStatus.Cancelled;
        emit RequestCancelled(requestId, msg.sender);
    }

    /// @notice Mark a stale request Expired. The idempotency key stays bound to this request for
    ///         good, so a retry that should be reconsidered must be filed under a new key.
    function expireRequest(bytes32 requestId) external nonReentrant {
        Request storage r = requests[requestId];
        if (r.status == RequestStatus.None) revert UnknownRequest();
        if (r.status != RequestStatus.Pending && r.status != RequestStatus.Approved) revert RequestFinalized();
        if (r.expiresAt == 0 || block.timestamp <= r.expiresAt) revert InvalidPolicy();

        r.status = RequestStatus.Expired;
        emit RequestExpired(requestId);
    }

    /// @notice Settle an approved request. Callable by an executor, the org, or the agent itself,
    ///         because authority comes from the on-chain approval rather than from the caller.
    function execute(bytes32 requestId) external nonReentrant whenNotPaused returns (bool) {
        _requireCanExecute(msg.sender, requests[requestId].agent);
        _execute(requestId);
        return true;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _request(
        address agent,
        address token,
        address target,
        uint256 amount,
        bytes32 idempotencyKey,
        uint64 expiresAt
    ) internal returns (bytes32 requestId) {
        if (msg.sender != agent && msg.sender != owner && !executors[msg.sender]) {
            revert NotAuthorized();
        }
        if (!agents[agent]) revert NotRegistered();

        requestId = computeRequestId(idempotencyKey);

        Request storage r = requests[requestId];
        if (r.status != RequestStatus.None) {
            // The key is a primary key: an exact replay is a no-op, a replay with different
            // parameters is a client bug and must not silently mint a second spend.
            if (r.agent == agent && r.token == token && r.target == target && r.amount == amount) {
                return requestId;
            }
            revert IdempotencyConflict();
        }

        _validate(agent, token, target, amount);

        uint64 deadline = expiresAt == 0 ? uint64(block.timestamp) + uint64(DAY) : expiresAt;
        if (deadline <= block.timestamp) revert DeadlinePassed();

        bool autoApproved = policies[agent].approvalThreshold == 0;

        r.agent = agent;
        r.token = token;
        r.target = target;
        r.amount = amount;
        r.requestedAt = uint64(block.timestamp);
        r.expiresAt = deadline;
        r.approvals = 0;
        r.status = autoApproved ? RequestStatus.Approved : RequestStatus.Pending;

        emit SpendRequested(requestId, agent, target, token, amount, deadline, autoApproved);
    }

    function _execute(bytes32 requestId) internal {
        Request storage r = requests[requestId];
        if (r.status == RequestStatus.None) revert UnknownRequest();
        if (r.status != RequestStatus.Approved) {
            if (r.status == RequestStatus.Executed) revert RequestFinalized();
            revert RequestNotApproved();
        }
        if (r.expiresAt != 0 && block.timestamp > r.expiresAt) revert DeadlinePassed();

        // Re-validate the entire policy: caps, expiry, allowlists, and balance may all have
        // changed since the request, so a stale approval can never over-spend.
        _validate(r.agent, r.token, r.target, r.amount);

        // The live policy is authoritative at settlement, not the policy that happened to be in
        // force when the request was filed. Tightening `approvalThreshold` after the fact must
        // immediately bind in-flight requests, otherwise a request auto-approved under a
        // threshold of 0 could still spend once the org decided humans must sign off.
        uint8 currentThreshold = policies[r.agent].approvalThreshold;
        if (currentThreshold != 0 && r.approvals < currentThreshold) revert RequestNotApproved();

        // Effects before interactions: the request becomes terminal and both budget scopes are
        // charged before any token leaves, so a re-entrant or reverting transfer cannot
        // double-spend.
        r.status = RequestStatus.Executed;
        _consumeBudget(r.agent, r.target, r.amount);

        if (r.token == NATIVE) {
            (bool ok,) = payable(r.target).call{value: r.amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(r.token).safeTransfer(r.target, r.amount);
        }

        emit RequestExecuted(requestId, r.agent, r.target, r.token, r.amount, msg.sender);
        emit ReceiptIssued(requestId, r.agent, r.target, r.token, r.amount, block.timestamp);
    }

    /// @notice Deterministic request id for an idempotency key. Cheap enough for a client to call
    ///         before submitting, and scoped to this vault so keys never collide across orgs.
    function computeRequestId(bytes32 idempotencyKey) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), idempotencyKey));
    }

    /// @notice Pure policy fence with a specific error per rule, so callers learn exactly which
    ///         rule stopped them instead of parsing opaque revert strings off-chain.
    /// @dev    Reverts are not indexable, so off-chain mirrors must record blocks themselves.
    function _validate(address agent, address token, address target, uint256 amount) internal view {
        if (amount == 0) revert ZeroAmount();

        Policy storage p = policies[agent];
        if (!p.active || !agents[agent]) revert NotRegistered();
        if (p.maxPerTx == 0 || p.dailyCap == 0) revert InvalidPolicy();
        if (p.expiry != 0 && block.timestamp > p.expiry) revert DeadlinePassed();
        if (!allowedTokens[agent][token]) revert NotAuthorized();

        ServicePolicy storage s = services[agent][target];
        if (!s.allowed) revert NotAuthorized();
        if (s.expiry != 0 && block.timestamp > s.expiry) revert DeadlinePassed();
        if (s.maxPerTx != 0 && amount > s.maxPerTx) revert InvalidPolicy();
        if (amount > p.maxPerTx) revert InvalidPolicy();

        if (_effectiveSpent(p.lastResetTime, p.spentToday) + amount > p.dailyCap) revert InvalidPolicy();

        // A recipient entry carries a daily cap only when one was set; `dailyCap == 0` means the
        // agent's own global policy is the only daily ceiling for this recipient.
        if (s.maxPerTx != 0 && s.dailyCap != 0) {
            if (_effectiveSpent(s.lastResetTime, s.spentToday) + amount > s.dailyCap) revert InvalidPolicy();
        }

        uint256 balance = token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
        if (balance < amount) revert InsufficientBalance();
    }

    /// @dev Day-window spend with roll-forward applied in memory.
    function _effectiveSpent(uint64 lastResetTime, uint256 spent) internal view returns (uint256) {
        if (block.timestamp >= uint256(lastResetTime) + DAY) return 0;
        return spent;
    }

    /// @dev States from which no further transition is possible.
    function _isTerminal(RequestStatus status) internal pure returns (bool) {
        return status == RequestStatus.Executed || status == RequestStatus.Rejected || status == RequestStatus.Cancelled
            || status == RequestStatus.Expired;
    }

    /// @dev Charge a settled spend against both budget scopes. Validation must precede this.
    function _consumeBudget(address agent, address target, uint256 amount) internal {
        Policy storage p = policies[agent];
        uint256 spent = _effectiveSpent(p.lastResetTime, p.spentToday);
        if (block.timestamp >= uint256(p.lastResetTime) + DAY) {
            p.lastResetTime = uint64(block.timestamp);
        }
        p.spentToday = spent + amount;

        ServicePolicy storage s = services[agent][target];
        if (s.maxPerTx != 0) {
            uint256 sSpent = _effectiveSpent(s.lastResetTime, s.spentToday);
            if (block.timestamp >= uint256(s.lastResetTime) + DAY) {
                s.lastResetTime = uint64(block.timestamp);
            }
            s.spentToday = sSpent + amount;
        }
    }

    function _requireCanExecute(address caller, address agent) internal view {
        if (caller == owner || executors[caller]) return;
        if (caller == agent && agents[agent]) return;
        revert NotAuthorized();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getPolicy(address agent) external view returns (Policy memory) {
        return policies[agent];
    }

    function getService(address agent, address target) external view returns (ServicePolicy memory) {
        return services[agent][target];
    }

    function getRequest(bytes32 requestId) external view returns (Request memory) {
        return requests[requestId];
    }

    function getRequestStatus(bytes32 requestId) external view returns (RequestStatus) {
        return requests[requestId].status;
    }

    function hasApproved(bytes32 requestId, address approver) external view returns (bool) {
        return approvedBy[requestId][approver];
    }

    /// @notice Remaining global daily allowance, or 0 when the agent cannot spend.
    function remainingDailyCap(address agent) external view returns (uint256) {
        Policy memory p = policies[agent];
        if (p.maxPerTx == 0 || p.dailyCap == 0 || !p.active || !agents[agent]) return 0;
        uint256 spent = _effectiveSpent(p.lastResetTime, p.spentToday);
        if (spent >= p.dailyCap) return 0;
        return p.dailyCap - spent;
    }

    /// @notice Remaining per-recipient daily allowance, or `type(uint256).max` when the recipient
    ///         carries no per-recipient daily cap. 0 when the recipient is not allowed.
    function remainingRecipientDailyCap(address agent, address target) external view returns (uint256) {
        ServicePolicy memory s = services[agent][target];
        if (!s.allowed) return 0;
        if (s.maxPerTx == 0 || s.dailyCap == 0) return type(uint256).max;
        uint256 spent = _effectiveSpent(s.lastResetTime, s.spentToday);
        if (spent >= s.dailyCap) return 0;
        return s.dailyCap - spent;
    }

    /// @notice True when a request can be settled right now, under the policy in force at this
    ///         moment rather than the one in force when it was filed.
    function isExecutable(bytes32 requestId) external view returns (bool) {
        Request memory r = requests[requestId];
        if (r.status != RequestStatus.Approved) return false;
        if (r.expiresAt != 0 && block.timestamp > r.expiresAt) return false;

        Policy memory p = policies[r.agent];
        if (!agents[r.agent] || !p.active) return false;
        if (p.approvalThreshold != 0 && r.approvals < p.approvalThreshold) return false;
        return true;
    }
}
