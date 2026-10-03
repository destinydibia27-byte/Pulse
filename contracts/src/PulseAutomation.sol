// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PulseAutomation
/// @notice Enforces capped, expiring, recipient-restricted, SCHEDULED and
///         CONDITIONAL transfer permissions. The AI / backend never holds
///         custody or unrestricted authority — every execution is checked
///         against the on-chain permission recorded here, including WHEN it
///         may run and WHETHER the balance condition holds, not just the
///         amount and recipient.
///
/// @dev Trust model: the `executor` role decides only when to CALL execute().
///      It cannot cause a transfer on the wrong day, with the condition unmet,
///      more than once per day, above the caps, to the wrong recipient, or
///      after cancellation/expiry/pause — every one of those is checked here,
///      independent of what the executor claims. Compare this to the MVP's
///      first version, where the schedule and condition were enforced only by
///      the off-chain worker; a compromised or buggy worker could previously
///      fire on any day the caps allowed. That gap is closed as of this
///      version. See `test_trustBoundary_*` in the test suite for what is
///      and isn't guaranteed.
///
///      Day-of-week is evaluated in UTC (from block.timestamp), not in the
///      automation's display timezone — there is no reliable on-chain source
///      of a user's local timezone. An off-chain "Every Friday (Africa/Lagos)"
///      convenience check may occasionally disagree with the UTC check for a
///      window of a few hours around a local day boundary; the on-chain UTC
///      check is authoritative in that case, and a rejected attempt is simply
///      retried the next scheduled day. See README for the full explanation.
contract PulseAutomation is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { Active, Paused, Cancelled, Expired }

    /// @notice Comparison applied to the owner's live balance of `asset`.
    enum Op { GT, GTE, LT, LTE, EQ }

    struct Permission {
        address owner;           // user who granted the permission
        address asset;           // ERC20 token address (e.g. USDC)
        address recipient;       // sole allowed destination
        uint256 maxPerExecution; // cap per single execution
        uint256 maxPerWindow;    // cap within one window of `windowSeconds`
        uint256 windowSeconds;   // fixed window length (e.g. 7 days)
        uint256 expiresAt;       // unix timestamp
        uint256 windowStart;     // 00:00 UTC of the day the current window began; resets on the first execute() after it elapses
        uint256 spentInWindow;   // amount spent so far in current window
        Status status;
        uint8 weekday;           // 0=Sunday..6=Saturday, UTC (epoch formula below)
        Op conditionOp;          // how the owner's balance is compared to conditionThreshold
        uint256 conditionThreshold; // in `asset`'s base units
        uint256 lastExecutionDay;   // UTC day index (timestamp/1 days) of the last SUCCESSFUL send; sentinel = NEVER_EXECUTED
    }

    uint256 private constant NEVER_EXECUTED = type(uint256).max;

    /// @notice address authorized to trigger executions on behalf of users
    ///         (the automation worker / keeper). This address can NEVER move
    ///         funds outside what a given permission allows, on a day it
    ///         isn't scheduled, or while its condition is unmet — it can only
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
        uint256 expiresAt,
        uint8 weekday,
        Op conditionOp,
        uint256 conditionThreshold
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

    /// @dev UTC weekday per the standard Unix-epoch formula: Jan 1 1970 was a
    ///      Thursday, so weekday = (daysSinceEpoch + 4) % 7, with 0 = Sunday.
    function _currentWeekday() internal view returns (uint8) {
        uint256 daysSinceEpoch = block.timestamp / 1 days;
        return uint8((daysSinceEpoch + 4) % 7);
    }

    function _currentDayIndex() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function _compare(uint256 a, Op op, uint256 b) internal pure returns (bool) {
        if (op == Op.GT) return a > b;
        if (op == Op.GTE) return a >= b;
        if (op == Op.LT) return a < b;
        if (op == Op.LTE) return a <= b;
        return a == b; // Op.EQ
    }

    /// @notice Create a new capped, expiring, scheduled, conditional transfer permission.
    /// @dev The caller must have already approved this contract to spend
    ///      at least `maxPerWindow` of `asset` on their behalf (standard
    ///      ERC20 allowance). This contract never takes custody up front —
    ///      it pulls funds only at execution time, within the cap.
    /// @param weekday 0=Sunday..6=Saturday (UTC). The permission may only
    ///        execute successfully on this UTC weekday.
    function createPermission(
        address asset,
        address recipient,
        uint256 maxPerExecution,
        uint256 maxPerWindow,
        uint256 windowSeconds,
        uint256 expiresAt,
        uint8 weekday,
        Op conditionOp,
        uint256 conditionThreshold
    ) external returns (uint256 id) {
        require(asset != address(0), "Pulse: bad asset");
        require(recipient != address(0), "Pulse: bad recipient");
        require(maxPerExecution > 0 && maxPerExecution <= maxPerWindow, "Pulse: bad caps");
        require(windowSeconds > 0, "Pulse: bad window");
        require(expiresAt > block.timestamp, "Pulse: already expired");
        require(weekday <= 6, "Pulse: bad weekday");

        id = nextPermissionId++;
        permissions[id] = Permission({
            owner: msg.sender,
            asset: asset,
            recipient: recipient,
            maxPerExecution: maxPerExecution,
            maxPerWindow: maxPerWindow,
            windowSeconds: windowSeconds,
            expiresAt: expiresAt,
            windowStart: _dayStart(block.timestamp),
            spentInWindow: 0,
            status: Status.Active,
            weekday: weekday,
            conditionOp: conditionOp,
            conditionThreshold: conditionThreshold,
            lastExecutionDay: NEVER_EXECUTED
        });

        emit PermissionCreated(
            id, msg.sender, asset, recipient,
            maxPerExecution, maxPerWindow, windowSeconds, expiresAt,
            weekday, conditionOp, conditionThreshold
        );
    }

    /// @notice Called by the executor/worker when it believes a permission is
    ///         due. Every constraint is re-verified here — the worker's job is
    ///         only to decide when to ATTEMPT this call, never whether the
    ///         attempt is allowed to succeed. Rejections are reported via
    ///         `ExecutionRejected` and the call returns normally (does not
    ///         revert), so a rejected attempt is still a mined transaction;
    ///         callers must read the events, not just the receipt status.
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
        if (_currentWeekday() != p.weekday) {
            emit ExecutionRejected(id, "Not the scheduled day (UTC)");
            return;
        }

        uint256 today = _currentDayIndex();
        if (p.lastExecutionDay == today) {
            emit ExecutionRejected(id, "Already executed for this UTC day");
            return;
        }

        uint256 balance = IERC20(p.asset).balanceOf(p.owner);
        if (!_compare(balance, p.conditionOp, p.conditionThreshold)) {
            emit ExecutionRejected(id, "Balance condition not met");
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
        // within a short span straddling a boundary. Documented + tested. In
        // practice the once-per-UTC-day gate above means this can only be reached
        // by two sends on different days within the same window, never two sends
        // on the same day.
        //
        // Windows start at 00:00 UTC of a day, never at the exact second of a send.
        // The schedule is "a weekday", so if the window were anchored to the time of
        // day of the last send, a 15:00 send one Friday would leave the next Friday's
        // 00:01 attempt still inside the old window and wrongly refused.
        if (block.timestamp >= p.windowStart + p.windowSeconds) {
            p.windowStart = _dayStart(block.timestamp);
            p.spentInWindow = 0;
        }

        if (p.spentInWindow + amount > p.maxPerWindow) {
            emit ExecutionRejected(id, "Amount exceeds weekly spending limit");
            return;
        }

        p.spentInWindow += amount;
        p.lastExecutionDay = today;

        IERC20(p.asset).safeTransferFrom(p.owner, p.recipient, amount);

        emit Executed(id, amount, p.recipient);
    }

    /// @dev 00:00 UTC of the day containing `ts`.
    function _dayStart(uint256 ts) private pure returns (uint256) {
        return ts - (ts % 1 days);
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
