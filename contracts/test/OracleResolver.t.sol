// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/OracleResolver.sol";
import "../src/OrderbookMarket.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "../src/interfaces/IPyth.sol";
import "./mocks/MockPyth.sol";
import "./mocks/MockUSDC.sol";

/// @notice Restores coverage of OracleResolver — the previous test file was
///         deleted during the cold-start refactor and never replaced.
///         Focus areas: TWAP staleness, spread detection, Pyth normalization,
///         keeper role gating, ETH top-up withdrawal.
contract OracleResolverTest is Test {
    OracleResolver resolver;
    MockPyth       pyth;

    address admin  = address(this);
    address keeper = makeAddr("keeper");
    address other  = makeAddr("other");

    bytes32 constant FEED = bytes32("PEPE/USD");

    function setUp() public {
        pyth     = new MockPyth();
        resolver = new OracleResolver(address(pyth));
        resolver.addKeeper(keeper);
    }

    // ─── ACCESS CONTROL ─────────────────────────────────────
    function test_AddKeeper_OnlyAdmin() public {
        vm.expectRevert();
        vm.prank(other);
        resolver.addKeeper(other);
    }

    function test_RecordPrice_OnlyKeeper() public {
        bytes[] memory data = new bytes[](0);
        vm.prank(other);
        vm.expectRevert();
        resolver.recordPrice(FEED, data);
    }

    function test_RemoveKeeper_RevokesAccess() public {
        resolver.removeKeeper(keeper);
        pyth.setPrice(FEED, 1e8, -8);
        bytes[] memory data = new bytes[](0);
        vm.prank(keeper);
        vm.expectRevert();
        resolver.recordPrice(FEED, data);
    }

    // ─── PRICE RECORDING / TWAP ─────────────────────────────
    /// @dev TWAP of a constant price over the window equals that price.
    function test_TWAP_ConstantPrice() public {
        pyth.setPrice(FEED, 1_000_000_00, -8); // $1.00, 8 decimals
        bytes[] memory data = new bytes[](0);

        // Record 5 prices spaced by 30s, all $1. Refresh the mock's
        // publishTime each tick — a real feed keeps publishing even when
        // the price itself hasn't moved.
        for (uint256 i = 0; i < 5; i++) {
            pyth.setPrice(FEED, 1_000_000_00, -8);
            vm.prank(keeper);
            resolver.recordPrice(FEED, data);
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
        pyth.setPrice(FEED, 1e8, -8);
        bytes[] memory data = new bytes[](0);

        vm.prank(keeper);
        resolver.recordPrice(FEED, data);

        // Jump past the 5-min TWAP window (and past 10-min cleanup head).
        vm.warp(block.timestamp + 11 minutes);

        // We can't call _getTWAP directly (internal); confirm history retains
        // a stale point and head advances on next recordPrice cleanup.
        (, uint256 ts0) = resolver.priceHistory(FEED, 0);
        assertGt(ts0, 0, "old point retained");
        assertEq(resolver.historyHead(FEED), 0, "head not yet advanced");

        // Trigger cleanup via a fresh recordPrice. Refresh the mock's own
        // publishTime first — the staleness under test here is about the
        // OLD history POINT, not about Pyth's live feed being down.
        pyth.setPrice(FEED, 1e8, -8);
        vm.prank(keeper);
        resolver.recordPrice(FEED, data);
        assertEq(resolver.historyHead(FEED), 1, "head advanced past stale entry");
    }

    // ─── PYTH PRICE NORMALIZATION ───────────────────────────
    /// @dev expo = -8 → 8 decimals → divisor 1e8 → result scaled to 1e18.
    function test_Normalize_NegativeExpo() public {
        // 9142 with expo -8 → 9142 * 1e18 / 1e8 = 9142e10
        pyth.setPrice(FEED, 9142, -8);
        bytes[] memory data = new bytes[](0);
        vm.prank(keeper);
        resolver.recordPrice(FEED, data);
        (uint256 price, ) = resolver.priceHistory(FEED, 0);
        assertEq(price, 9142e10, "9142 with expo -8");
    }

    /// @dev expo = 0 → result = price * 1e18.
    function test_Normalize_ZeroExpo() public {
        pyth.setPrice(FEED, 5, 0);
        bytes[] memory data = new bytes[](0);
        vm.prank(keeper);
        resolver.recordPrice(FEED, data);
        (uint256 price, ) = resolver.priceHistory(FEED, 0);
        assertEq(price, 5e18, "5 with expo 0 = 5e18");
    }

    /// @dev Fuzz: any non-zero positive price with reasonable expo normalizes
    ///      to a non-zero uint256 without revert.
    function testFuzz_Normalize_NoRevert_PositivePrice(int64 raw, int8 expoSmall) public {
        vm.assume(raw > 0 && raw < 1e15);
        vm.assume(expoSmall > -18 && expoSmall < 0);
        int32 expo = int32(expoSmall);

        pyth.setPrice(FEED, raw, expo);
        bytes[] memory data = new bytes[](0);
        vm.prank(keeper);
        resolver.recordPrice(FEED, data);

        (uint256 price, ) = resolver.priceHistory(FEED, 0);
        assertGt(price, 0, "normalized > 0");
    }

    // ─── HISTORY CLEANUP / HEAD ADVANCE ─────────────────────
    function test_HistoryHead_NotAffectingFreshPrices() public {
        pyth.setPrice(FEED, 1e8, -8);
        bytes[] memory data = new bytes[](0);

        // 3 fresh prices in the window.
        for (uint256 i = 0; i < 3; i++) {
            pyth.setPrice(FEED, 1e8, -8);
            vm.prank(keeper);
            resolver.recordPrice(FEED, data);
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

        OrderbookMarket market = new OrderbookMarket(
            address(usdc),
            address(resolver),
            address(pool),
            makeAddr("feeDistrib"),
            address(0),
            makeAddr("multisig"),
            FEED,
            5 minutes
        );
        pool.authorizeMarket(address(market));

        address alice = makeAddr("alice");
        address bob   = makeAddr("bob");
        usdc.mint(alice, 100e6);
        usdc.mint(bob,   100e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(market), type(uint256).max);

        // Entry price locked at $1.00.
        pyth.setPrice(FEED, 1e8, -8);
        vm.prank(alice); market.placeBet(OrderbookMarket.Direction.UP,   25e6, address(0), 1e18, 100);
        vm.prank(bob);   market.placeBet(OrderbookMarket.Direction.DOWN, 25e6, address(0), 1e18, 100);

        bytes[] memory data = new bytes[](0);

        // 8 stale ticks at $1.00 spanning the first 210s of the match.
        // Refresh the mock's publishTime each tick — a real feed keeps
        // publishing even when the price itself hasn't moved.
        for (uint256 i = 0; i < 8; i++) {
            pyth.setPrice(FEED, 1e8, -8);
            vm.prank(keeper); resolver.recordPrice(FEED, data);
            vm.warp(block.timestamp + 30);
        }

        // Price genuinely moves to $2.00 for the last ~90s of the match.
        for (uint256 i = 0; i < 3; i++) {
            pyth.setPrice(FEED, 2e8, -8);
            vm.prank(keeper); resolver.recordPrice(FEED, data);
            vm.warp(block.timestamp + 30);
        }

        // Settle just past the 5-minute duration.
        vm.warp(block.timestamp + 1);
        vm.prank(keeper);
        resolver.resolveOrderbookMatch(address(market), 1, data);

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
    function _freshMarketWithOneMatch(uint256 duration)
        internal
        returns (OrderbookMarket market, uint256 matchId)
    {
        MockUSDC usdc = new MockUSDC();
        GenesisNFT genesisNFT = new GenesisNFT("ipfs://test/");
        LiquidityPool pool = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        market = new OrderbookMarket(
            address(usdc),
            address(resolver),
            address(pool),
            makeAddr("feeDistrib"),
            address(0),
            makeAddr("multisig"),
            FEED,
            duration
        );
        pool.authorizeMarket(address(market));

        address alice = makeAddr("alice");
        address bob   = makeAddr("bob");
        usdc.mint(alice, 100e6);
        usdc.mint(bob,   100e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(market), type(uint256).max);

        pyth.setPrice(FEED, 1e8, -8); // entry locked at $1.00
        vm.prank(alice); market.placeBet(OrderbookMarket.Direction.UP,   25e6, address(0), 1e18, 100);
        vm.prank(bob);   market.placeBet(OrderbookMarket.Direction.DOWN, 25e6, address(0), 1e18, 100);

        matchId = 1;
    }

    function test_ResolveOrderbookMatch_Reverts_NonKeeper() public {
        (OrderbookMarket market, uint256 matchId) = _freshMarketWithOneMatch(15 minutes);
        vm.warp(block.timestamp + 15 minutes + 1);
        bytes[] memory data = new bytes[](0);
        vm.prank(other);
        vm.expectRevert();
        resolver.resolveOrderbookMatch(address(market), matchId, data);
    }

    function test_ResolveOrderbookMatch_AnomalyCancels_NoSettle() public {
        (OrderbookMarket market, uint256 matchId) = _freshMarketWithOneMatch(15 minutes);
        bytes[] memory data = new bytes[](0);

        // Record a price point inside the TWAP window (duration/5 = 3 min
        // for a 15-min market) so exitTwap ≈ $1.00.
        vm.warp(block.timestamp + 15 minutes - 60);
        pyth.setPrice(FEED, 1e8, -8);
        vm.prank(keeper); resolver.recordPrice(FEED, data);
        vm.warp(block.timestamp + 61); // now >= settleAt

        // Spot price has since diverged wildly from the TWAP → spread > 2%
        // must cancel settlement rather than lock in a bad exit price.
        pyth.setPrice(FEED, 2e8, -8);

        vm.prank(keeper);
        resolver.resolveOrderbookMatch(address(market), matchId, data);

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
        vm.prank(carol); market.placeBet(OrderbookMarket.Direction.UP,   25e6, address(0), 1e18, 100);
        vm.prank(dave);  market.placeBet(OrderbookMarket.Direction.DOWN, 25e6, address(0), 1e18, 100);

        bytes[] memory data = new bytes[](0);
        vm.warp(block.timestamp + 15 minutes - 60);
        pyth.setPrice(FEED, 1e8, -8);
        vm.prank(keeper); resolver.recordPrice(FEED, data);
        vm.warp(block.timestamp + 61);
        pyth.setPrice(FEED, 1e8, -8); // refresh spot for the anomaly check at resolve time

        vm.prank(keeper);
        uint256 settled = resolver.resolveOrderbookMarketBatch(address(market), data, 10);
        assertEq(settled, 2, "both ready matches settled in one batch call");
    }

    function test_ResolveOrderbookMarket_UnboundedWrapper_SettlesAll() public {
        (OrderbookMarket market, uint256 matchId) = _freshMarketWithOneMatch(15 minutes);
        bytes[] memory data = new bytes[](0);
        vm.warp(block.timestamp + 15 minutes - 60);
        pyth.setPrice(FEED, 1e8, -8);
        vm.prank(keeper); resolver.recordPrice(FEED, data);
        vm.warp(block.timestamp + 61);
        pyth.setPrice(FEED, 1e8, -8); // refresh spot for the anomaly check at resolve time

        vm.prank(keeper);
        resolver.resolveOrderbookMarket(address(market), data);

        OrderbookMarket.Match memory m = market.getMatch(matchId);
        assertTrue(m.settled, "unbounded wrapper settles the ready match");
    }

    // ─── ETH MANAGEMENT ─────────────────────────────────────
    function test_ReceiveAndWithdrawETH() public {
        // Top up resolver with 1 ETH.
        vm.deal(address(this), 1 ether);
        (bool ok, ) = address(resolver).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(resolver).balance, 1 ether);

        // Withdraw 0.5 ETH as admin.
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
        pyth.setPrice(FEED, 1e8, -8);
        vm.prank(keeper); resolver.recordPrice(FEED, data);
        vm.warp(block.timestamp + 61);

        // Spot diverges wildly from the recorded TWAP → batch path must also
        // cancel settlement rather than lock in a bad exit price.
        pyth.setPrice(FEED, 2e8, -8);

        vm.prank(keeper);
        uint256 settled = resolver.resolveOrderbookMarketBatch(address(market), data, 10);

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
        pyth.setPrice(FEED, 5e8, -8);
        vm.prank(keeper); resolver.recordPrice(FEED, data);

        // Fresh tick 2 minutes before settle.
        vm.warp(block.timestamp + 6 minutes);
        pyth.setPrice(FEED, 2e8, -8);
        vm.prank(keeper); resolver.recordPrice(FEED, data);

        // Advance the remaining 2 minutes to settle = duration + 1s exactly.
        vm.warp(block.timestamp + 2 minutes);
        pyth.setPrice(FEED, 2e8, -8); // fresh spot matching the expected TWAP

        vm.prank(keeper);
        resolver.resolveOrderbookMatch(address(market), matchId, data);

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
        pyth.setPrice(FEED, 5e8, -8);
        vm.prank(keeper); resolver.recordPrice(FEED, data);

        vm.warp(block.timestamp + 20); // t=55: 6s before settle
        pyth.setPrice(FEED, 2e8, -8);
        vm.prank(keeper); resolver.recordPrice(FEED, data);

        vm.warp(block.timestamp + 6); // t=61 = duration + 1s
        pyth.setPrice(FEED, 3.5e8, -8); // fresh spot matching the expected blended TWAP

        vm.prank(keeper);
        resolver.resolveOrderbookMatch(address(market), matchId, data);

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
        resolver.resolveOrderbookMatch(address(market), matchId, data);
    }

    // Required for ETH-receiving tests.
    receive() external payable {}
}

/// @dev Minimal contract with no receive/fallback — plain ETH transfers to it
///      always fail, used to exercise withdrawETH's failure branch.
contract RejectsEth {}
