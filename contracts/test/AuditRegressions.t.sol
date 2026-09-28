// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoolOrderbookMarket.t.sol";

/**
 * Regression coverage for the 2026-09-28 audit's L01 and A04 findings,
 * promoted from contracts/audit/AuditCases.t.sol so they run in the default
 * `forge test` invocation (that folder sits outside the default test path
 * deliberately - see audit/README.md - so nothing there runs in CI without
 * an explicit --match-contract). The audit folder's copies stay in place as
 * the dated report's own linked evidence; these are the ones that actually
 * guard against a regression going forward.
 */
contract AuditRegressions is PoolOrderbookMarketTest {
    /// L01: a resting order's own price band must hold at fill time, not
    /// just at placement. Before the fix, Alice's order (price 1, 1%
    /// slippage) filled two minutes later at ~2x that price - whatever the
    /// taker's transaction happened to carry.
    function test_Audit_MakerSlippageIsPreservedAtFill() public {
        uint256 aliceOrder = _bet(alice, OrderbookMarket.Direction.UP, 0.01 ether);
        pool.pushTick(T0 + 1, 6932);
        vm.warp(T0 + 120); // still inside the maker's 5-minute matching window
        uint256 newPrice = resolver.spotPriceWad(market.feedId());
        assertGt(newPrice, 1.9e18, "price should have drifted well outside alice's 1% band by now");

        vm.prank(bob);
        uint256 bobOrder = market.placeBet(OrderbookMarket.Direction.DOWN, 0.01 ether, address(0), newPrice, 100);

        OrderbookMarket.Order memory aliceAfter = market.getOrder(aliceOrder);
        assertEq(aliceAfter.matchId, 0, "alice must remain unmatched, not filled at a drifted price");
        assertEq(aliceAfter.filledAmount, 0);

        OrderbookMarket.Order memory bobAfter = market.getOrder(bobOrder);
        assertEq(bobAfter.filledAmount, 0);

        // Not stranded: eviction from the matching queue does not stop the
        // ordinary 5-minute refund path from working on her normally.
        vm.warp(T0 + market.MATCH_TIMEOUT() + 1);
        market.refundExpired(aliceOrder);
        assertEq(uint256(market.getOrder(aliceOrder).status), uint256(OrderbookMarket.OrderStatus.REFUNDED));
    }

    /// A04's contract-level basis: an order forced to REFUNDED by one
    /// match's emergency refund can still have a real, claimable payout from
    /// a different, already-won match. This has always been correct contract
    /// behaviour - the bug was the old frontend's REFUNDED branch never
    /// offering the claim; that is fixed in OrderStatusCard/markets.ts, not
    /// here. Kept as a contract-level pin so nothing changes this invariant
    /// out from under the UI fix.
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
    }
}
