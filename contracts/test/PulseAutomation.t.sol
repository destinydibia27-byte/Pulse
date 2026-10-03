// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/console2.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/PulseAutomation.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract PulseAutomationTest is Test {
    PulseAutomation pulse;
    MockUSDC usdc;

    address deployer = address(0xD00D);
    address executor = address(0xE8EC);
    address user = address(0xA11CE);
    address attacker = address(0xBAD);
    address savings = address(0x5A71);

    uint256 constant USDC = 1e6;
    uint256 constant WEEK = 7 days;
    uint256 constant DAY = 1 days;

    // 1_800_000_000 is a UTC Friday (weekday 5), 08:00:00. Verified via the
    // epoch formula: dayIndex 20833, (20833+4)%7 == 5.
    uint256 constant FRIDAY_TS = 1_800_000_000;
    uint8 constant FRIDAY = 5;
    uint8 constant SATURDAY = 6;
    uint8 constant THURSDAY = 4;

    uint256 id;

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
        PulseAutomation.Op conditionOp,
        uint256 conditionThreshold
    );
    event Executed(uint256 indexed id, uint256 amount, address recipient);
    event ExecutionRejected(uint256 indexed id, string reason);
    event PermissionPaused(uint256 indexed id);
    event PermissionResumed(uint256 indexed id);
    event PermissionCancelled(uint256 indexed id);

    /// Default permission: Friday, condition "balance >= 0" (always true given
    /// the user's minted balance), 10 USDC per execution and per week.
    function _createDefault() internal returns (uint256) {
        vm.prank(user);
        return pulse.createPermission(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0
        );
    }

    function setUp() public {
        vm.warp(FRIDAY_TS);
        vm.prank(deployer);
        pulse = new PulseAutomation(executor);
        usdc = new MockUSDC();

        usdc.mint(user, 1_000 * USDC);
        vm.prank(user);
        usdc.approve(address(pulse), type(uint256).max);

        id = _createDefault();
    }

    // ------------------------------------------------------------ helpers

    function _exec(uint256 amount) internal {
        vm.prank(executor);
        pulse.execute(id, amount);
    }

    function _status() internal view returns (PulseAutomation.Status) {
        return pulse.getPermission(id).status;
    }

    /// @dev ALWAYS use this instead of `block.timestamp` in tests. With the
    ///      optimizer on, solc treats `block.timestamp` as constant within one
    ///      function and can reuse a stale value after `vm.warp`, so derived
    ///      arithmetic silently uses the pre-warp time (see CONTINUE_HERE.md,
    ///      item 6). The cheatcode always reads the real current value.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /// Jump to the next occurrence of `weekday` (UTC), landing at the same
    /// time-of-day as `from`, k full weeks later if `from` is already that
    /// weekday and `sameOccurrenceOk` is false.
    function _warpToWeekday(uint256 from, uint8 weekday, bool sameOccurrenceOk) internal {
        uint256 fromDay = from / DAY;
        uint8 fromWeekday = uint8((fromDay + 4) % 7);
        uint256 delta = (weekday + 7 - fromWeekday) % 7;
        if (delta == 0 && !sameOccurrenceOk) delta = 7;
        vm.warp(from + delta * DAY);
    }

    // ------------------------------------------------------ createPermission

    function test_create_storesFieldsAndIncrementsId() public {
        PulseAutomation.Permission memory p = pulse.getPermission(id);
        assertEq(p.owner, user);
        assertEq(p.asset, address(usdc));
        assertEq(p.recipient, savings);
        assertEq(p.maxPerExecution, 10 * USDC);
        assertEq(p.maxPerWindow, 10 * USDC);
        assertEq(p.windowSeconds, WEEK);
        assertEq(p.spentInWindow, 0);
        assertEq(uint8(p.status), uint8(PulseAutomation.Status.Active));
        assertEq(p.weekday, FRIDAY);
        assertEq(uint8(p.conditionOp), uint8(PulseAutomation.Op.GTE));
        assertEq(p.conditionThreshold, 0);
        assertEq(pulse.nextPermissionId(), 1);

        vm.prank(user);
        uint256 id2 = pulse.createPermission(
            address(usdc), savings, 1 * USDC, 1 * USDC, WEEK, _now() + 1 days,
            SATURDAY, PulseAutomation.Op.GT, 50 * USDC
        );
        assertEq(id2, 1);
        PulseAutomation.Permission memory p2 = pulse.getPermission(id2);
        assertEq(p2.weekday, SATURDAY);
        assertEq(uint8(p2.conditionOp), uint8(PulseAutomation.Op.GT));
        assertEq(p2.conditionThreshold, 50 * USDC);
    }

    function test_create_lastExecutionDayStartsAsNeverSentinel() public {
        // Implicit: a fresh permission must be executable on its first valid day,
        // which only holds if lastExecutionDay isn't accidentally 0 (today's real
        // index is nowhere near 0, but this guards the sentinel choice itself).
        _exec(10 * USDC);
        assertEq(usdc.balanceOf(savings), 10 * USDC);
    }

    function test_create_emitsEvent() public {
        uint256 exp = _now() + 30 days;
        vm.expectEmit(true, true, false, true);
        emit PermissionCreated(1, user, address(usdc), savings, 5 * USDC, 20 * USDC, WEEK, exp, SATURDAY, PulseAutomation.Op.LT, 7 * USDC);
        vm.prank(user);
        pulse.createPermission(address(usdc), savings, 5 * USDC, 20 * USDC, WEEK, exp, SATURDAY, PulseAutomation.Op.LT, 7 * USDC);
    }

    function test_create_revertsOnZeroAsset() public {
        vm.prank(user);
        vm.expectRevert("Pulse: bad asset");
        pulse.createPermission(address(0), savings, 1, 1, WEEK, _now() + 1 days, FRIDAY, PulseAutomation.Op.GT, 0);
    }

    function test_create_revertsOnZeroRecipient() public {
        vm.prank(user);
        vm.expectRevert("Pulse: bad recipient");
        pulse.createPermission(address(usdc), address(0), 1, 1, WEEK, _now() + 1 days, FRIDAY, PulseAutomation.Op.GT, 0);
    }

    function test_create_revertsOnZeroPerExecutionCap() public {
        vm.prank(user);
        vm.expectRevert("Pulse: bad caps");
        pulse.createPermission(address(usdc), savings, 0, 1, WEEK, _now() + 1 days, FRIDAY, PulseAutomation.Op.GT, 0);
    }

    function test_create_revertsWhenPerExecutionExceedsWindowCap() public {
        vm.prank(user);
        vm.expectRevert("Pulse: bad caps");
        pulse.createPermission(address(usdc), savings, 11, 10, WEEK, _now() + 1 days, FRIDAY, PulseAutomation.Op.GT, 0);
    }

    function test_create_revertsOnZeroWindow() public {
        vm.prank(user);
        vm.expectRevert("Pulse: bad window");
        pulse.createPermission(address(usdc), savings, 1, 1, 0, _now() + 1 days, FRIDAY, PulseAutomation.Op.GT, 0);
    }

    function test_create_revertsWhenAlreadyExpired() public {
        vm.prank(user);
        vm.expectRevert("Pulse: already expired");
        pulse.createPermission(address(usdc), savings, 1, 1, WEEK, _now(), FRIDAY, PulseAutomation.Op.GT, 0);
    }

    function test_create_revertsOnWeekdayAbove6() public {
        vm.prank(user);
        vm.expectRevert("Pulse: bad weekday");
        pulse.createPermission(address(usdc), savings, 1, 1, WEEK, _now() + 1 days, 7, PulseAutomation.Op.GT, 0);
    }

    function testFuzz_create_weekdayValidation(uint8 weekday) public {
        vm.prank(user);
        if (weekday > 6) {
            vm.expectRevert("Pulse: bad weekday");
            pulse.createPermission(address(usdc), savings, 1, 1, WEEK, _now() + 1 days, weekday, PulseAutomation.Op.GT, 0);
        } else {
            uint256 newId = pulse.createPermission(address(usdc), savings, 1, 1, WEEK, _now() + 1 days, weekday, PulseAutomation.Op.GT, 0);
            assertEq(pulse.getPermission(newId).weekday, weekday);
        }
    }

    // ---------------------------------------------------------------- execute

    function test_execute_movesFundsAndTracksSpend() public {
        vm.expectEmit(true, false, false, true);
        emit Executed(id, 10 * USDC, savings);
        _exec(10 * USDC);

        assertEq(usdc.balanceOf(savings), 10 * USDC);
        assertEq(usdc.balanceOf(user), 990 * USDC);
        assertEq(pulse.getPermission(id).spentInWindow, 10 * USDC);
        assertEq(pulse.getPermission(id).lastExecutionDay, _now() / DAY);
    }

    function test_execute_onlyExecutor() public {
        vm.prank(attacker);
        vm.expectRevert("Pulse: caller is not executor");
        pulse.execute(id, 1 * USDC);

        vm.prank(user); // not even the permission owner can call it
        vm.expectRevert("Pulse: caller is not executor");
        pulse.execute(id, 1 * USDC);
    }

    function test_execute_unknownPermissionReverts() public {
        vm.prank(executor);
        vm.expectRevert("Pulse: unknown permission");
        pulse.execute(999, 1);
    }

    function test_execute_rejectsOverPerExecutionCap() public {
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(id, "Amount exceeds per-execution limit");
        _exec(10 * USDC + 1);
        assertEq(usdc.balanceOf(savings), 0);
        assertEq(pulse.getPermission(id).spentInWindow, 0);
        assertEq(pulse.getPermission(id).lastExecutionDay, type(uint256).max, "a rejection must not consume the day");
    }

    function test_window_weeklySendsSucceedRegardlessOfTimeOfDay() public {
        // Regression for the old "anchored to the send's time of day" bug. Default `id` is
        // 10/10 with a 1-week window, so every week's send must fit on its own. Send times
        // are deliberately out of order within the day: late, early, even earlier.
        uint256 fridayStart = FRIDAY_TS - (FRIDAY_TS % DAY); // 00:00 UTC of the Friday setUp lands on

        vm.warp(fridayStart + 15 hours);          // week 1: Fri 15:00
        _exec(10 * USDC);
        vm.warp(fridayStart + WEEK + 60);         // week 2: Fri 00:01 (6d9h later, inside a 7d-from-send window)
        _exec(10 * USDC);
        vm.warp(fridayStart + 2 * WEEK + 30);     // week 3: Fri 00:00:30 (earlier than week 2's send)
        _exec(10 * USDC);
        vm.warp(fridayStart + 3 * WEEK);          // week 4: Fri 00:00:00 exactly
        _exec(10 * USDC);

        assertEq(usdc.balanceOf(savings), 40 * USDC, "all four weekly sends went through");
    }

    function test_window_startIsAlwaysMidnightUTC_atCreationAndAfterRollover() public {
        assertEq(FRIDAY_TS % DAY, 8 hours, "precondition: created at 08:00 UTC, not midnight");
        PulseAutomation.Permission memory p0 = pulse.getPermission(id);
        assertEq(p0.windowStart % DAY, 0, "creation aligns to 00:00 UTC");
        assertEq(p0.windowStart, FRIDAY_TS - (FRIDAY_TS % DAY), "and to the SAME day, not the next");

        vm.warp(FRIDAY_TS + WEEK + 5 hours + 17 minutes + 9); // next Friday at an awkward time
        _exec(10 * USDC); // rolls the window over
        PulseAutomation.Permission memory p1 = pulse.getPermission(id);
        assertEq(p1.windowStart % DAY, 0, "rollover aligns to 00:00 UTC");
        assertEq(p1.windowStart, _now() - (_now() % DAY), "to the day of the send");
        assertEq(p1.spentInWindow, 10 * USDC, "and the counter restarted at this send");
    }

    function test_window_afterRollover_capIsStillEnforcedInTheNewWindow() public {
        // After a rollover the NEW window must start where the rollover happened, otherwise
        // the counter would reset on every later send and the cap would stop meaning anything.
        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 10 * USDC, 10 * USDC, 3 * WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0
        );
        vm.prank(executor);
        pulse.execute(pid, 10 * USDC);                  // week 0: fills window 1

        vm.warp(_now() + 3 * WEEK);
        vm.prank(executor);
        pulse.execute(pid, 10 * USDC);                  // week 3: window 1 over, window 2 starts, fills it

        vm.warp(_now() + WEEK);                         // week 4: inside window 2 (which runs to week 6)
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Amount exceeds weekly spending limit");
        vm.prank(executor);
        pulse.execute(pid, 10 * USDC);

        assertEq(usdc.balanceOf(savings), 20 * USDC, "only the two window-starting sends went through");
    }

    function test_window_exactBoundary_rollsOverAtMidnightButNotBefore() public {
        // 2-week window created Fri 08:00 starts at Fri 00:00. Window cap 10 == one send.
        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 10 * USDC, 10 * USDC, 2 * WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0
        );
        uint256 windowStart = FRIDAY_TS - (FRIDAY_TS % DAY);
        assertEq(pulse.getPermission(pid).windowStart, windowStart);

        vm.prank(executor);
        pulse.execute(pid, 10 * USDC);                          // week 0, Fri 08:00: spends the window

        vm.warp(windowStart + WEEK + 8 hours);                  // week 1: still inside the 2-week window
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Amount exceeds weekly spending limit");
        vm.prank(executor);
        pulse.execute(pid, 10 * USDC);

        vm.warp(windowStart + 2 * WEEK);                        // week 2, exactly windowStart + windowSeconds
        vm.prank(executor);
        pulse.execute(pid, 10 * USDC);                          // >= boundary: rolled over, allowed
        assertEq(usdc.balanceOf(savings), 20 * USDC);
    }

    function test_execute_rejectsOverWindowCap_accumulatedAcrossDays() public {
        // Window is 3 weeks and sends are one WEEK apart, so the weekday gate
        // keeps matching (always Friday) while spending accumulates toward the
        // window cap. 6 + 4 = 10 exactly (at cap, succeeds); a third send of 1
        // two weeks in pushes spentInWindow to 11 > maxPerWindow(10) and is
        // rejected with the weekly-limit reason specifically (1 USDC alone is
        // well under the 10 USDC per-execution cap).
        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 10 * USDC, 10 * USDC, 3 * WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0
        );
        vm.prank(executor);
        pulse.execute(pid, 6 * USDC);

        vm.warp(_now() + WEEK);
        vm.prank(executor);
        pulse.execute(pid, 4 * USDC);
        assertEq(usdc.balanceOf(savings), 10 * USDC);

        vm.warp(_now() + WEEK);
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Amount exceeds weekly spending limit");
        vm.prank(executor);
        pulse.execute(pid, 1 * USDC);
        assertEq(usdc.balanceOf(savings), 10 * USDC);
        assertEq(pulse.getPermission(pid).spentInWindow, 10 * USDC);
    }

    function test_execute_rejectsZeroAmount() public {
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(id, "Amount is zero");
        _exec(0);
        assertEq(usdc.balanceOf(savings), 0);
    }

    function test_execute_rejectsZeroAmount_doesNotConsumeDay() public {
        _exec(0);
        _exec(10 * USDC); // should still succeed same day since the zero-amount rejection didn't mark the day used
        assertEq(usdc.balanceOf(savings), 10 * USDC);
    }

    function test_execute_rejectsWhenPaused() public {
        vm.prank(user);
        pulse.pause(id);
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(id, "Permission paused");
        _exec(1 * USDC);
        assertEq(usdc.balanceOf(savings), 0);
    }

    function test_execute_rejectsWhenCancelled() public {
        vm.prank(user);
        pulse.cancel(id);
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(id, "Permission cancelled");
        _exec(1 * USDC);
        assertEq(usdc.balanceOf(savings), 0);
    }

    function test_execute_rejectsWhenExpired_andMarksExpired() public {
        vm.warp(_now() + 365 days);
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(id, "Permission expired");
        _exec(1 * USDC);
        assertEq(usdc.balanceOf(savings), 0);
        assertEq(uint8(_status()), uint8(PulseAutomation.Status.Expired));
    }

    function test_execute_expiryCheckedBeforeWeekday() public {
        // Expired AND on the wrong weekday simultaneously (365 % 7 == 1, so the
        // weekday has shifted off Friday too): the reported reason must be
        // expiry, proving check order is as documented.
        vm.warp(_now() + 365 days);
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(id, "Permission expired");
        _exec(1 * USDC);
    }

    function test_execute_revertsAndLeavesStateUntouched_whenAllowanceRemoved() public {
        vm.prank(user);
        usdc.approve(address(pulse), 0);

        vm.prank(executor);
        vm.expectRevert();
        pulse.execute(id, 5 * USDC);

        assertEq(pulse.getPermission(id).spentInWindow, 0);
        assertEq(pulse.getPermission(id).lastExecutionDay, type(uint256).max, "a revert must not consume the day either");
    }

    function test_execute_revertsWhenUserBalanceTooLow() public {
        vm.startPrank(user);
        usdc.transfer(attacker, 1_000 * USDC);
        vm.stopPrank();
        // (balance now 0, which still satisfies the default GTE 0 condition, so
        // we reach the real transfer attempt and it reverts on insufficient funds)
        vm.prank(executor);
        vm.expectRevert();
        pulse.execute(id, 5 * USDC);
        assertEq(pulse.getPermission(id).spentInWindow, 0);
    }

    function test_execute_neverPaysAnyoneButRecipient() public {
        _exec(3 * USDC);
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(executor), 0);
        assertEq(usdc.balanceOf(savings), 3 * USDC);
    }

    // --------------------------------------------------------- weekday gate

    function test_weekday_wrongDayIsRejected_noStateChange() public {
        _warpToWeekday(_now(), SATURDAY, true);
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(id, "Not the scheduled day (UTC)");
        _exec(10 * USDC);
        assertEq(usdc.balanceOf(savings), 0);
        assertEq(pulse.getPermission(id).spentInWindow, 0);
        assertEq(pulse.getPermission(id).lastExecutionDay, type(uint256).max);
    }

    function test_oncePerDay_laterInSameUTCDayIsRejected_notJustSameTimestamp() public {
        // FRIDAY_TS is 08:00 UTC. The once-per-day gate must be keyed on the UTC
        // DAY, not on the hour or the exact timestamp: a second attempt hours
        // later (and at the very last second) of that same UTC day is rejected.
        assertEq(FRIDAY_TS % DAY, 8 hours, "precondition: FRIDAY_TS is 08:00 UTC");
        _exec(1 * USDC);
        assertEq(usdc.balanceOf(savings), 1 * USDC);

        vm.warp(_now() + 12 hours); // 20:00 same UTC day
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(id, "Already executed for this UTC day");
        _exec(1 * USDC);

        vm.warp(_now() - (_now() % DAY) + DAY - 1); // 23:59:59 same UTC day
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(id, "Already executed for this UTC day");
        _exec(1 * USDC);

        assertEq(usdc.balanceOf(savings), 1 * USDC, "only the first send of the UTC day moves funds");
    }

    function test_weekday_correctDaySucceeds_acrossAllSevenDays() public {
        for (uint8 w = 0; w < 7; w++) {
            vm.prank(user);
            uint256 pid = pulse.createPermission(
                address(usdc), savings, 1 * USDC, 1 * USDC, WEEK, _now() + 365 days,
                w, PulseAutomation.Op.GTE, 0
            );
            _warpToWeekday(FRIDAY_TS, w, true);
            // Independent check that the harness really landed on weekday w.
            assertEq(uint8((_now() / DAY + 4) % 7), w, "harness warped to wrong weekday");
            vm.prank(executor);
            pulse.execute(pid, 1 * USDC);
            vm.warp(FRIDAY_TS); // reset for the next iteration's relative warp
        }
        assertEq(usdc.balanceOf(savings), 7 * USDC);
    }

    function test_weekday_dayBoundary_lastSecondVsFirstSecond() public {
        // One second before the configured weekday begins (UTC) must reject;
        // the first second of that day must succeed.
        uint256 saturdayStart = FRIDAY_TS - (FRIDAY_TS % DAY) + DAY; // next midnight after Friday (= Saturday 00:00)
        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 1 * USDC, 1 * USDC, WEEK, _now() + 365 days,
            SATURDAY, PulseAutomation.Op.GTE, 0
        );

        vm.warp(saturdayStart - 1); // 23:59:59 Friday
        vm.prank(executor);
        pulse.execute(pid, 1 * USDC);
        assertEq(usdc.balanceOf(savings), 0); // rejected, not reverted

        vm.warp(saturdayStart); // 00:00:00 Saturday
        vm.prank(executor);
        pulse.execute(pid, 1 * USDC);
        assertEq(usdc.balanceOf(savings), 1 * USDC);
    }

    function testFuzz_weekday_onlyMatchingDayEverSucceeds(uint8 configuredDay, uint16 dayOffset) public {
        configuredDay = uint8(bound(configuredDay, 0, 6));
        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 1 * USDC, 1 * USDC, WEEK, _now() + 70_000 days, // > uint16.max days, so expiry never masks the weekday check
            configuredDay, PulseAutomation.Op.GTE, 0
        );

        vm.warp(FRIDAY_TS + uint256(dayOffset) * DAY);
        uint8 actualDay = uint8(((_now() / DAY) + 4) % 7);

        vm.prank(executor);
        pulse.execute(pid, 1 * USDC);

        if (actualDay == configuredDay) {
            assertEq(usdc.balanceOf(savings), 1 * USDC);
        } else {
            assertEq(usdc.balanceOf(savings), 0);
        }
    }

    // ------------------------------------------------------- once-per-day gate

    function test_oncePerDay_secondAttemptSameDayRejected() public {
        _exec(1 * USDC);
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(id, "Already executed for this UTC day");
        _exec(1 * USDC);
        assertEq(usdc.balanceOf(savings), 1 * USDC, "only the first send should have gone through");
    }

    function test_oncePerDay_onlyASuccessConsumesTheDay_rejectionsDoNot() public {
        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 1 * USDC, 1 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 2_000 * USDC // user only has 1000: condition initially false
        );
        vm.prank(executor);
        pulse.execute(pid, 1 * USDC); // rejected: condition not met
        assertEq(usdc.balanceOf(savings), 0);

        usdc.mint(user, 1_500 * USDC); // now balance is 2500, condition met
        vm.prank(executor);
        pulse.execute(pid, 1 * USDC); // SAME day, should now succeed
        assertEq(usdc.balanceOf(savings), 1 * USDC);
    }

    function test_oncePerDay_nextDayAllowsAgain_evenIfNotNextWeek() public {
        _exec(1 * USDC);
        vm.prank(user);
        uint256 satId = pulse.createPermission(
            address(usdc), savings, 1 * USDC, 1 * USDC, WEEK, _now() + 365 days,
            SATURDAY, PulseAutomation.Op.GTE, 0
        );
        vm.warp(_now() + DAY);
        vm.prank(executor);
        pulse.execute(satId, 1 * USDC);
        assertEq(usdc.balanceOf(savings), 2 * USDC);
    }

    function test_oncePerDay_nextWeekAllowsAgain() public {
        _exec(1 * USDC);
        vm.warp(_now() + WEEK);
        _exec(1 * USDC);
        assertEq(usdc.balanceOf(savings), 2 * USDC);
    }

    // --------------------------------------------------------- condition gate

    function test_condition_allFiveOperators() public {
        // User balance is exactly 1_000 USDC at each check (_assertConditionAccepts
        // restores it), so one operator's send can't change another's outcome.
        _assertConditionAccepts(PulseAutomation.Op.GT, 999 * USDC);     // 1000 > 999
        _assertConditionAccepts(PulseAutomation.Op.GTE, 1_000 * USDC);  // 1000 >= 1000
        _assertConditionAccepts(PulseAutomation.Op.LT, 1_001 * USDC);   // 1000 < 1001
        _assertConditionAccepts(PulseAutomation.Op.LTE, 1_000 * USDC);  // 1000 <= 1000
        _assertConditionAccepts(PulseAutomation.Op.EQ, 1_000 * USDC);   // 1000 == 1000
    }

    function _assertConditionAccepts(PulseAutomation.Op op, uint256 threshold) internal {
        uint256 bal = usdc.balanceOf(user);
        if (bal < 1_000 * USDC) usdc.mint(user, 1_000 * USDC - bal); // restore exact 1_000 USDC
        assertEq(usdc.balanceOf(user), 1_000 * USDC, "precondition: owner balance");

        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 1, 1, WEEK, _now() + 365 days, FRIDAY, op, threshold
        );
        uint256 before = usdc.balanceOf(savings);
        vm.prank(executor);
        pulse.execute(pid, 1);
        assertEq(usdc.balanceOf(savings) - before, 1, "operator should accept at this threshold");
    }

    function test_condition_eachOperatorRejectsOnTheWrongSide() public {
        // balance fixed at 1_000 USDC
        _assertConditionRejects(PulseAutomation.Op.GT, 1_000 * USDC);     // 1000 > 1000 is false
        _assertConditionRejects(PulseAutomation.Op.GTE, 1_001 * USDC);    // 1000 >= 1001 is false
        _assertConditionRejects(PulseAutomation.Op.LT, 1_000 * USDC);     // 1000 < 1000 is false
        _assertConditionRejects(PulseAutomation.Op.LTE, 999 * USDC);      // 1000 <= 999 is false
        _assertConditionRejects(PulseAutomation.Op.EQ, 999 * USDC);       // 1000 == 999 is false
    }

    function _assertConditionRejects(PulseAutomation.Op op, uint256 threshold) internal {
        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 1, 1, WEEK, _now() + 365 days, FRIDAY, op, threshold
        );
        uint256 before = usdc.balanceOf(savings);
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Balance condition not met");
        vm.prank(executor);
        pulse.execute(pid, 1);
        assertEq(usdc.balanceOf(savings), before);
    }

    function test_condition_checksOwnersBalance_notExecutorsOrRecipients() public {
        usdc.mint(savings, 1_000_000 * USDC);
        usdc.mint(executor, 1_000_000 * USDC);

        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 1, 1, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GT, 5_000 * USDC // user only has 1000, well under this
        );
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Balance condition not met");
        vm.prank(executor);
        pulse.execute(pid, 1);
    }

    function test_condition_reflectsBalanceChangesSinceCreation() public {
        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 1, 1, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 1_500 * USDC
        );
        vm.prank(executor);
        pulse.execute(pid, 1); // rejected, user has only 1000
        assertEq(usdc.balanceOf(savings), 0);

        usdc.mint(user, 1_000 * USDC); // external mint, not via this contract
        vm.prank(executor);
        pulse.execute(pid, 1);
        assertEq(usdc.balanceOf(savings), 1);
    }

    function testFuzz_condition_matchesOffchainSemantics(uint256 balance, uint256 threshold, uint8 opRaw) public {
        PulseAutomation.Op op = PulseAutomation.Op(bound(opRaw, 0, 4));
        balance = bound(balance, 1, 1_000_000 * USDC); // zero balance covered by its own test below
        threshold = bound(threshold, 0, 1_000_000 * USDC);

        uint256 current = usdc.balanceOf(user);
        if (balance > current) usdc.mint(user, balance - current);
        else usdc.burn(user, current - balance);

        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 1, type(uint256).max, WEEK, _now() + 365 days,
            FRIDAY, op, threshold
        );

        bool expected;
        if (op == PulseAutomation.Op.GT) expected = balance > threshold;
        else if (op == PulseAutomation.Op.GTE) expected = balance >= threshold;
        else if (op == PulseAutomation.Op.LT) expected = balance < threshold;
        else if (op == PulseAutomation.Op.LTE) expected = balance <= threshold;
        else expected = balance == threshold;

        vm.prank(executor);
        pulse.execute(pid, 1);
        assertEq(usdc.balanceOf(savings) == 1, expected);
    }

    function test_condition_trueButOwnerHasNothingToSend_revertsAndDoesNotBurnDay() public {
        // Condition LTE 0 is true for an empty owner balance, but there is
        // nothing to transfer: the ERC20 transfer reverts the WHOLE call, so
        // no state (spentInWindow, lastExecutionDay) is consumed.
        usdc.burn(user, usdc.balanceOf(user));
        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 1, 1, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.LTE, 0
        );
        vm.prank(executor);
        vm.expectRevert();
        pulse.execute(pid, 1);
        assertEq(pulse.getPermission(pid).spentInWindow, 0);
        assertEq(pulse.getPermission(pid).lastExecutionDay, type(uint256).max);
    }

    // ------------------------------------------------------- pause / resume

    function test_pause_thenResume_roundTrips() public {
        vm.expectEmit(true, false, false, false);
        emit PermissionPaused(id);
        vm.prank(user);
        pulse.pause(id);
        assertEq(uint8(_status()), uint8(PulseAutomation.Status.Paused));

        vm.expectEmit(true, false, false, false);
        emit PermissionResumed(id);
        vm.prank(user);
        pulse.resume(id);
        assertEq(uint8(_status()), uint8(PulseAutomation.Status.Active));

        _exec(1 * USDC);
        assertEq(usdc.balanceOf(savings), 1 * USDC);
    }

    function test_pause_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert("Pulse: not owner");
        pulse.pause(id);

        vm.prank(executor);
        vm.expectRevert("Pulse: not owner");
        pulse.pause(id);
    }

    function test_pause_requiresActive() public {
        vm.startPrank(user);
        pulse.pause(id);
        vm.expectRevert("Pulse: not active");
        pulse.pause(id);
        vm.stopPrank();
    }

    function test_resume_requiresPaused() public {
        vm.prank(user);
        vm.expectRevert("Pulse: not paused");
        pulse.resume(id);
    }

    function test_resume_onlyOwner() public {
        vm.prank(user);
        pulse.pause(id);
        vm.prank(attacker);
        vm.expectRevert("Pulse: not owner");
        pulse.resume(id);
    }

    function test_resume_revertsIfExpiredWhilePaused() public {
        vm.prank(user);
        pulse.pause(id);
        vm.warp(_now() + 365 days);
        vm.prank(user);
        vm.expectRevert("Pulse: expired");
        pulse.resume(id);
    }

    // ---------------------------------------------------------------- cancel

    function test_cancel_isPermanent() public {
        vm.expectEmit(true, false, false, false);
        emit PermissionCancelled(id);
        vm.prank(user);
        pulse.cancel(id);
        assertEq(uint8(_status()), uint8(PulseAutomation.Status.Cancelled));

        vm.startPrank(user);
        vm.expectRevert("Pulse: not paused");
        pulse.resume(id);
        vm.expectRevert("Pulse: not active");
        pulse.pause(id);
        vm.expectRevert("Pulse: already cancelled");
        pulse.cancel(id);
        vm.stopPrank();

        _exec(1 * USDC);
        assertEq(usdc.balanceOf(savings), 0);
    }

    function test_cancel_worksFromPausedState() public {
        vm.startPrank(user);
        pulse.pause(id);
        pulse.cancel(id);
        vm.stopPrank();
        assertEq(uint8(_status()), uint8(PulseAutomation.Status.Cancelled));
    }

    function test_cancel_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert("Pulse: not owner");
        pulse.cancel(id);

        vm.prank(executor);
        vm.expectRevert("Pulse: not owner");
        pulse.cancel(id);
        assertEq(uint8(_status()), uint8(PulseAutomation.Status.Active));
    }

    function test_cancel_doesNotAffectOtherPermissions() public {
        vm.prank(user);
        uint256 other = pulse.createPermission(
            address(usdc), savings, 1 * USDC, 1 * USDC, WEEK, _now() + 1 days,
            FRIDAY, PulseAutomation.Op.GTE, 0
        );
        vm.prank(user);
        pulse.cancel(id);

        vm.prank(executor);
        pulse.execute(other, 1 * USDC);
        assertEq(usdc.balanceOf(savings), 1 * USDC);
    }

    // -------------------------------------------------------------- executor

    function test_setExecutor_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        pulse.setExecutor(attacker);

        vm.prank(deployer);
        pulse.setExecutor(address(0xE8EC2));

        vm.prank(executor);
        vm.expectRevert("Pulse: caller is not executor");
        pulse.execute(id, 1 * USDC);
    }

    /// Updated trust-boundary test: this is the whole point of this change.
    /// Previously the executor could fire on ANY day within the caps. Now it
    /// cannot: wrong day, condition unmet, and more than one success per day
    /// are all rejected on-chain regardless of what the executor attempts.
    function test_trustBoundary_executorCannotControlTimingOrCondition() public {
        // Wrong day: rejected even though caps/condition would otherwise allow it.
        _warpToWeekday(_now(), SATURDAY, true);
        _exec(10 * USDC);
        assertEq(usdc.balanceOf(savings), 0, "executor must not be able to fire on an unscheduled day");

        // Right day, condition unmet: rejected.
        vm.warp(FRIDAY_TS);
        vm.prank(user);
        uint256 strictId = pulse.createPermission(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 5_000 * USDC // user has only 1000
        );
        vm.prank(executor);
        pulse.execute(strictId, 10 * USDC);
        assertEq(usdc.balanceOf(savings), 0, "executor must not be able to fire when the condition is unmet");

        // Right day, condition met: succeeds once...
        _exec(10 * USDC);
        assertEq(usdc.balanceOf(savings), 10 * USDC);
        // ...but a second attempt the SAME day is rejected, proving the executor
        // cannot squeeze out more than one send per day regardless of caps left.
        _exec(1);
        assertEq(usdc.balanceOf(savings), 10 * USDC, "executor must not get a second send on the same day");
    }

    /// What is STILL true: the executor decides which permission to call and
    /// when to ATTEMPT it, and a malicious executor can always choose to attempt
    /// nothing (denial of service) -- that is explicitly out of scope here and
    /// is the reason the README still calls this worker a single point of
    /// failure. What changed is that attempting no longer equals succeeding.
    function test_trustBoundary_executorCanStillChooseNotToAct() public {
        assertTrue(true); // documentation anchor; see comment above
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_windowCapNeverExceeded(uint256 a, uint256 b, uint256 c) public {
        a = bound(a, 0, 20 * USDC);
        b = bound(b, 0, 20 * USDC);
        c = bound(c, 0, 20 * USDC);

        // Three Fridays one WEEK apart inside a 3-week window: the weekday and
        // once-per-day gates pass every time, so only the window cap (10) and
        // per-execution cap (10) decide what goes through.
        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 10 * USDC, 10 * USDC, 3 * WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0
        );
        vm.prank(executor);
        pulse.execute(pid, a);
        vm.warp(_now() + WEEK);
        vm.prank(executor);
        pulse.execute(pid, b);
        vm.warp(_now() + WEEK);
        vm.prank(executor);
        pulse.execute(pid, c);

        uint256 paid = usdc.balanceOf(savings);
        assertLe(paid, 10 * USDC);
        assertEq(pulse.getPermission(pid).spentInWindow, paid);
    }

    function testFuzz_perExecutionCapNeverExceeded(uint256 amount) public {
        amount = bound(amount, 0, type(uint128).max);
        uint256 before = usdc.balanceOf(savings);
        _exec(amount);
        assertLe(usdc.balanceOf(savings) - before, 10 * USDC);
    }

    function testFuzz_nonExecutorCanNeverMoveFunds(address caller, uint256 amount) public {
        vm.assume(caller != executor);
        amount = bound(amount, 0, 20 * USDC);

        vm.prank(caller);
        vm.expectRevert("Pulse: caller is not executor");
        pulse.execute(id, amount);

        assertEq(usdc.balanceOf(savings), 0);
        assertEq(usdc.balanceOf(user), 1_000 * USDC);
    }
}
