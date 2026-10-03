// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PulseAutomation
/// @notice Enforces capped, expiring, recipient-restricted transfer permissions.
///         The AI / backend never holds custody or unrestricted authority — every
///         execution is checked against the on-chain permission recorded here.
///         This is deliberately minimal for the hackathon MVP: one action type
///         (recurring conditional transfer), one asset per permission.
contract PulseAutomation is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { Active, Paused, Cancelled, Expired }

    struct Permission {
        address owner;           // user who granted the permission
        address asset;           // ERC20 token address (e.g. USDC)
        address recipient;       // sole allowed destination
        uint256 maxPerExecution; // cap per single execution
        uint256 maxPerWindow;    // cap within one window of `windowSeconds`
        uint256 windowSeconds;   // fixed window length (e.g. 7 days)
        uint256 expiresAt;       // unix timestamp
        uint256 windowStart;     // start of current window; resets on the first execute() after it elapses
        uint256 spentInWindow;   // amount spent so far in current window
        Status status;
    }

    /// @notice address authorized to trigger executions on behalf of users
    ///         (the automation worker / keeper). This address can NEVER move
    ///         funds outside what a given permission allows — it can only
    ///         invoke execute(), which re-checks everything on-chain.
    address public executor;

    uint256 public nextPermissionId;
    mapping(uint256 => Permission) public permissions;

    event PermissionCreated(
        uint256 indexed id,
        address indexed owner,
        address asset,
        address recipient,
        uint256 maxPerExecution,
        uint256 maxPerWindow,
        uint256 windowSeconds,
        uint256 expiresAt
    );
    event PermissionPaused(uint256 indexed id);
    event PermissionResumed(uint256 indexed id);
    event PermissionCancelled(uint256 indexed id);
    event Executed(uint256 indexed id, uint256 amount, address recipient);
    event ExecutionRejected(uint256 indexed id, string reason);
    event ExecutorUpdated(address indexed newExecutor);

    modifier onlyExecutor() {
        require(msg.sender == executor, "Pulse: caller is not executor");
        _;
    }

    constructor(address _executor) Ownable(msg.sender) {
        executor = _executor;
    }

    function setExecutor(address _executor) external onlyOwner {
        executor = _executor;
        emit ExecutorUpdated(_executor);
    }

    /// @notice Create a new capped, expiring transfer permission.
    /// @dev The caller must have already approved this contract to spend
    ///      at least `maxPerWindow` of `asset` on their behalf (standard
    ///      ERC20 allowance). This contract never takes custody up front —
    ///      it pulls funds only at execution time, within the cap.
    function createPermission(
        address asset,
        address recipient,
        uint256 maxPerExecution,
        uint256 maxPerWindow,
        uint256 windowSeconds,
        uint256 expiresAt
    ) external returns (uint256 id) {
        require(asset != address(0), "Pulse: bad asset");
        require(recipient != address(0), "Pulse: bad recipient");
        require(maxPerExecution > 0 && maxPerExecution <= maxPerWindow, "Pulse: bad caps");
        require(windowSeconds > 0, "Pulse: bad window");
        require(expiresAt > block.timestamp, "Pulse: already expired");

        id = nextPermissionId++;
        permissions[id] = Permission({
            owner: msg.sender,
            asset: asset,
            recipient: recipient,
            maxPerExecution: maxPerExecution,
            maxPerWindow: maxPerWindow,
            windowSeconds: windowSeconds,
            expiresAt: expiresAt,
            windowStart: block.timestamp,
            spentInWindow: 0,
            status: Status.Active
        });

        emit PermissionCreated(
            id, msg.sender, asset, recipient,
            maxPerExecution, maxPerWindow, windowSeconds, expiresAt
        );
    }

    /// @notice Called by the executor/worker when a trigger condition fires.
    ///         Every constraint is re-verified here — the worker's job is only
    ///         to decide *when* to call this, never *whether* it's allowed.
    function execute(uint256 id, uint256 amount) external onlyExecutor nonReentrant {
        Permission storage p = permissions[id];
        require(p.owner != address(0), "Pulse: unknown permission");

        if (p.status == Status.Cancelled) {
            emit ExecutionRejected(id, "Permission cancelled");
            return;
        }
        if (p.status == Status.Paused) {
            emit ExecutionRejected(id, "Permission paused");
            return;
        }
        if (block.timestamp >= p.expiresAt) {
            p.status = Status.Expired;
            emit ExecutionRejected(id, "Permission expired");
            return;
        }
        if (amount == 0) {
            emit ExecutionRejected(id, "Amount is zero");
            return;
        }
        if (amount > p.maxPerExecution) {
            emit ExecutionRejected(id, "Amount exceeds per-execution limit");
            return;
        }

        // Fixed window (not a true sliding window): once windowSeconds has elapsed
        // the counter resets. A user can therefore see up to 2x maxPerWindow leave
        // within a short span straddling a boundary. Documented + tested.
        if (block.timestamp >= p.windowStart + p.windowSeconds) {
            p.windowStart = block.timestamp;
            p.spentInWindow = 0;
        }

        if (p.spentInWindow + amount > p.maxPerWindow) {
            emit ExecutionRejected(id, "Amount exceeds weekly spending limit");
            return;
        }

        p.spentInWindow += amount;

        IERC20(p.asset).safeTransferFrom(p.owner, p.recipient, amount);

        emit Executed(id, amount, p.recipient);
    }

    function pause(uint256 id) external {
        Permission storage p = permissions[id];
        require(p.owner == msg.sender, "Pulse: not owner");
        require(p.status == Status.Active, "Pulse: not active");
        p.status = Status.Paused;
        emit PermissionPaused(id);
    }

    function resume(uint256 id) external {
        Permission storage p = permissions[id];
        require(p.owner == msg.sender, "Pulse: not owner");
        require(p.status == Status.Paused, "Pulse: not paused");
        require(block.timestamp < p.expiresAt, "Pulse: expired");
        p.status = Status.Active;
        emit PermissionResumed(id);
    }

    /// @notice Permanently revokes the permission. This is the real
    ///         cancellation — the UI must reflect this, not a soft DB flag.
    function cancel(uint256 id) external {
        Permission storage p = permissions[id];
        require(p.owner == msg.sender, "Pulse: not owner");
        require(p.status != Status.Cancelled, "Pulse: already cancelled");
        p.status = Status.Cancelled;
        emit PermissionCancelled(id);
    }

    function getPermission(uint256 id) external view returns (Permission memory) {
        return permissions[id];
    }
}
