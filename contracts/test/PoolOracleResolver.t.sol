// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PoolOracleResolver.sol";
import "../src/OrderbookMarket.sol";
import "./mocks/MockUniswapV3Pool.sol";
import "./mocks/MockSettleableMarket.sol";

/**
 * PoolOracleResolver: the Robinhood Chain oracle path.
 *
 * The properties worth testing here are the ones that differ from
 * OracleResolver, plus the one that must NOT differ - that settlement is priced
 * at each match's own settleAt rather than at whenever the keeper ran. That bug
 * cost real money on Base and the fix is the reason _getTWAPAt exists; moving
 * to a pool oracle is exactly the kind of change that would quietly reintroduce
 * it, because observe() makes "now" the easy thing to ask for.
 */
contract PoolOracleResolverTest is Test {
    PoolOracleResolver resolver;
    MockUniswapV3Pool pool;
    MockSettleableMarket market;

    address weth = makeAddr("weth");
    address memecoin = makeAddr("memecoin");
    address keeper = makeAddr("keeper");
    address other = makeAddr("other");

    uint256 constant DURATION = 15 minutes; // exit window = duration/5 = 180s
    uint256 constant WINDOW = 180;
    uint32 constant T0 = 1_787_000_000;

    function setUp() public {
        vm.warp(T0);
        resolver = new PoolOracleResolver(weth);
        resolver.addKeeper(keeper);

        // memecoin is token0, WETH is token1: the quote is the pool's own
        // token1/token0 ratio, no reciprocal.
        pool = new MockUniswapV3Pool(memecoin, weth, 10000);
        market = new MockSettleableMarket(_feedId(address(pool)), DURATION);
    }

    function _feedId(address p) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(p)));
    }

    /// Relative comparison: the tick ladder rounds, so exact equality against a
    /// float-derived reference would be testing the rounding, not the price.
    function _assertClose(uint256 actual, uint256 expected, string memory what) internal pure {
        uint256 diff = actual > expected ? actual - expected : expected - actual;
        assertLt(diff * 1e9, expected, what); // within 1e-9 relative
    }

    // ── PRICE ────────────────────────────────────────────────
    /**
     * Reference values are 1.0001^tick computed from the definition in
     * JavaScript, not with the tick ladder - so this checks the whole pipeline
     * (TickMath, the Q192/Q128 branch, the WAD scaling) against something that
     * shares no code with it.
     */
    function test_SpotPrice_MatchesTheDefinition() public {
        pool.pushTick(T0 - 1000, 0);
        assertEq(resolver.spotPriceWad(_feedId(address(pool))), 1e18, "tick 0 is exactly 1.0");

        _repriceAt(6932);
        _assertClose(resolver.spotPriceWad(_feedId(address(pool))), 2000036323830794752, "1.0001^6932");

        _repriceAt(-6932);
        _assertClose(resolver.spotPriceWad(_feedId(address(pool))), 499990919207225920, "1.0001^-6932");

        _repriceAt(100000);
        _assertClose(resolver.spotPriceWad(_feedId(address(pool))), 22015456048527955722240, "1.0001^100000");

        // Exercises the Q128 branch: sqrtRatioX96 passes uint128 up here.
        _repriceAt(202919);
        _assertClose(resolver.spotPriceWad(_feedId(address(pool))), 648962487562791136058671104, "1.0001^202919");
    }

    /// A price below 1.0 must not round the wrong way. Solidity truncates
    /// toward zero, so the floor adjustment in _meanFrom is what keeps a
    /// negative mean tick from coming out one tick high.
    function test_SpotPrice_NegativeMeanTickFloors() public {
        // Two segments averaging -0.5 ticks over the entry window.
        pool.pushTick(T0 - 3600, 0);
        pool.pushTick(uint32(block.timestamp) - 30, -1);
        uint256 price = resolver.spotPriceWad(_feedId(address(pool)));
        // floor(-0.5) = -1, so the price is 1.0001^-1, strictly below 1e18.
        assertLt(price, 1e18, "must floor toward the lower tick");
        _assertClose(price, 999900009999000064, "1.0001^-1");
    }

    /// With WETH as token0 the memecoin is token1, so the quote is the
    /// reciprocal. Getting this backwards would invert every market.
    function test_SpotPrice_TokenOrderingInvertsTheQuote() public {
        pool.setTokens(weth, memecoin);
        _repriceAt(6932);
        uint256 inverted = resolver.spotPriceWad(_feedId(address(pool)));

        pool.setTokens(memecoin, weth);
        uint256 direct = resolver.spotPriceWad(_feedId(address(pool)));

        _assertClose(inverted * direct / 1e18, 1e18, "the two orderings are reciprocal");
        assertLt(inverted, 1e18);
        assertGt(direct, 1e18);
    }

    function test_SpotPrice_RevertsWhenPoolIsEmpty() public {
        pool.pushTick(T0 - 1000, 0);
        pool.setLiquidity(0);
        vm.expectRevert("pool has no liquidity");
        resolver.spotPriceWad(_feedId(address(pool)));
    }

    function test_SpotPrice_RevertsWhenRingTooShort() public {
        pool.pushTick(T0 - 1000, 0);
        pool.setForceOld(true);
        vm.expectRevert("pool cannot price entry");
        resolver.spotPriceWad(_feedId(address(pool)));
    }

    /**
     * The strike is always the 60-second entry TWAP, never live spot - that
     * is unchanged. What is new: entry is REFUSED, not merely priced
     * honestly, when the current spot has already diverged from that TWAP by
     * more than MAX_SPREAD_BPS (2%, the same threshold the settlement spread
     * guards use).
     *
     * This is what R-4 (docs/rhc/review-2026-09-11.md §4.7 / the 2026-09-15
     * audit) is actually about: anyone can read live spot for free, and
     * betting in its direction against the lagging TWAP wins more than half
     * the time even in a pure random walk (measured: 69.6% at 60s, 58.6% at
     * 300s, in a companion Monte-Carlo check outside this repo). A full fix
     * needs storing a resting order's own price bound and checking it again
     * at fill time - a struct/ABI change deferred for a separate pass (see
     * LAUNCH-GATES.md) - but refusing the worst of the edge at entry, using
     * the same anomaly threshold already trusted for settlement, needs no
     * such change and closes the sharpest, most exploitable version of it
     * today: a large, sudden move just before someone bets into it.
     */
    function test_SpotPrice_RefusesEntry_WhenSpotHasAlreadyDivergedFromTwap() public {
        pool.pushTick(T0 - 3600, 0); // flat for the whole TWAP window
        pool.pushTick(uint32(block.timestamp), 500); // spot just moved hard, this second
        vm.expectRevert("entry price too volatile right now");
        resolver.spotPriceWad(_feedId(address(pool)));
    }

    /// The mirror case: an ordinary move well inside the threshold must not
    /// block entry - this is not a "the pool moved at all" tripwire.
    function test_SpotPrice_AllowsEntry_WhenSpotIsCloseToTwap() public {
        pool.pushTick(T0 - 3600, 0);
        pool.pushTick(uint32(block.timestamp), 50); // ~0.5%, well under 2%
        uint256 price = resolver.spotPriceWad(_feedId(address(pool)));
        assertGt(price, 0);
    }

    // ── SETTLEMENT IS ANCHORED AT settleAt ───────────────────
    /**
     * The property this whole file exists for.
     *
     * A match came due while the price was at tick 0. The keeper is an hour
     * late, and by now the pool sits at tick 100000 - a 22000x move. The exit
     * price must be the one from the match's own window, not the one the keeper
     * can see. Anchoring at block.timestamp would hand the win to the other
     * side, which is exactly the bug the Base resolver was fixed for.
     */
    function test_ExitPriceAnchoredAtSettleAt_NotKeeperTime() public {
        uint256 settleAt = block.timestamp + DURATION;

        pool.pushTick(T0 - 3600, 0); // flat through the match's window
        market.addMatch(1, 1e18, settleAt);

        // The match comes due, then the pool runs away long afterwards.
        vm.warp(settleAt + 1);
        pool.pushTick(uint32(block.timestamp), 100000);
        vm.warp(block.timestamp + 1 hours);

        vm.prank(keeper);
        uint256 settled = resolver.resolveOrderbookMarketBatch(address(market), 10);

        assertEq(settled, 1, "the match must settle");
        (, uint256 exitPrice) = market.settlements(0);
        assertEq(exitPrice, 1e18, "priced at settleAt, not at the keeper's block");
    }

    /// The exit window ends at settleAt and starts duration/5 before it, so a
    /// move inside that window moves the exit price and a move outside it does
    /// not.
    function test_ExitPrice_AveragesTheWindowEndingAtSettleAt() public {
        uint256 settleAt = block.timestamp + DURATION;

        pool.pushTick(T0 - 3600, 0);
        // Half the 180s window at tick 200, half at tick 0 → mean tick 100.
        pool.pushTick(uint32(settleAt - WINDOW), 200);
        pool.pushTick(uint32(settleAt - WINDOW / 2), 0);
        market.addMatch(1, 1e18, settleAt);

        vm.warp(settleAt + 1);
        vm.prank(keeper);
        resolver.resolveOrderbookMarketBatch(address(market), 10);

        (, uint256 exitPrice) = market.settlements(0);
        _assertClose(exitPrice, 1010049662092875392, "1.0001^100");
    }

    // ── UNPRICEABLE ──────────────────────────────────────────
    /// A pool drained under an open position quotes whatever the last swap
    /// left. Refuse rather than settle against it.
    function test_ZeroLiquidity_IsUnpriceable() public {
        uint256 settleAt = block.timestamp + DURATION;
        pool.pushTick(T0 - 3600, 0);
        market.addMatch(1, 1e18, settleAt);
        pool.setLiquidity(0);

        vm.warp(settleAt + 1);
        vm.expectEmit(true, true, false, true);
        emit PoolOracleResolver.MatchUnpriceable(address(market), 1, settleAt);
        vm.prank(keeper);
        uint256 settled = resolver.resolveOrderbookMarketBatch(address(market), 10);

        assertEq(settled, 0, "nothing may settle");
        assertEq(market.settlementCount(), 0);
    }

    /// observe() reverting 'OLD' is the pool-oracle equivalent of a keeper
    /// outage longer than HISTORY_RETENTION. The ring can never grow the past
    /// back, so the match is refunded at once (audit L02) rather than left
    /// locked for SETTLE_GRACE.
    function test_ObservationRingTooShort_RefundsAtOnce() public {
        uint256 settleAt = block.timestamp + DURATION;
        pool.pushTick(T0 - 3600, 0);
        market.addMatch(1, 1e18, settleAt);

        vm.warp(settleAt + 1);
        pool.setForceOld(true);

        vm.expectEmit(true, true, false, true);
        emit PoolOracleResolver.MatchUnpriceableRefunded(address(market), 1, resolver.REASON_HISTORY());
        vm.prank(keeper);
        assertEq(resolver.resolveOrderbookMarketBatch(address(market), 10), 1, "a refund is a final state");
        assertEq(market.refundCount(), 1);
        assertEq(market.refunds(0), 1);
        assertEq(market.settlementCount(), 0, "nothing was settled");
    }

    /// A pool read that fails for some reason OTHER than 'OLD' proves nothing
    /// about history, so it must never turn into a refund - a refund cannot be
    /// undone. Both failure shapes: a reason string, and no data at all (a
    /// panic or running out of gas inside the pool).
    function test_OtherObserveFailures_AreSkippedNeverRefunded() public {
        uint256 settleAt = block.timestamp + DURATION;
        pool.pushTick(T0 - 3600, 0);
        market.addMatch(1, 1e18, settleAt);
        vm.warp(settleAt + 1);

        for (uint8 mode = 1; mode <= 2; mode++) {
            pool.setForceOtherRevert(mode);
            vm.expectEmit(true, true, false, true);
            emit PoolOracleResolver.MatchUnpriceable(address(market), 1, settleAt);
            vm.prank(keeper);
            assertEq(resolver.resolveOrderbookMarketBatch(address(market), 10), 0, "left alone");
            assertEq(market.refundCount(), 0, "no refund on an unproven failure");
        }

        // And once the pool answers again it settles normally.
        pool.setForceOtherRevert(0);
        vm.prank(keeper);
        assertEq(resolver.resolveOrderbookMarketBatch(address(market), 10), 1);
        assertEq(market.settlementCount(), 1);
    }

    /// resolveOrderbookMatch lets anyone name any matchId, and a refund is
    /// permanent, so a match that has not come due must be left completely
    /// alone - even though its window "cannot be read yet".
    function test_NotDue_IsNeverRefunded() public {
        uint256 settleAt = block.timestamp + DURATION;
        pool.pushTick(T0 - 3600, 0);
        market.addMatch(1, 1e18, settleAt);

        // Make every refund condition true at once.
        pool.setForceOld(true);
        pool.setLiquidity(0);

        vm.prank(other);
        resolver.resolveOrderbookMatch(address(market), 1);

        assertEq(market.refundCount(), 0, "not due, so no refund");
        assertEq(market.settlementCount(), 0);
    }

    /// A refund that cannot complete (an LP callback failing, say) must not
    /// take the batch down: the other matches still settle, and the stuck one
    /// is reported as merely unpriceable for now.
    function test_RefundFailure_DoesNotBlockTheBatch() public {
        pool.pushTick(T0 - 7200, 0);
        uint256 oldSettleAt = block.timestamp + 60;
        vm.warp(block.timestamp + 3600);
        uint256 freshSettleAt = block.timestamp + 60;

        MockUniswapV3Pool shallow = new MockUniswapV3Pool(memecoin, weth, 10000);
        shallow.pushTick(uint32(freshSettleAt - WINDOW), 0);
        MockSettleableMarket m2 = new MockSettleableMarket(_feedId(address(shallow)), DURATION);
        m2.addMatch(1, 1e18, oldSettleAt); // predates the ring: wants a refund
        m2.addMatch(2, 1e18, freshSettleAt);
        m2.setFailRefunds(true);

        vm.warp(freshSettleAt + 1);
        vm.expectEmit(true, true, false, true);
        emit PoolOracleResolver.MatchUnpriceable(address(m2), 1, oldSettleAt);
        vm.prank(keeper);
        assertEq(resolver.resolveOrderbookMarketBatch(address(m2), 10), 1, "only the priceable one is final");
        assertEq(m2.refundCount(), 0);
        (uint256 matchId,) = m2.settlements(0);
        assertEq(matchId, 2);
    }

    /// One unpriceable match must not take the batch down with it. This is the
    /// reason _settleOne returns a bool instead of reverting.
    function test_UnpriceableMatchDoesNotBlockTheBatch() public {
        pool.pushTick(T0 - 7200, 0);

        // Match 1 came due so long ago that its window predates the ring;
        // match 2 is inside it.
        uint256 oldSettleAt = block.timestamp + 60;
        vm.warp(block.timestamp + 3600);
        uint256 freshSettleAt = block.timestamp + 60;

        // A ring that starts after match 1's window but before match 2's.
        MockUniswapV3Pool shallow = new MockUniswapV3Pool(memecoin, weth, 10000);
        shallow.pushTick(uint32(freshSettleAt - WINDOW), 0);
        MockSettleableMarket m2 = new MockSettleableMarket(_feedId(address(shallow)), DURATION);
        m2.addMatch(1, 1e18, oldSettleAt);
        m2.addMatch(2, 1e18, freshSettleAt);

        vm.warp(freshSettleAt + 1);
        vm.prank(keeper);
        uint256 settled = resolver.resolveOrderbookMarketBatch(address(m2), 10);

        assertEq(settled, 2, "the priceable match settles and the aged-out one is refunded");
        (uint256 matchId,) = m2.settlements(0);
        assertEq(matchId, 2, "the settled one is the one inside the ring");
        assertEq(m2.refunds(0), 1, "the one older than the ring was refunded");
    }

    // ── SPREAD GUARDS ────────────────────────────────────────
    /// (a) Internal consistency: the window average against the average over
    ///     its own last ANCHOR_FRACTION share. A pool shoved hard for that
    ///     whole sub-window still trips this.
    function test_SpreadGuard_WindowAgainstSustainedAnchorPush() public {
        uint256 settleAt = block.timestamp + DURATION;
        uint256 anchorWindow = WINDOW / resolver.ANCHOR_FRACTION(); // 180/3 = 60s

        pool.pushTick(T0 - 3600, 0);
        // Flat at 0 for most of the window, then shoved for the WHOLE anchor
        // sub-window: the anchor average is far from the window mean even
        // after averaging, because the push was sustained, not a blip.
        pool.pushTick(uint32(settleAt - anchorWindow), 5000);
        market.addMatch(1, 1e18, settleAt);

        vm.warp(settleAt + 1);
        vm.expectEmit(true, true, false, true);
        emit PoolOracleResolver.MatchUnpriceableRefunded(address(market), 1, resolver.REASON_SPREAD());
        vm.prank(keeper);
        assertEq(resolver.resolveOrderbookMarketBatch(address(market), 10), 1, "the refund is a final state");
        assertEq(market.settlementCount(), 0, "nothing settles");
        assertEq(market.refunds(0), 1, "the match is refunded now, not after SETTLE_GRACE");
    }

    /// Audit L02, the proof: the guard fails on FIXED history, so waiting can
    /// never change the answer. Before the fix the match stayed skipped for
    /// 24 hours, however calm the price got, and only then was refunded.
    function test_SpreadGuardTrip_IsPermanentSoItRefundsInsteadOfWaiting() public {
        uint256 settleAt = block.timestamp + DURATION;
        pool.pushTick(T0 - 3600, 0);
        // A sustained +3.5% step across the whole 60-second anchor: the anchor
        // average sits about 2.3% away from the 180-second window average.
        pool.pushTick(uint32(settleAt - 60), 350);
        market.addMatch(1, 1e18, settleAt);
        market.addMatch(2, 1e18, settleAt);

        vm.warp(settleAt + 1);
        // The price calms completely afterwards. It must make no difference.
        pool.pushTick(uint32(block.timestamp), 0);

        vm.prank(keeper);
        uint256 handled = resolver.resolveOrderbookMarketBatch(address(market), 10);
        assertEq(handled, 2, "both matches reached a final state on the first call");
        assertEq(market.refundCount(), 2);
    }

    /**
     * The fix for the exploit this guard used to enable: a 1-2 second spot
     * push right at settleAt no longer permanently blocks the match.
     *
     * Before this fix, the anchor was the single tick AT settleAt - fixed
     * history the instant time passes it, so a brief push there blocked
     * settlement FOREVER (the only recovery being a 24h wait for
     * emergencyRefundMatch, which pays the winner only their own stake back).
     * A losing side could exploit this for a fraction of a percent of MAX_BET.
     * Averaging the anchor over a wider tail dilutes a spike this short well
     * under MAX_SPREAD_BPS, so the honest window average is used instead.
     */
    function test_SpreadGuard_BriefSpikeNoLongerBlocksSettlementForever() public {
        uint256 settleAt = block.timestamp + DURATION;

        pool.pushTick(T0 - 3600, 0);
        // The old exploit: flat the whole window, then a hard shove for just
        // the last 2 seconds before settleAt.
        pool.pushTick(uint32(settleAt - 2), 5000);
        market.addMatch(1, 1e18, settleAt);

        vm.warp(settleAt + 1);
        vm.prank(keeper);
        assertEq(
            resolver.resolveOrderbookMarketBatch(address(market), 10), 1, "a 2-second spike must not block settlement"
        );
        (, uint256 exitPrice) = market.settlements(0);
        // Close to the honest window average, not the manipulated spot.
        assertLt(exitPrice, 1050000000000000000, "exit priced off the diluted window, not the spike");
    }

    /**
     * Guard (b) - anchored price against live spot - is gone. It only ever
     * applied within MAX_PRICE_AGE of settleAt, so a patient manipulator
     * could always just wait it out; what it actually did was block PROMPT
     * settlement on any pool that had simply kept trading normally since -
     * the common case on an active pool, not a rare one. Prompt settlement
     * must now succeed even though the live price has moved on since.
     */
    function test_LiveSpotDivergenceSincePassing_NoLongerBlocksPromptSettlement() public {
        uint256 settleAt = block.timestamp + DURATION;
        pool.pushTick(T0 - 3600, 0);
        market.addMatch(1, 1e18, settleAt);

        vm.warp(settleAt + 1); // settling promptly
        pool.pushTick(uint32(block.timestamp), 5000); // live price has since moved far away

        vm.prank(keeper);
        assertEq(resolver.resolveOrderbookMarketBatch(address(market), 10), 1, "prompt settlement is no longer guarded");
        (, uint256 exitPrice) = market.settlements(0);
        assertEq(exitPrice, 1e18, "still the anchored window price, not the live one");
    }

    // ── SETTLEMENT PAST GRACE ─────────────────────────────────
    /**
     * OrderbookMarket.settleMatch reverts "settlement window expired" once
     * SETTLE_GRACE has passed - calling it anyway would take the whole batch
     * down with it. The resolver must recognise this itself and skip, the
     * same way it already skips a match the pool cannot price.
     */
    function test_PastGrace_IsRefundedNotSettled() public {
        uint256 settleAt = block.timestamp + DURATION;
        pool.pushTick(T0 - 3600, 0);
        market.addMatch(1, 1e18, settleAt);

        vm.warp(settleAt + resolver.SETTLE_GRACE() + 1);
        vm.expectEmit(true, true, false, true);
        emit PoolOracleResolver.MatchUnpriceableRefunded(address(market), 1, resolver.REASON_GRACE());
        vm.prank(keeper);
        uint256 handled = resolver.resolveOrderbookMarketBatch(address(market), 10);

        assertEq(handled, 1, "refunded, which is a final state");
        assertEq(market.settlementCount(), 0, "settleMatch must never even be attempted past grace");
        assertEq(market.refundCount(), 1);
    }

    // ── ROLES AND BATCHING ───────────────────────────────────
    /**
     * Deliberately open, unlike OracleResolver's KEEPER_ROLE gate: the price
     * comes straight from the pool on every call, the same public data
     * spotPriceWad already exposes, so restricting who may trigger settlement
     * on it only adds a single point of failure (a down keeper wallet leaves
     * a settleable winner unable to collect).
     */
    function test_AnyoneMaySettle() public {
        uint256 settleAt = block.timestamp + DURATION;
        pool.pushTick(T0 - 3600, 0);
        market.addMatch(1, 1e18, settleAt);
        vm.warp(settleAt + 1);

        vm.prank(other);
        assertEq(resolver.resolveOrderbookMarketBatch(address(market), 10), 1, "any address may settle");
    }

    /// The offset entrypoint exists so a stuck match at the head cannot hide
    /// everything behind it. Same contract as OracleResolver's.
    function test_BatchFromOffsetSkipsTheHead() public {
        uint256 settleAt = block.timestamp + DURATION;
        pool.pushTick(T0 - 3600, 0);
        market.addMatch(1, 1e18, settleAt);
        market.addMatch(2, 1e18, settleAt);
        vm.warp(settleAt + 1);

        vm.prank(keeper);
        uint256 settled = resolver.resolveOrderbookMarketBatchFrom(address(market), 1, 10);

        assertEq(settled, 1);
        (uint256 matchId,) = market.settlements(0);
        assertEq(matchId, 2, "offset 1 starts at the second match");
    }

    function test_FeedIdIsThePoolAddress() public view {
        assertEq(address(resolver.poolOf(_feedId(address(pool)))), address(pool));
    }

    function test_ConstructorRejectsZeroWeth() public {
        vm.expectRevert(PoolOracleResolver.ZeroAddress.selector);
        new PoolOracleResolver(address(0));
    }

    // ── helpers ──────────────────────────────────────────────
    /// Make `tick` the pool's price for well over the entry TWAP window.
    function _repriceAt(int24 tick) internal {
        MockUniswapV3Pool p = new MockUniswapV3Pool(pool.token0(), pool.token1(), 10000);
        p.pushTick(uint32(block.timestamp) - 3600, tick);
        pool = p;
    }
}
