// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../test/PoolOrderbookMarket.t.sol";

/// Local audit evidence, not correctness assertions. These tests intentionally
/// assert current problematic behavior. They do not connect to a live chain.
///
/// Both cases below are fixed as of 2026-09-28 (L01, A04) and now assert the
/// corrected behaviour instead - kept here as the dated report's own linked
/// evidence, and PROMOTED to test/AuditRegressions.t.sol so they actually run
/// in the default `forge test` CI invocation (this folder does not - see
/// README.md).
contract AuditCases is PoolOrderbookMarketTest {
    /// Regression test for the L01 fix (2026-09-28). Was
    /// test_Audit_MakerSlippageIsNotPreservedAtFill, which proved the bug:
    /// Alice's resting order used to be filled at whatever price Bob's
    /// transaction happened to carry, ~2x what she agreed to. Order now
    /// carries its own expectedPrice/slippageBps, and _tryMatch's PvP scan
    /// evicts a candidate whose band the current price no longer satisfies,
    /// the same way it already evicts an expired or dead one.
    function test_Audit_MakerSlippageIsPreservedAtFill() public {
        // Alice agrees to price 1 with 1% slippage and waits in the queue.
        uint256 aliceOrder = _bet(alice, OrderbookMarket.Direction.UP, 0.01 ether);
        pool.pushTick(T0 + 1, 6932);
        vm.warp(T0 + 120); // still inside the maker's 5-minute matching window
        uint256 newPrice = resolver.spotPriceWad(market.feedId());
        assertGt(newPrice, 1.9e18, "price should have drifted well outside alice's 1% band by now");

        vm.prank(bob);
        uint256 bobOrder = market.placeBet(OrderbookMarket.Direction.DOWN, 0.01 ether, address(0), newPrice, 100);

        // Alice is evicted from consideration rather than filled at a price
        // she never agreed to - she remains fully unmatched, not partially
        // filled at the wrong price.
        OrderbookMarket.Order memory aliceAfter = market.getOrder(aliceOrder);
        assertEq(aliceAfter.matchId, 0, "alice must remain unmatched, not filled at a drifted price");
        assertEq(aliceAfter.filledAmount, 0);

        // Bob found no valid counterparty either - his order rests in the
        // book exactly as it would have if the queue had been empty.
        OrderbookMarket.Order memory bobAfter = market.getOrder(bobOrder);
        assertEq(bobAfter.filledAmount, 0);

        // Not stranded: eviction from the matching queue does not stop the
        // ordinary 5-minute refund path from working on her normally.
        vm.warp(T0 + market.MATCH_TIMEOUT() + 1);
        market.refundExpired(aliceOrder);
        assertEq(uint256(market.getOrder(aliceOrder).status), uint256(OrderbookMarket.OrderStatus.REFUNDED));
    }

    function test_Audit_RefundedOrderCanStillHaveClaimableWinnings() public {
        address charlie = makeAddr("audit-charlie");
        _fund(charlie);
        uint256 aliceOrder = _bet(alice, OrderbookMarket.Direction.UP, 0.02 ether);
        _bet(bob, OrderbookMarket.Direction.DOWN, 0.01 ether);
        _bet(charlie, OrderbookMarket.Direction.DOWN, 0.01 ether);
        uint256 deadline = market.getMatch(1).settleAt;
        vm.warp(deadline + 1);
        vm.prank(address(resolver));
        market.settleMatch(1, 2e18);
        vm.warp(deadline + market.SETTLE_GRACE() + 1);
        market.emergencyRefundMatch(2);
        OrderbookMarket.Order memory o = market.getOrder(aliceOrder);
        assertEq(uint256(o.status), uint256(OrderbookMarket.OrderStatus.REFUNDED));
        assertGt(o.payout, 0, "REFUNDED is not equivalent to nothing left to claim");
        assertEq(o.pendingSettlements, 0);
        uint256 beforeClaim = weth.balanceOf(alice);
        vm.prank(alice);
        market.claim(aliceOrder);
        assertEq(weth.balanceOf(alice) - beforeClaim, o.payout);
        emit log_named_uint("Claim hidden by UI REFUNDED branch", o.payout);
    }
}

