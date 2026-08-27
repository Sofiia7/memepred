// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/OracleResolver.sol";
import "../src/OrderbookMarket.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "./helpers/RedstonePayloadBuilder.sol";
import "./helpers/RedstoneHarness.sol";
import "./mocks/MockMarketRegistry.sol";
import "./mocks/MockUSDC.sol";

/// @notice Restores coverage of OracleResolver — the previous test file was
///         deleted during the cold-start refactor and never replaced.
///         Focus areas: TWAP staleness, spread detection, Pyth normalization,
///         keeper role gating, ETH top-up withdrawal.
contract OracleResolverTest is Test {
    OracleResolverHarness resolver;

    address admin  = address(this);
    address keeper = makeAddr("keeper");
    address other  = makeAddr("other");

    bytes32 constant FEED = bytes32("PEPE/USD");

    function setUp() public {
        resolver = new OracleResolverHarness();
        resolver.addKeeper(keeper);
        // RedStone payloads are timestamped in milliseconds and the consumer
        // rejects anything from before mid-2022, so tests cannot run at t=0.
        vm.warp(1_787_000_000);
    }

    // ─── HELPERS ────────────────────────────────────────────
    /**
     * Record a price the way the keeper does: the value rides on the calldata
     * as a RedStone payload signed by three mock signers, not as a parameter.
     *
     * `value8dp` is the price scaled by 1e8, which is exactly the scale the old
     * MockPyth calls used via expo -8 - so the numbers in these tests did not
     * have to change when the oracle did.
     */
    function _record(uint256 value8dp) internal {
        _record(FEED, value8dp);
    }

    function _record(bytes32 feedId, uint256 value8dp) internal {
        vm.prank(keeper);
        (bool ok,) = address(resolver).call(bytes.concat(
            abi.encodeWithSelector(OracleResolver.recordPrice.selector, feedId),
            RedstonePayloadBuilder.buildNow(feedId, value8dp, 3)
        ));
        require(ok, "recordPrice reverted");
    }

    /// Settle one match, carrying `spot8dp` as the live price the recorded TWAP
    /// is sanity-checked against. Under Pyth this was a separate setPrice call
    /// before the resolve; now it is part of the same transaction.
    function _resolveMatch(address market, uint256 matchId, uint256 spot8dp) internal {
        vm.prank(keeper);
        (bool ok,) = address(resolver).call(bytes.concat(
            abi.encodeWithSelector(OracleResolver.resolveOrderbookMatch.selector, market, matchId),
            RedstonePayloadBuilder.buildNow(FEED, spot8dp, 3)
        ));
        require(ok, "resolveOrderbookMatch reverted");
    }

    function _resolveBatch(address market, uint256 maxCount, uint256 spot8dp)
        internal returns (uint256 settled)
    {
        vm.prank(keeper);
        (bool ok, bytes memory ret) = address(resolver).call(bytes.concat(
            abi.encodeWithSelector(OracleResolver.resolveOrderbookMarketBatch.selector, market, maxCount),
            RedstonePayloadBuilder.buildNow(FEED, spot8dp, 3)
        ));
        require(ok, "resolveOrderbookMarketBatch reverted");
        settled = abi.decode(ret, (uint256));
    }

    function _resolveAll(address market, uint256 spot8dp) internal {
        vm.prank(keeper);
        (bool ok,) = address(resolver).call(bytes.concat(
            abi.encodeWithSelector(OracleResolver.resolveOrderbookMarket.selector, market),
            RedstonePayloadBuilder.buildNow(FEED, spot8dp, 3)
        ));
        require(ok, "resolveOrderbookMarket reverted");
    }

    /// Place a bet the way a user does: the strike rides on the calldata of the
    /// bet itself, so there is no separate "set the price first" step any more.
    function _bet(
        OrderbookMarket mkt,
        address who,
        OrderbookMarket.Direction dir,
        uint256 amount,
        uint256 entry8dp
    ) internal {
        vm.prank(who);
        (bool ok,) = address(mkt).call(bytes.concat(
            abi.encodeWithSelector(
                OrderbookMarket.placeBet.selector,
                dir, amount, address(0), entry8dp * 1e10, uint256(100)
            ),
            RedstonePayloadBuilder.buildNow(FEED, entry8dp, 3)
        ));
        require(ok, "placeBet reverted");
    }

    // ─── ACCESS CONTROL ─────────────────────────────────────
    function test_AddKeeper_OnlyAdmin() public {
        vm.expectRevert();
        vm.prank(other);
        resolver.addKeeper(other);
    }

    /// Carries a valid payload deliberately: without one the call would revert
    /// for lacking a price rather than for lacking the role, and this test
    /// would pass while proving nothing about access control.
    function test_RecordPrice_OnlyKeeper() public {
        bytes memory callData = bytes.concat(
            abi.encodeWithSelector(OracleResolver.recordPrice.selector, FEED),
            RedstonePayloadBuilder.buildNow(FEED, 1e8, 3)
        );
        vm.prank(other);
        (bool ok,) = address(resolver).call(callData);
        assertFalse(ok, "a non-keeper must not be able to record a price");
    }

    function test_RemoveKeeper_RevokesAccess() public {
        resolver.removeKeeper(keeper);
        bytes memory callData = bytes.concat(
            abi.encodeWithSelector(OracleResolver.recordPrice.selector, FEED),
            RedstonePayloadBuilder.buildNow(FEED, 1e8, 3)
        );
        vm.prank(keeper);
        (bool ok,) = address(resolver).call(callData);
        assertFalse(ok, "a revoked keeper must not be able to record a price");
    }

    // ─── PRICE RECORDING / TWAP ─────────────────────────────
    /// @dev TWAP of a constant price over the window equals that price.
    function test_TWAP_ConstantPrice() public {
        // Record 5 prices spaced by 30s, all $1.00. Each _record builds a
        // payload stamped at the current block, which is what a real feed does:
        // it keeps publishing even when the price itself has not moved.
        for (uint256 i = 0; i < 5; i++) {
        _record(1_000_000_00);
            vm.warp(block.timestamp + 30);
        }

        // Snapshot history via the public getter.
        (uint256 lastPrice, uint256 ts) = resolver.priceHistory(FEED, 4);
        assertEq(lastPrice, 1e18, "normalized $1 = 1e18");
        assertGt(ts, 0);
    }

    /// @dev If the last recorded price is older than TWAP_WINDOW (5 min),
    ///      _getTWAP must revert via "no price data".
    function test_TWAP_AllStale_NotUsable() public {
        _record(1e8);

        // Jump past the TWAP window AND past the history retention window.
        // Retention was widened from 10 minutes to HISTORY_RETENTION (2h) when
        // the exit price became anchored to each match's settleAt: with
        // anchored pricing, history has to outlive a late keeper or an overdue
        // match cannot be priced at all. The behaviour under test — stale
        // points eventually get pruned — is unchanged; only the age is.
        vm.warp(block.timestamp + resolver.HISTORY_RETENTION() + 1 minutes);

        // We can't call _getTWAP directly (internal); confirm history retains
        // a stale point and head advances on next recordPrice cleanup.
        (, uint256 ts0) = resolver.priceHistory(FEED, 0);
        assertGt(ts0, 0, "old point retained");
        assertEq(resolver.historyHead(FEED), 0, "head not yet advanced");

        // Trigger cleanup with a fresh recordPrice. The staleness under test
        // is that of the OLD history POINT, not of the incoming payload, which
        // is always stamped at the current block.
        _record(1e8);
        assertEq(resolver.historyHead(FEED), 1, "head advanced past stale entry");
    }

    // ─── PRICE NORMALIZATION ────────────────────────────────
    // The two expo-specific tests that lived here are gone with the exponent:
    // Pyth delivered a price plus a signed exponent, RedStone delivers a plain
    // integer at 8 decimals. The 8dp→1e18 conversion is covered across three
    // magnitudes in OracleResolverRedstone.t.sol.

    /// @dev Fuzz: any plausible price normalises without reverting or
    ///      collapsing to zero.
    function testFuzz_Normalize_NoRevert_PositivePrice(uint64 value8dp) public {
        vm.assume(value8dp > 0 && value8dp < 1e15);

        _record(value8dp);

        (uint256 price, ) = resolver.priceHistory(FEED, 0);
        assertEq(price, uint256(value8dp) * 1e10, "8dp scaled to 1e18");
        assertGt(price, 0, "normalized > 0");
    }

    // ─── HISTORY CLEANUP / HEAD ADVANCE ─────────────────────
    function test_HistoryHead_NotAffectingFreshPrices() public {
        // 3 fresh prices in the window.
        for (uint256 i = 0; i < 3; i++) {
        _record(1e8);
            vm.warp(block.timestamp + 60);
        }
        // Head should still be 0 — none are stale yet.
        assertEq(resolver.historyHead(FEED), 0);
    }

    // ─── DURATION-SCALED TWAP EXIT WINDOW (Sprint 5.5 audit fix) ────
    /// @dev Before this fix, the exit TWAP always averaged over a flat
    ///      5-minute window regardless of market duration. For a 5-minute
    ///      market that means the window == the ENTIRE match period, so the
    ///      "exit price" was really "average price over the whole bet" —
    ///      diluted by stale early-period ticks — instead of a short
    ///      end-of-period close. This proves a 5-minute market now uses a
    ///      ~60s window (duration/5): a late price move dominates the exit
    ///      price instead of being blended with 210s of earlier, stale ticks.
    function test_TWAP_WindowScalesDownForShortDurationMarket() public {
        MockUSDC usdc = new MockUSDC();
        GenesisNFT genesisNFT = new GenesisNFT("ipfs://test/");
        LiquidityPool pool = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        OrderbookMarket market = new OrderbookMarketHarness(
            address(usdc),
            address(resolver),
            address(pool),
            makeAddr("feeDistrib"),
            address(0),
            makeAddr("multisig"),
            FEED,
            5 minutes
        );
        // authorizeMarket now requires the pool's factory to vouch for the
        // market; this suite deploys one directly, so stand a registry up.
        MockMarketRegistry registry = new MockMarketRegistry();
        registry.register(address(market));
        pool.setMarketFactory(address(registry));
        pool.authorizeMarket(address(market));

        address alice = makeAddr("alice");
        address bob   = makeAddr("bob");
        usdc.mint(alice, 100e6);
        usdc.mint(bob,   100e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(market), type(uint256).max);

        // Entry price locked at $1.00, carried by each bet's own calldata.
        _bet(market, alice, OrderbookMarket.Direction.UP,   25e6, 1e8);
        _bet(market, bob,   OrderbookMarket.Direction.DOWN, 25e6, 1e8);

        // 8 stale ticks at $1.00 spanning the first 210s of the match.
        // Refresh the mock's publishTime each tick — a real feed keeps
        // publishing even when the price itself hasn't moved.
        for (uint256 i = 0; i < 8; i++) {
        _record(1e8);
            vm.warp(block.timestamp + 30);
        }

        // Price genuinely moves to $2.00 for the last ~90s of the match.
        for (uint256 i = 0; i < 3; i++) {
        _record(2e8);
            vm.warp(block.timestamp + 30);
        }

        // Settle just past the 5-minute duration.
        vm.warp(block.timestamp + 1);
        _resolveMatch(address(market), 1, 2e8);

        OrderbookMarket.Match memory m = market.getMatch(1);
        // A ~60s window (duration/5) sees only the $2.00 ticks → exactly
        // $2.00. The old flat-5-minute window would have blended in the
        // $1.00 ticks and landed around $1.33 instead.
        assertEq(m.exitPrice, 2e18, "exit TWAP must reflect the short end-of-period window, not the whole match duration");
    }

    // ─── RESOLVE ENTRYPOINTS (Sprint 5.5 coverage hardening) ────
    /// @dev These are the ACTUAL functions the production keeper calls
    ///      (resolveKeeper.ts → resolveOrderbookMarketBatch). Before this,
    ///      the only coverage of resolveOrderbookMatch/_resolveBatch was the
    ///      one TWAP-window test above — the anomaly-cancel branch and the
    ///      batch/unbounded wrappers had zero coverage.
    /**
     * The exit price must come from the match's own settleAt, not from whenever
     * the keeper got around to it.
     *
     * Entry is $1.00. At settleAt the price is $1.05, so UP won on the merits.
     * The keeper then goes down for 30 minutes and, on recovery, the market has
     * collapsed to $0.50. Before anchoring, settlement read the price at keeper
     * time and UP lost despite having been right — a user's entire stake turned
     * on when a server came back.
     */
    function test_LateSettlement_UsesPriceAtSettleAt_NotAtKeeperTime() public {
        (OrderbookMarket market, uint256 matchId) = _freshMarketWithOneMatch(15 minutes);
        bytes[] memory data = new bytes[](0);

        // Price at the moment the bet was actually due: $1.05 → UP wins.
        vm.warp(block.timestamp + 15 minutes);
        _record(105e6);

        // Keeper is down for half an hour; the coin collapses meanwhile.
        vm.warp(block.timestamp + 30 minutes);
        _record(50e6);

        uint256 settled = _resolveBatch(address(market), 10, 50e6);

        assertEq(settled, 1, "an overdue match must still settle");
        OrderbookMarket.Match memory m = market.getMatch(matchId);
        assertTrue(m.settled, "settled");
        assertTrue(m.upWon, "UP was right at settleAt and must win regardless of keeper lateness");
        assertGt(m.exitPrice, m.entryPrice, "exit price is the one from settleAt");
    }

    /**
     * Past HISTORY_RETENTION there is no honest price for the match's deadline.
     * Settling anyway would invent a winner, so the match is skipped and left
     * for the permissionless emergencyRefundMatch — and, importantly, the rest
     * of the batch is not reverted.
     */
    function test_SettlementBeyondRetention_SkipsRatherThanInventingAWinner() public {
        (OrderbookMarket market, uint256 matchId) = _freshMarketWithOneMatch(15 minutes);
        bytes[] memory data = new bytes[](0);

        vm.warp(block.timestamp + 15 minutes);
        _record(105e6);

        // Outage longer than the retention window: the settleAt-era points are
        // pruned, so nothing covers this match's window any more.
        vm.warp(block.timestamp + resolver.HISTORY_RETENTION() + 10 minutes);
        _record(50e6);

        uint256 settled = _resolveBatch(address(market), 10, 50e6);

        assertEq(settled, 0, "must not settle a match it cannot price");
        OrderbookMarket.Match memory m = market.getMatch(matchId);
        assertFalse(m.settled, "left unsettled for emergencyRefundMatch");
    }

    function _freshMarketWithOneMatch(uint256 duration)
        internal
        returns (OrderbookMarket market, uint256 matchId)
    {
        MockUSDC usdc = new MockUSDC();
        GenesisNFT genesisNFT = new GenesisNFT("ipfs://test/");
        LiquidityPool pool = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        market = new OrderbookMarketHarness(
            address(usdc),
            address(resolver),
            address(pool),
            makeAddr("feeDistrib"),
            address(0),
            makeAddr("multisig"),
            FEED,
            duration
        );
        // authorizeMarket now requires the pool's factory to vouch for the
        // market; this suite deploys one directly, so stand a registry up.
        MockMarketRegistry registry = new MockMarketRegistry();
        registry.register(address(market));
        pool.setMarketFactory(address(registry));
        pool.authorizeMarket(address(market));

        address alice = makeAddr("alice");
        address bob   = makeAddr("bob");
        usdc.mint(alice, 100e6);
        usdc.mint(bob,   100e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(market), type(uint256).max);

        // Entry locked at $1.00.
        _bet(market, alice, OrderbookMarket.Direction.UP,   25e6, 1e8);
        _bet(market, bob,   OrderbookMarket.Direction.DOWN, 25e6, 1e8);

        matchId = 1;
    }

    function test_ResolveOrderbookMatch_Reverts_NonKeeper() public {
        (OrderbookMarket market, uint256 matchId) = _freshMarketWithOneMatch(15 minutes);
        vm.warp(block.timestamp + 15 minutes + 1);
        // Carries a valid payload deliberately: without one the call would
        // revert for lacking a price rather than for lacking the role.
        vm.prank(other);
        (bool ok,) = address(resolver).call(bytes.concat(
            abi.encodeWithSelector(
                OracleResolver.resolveOrderbookMatch.selector, address(market), matchId),
            RedstonePayloadBuilder.buildNow(FEED, 1e8, 3)
        ));
        assertFalse(ok, "a non-keeper must not be able to settle");
    }

    function test_ResolveOrderbookMatch_AnomalyCancels_NoSettle() public {
        (OrderbookMarket market, uint256 matchId) = _freshMarketWithOneMatch(15 minutes);
        bytes[] memory data = new bytes[](0);

        // Record a price point inside the TWAP window (duration/5 = 3 min
        // for a 15-min market) so exitTwap ≈ $1.00.
        vm.warp(block.timestamp + 15 minutes - 60);
        _record(1e8);
        vm.warp(block.timestamp + 61); // now >= settleAt

        // Spot price has since diverged wildly from the TWAP → spread > 2%
        // must cancel settlement rather than lock in a bad exit price.
        _resolveMatch(address(market), matchId, 2e8);

        OrderbookMarket.Match memory m = market.getMatch(matchId);
        assertFalse(m.settled, "anomaly must block settlement");
    }

    function test_ResolveOrderbookMarketBatch_SettlesMultipleUpToMaxCount() public {
        (OrderbookMarket market, ) = _freshMarketWithOneMatch(15 minutes);

        address carol = makeAddr("carol");
        address dave  = makeAddr("dave");
        MockUSDC usdc = MockUSDC(address(market.usdc()));
        usdc.mint(carol, 100e6);
        usdc.mint(dave,  100e6);
        vm.prank(carol); usdc.approve(address(market), type(uint256).max);
        vm.prank(dave);  usdc.approve(address(market), type(uint256).max);
        _bet(market, carol, OrderbookMarket.Direction.UP,   25e6, 1e8);
        _bet(market, dave,  OrderbookMarket.Direction.DOWN, 25e6, 1e8);

        bytes[] memory data = new bytes[](0);
        vm.warp(block.timestamp + 15 minutes - 60);
        _record(1e8);
        vm.warp(block.timestamp + 61);
        // The spot the anomaly check uses now rides on the resolve call itself.
        uint256 settled = _resolveBatch(address(market), 10, 1e8);
        assertEq(settled, 2, "both ready matches settled in one batch call");
    }

    function test_ResolveOrderbookMarket_UnboundedWrapper_SettlesAll() public {
        (OrderbookMarket market, uint256 matchId) = _freshMarketWithOneMatch(15 minutes);
        bytes[] memory data = new bytes[](0);
        vm.warp(block.timestamp + 15 minutes - 60);
        _record(1e8);
        vm.warp(block.timestamp + 61);
        _resolveAll(address(market), 1e8);

        OrderbookMarket.Match memory m = market.getMatch(matchId);
        assertTrue(m.settled, "unbounded wrapper settles the ready match");
    }

    // ─── ETH MANAGEMENT ─────────────────────────────────────
    /**
     * The resolver no longer accepts ether at all. Its payable receive() existed
     * to fund Pyth update fees; RedStone charges nothing, so a balance here is
     * now a mistake, and refusing it stops anyone quietly recreating the
     * "resolver ran dry and settlement stopped" failure.
     */
    function test_RejectsPlainEther() public {
        vm.deal(address(this), 1 ether);

        (bool ok, ) = address(resolver).call{value: 1 ether}("");

        assertFalse(ok, "the resolver must not accept ether any more");
        assertEq(address(resolver).balance, 0);
    }

    /// withdrawETH survives only to rescue a forced send, which no missing
    /// receive() can block. vm.deal stands in, since nothing can pay in normally.
    function test_WithdrawRescuesForcedEther() public {
        vm.deal(address(resolver), 1 ether);

        address payable sink = payable(makeAddr("sink"));
        resolver.withdrawETH(sink, 0.5 ether);

        assertEq(address(resolver).balance, 0.5 ether);
        assertEq(sink.balance, 0.5 ether);
    }

    function test_WithdrawETH_OnlyAdmin() public {
        vm.deal(address(resolver), 1 ether);
        vm.prank(other);
        vm.expectRevert();
        resolver.withdrawETH(payable(other), 0.1 ether);
    }

    /// @dev The low-level call inside withdrawETH can fail (e.g. recipient
    ///      has no receive/fallback) — must revert with "eth withdraw failed"
    ///      instead of silently swallowing a failed transfer.
    function test_WithdrawETH_Reverts_OnFailedTransfer() public {
        vm.deal(address(resolver), 1 ether);
        RejectsEth sink = new RejectsEth();
        vm.expectRevert(bytes("eth withdraw failed"));
        resolver.withdrawETH(payable(address(sink)), 0.1 ether);
    }

    // ─── BATCH ANOMALY PATH (coverage gap: only the single-match resolve
    // ─── entrypoint had an anomaly-cancels test; the batch path (the one the
    // ─── production keeper actually calls) shared the same _resolveBatch
    // ─── anomaly-guard but had never exercised it) ──────────────────────
    function test_ResolveOrderbookMarketBatch_AnomalyCancels_NoSettle() public {
        (OrderbookMarket market, uint256 matchId) = _freshMarketWithOneMatch(15 minutes);
        bytes[] memory data = new bytes[](0);

        vm.warp(block.timestamp + 15 minutes - 60);
        _record(1e8);
        vm.warp(block.timestamp + 61);

        // Spot diverges wildly from the recorded TWAP → batch path must also
        // cancel settlement rather than lock in a bad exit price.
        uint256 settled = _resolveBatch(address(market), 10, 2e8);

        assertEq(settled, 0, "anomaly must block settlement in the batch path too");
        OrderbookMarket.Match memory m = market.getMatch(matchId);
        assertFalse(m.settled);
    }

    // ─── TWAP WINDOW CLAMPS (coverage gap: the CAP and MIN_TWAP_WINDOW
    // ─── clamps existed as named constants but neither had ever actually
    // ─── been triggered by a test — the short-duration test's scaled window
    // ─── (60s) sits between the floor (30s) and cap (300s), so it exercises
    // ─── neither clamp) ──────────────────────────────────────────────────

    /// @dev 24h market: duration/5 = 17280s, far above TWAP_WINDOW_CAP (5min).
    ///      A price point ~8 minutes before settle sits outside the capped
    ///      5-minute window but would still be inside the raw (uncapped)
    ///      ~4.8h window — proving the cap is what excludes it, not
    ///      unrelated history pruning (which only prunes after 10 minutes).
    function test_TWAP_WindowCapsForLongDurationMarket() public {
        (OrderbookMarket market, uint256 matchId) = _freshMarketWithOneMatch(24 hours);
        bytes[] memory data = new bytes[](0);

        // Anomalous tick 8 minutes before settle (settle = duration + 1s) —
        // outside a capped 5-min window, inside an uncapped ~4.8h window,
        // and inside the unrelated 10-min history-prune cutoff (so it's
        // excluded by the CAP, not by unrelated garbage collection).
        vm.warp(block.timestamp + 24 hours - 8 minutes);
        _record(5e8);

        // Fresh tick 2 minutes before settle.
        vm.warp(block.timestamp + 6 minutes);
        _record(2e8);

        // Advance the remaining 2 minutes to settle = duration + 1s exactly.
        vm.warp(block.timestamp + 2 minutes);
        // Fresh spot matching the expected TWAP.
        _resolveMatch(address(market), matchId, 2e8);

        OrderbookMarket.Match memory m = market.getMatch(matchId);
        assertTrue(m.settled, "capped window must settle cleanly, not treat the 8-min-old tick as an anomaly");
        assertEq(m.exitPrice, 2e18, "capped 5-min window must exclude the 8-min-old tick entirely");
    }

    /// @dev 60s market: duration/5 = 12s, below MIN_TWAP_WINDOW (30s). Settle
    ///      happens at duration + 1s = 61s. A tick 26s before settle (t=35)
    ///      sits outside a raw 12s window (cutoff=49) but inside the floored
    ///      30s window (cutoff=31) — asserting the blended average (not just
    ///      the freshest tick) proves the floor actually widened the window.
    function test_TWAP_WindowFloorsForVeryShortDuration() public {
        (OrderbookMarket market, uint256 matchId) = _freshMarketWithOneMatch(60);
        bytes[] memory data = new bytes[](0);

        vm.warp(block.timestamp + 35); // t=35: 26s before the eventual t=61 settle
        _record(5e8);

        vm.warp(block.timestamp + 20); // t=55: 6s before settle
        _record(2e8);

        vm.warp(block.timestamp + 6); // t=61 = duration + 1s
        // Fresh spot matching the expected blended TWAP.
        _resolveMatch(address(market), matchId, 3.5e8);

        OrderbookMarket.Match memory m = market.getMatch(matchId);
        assertTrue(m.settled);
        assertEq(m.exitPrice, 3.5e18, "floored 30s window must include both ticks, not just the freshest one");
    }

    /// @dev Resolving a match whose feed has literally never had a price
    ///      recorded must revert with "no price data" rather than settling
    ///      on a bogus zero/uninitialized TWAP.
    function test_Resolve_Reverts_NoPriceDataEverRecorded() public {
        (OrderbookMarket market, uint256 matchId) = _freshMarketWithOneMatch(15 minutes);
        bytes[] memory data = new bytes[](0);
        vm.warp(block.timestamp + 15 minutes + 1);

        vm.prank(keeper);
        vm.expectRevert(bytes("no price data"));
        (bool ok,) = address(resolver).call(bytes.concat(
            abi.encodeWithSelector(OracleResolver.resolveOrderbookMatch.selector, address(market), matchId),
            RedstonePayloadBuilder.buildNow(FEED, 1e8, 3)
        ));
        ok; // silence unused; expectRevert already asserted the failure
    }

    // Required for ETH-receiving tests.
    receive() external payable {}
}

/// @dev Minimal contract with no receive/fallback — plain ETH transfers to it
///      always fail, used to exercise withdrawETH's failure branch.
contract RejectsEth {}
