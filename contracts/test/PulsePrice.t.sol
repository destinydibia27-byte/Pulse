// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PulseAutomation.sol";
import "./PulseAutomation.t.sol"; // MockUSDC

/// @dev A controllable stand-in for a Chainlink price feed. Satisfies AggregatorV3Interface.
contract MockAggregator {
    uint8 public immutable decimals;
    string public description = "ETH / USD";
    int256 public answer;
    uint256 public updatedAt;
    bool public shouldRevert;

    constructor(uint8 _decimals) {
        decimals = _decimals;
    }

    function set(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
    }

    function setRevert(bool r) external {
        shouldRevert = r;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @dev Feed whose decimals() reverts, to prove creation refuses a broken feed.
contract BrokenDecimalsFeed {
    function decimals() external pure returns (uint8) {
        revert("nope");
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 1, block.timestamp, block.timestamp, 1); // on-chain mock: real value
    }
}

contract PulsePriceTest is Test {
    PulseAutomation pulse;
    MockUSDC usdc;
    MockAggregator feed;

    address deployer = address(0xD00D);
    address executor = address(0xE8EC);
    address user = address(0xA11CE);
    address savings = address(0x5A71);

    uint256 constant USDC = 1e6;
    uint256 constant WEEK = 7 days;
    uint256 constant DAY = 1 days;
    uint256 constant FRIDAY_TS = 1_800_000_000; // Friday 08:00 UTC
    uint8 constant FRIDAY = 5;
    int256 constant PRICE_2000 = 2_000 * 1e8; // ETH/USD at 8 decimals
    uint256 constant MAX_AGE = 1 hours;

    event ExecutionRejected(uint256 indexed id, string reason);
    event Executed(uint256 indexed id, uint256 amount, address recipient);
    event PriceConditionSet(
        uint256 indexed id, address feed, PulseAutomation.Op op, uint8 decimals, uint256 threshold, uint256 maxAge
    );

    function setUp() public {
        vm.warp(FRIDAY_TS);
        vm.prank(deployer);
        pulse = new PulseAutomation(executor);
        usdc = new MockUSDC();
        feed = new MockAggregator(8);
        feed.set(PRICE_2000, FRIDAY_TS); // fresh, ETH = $2,000

        usdc.mint(user, 1_000 * USDC);
        vm.prank(user);
        usdc.approve(address(pulse), type(uint256).max);
    }

    // ------------------------------------------------------------ helpers

    /// @dev Use this, never `block.timestamp`, after a vm.warp: with the optimizer on, solc can
    ///      reuse a pre-warp value (see contracts/README.md). The cheatcode always reads the real one.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _price(PulseAutomation.Op op, uint256 threshold, uint256 maxAge)
        internal
        view
        returns (PulseAutomation.PriceCondition memory)
    {
        return PulseAutomation.PriceCondition({feed: address(feed), op: op, threshold: threshold, maxAge: maxAge});
    }

    /// 10 USDC/10 USDC caps, Friday, balance condition trivially true, plus the given price condition.
    function _create(PulseAutomation.PriceCondition memory pc) internal returns (uint256 pid) {
        vm.prank(user);
        pid = pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, pc
        );
    }

    function _run(uint256 pid) internal {
        vm.prank(executor);
        pulse.execute(pid, 1 * USDC);
    }

    /// Execute and report whether 1 USDC actually reached the recipient.
    function _sends(uint256 pid) internal returns (bool) {
        uint256 before = usdc.balanceOf(savings);
        _run(pid);
        return usdc.balanceOf(savings) == before + 1 * USDC;
    }

    // ------------------------------------------------------- creation: validation

    function test_create_storesPriceFieldsAndEmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit PriceConditionSet(0, address(feed), PulseAutomation.Op.LT, 8, 2_500 * 1e8, MAX_AGE);
        uint256 pid = _create(_price(PulseAutomation.Op.LT, 2_500 * 1e8, MAX_AGE));

        PulseAutomation.Permission memory p = pulse.getPermission(pid);
        assertEq(p.priceFeed, address(feed));
        assertEq(uint8(p.priceOp), uint8(PulseAutomation.Op.LT));
        assertEq(p.priceDecimals, 8);
        assertEq(p.priceThreshold, 2_500 * 1e8);
        assertEq(p.maxPriceAge, MAX_AGE);
    }

    function test_create_withoutPrice_hasNoFeedAndIgnoresFeedEntirely() public {
        vm.prank(user);
        uint256 pid = pulse.createPermission(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0
        );
        assertEq(pulse.getPermission(pid).priceFeed, address(0));
        // A dead, stale or absurd feed elsewhere cannot affect a permission that has none.
        feed.setRevert(true);
        assertTrue(_sends(pid));
    }

    function test_create_rejectsZeroFeed() public {
        PulseAutomation.PriceCondition memory pc = _price(PulseAutomation.Op.GT, 1, MAX_AGE);
        pc.feed = address(0);
        vm.prank(user);
        vm.expectRevert("Pulse: bad feed");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, pc
        );
    }

    function test_create_rejectsZeroThreshold() public {
        vm.prank(user);
        vm.expectRevert("Pulse: bad price threshold");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, _price(PulseAutomation.Op.GT, 0, MAX_AGE)
        );
    }

    function test_create_rejectsBadMaxAge() public {
        vm.startPrank(user);
        vm.expectRevert("Pulse: bad price age");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, _price(PulseAutomation.Op.GT, 1, 0)
        );
        vm.expectRevert("Pulse: bad price age");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, _price(PulseAutomation.Op.GT, 1, 7 days + 1)
        );
        vm.stopPrank();
        // exactly the limit is allowed
        _create(_price(PulseAutomation.Op.GT, 1, 7 days));
    }

    function test_create_rejectsAnAddressThatIsNotAFeed() public {
        PulseAutomation.PriceCondition memory pc = _price(PulseAutomation.Op.GT, 1, MAX_AGE);
        pc.feed = address(0xBEEF); // an EOA: calling decimals() on it fails
        vm.prank(user);
        vm.expectRevert("Pulse: bad feed");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, pc
        );

        pc.feed = address(usdc); // a real contract that is not a feed
        vm.prank(user);
        vm.expectRevert(); // no latestRoundData() selector: either way it must not be accepted
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, pc
        );
    }

    function test_create_rejectsFeedWhoseDecimalsReverts() public {
        PulseAutomation.PriceCondition memory pc = _price(PulseAutomation.Op.GT, 1, MAX_AGE);
        pc.feed = address(new BrokenDecimalsFeed());
        vm.prank(user);
        vm.expectRevert("Pulse: bad feed");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, pc
        );
    }

    function test_create_rejectsFeedWithTooManyDecimals() public {
        MockAggregator wide = new MockAggregator(19);
        wide.set(PRICE_2000, FRIDAY_TS);
        PulseAutomation.PriceCondition memory pc = _price(PulseAutomation.Op.GT, 1, MAX_AGE);
        pc.feed = address(wide);
        vm.prank(user);
        vm.expectRevert("Pulse: bad feed");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, pc
        );
    }

    function test_create_rejectsFeedReportingNoPositivePrice() public {
        PulseAutomation.PriceCondition memory pc = _price(PulseAutomation.Op.GT, 1, MAX_AGE);

        feed.set(0, FRIDAY_TS);
        vm.prank(user);
        vm.expectRevert("Pulse: bad feed");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, pc
        );

        feed.set(-5, FRIDAY_TS);
        vm.prank(user);
        vm.expectRevert("Pulse: bad feed");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, pc
        );

        feed.set(PRICE_2000, 0); // no update time
        vm.prank(user);
        vm.expectRevert("Pulse: bad feed");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, pc
        );

        feed.setRevert(true);
        vm.prank(user);
        vm.expectRevert("Pulse: bad feed");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, pc
        );
    }

    function test_create_aStaleFeedIsStillAllowedAtCreation() public {
        // A quiet testnet feed must not stop someone creating a rule; it just never fires while stale.
        feed.set(PRICE_2000, FRIDAY_TS - 30 days);
        uint256 pid = _create(_price(PulseAutomation.Op.GT, 1, MAX_AGE));
        assertFalse(_sends(pid));
    }

    function test_create_otherValidationStillAppliesToPriceVariant() public {
        vm.startPrank(user);
        vm.expectRevert("Pulse: bad caps");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 20 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GTE, 0, _price(PulseAutomation.Op.GT, 1, MAX_AGE)
        );
        vm.expectRevert("Pulse: bad weekday");
        pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            7, PulseAutomation.Op.GTE, 0, _price(PulseAutomation.Op.GT, 1, MAX_AGE)
        );
        vm.stopPrank();
    }

    // ------------------------------------------------------------ execution: the condition

    function test_execute_sendsWhenPriceConditionHolds() public {
        uint256 pid = _create(_price(PulseAutomation.Op.LT, 2_500 * 1e8, MAX_AGE)); // ETH < 2500, is 2000
        vm.expectEmit(true, false, false, true);
        emit Executed(pid, 1 * USDC, savings);
        _run(pid);
        assertEq(usdc.balanceOf(savings), 1 * USDC);
    }

    function test_execute_rejectsWhenPriceConditionFails_andDoesNotBurnTheDay() public {
        uint256 pid = _create(_price(PulseAutomation.Op.LT, 1_500 * 1e8, MAX_AGE)); // ETH < 1500, is 2000
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Price condition not met");
        _run(pid);
        assertEq(usdc.balanceOf(savings), 0);
        PulseAutomation.Permission memory p = pulse.getPermission(pid);
        assertEq(p.spentInWindow, 0, "no spend recorded");
        assertEq(p.lastExecutionDay, type(uint256).max, "a refusal must not use up the day");

        // The price then crosses later the same day: the very same permission can now send.
        feed.set(1_400 * 1e8, _now());
        assertTrue(_sends(pid));
    }

    function _accepts(PulseAutomation.Op op, uint256 threshold) internal returns (bool) {
        return _sends(_create(_price(op, threshold, MAX_AGE)));
    }

    function test_priceOperators_boundariesForAllFive() public {
        // The price is exactly 2000.00000000.
        uint256 t = uint256(PRICE_2000);
        // GT
        assertTrue(_accepts(PulseAutomation.Op.GT, t - 1), "GT below");
        assertFalse(_accepts(PulseAutomation.Op.GT, t), "GT equal");
        assertFalse(_accepts(PulseAutomation.Op.GT, t + 1), "GT above");
        // GTE
        assertTrue(_accepts(PulseAutomation.Op.GTE, t - 1), "GTE below");
        assertTrue(_accepts(PulseAutomation.Op.GTE, t), "GTE equal");
        assertFalse(_accepts(PulseAutomation.Op.GTE, t + 1), "GTE above");
        // LT
        assertFalse(_accepts(PulseAutomation.Op.LT, t - 1), "LT below");
        assertFalse(_accepts(PulseAutomation.Op.LT, t), "LT equal");
        assertTrue(_accepts(PulseAutomation.Op.LT, t + 1), "LT above");
        // LTE
        assertFalse(_accepts(PulseAutomation.Op.LTE, t - 1), "LTE below");
        assertTrue(_accepts(PulseAutomation.Op.LTE, t), "LTE equal");
        assertTrue(_accepts(PulseAutomation.Op.LTE, t + 1), "LTE above");
        // EQ
        assertFalse(_accepts(PulseAutomation.Op.EQ, t - 1), "EQ below");
        assertTrue(_accepts(PulseAutomation.Op.EQ, t), "EQ equal");
        assertFalse(_accepts(PulseAutomation.Op.EQ, t + 1), "EQ above");
    }

    // ---------------------------------------------------------- freshness and availability

    function test_stale_exactlyAtMaxAgeIsAccepted_oneSecondLaterIsNot() public {
        uint256 pid = _create(_price(PulseAutomation.Op.GT, 1, MAX_AGE));
        feed.set(PRICE_2000, _now() - MAX_AGE); // age == maxAge
        assertTrue(_sends(pid), "age == maxAge is still fresh");

        uint256 pid2 = _create(_price(PulseAutomation.Op.GT, 1, MAX_AGE));
        feed.set(PRICE_2000, _now() - MAX_AGE - 1); // one second too old
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid2, "Price feed stale");
        _run(pid2);
        assertEq(pulse.getPermission(pid2).lastExecutionDay, type(uint256).max, "stale does not burn the day");
    }

    function test_stale_aTrueConditionWithAnOldPriceNeverSends() public {
        uint256 pid = _create(_price(PulseAutomation.Op.GT, 1, MAX_AGE)); // would pass on value alone
        feed.set(PRICE_2000, _now() - 2 days);
        assertFalse(_sends(pid));
    }

    function test_feed_futureTimestampDoesNotUnderflowOrRevert() public {
        uint256 pid = _create(_price(PulseAutomation.Op.GT, 1, MAX_AGE));
        feed.set(PRICE_2000, _now() + 1 days); // clock skew
        assertTrue(_sends(pid));
    }

    function test_feed_unavailable_revertingFeedIsARefusalNotARevert() public {
        uint256 pid = _create(_price(PulseAutomation.Op.GT, 1, MAX_AGE));
        feed.setRevert(true);
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Price feed unavailable");
        _run(pid); // must not revert
        assertEq(usdc.balanceOf(savings), 0);
    }

    function test_feed_unavailable_nonPositiveAnswerOrNoUpdateTime() public {
        uint256 pid = _create(_price(PulseAutomation.Op.LT, type(uint128).max, MAX_AGE));

        feed.set(0, _now());
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Price feed unavailable");
        _run(pid);

        feed.set(-1, _now());
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Price feed unavailable");
        _run(pid);

        feed.set(PRICE_2000, 0);
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Price feed unavailable");
        _run(pid);

        assertEq(usdc.balanceOf(savings), 0, "LT-huge would pass on any real price; none of these may send");
    }

    function test_feed_codeVanishesAfterCreation_isARefusalNotARevert() public {
        // A codeless address would revert before a try/catch could see it; _readFeed checks first.
        uint256 pid = _create(_price(PulseAutomation.Op.GT, 1, MAX_AGE));
        vm.etch(address(feed), bytes(""));
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Price feed unavailable");
        _run(pid); // must not revert
        assertEq(usdc.balanceOf(savings), 0);
    }

    function test_feed_recoversAfterOutage() public {
        uint256 pid = _create(_price(PulseAutomation.Op.GT, 1, MAX_AGE));
        feed.setRevert(true);
        assertFalse(_sends(pid));
        feed.setRevert(false);
        assertTrue(_sends(pid), "the same permission works once the feed is back");
    }

    // ------------------------------------------------------------ interaction with the other rules

    function test_order_balanceConditionIsReportedBeforePrice() public {
        vm.prank(user);
        uint256 pid = pulse.createPermissionWithPrice(
            address(usdc), savings, 10 * USDC, 10 * USDC, WEEK, _now() + 365 days,
            FRIDAY, PulseAutomation.Op.GT, 5_000 * USDC, // balance > 5000: unmet (user has 1000)
            _price(PulseAutomation.Op.GT, type(uint128).max, MAX_AGE) // price also unmet
        );
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Balance condition not met");
        _run(pid);
    }

    function test_order_weekdayAndOncePerDayComeBeforePrice() public {
        uint256 pid = _create(_price(PulseAutomation.Op.GT, type(uint128).max, MAX_AGE)); // price unmet
        vm.warp(_now() + 1 days); // Saturday
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Not the scheduled day (UTC)");
        _run(pid);

        vm.warp(FRIDAY_TS);
        feed.set(PRICE_2000, FRIDAY_TS);
        uint256 pid2 = _create(_price(PulseAutomation.Op.GT, 1, MAX_AGE));
        assertTrue(_sends(pid2));
        // same day again: refused for the day, even though the price is now unmet
        feed.set(1, _now());
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid2, "Already executed for this UTC day");
        _run(pid2);
    }

    function test_priceCondition_stillRespectsCaps() public {
        uint256 pid = _create(_price(PulseAutomation.Op.GT, 1, MAX_AGE));
        vm.expectEmit(true, false, false, true);
        emit ExecutionRejected(pid, "Amount exceeds per-execution limit");
        vm.prank(executor);
        pulse.execute(pid, 10 * USDC + 1);
        assertEq(usdc.balanceOf(savings), 0);
    }

    function test_priceCondition_weeklySendsAcrossFridays() public {
        uint256 pid = _create(_price(PulseAutomation.Op.LT, 2_500 * 1e8, MAX_AGE));
        for (uint256 w = 0; w < 4; w++) {
            feed.set(PRICE_2000, _now()); // keep the feed fresh after each warp
            assertTrue(_sends(pid), "each Friday sends while ETH < 2500");
            vm.warp(_now() + WEEK);
        }
        assertEq(usdc.balanceOf(savings), 4 * USDC);
    }

    // ----------------------------------------------------------------- trust boundary

    function test_trustBoundary_executorCannotSendWhilePriceConditionFails() public {
        uint256 pid = _create(_price(PulseAutomation.Op.LT, 1_500 * 1e8, MAX_AGE));
        // The executor tries every amount it is allowed to use; none may move funds.
        for (uint256 a = 1; a <= 10; a++) {
            vm.prank(executor);
            pulse.execute(pid, a * USDC);
        }
        assertEq(usdc.balanceOf(savings), 0);
    }

    function test_trustBoundary_nobodyCanSwapTheFeedAfterCreation() public {
        uint256 pid = _create(_price(PulseAutomation.Op.LT, 1_500 * 1e8, MAX_AGE));
        MockAggregator rigged = new MockAggregator(8);
        rigged.set(1, _now()); // would satisfy "< 1500"
        // There is no function that changes a permission's feed; the stored address is immutable.
        assertEq(pulse.getPermission(pid).priceFeed, address(feed));
        assertFalse(_sends(pid));
        assertEq(rigged.updatedAt(), _now()); // (the rigged feed exists but is unreachable)
    }

    function test_trustBoundary_attackerFeedIsOnlyTheCreatorsOwnRisk() public {
        // Anyone may create a permission against any feed; the harm is confined to their own funds
        // moving to the recipient THEY chose, within THEIR caps. The app allowlists feeds off-chain.
        MockAggregator rigged = new MockAggregator(8);
        rigged.set(1, _now());
        PulseAutomation.PriceCondition memory pc = _price(PulseAutomation.Op.LT, 1_500 * 1e8, MAX_AGE);
        pc.feed = address(rigged);
        uint256 pid = _create(pc);
        assertTrue(_sends(pid));
        assertEq(usdc.balanceOf(savings), 1 * USDC);
    }

    // ----------------------------------------------------------------------------- fuzz

    function _offchain(uint256 a, PulseAutomation.Op op, uint256 b) internal pure returns (bool) {
        if (op == PulseAutomation.Op.GT) return a > b;
        if (op == PulseAutomation.Op.GTE) return a >= b;
        if (op == PulseAutomation.Op.LT) return a < b;
        if (op == PulseAutomation.Op.LTE) return a <= b;
        return a == b;
    }

    function testFuzz_priceCondition_matchesOffchainSemantics(uint96 price, uint8 opRaw, uint96 threshold) public {
        price = uint96(bound(price, 1, type(uint96).max));
        threshold = uint96(bound(threshold, 1, type(uint96).max));
        PulseAutomation.Op op = PulseAutomation.Op(bound(opRaw, 0, 4));

        feed.set(int256(uint256(price)), _now());
        uint256 pid = _create(_price(op, threshold, MAX_AGE));
        assertEq(_sends(pid), _offchain(price, op, threshold));
    }

    function testFuzz_priceCondition_freshnessBoundary(uint32 ageSeconds, uint32 maxAge) public {
        maxAge = uint32(bound(maxAge, 1, 7 days));
        ageSeconds = uint32(bound(ageSeconds, 0, 14 days));
        uint256 pid = _create(_price(PulseAutomation.Op.GT, 1, maxAge));
        feed.set(PRICE_2000, _now() - ageSeconds);
        assertEq(_sends(pid), ageSeconds <= maxAge);
    }

    function testFuzz_priceCondition_neverExceedsCaps(uint96 amount) public {
        uint256 pid = _create(_price(PulseAutomation.Op.GT, 1, MAX_AGE));
        vm.prank(executor);
        pulse.execute(pid, amount);
        assertLe(usdc.balanceOf(savings), 10 * USDC);
    }
}
