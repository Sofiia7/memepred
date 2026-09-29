// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoolOrderbookMarket.t.sol";
import "../src/PoolLiquidityPool.sol";

/**
 * Regression coverage for the 2026-09-29 pass over the 2026-09-28 audit.
 *
 * Three things are pinned here, each against the REAL contracts rather than a
 * mock market:
 *
 *   1. cancelOrder - a maker can withdraw the unmatched part of their own
 *      order at once, which is what lets a partly filled order that already
 *      won be claimed without waiting for MATCH_TIMEOUT (L01 follow-up).
 *   2. The resolver's immediate refund (L02) - a match whose exit window can
 *      never be priced is refunded on the first call after settleAt, PvP and
 *      LP-backed alike, instead of sitting locked for SETTLE_GRACE.
 *   3. An unauthorised market with a funded vault still takes bets - the
 *      deployed PoolLiquidityPool declines, it does not revert. The two suites
 *      that wire the factory to the base LiquidityPool cannot show this
 *      (it does revert there), which is how an audit note ended up claiming
 *      the opposite of what is deployed.
 */
contract FixRegressions is PoolOrderbookMarketTest {
    OrderbookMarket.Direction constant UP = OrderbookMarket.Direction.UP;
    OrderbookMarket.Direction constant DOWN = OrderbookMarket.Direction.DOWN;

    address charlie = makeAddr("fix-charlie");

    // ── cancelOrder ──────────────────────────────────────────
    function test_Cancel_UnfilledOrderReturnsTheWholeStakeAndLeavesTheQueue() public {
        uint256 id = _bet(alice, UP, 0.01 ether);
        (uint256 upBefore,) = market.getPendingDepth();
        assertEq(upBefore, 1);
        uint256 balBefore = weth.balanceOf(alice);

        vm.prank(alice);
        market.cancelOrder(id);

        assertEq(weth.balanceOf(alice) - balBefore, 0.01 ether, "stake came back in full");
        assertEq(uint256(market.getOrder(id).status), uint256(OrderbookMarket.OrderStatus.REFUNDED));
        assertTrue(market.getOrder(id).unmatchedRefunded);
        (uint256 upAfter,) = market.getPendingDepth();
        assertEq(upAfter, 0, "no longer in the queue");

        // A counter-bet finds nothing to match: it must rest, not fill a cancelled order.
        uint256 bobId = _bet(bob, DOWN, 0.01 ether);
        assertEq(market.getOrder(bobId).filledAmount, 0);
    }

    function test_Cancel_OnlyTheTraderMay() public {
        uint256 id = _bet(alice, UP, 0.01 ether);
        vm.prank(bob);
        vm.expectRevert("not your order");
        market.cancelOrder(id);
    }

    function test_Cancel_IsNotRepeatable() public {
        uint256 id = _bet(alice, UP, 0.01 ether);
        vm.startPrank(alice);
        market.cancelOrder(id);
        vm.expectRevert("already refunded");
        market.cancelOrder(id);
        vm.stopPrank();
    }

    function test_Cancel_NothingToCancelOnAFullyFilledOrder() public {
        uint256 aliceId = _bet(alice, UP, 0.01 ether);
        _bet(bob, DOWN, 0.01 ether);
        assertEq(uint256(market.getOrder(aliceId).status), uint256(OrderbookMarket.OrderStatus.MATCHED));

        vm.prank(alice);
        vm.expectRevert("nothing to refund");
        market.cancelOrder(aliceId);
    }

    /// The exit must work while the market is paused: a pause that also
    /// trapped resting orders would turn a safety switch into a lock.
    function test_Cancel_WorksWhilePaused() public {
        uint256 id = _bet(alice, UP, 0.01 ether);
        vm.prank(multisig);
        market.pause();

        vm.prank(alice);
        market.cancelOrder(id);
        assertEq(uint256(market.getOrder(id).status), uint256(OrderbookMarket.OrderStatus.REFUNDED));
    }

    /// The L01 side effect, closed: alice is half filled, the half that got
    /// matched wins, and she does not want to wait five minutes for the rest
    /// to be refunded before she can claim.
    function test_Cancel_LetsAPartlyFilledWinnerClaimWithoutWaitingForTheTimeout() public {
        // A 60-second market, so the match settles well inside MATCH_TIMEOUT
        // (the 15-minute one from setUp outlives the timeout, which hides this).
        PoolOrderbookMarket m = _shortMarket();

        vm.prank(alice);
        uint256 aliceId = m.placeBet(UP, 0.02 ether, address(0), 1e18, 100);
        vm.prank(bob);
        m.placeBet(DOWN, 0.01 ether, address(0), 1e18, 100); // fills half of alice's order
        assertEq(m.getOrder(aliceId).filledAmount, 0.01 ether);
        assertEq(m.getOrder(aliceId).amount, 0.02 ether);

        // Her matched half wins: the price steps up right after the entry and
        // stays there, so window and anchor agree and the guard is quiet.
        uint256 settleAt = m.getMatch(1).settleAt;
        pool.pushTick(uint32(block.timestamp + 5), 200);
        vm.warp(settleAt + 1);
        resolver.resolveOrderbookMarket(address(m));
        assertTrue(m.getMatch(1).settled);
        assertTrue(m.getMatch(1).upWon, "alice's side won");

        // Still inside MATCH_TIMEOUT: before cancelOrder existed she could neither
        // claim (a tail is open) nor withdraw it (refundExpired is not due).
        assertLt(block.timestamp, m.getOrder(aliceId).placedAt + m.MATCH_TIMEOUT());
        vm.prank(alice);
        vm.expectRevert("not settled");
        m.claim(aliceId);

        uint256 balBefore = weth.balanceOf(alice);
        vm.prank(alice);
        m.cancelOrder(aliceId);
        assertEq(weth.balanceOf(alice) - balBefore, 0.01 ether, "the unmatched half came back");

        vm.prank(alice);
        m.claim(aliceId);
        // Won a 0.02 pot; a directly deployed market has no feeBps, so nothing is taken.
        assertEq(weth.balanceOf(alice) - balBefore, 0.01 ether + 0.02 ether, "tail refund plus winnings");
    }

    /// A market whose exit window (30s) is short enough to settle inside MATCH_TIMEOUT.
    function _shortMarket() internal returns (PoolOrderbookMarket m) {
        GenesisNFT g = new GenesisNFT("ipfs://test/");
        // The vault that is actually deployed: it declines an unauthorised market.
        PoolLiquidityPool l = new PoolLiquidityPool(IERC20(address(weth)), address(g));
        g.setLiquidityPool(address(l));
        m = new PoolOrderbookMarket(
            address(weth),
            address(resolver),
            address(l),
            makeAddr("feeDistrib"),
            address(0),
            multisig,
            bytes32(uint256(uint160(address(pool)))),
            60
        );
        vm.prank(alice);
        weth.approve(address(m), type(uint256).max);
        vm.prank(bob);
        weth.approve(address(m), type(uint256).max);
    }

    // ── resolver refund: access control at the market ────────
    function test_RefundUnpriceable_OnlyTheResolver() public {
        _bet(alice, UP, 0.01 ether);
        _bet(bob, DOWN, 0.01 ether);
        vm.warp(market.getMatch(1).settleAt + 1);

        vm.prank(alice);
        vm.expectRevert("only resolver");
        market.refundUnpriceableMatch(1);
    }

    function test_RefundUnpriceable_NotBeforeTheMatchIsDue() public {
        _bet(alice, UP, 0.01 ether);
        _bet(bob, DOWN, 0.01 ether);

        vm.prank(address(resolver));
        vm.expectRevert("too early");
        market.refundUnpriceableMatch(1);
    }

    // ── L02: the resolver refunds at once ────────────────────
    /// The exit window is history the moment settleAt passes, so a guard that
    /// trips on it cannot un-trip. Before the fix both sides sat locked for a
    /// day and were then refunded anyway.
    function test_SpreadGuardTrip_RefundsBothSidesOnTheFirstCall() public {
        _bet(alice, UP, 0.01 ether);
        _bet(bob, DOWN, 0.01 ether);
        uint256 settleAt = market.getMatch(1).settleAt;

        // A sustained +8% shove across the whole anchor: trips the 2% guard.
        pool.pushTick(uint32(settleAt - 60), 800);
        vm.warp(settleAt + 1);

        uint256 aliceBefore = weth.balanceOf(alice);
        uint256 bobBefore = weth.balanceOf(bob);

        vm.expectEmit(true, true, false, true);
        emit PoolOracleResolver.MatchUnpriceableRefunded(address(market), 1, resolver.REASON_SPREAD());
        resolver.resolveOrderbookMatch(address(market), 1);

        assertEq(weth.balanceOf(alice) - aliceBefore, 0.01 ether, "alice got her stake back");
        assertEq(weth.balanceOf(bob) - bobBefore, 0.01 ether, "bob got his stake back");
        assertEq(weth.balanceOf(address(market)), 0, "nothing left in the market");
        assertTrue(market.getMatch(1).settled, "the match is closed");

        // Closed for good: neither path can touch it again.
        vm.expectRevert("already settled");
        market.emergencyRefundMatch(1);
        vm.prank(address(resolver));
        vm.expectRevert("already settled");
        market.settleMatch(1, 1e18);
    }

    function test_RingTooShort_RefundsWithoutWaiting() public {
        _bet(alice, UP, 0.01 ether);
        _bet(bob, DOWN, 0.01 ether);
        uint256 settleAt = market.getMatch(1).settleAt;
        vm.warp(settleAt + 1);
        pool.setForceOld(true);

        uint256 aliceBefore = weth.balanceOf(alice);
        resolver.resolveOrderbookMarket(address(market));

        assertEq(weth.balanceOf(alice) - aliceBefore, 0.01 ether);
        assertTrue(market.getMatch(1).settled);
    }

    /// An LP-backed match refunds the vault too, and releases what it had
    /// reserved, so the refund path does not leak exposure.
    function test_SpreadGuardTrip_RefundsAnLpBackedMatchAndReleasesExposure() public {
        // Fund the vault (base LiquidityPool from setUp, market already authorised).
        weth.mint(address(this), 2 ether);
        weth.approve(address(lp), type(uint256).max);
        lp.deposit(2 ether, address(this));
        uint256 assetsBefore = lp.totalAssets();

        _bet(alice, UP, 0.01 ether); // no PvP counterparty: the vault takes it
        OrderbookMarket.Match memory m = market.getMatch(1);
        assertTrue(m.lpMatch, "matched against the vault");
        assertEq(lp.totalExposure(), 0.01 ether);

        pool.pushTick(uint32(m.settleAt - 60), 800);
        vm.warp(m.settleAt + 1);
        uint256 aliceBefore = weth.balanceOf(alice);
        resolver.resolveOrderbookMatch(address(market), 1);

        assertEq(weth.balanceOf(alice) - aliceBefore, 0.01 ether, "alice refunded");
        assertEq(lp.totalExposure(), 0, "exposure released");
        assertEq(lp.totalAssets(), assetsBefore, "the vault is whole");
        assertEq(market.traderLpExposure(alice), 0, "her LP allowance is back");
    }

    // ── the vault that is actually deployed ──────────────────
    /**
     * Deployed stack: PoolLiquidityPool. A freshly created market has not been
     * authorised on it, and the vault holds money. Every order that is not
     * fully filled by the PvP queue falls through to the vault - including a
     * plain maker order on an empty book - and it must simply rest.
     */
    function test_UnauthorisedMarketWithAFundedVault_StillTakesBets() public {
        GenesisNFT g = new GenesisNFT("ipfs://test/");
        PoolLiquidityPool vault = new PoolLiquidityPool(IERC20(address(weth)), address(g));
        g.setLiquidityPool(address(vault));

        PoolOrderbookMarket m = new PoolOrderbookMarket(
            address(weth),
            address(resolver),
            address(vault),
            makeAddr("feeDistrib"),
            address(0),
            multisig,
            bytes32(uint256(uint160(address(pool)))),
            DURATION
        );
        vm.prank(alice);
        weth.approve(address(m), type(uint256).max);
        vm.prank(bob);
        weth.approve(address(m), type(uint256).max);

        // Anyone can fund the vault; 0.05 WETH is the floor.
        weth.mint(address(this), 1 ether);
        weth.approve(address(vault), type(uint256).max);
        vault.deposit(1 ether, address(this));
        assertGt(vault.totalAssets(), 0);
        assertFalse(vault.isAuthorizedMarket(address(m)), "never authorised");

        // A maker order on an empty book must rest, not revert.
        vm.prank(alice);
        uint256 aliceId = m.placeBet(UP, 0.01 ether, address(0), 1e18, 100);
        assertEq(m.getOrder(aliceId).filledAmount, 0);

        // And a counter-bet matches it PvP, with the vault untouched.
        vm.prank(bob);
        m.placeBet(DOWN, 0.01 ether, address(0), 1e18, 100);
        assertEq(m.getMatch(1).amount, 0.01 ether);
        assertFalse(m.getMatch(1).lpMatch, "peer to peer, not the vault");
        assertEq(vault.totalExposure(), 0);
    }
}
