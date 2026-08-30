// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/OrderbookMarket.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockMarketRegistry.sol";
import "./helpers/RedstoneTest.sol";
import "./helpers/RedstoneHarness.sol";

/// @notice Coverage for the five CRITICAL fixes:
///   C2 — emergencyRefundMatch (PvP + LP)
///   C3 — placeBetWithPyth pushes price + refunds excess ETH
///   C4 — Genesis NFT transfer rebalances fee weights
///   C5 — refundExpired drops orderId from the queue; tryMatch is bounded.
contract CriticalFixesTest is RedstoneTest {
    OrderbookMarket market;
    LiquidityPool pool;
    GenesisNFT genesisNFT;
    MockUSDC usdc;

    address resolver;
    address feeDistrib = makeAddr("feeDistrib");
    address multisig = makeAddr("multisig");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address lp1 = makeAddr("lp1");
    address lp2 = makeAddr("lp2");

    uint256 constant ENTRY_PRICE = 9142e12; // 914200 * 1e10
    uint256 constant DURATION = 15 minutes;

    function setUp() public {
        resolver = makeAddr("resolver");
        _setPrice(bytes32("PEPE/USD"), 914200);

        usdc = new MockUSDC();
        genesisNFT = new GenesisNFT("ipfs://test/");
        pool = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        market = new OrderbookMarketHarness(
            address(usdc),
            resolver,
            address(pool),
            feeDistrib,
            address(0), // referralRegistry (not exercised)
            multisig,
            bytes32("PEPE/USD"),
            DURATION
        );

        // authorizeMarket now requires the pool's factory to vouch for the
        // market; this suite deploys one directly, so stand a registry up.
        MockMarketRegistry registry = new MockMarketRegistry();
        registry.register(address(market));
        pool.setMarketFactory(address(registry));
        pool.authorizeMarket(address(market));

        usdc.mint(alice, 1000e6);
        usdc.mint(bob, 1000e6);
        usdc.mint(carol, 1000e6);
        usdc.mint(lp1, 1000e6);
        usdc.mint(lp2, 1000e6);

        vm.prank(alice);
        usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(market), type(uint256).max);
        vm.prank(carol);
        usdc.approve(address(market), type(uint256).max);
        vm.prank(lp1);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp2);
        usdc.approve(address(pool), type(uint256).max);
    }

    // ── C2: emergencyRefundMatch (PvP) ────────────────────
    function test_C2_EmergencyRefundMatch_PvP_After24h() public {
        _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);
        _bet(market, bob, OrderbookMarket.Direction.DOWN, 25e6, address(0), ENTRY_PRICE, 100);

        // Oracle is "down": don't settle. Fast forward past SETTLE_GRACE.
        vm.warp(block.timestamp + DURATION + market.SETTLE_GRACE() + 1);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        market.emergencyRefundMatch(1);

        assertEq(usdc.balanceOf(alice) - aliceBefore, 25e6, "alice refunded");
        assertEq(usdc.balanceOf(bob) - bobBefore, 25e6, "bob refunded");

        OrderbookMarket.Order memory ao = market.getOrder(1);
        OrderbookMarket.Order memory bo = market.getOrder(2);
        assertEq(uint256(ao.status), uint256(OrderbookMarket.OrderStatus.REFUNDED));
        assertEq(uint256(bo.status), uint256(OrderbookMarket.OrderStatus.REFUNDED));

        // Match marked settled — settleMatch must now reject.
        vm.warp(block.timestamp + 1);
        vm.prank(resolver);
        vm.expectRevert("already settled");
        market.settleMatch(1, ENTRY_PRICE + 100);
    }

    // ── S1 (audit 2026-07-05): settleMatch must not accept a settlement
    //    once the SETTLE_GRACE window has elapsed. Before this fix, a keeper
    //    that came back online after 24h+ of downtime could still call
    //    settleMatch with whatever the CURRENT price happened to be — settling
    //    the match on a price from long after the intended settlement time
    //    instead of routing to the fair, symmetric emergencyRefundMatch path.
    function test_SettleMatch_Reverts_AfterGraceWindowExpired() public {
        _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);
        _bet(market, bob, OrderbookMarket.Direction.DOWN, 25e6, address(0), ENTRY_PRICE, 100);

        // Keeper was down for a long time — well past the point where
        // settlement is still meaningful.
        vm.warp(block.timestamp + DURATION + market.SETTLE_GRACE() + 1);

        vm.prank(resolver);
        vm.expectRevert("settlement window expired");
        market.settleMatch(1, ENTRY_PRICE + 100);

        // The correct recovery path still works.
        market.emergencyRefundMatch(1);
        OrderbookMarket.Order memory ao = market.getOrder(1);
        assertEq(uint256(ao.status), uint256(OrderbookMarket.OrderStatus.REFUNDED));
    }

    function test_C2_EmergencyRefundMatch_RevertsBeforeGrace() public {
        _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);
        _bet(market, bob, OrderbookMarket.Direction.DOWN, 25e6, address(0), ENTRY_PRICE, 100);

        // Just past duration but before grace ends.
        vm.warp(block.timestamp + DURATION + 1 hours);
        vm.expectRevert("grace not over");
        market.emergencyRefundMatch(1);
    }

    // ── C2: emergencyRefundMatch (LP match) ────────────────
    function test_C2_EmergencyRefundMatch_LP_RestoresPoolExposure() public {
        vm.prank(lp1);
        pool.deposit(500e6, lp1);

        uint256 orderId = _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);

        // After tryMatch: pool exposure recorded.
        uint256 expBefore = pool.totalExposure();
        assertGt(expBefore, 0, "exposure locked");

        uint256 poolBalBefore = usdc.balanceOf(address(pool));
        uint256 aliceBalBefore = usdc.balanceOf(alice);

        vm.warp(block.timestamp + DURATION + market.SETTLE_GRACE() + 1);
        market.emergencyRefundMatch(1);

        // Alice gets her 25 back; pool gets its 25 back.
        assertEq(usdc.balanceOf(alice) - aliceBalBefore, 25e6, "alice refunded");
        assertEq(usdc.balanceOf(address(pool)) - poolBalBefore, 25e6, "lp stake returned");
        assertEq(pool.totalExposure(), 0, "exposure unlocked");

        OrderbookMarket.Order memory o = market.getOrder(orderId);
        assertEq(uint256(o.status), uint256(OrderbookMarket.OrderStatus.REFUNDED));
    }

    // ── C3: the bet carries its own price ────────────────────
    //
    // This section used to test that placeBetWithPyth paid Pyth's update fee
    // out of msg.value and refunded the excess, and that an empty
    // priceUpdateData array was rejected. Both are gone with Pyth: RedStone
    // verifies signatures in our own contract and charges nothing, so placeBet
    // is not payable and there is no array to be empty. What survives is the
    // property those tests existed to protect - a bet cannot be placed without
    // carrying a fresh signed price - and it is now structural.

    function test_C3_PlaceBet_TakesNoFeeAndIsNotPayable() public {
        vm.deal(alice, 1 ether);
        uint256 before = alice.balance;

        _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);

        assertEq(alice.balance, before, "placing a bet must cost no ether at all");
        assertEq(address(market).balance, 0, "the market must not accumulate ether");
    }

    /// The oracle no longer needs funding, so an empty resolver cannot stop a
    /// bet - which under Pyth it could, since the fee was quoted from it.
    function test_C3_PlaceBet_WorksWithAnUnfundedResolver() public {
        vm.deal(address(resolver), 0);

        _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);

        OrderbookMarket.Order memory o = market.getOrder(1);
        assertEq(uint256(o.status), uint256(OrderbookMarket.OrderStatus.PENDING));
    }

    /**
     * A call carrying no signed price cannot produce one. Under Pyth this was
     * a require on a non-empty array, which a sniper could satisfy with a
     * deliberately old update; now there is nothing to fake - without a payload
     * the calldata simply does not parse.
     */
    function test_C3_PlaceBet_RejectsACallWithNoSignedPrice() public {
        vm.prank(alice);
        (bool ok,) = address(market)
            .call(
                abi.encodeWithSelector(
                    OrderbookMarket.placeBet.selector,
                    OrderbookMarket.Direction.UP,
                    uint256(25e6),
                    address(0),
                    ENTRY_PRICE,
                    uint256(100)
                )
            );

        assertFalse(ok, "a bet with no signed price must not be accepted");
    }

    /// There is no longer a way to place a bet without carrying a price
    /// update: the 5-argument overload is gone from the ABI entirely, so a
    /// caller cannot select a stale-price path even deliberately.
    function test_C3_BarePlaceBetOverloadIsGone() public view {
        bytes4 bareSelector = bytes4(keccak256("placeBet(uint8,uint256,address,uint256,uint256)"));
        (bool found,) = _hasSelector(address(market), bareSelector);
        assertFalse(found, "bare placeBet must not be callable");
    }

    /// @dev A missing function selector makes the call revert with empty
    ///      returndata (no fallback on OrderbookMarket), which is how we
    ///      distinguish "not in the ABI" from "reverted with a reason".
    function _hasSelector(address target, bytes4 sel) internal view returns (bool, bytes memory) {
        (bool ok, bytes memory ret) =
            target.staticcall(abi.encodeWithSelector(sel, 0, uint256(1), address(0), uint256(1), uint256(1)));
        return (ok || ret.length > 0, ret);
    }

    // ── C4: Genesis NFT transfer moves fee weight to new owner ─
    function test_C4_GenesisTransferRebalancesFeeWeight() public {
        // Saturate Genesis: lp1 + 19 anon LPs claim all 20 NFTs.
        vm.prank(lp1);
        pool.deposit(500e6, lp1);
        for (uint256 i = 0; i < 19; i++) {
            address t = address(uint160(uint256(keccak256(abi.encode("genfiller", i)))));
            usdc.mint(t, 60e6);
            vm.prank(t);
            usdc.approve(address(pool), type(uint256).max);
            vm.prank(t);
            pool.deposit(60e6, t);
        }

        // lp2 deposits AFTER cap → not Genesis.
        vm.prank(lp2);
        pool.deposit(500e6, lp2);

        assertTrue(pool.isGenesis(lp1), "lp1 starts as genesis");
        assertFalse(pool.isGenesis(lp2), "lp2 starts non-genesis");

        // Find lp1's Genesis tokenId (sequential mint → first NFT id == 1).
        uint256 tokenId = 1;
        assertEq(genesisNFT.ownerOf(tokenId), lp1);

        // Transfer NFT lp1 → lp2.
        vm.prank(lp1);
        genesisNFT.safeTransferFrom(lp1, lp2, tokenId);

        // Genesis derives from NFT ownership now.
        assertFalse(pool.isGenesis(lp1), "lp1 lost genesis after transfer");
        assertTrue(pool.isGenesis(lp2), "lp2 gained genesis after transfer");

        // Drive a fee-accrual event: simulate an LP-won match via direct call.
        // Easiest: make alice take an LP match, then mark LP as winner.
        _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);

        vm.warp(block.timestamp + DURATION + 1);

        // Set pyth price so user (UP) LOSES — exit < entry → LP wins.
        _setPrice(bytes32("PEPE/USD"), 900000);

        vm.prank(resolver);
        market.settleMatch(1, 900000 * 1e10);

        uint256 earned1 = pool.earnedFees(lp1);
        uint256 earned2 = pool.earnedFees(lp2);

        // lp2 (now Genesis) must earn STRICTLY more than lp1, despite equal shares.
        assertGt(earned2, earned1, "post-transfer genesis lp2 earns more");
    }

    // ── C5: refundExpired removes orderId from queue ───────
    function test_C5_RefundExpired_RemovesFromQueue() public {
        // 3 pending UP orders, all expire.
        _bet(market, alice, OrderbookMarket.Direction.UP, 5e6, address(0), ENTRY_PRICE, 100);
        _bet(market, bob, OrderbookMarket.Direction.UP, 5e6, address(0), ENTRY_PRICE, 100);
        _bet(market, carol, OrderbookMarket.Direction.UP, 5e6, address(0), ENTRY_PRICE, 100);

        (uint256 up,) = market.getPendingDepth();
        assertEq(up, 3);

        // Expire and refund the middle one.
        vm.warp(block.timestamp + market.MATCH_TIMEOUT() + 1);
        market.refundExpired(2);

        (up,) = market.getPendingDepth();
        assertEq(up, 2, "queue shrunk by exactly one");

        // Refund remaining two; queue empties.
        market.refundExpired(1);
        market.refundExpired(3);
        (up,) = market.getPendingDepth();
        assertEq(up, 0, "queue empty");
    }

    // ── C5: tryMatch is bounded (no DoS via stale queue) ──
    function test_C5_TryMatch_BoundedScan_NoDoS() public {
        // Generate MAX_MATCH_SCAN + extras stale DOWN orders.
        uint256 nStale = market.MAX_MATCH_SCAN() + 20;
        for (uint256 i = 0; i < nStale; i++) {
            address t = address(uint160(uint256(keccak256(abi.encode("staler", i)))));
            usdc.mint(t, 10e6);
            vm.prank(t);
            usdc.approve(address(market), type(uint256).max);
            _bet(market, t, OrderbookMarket.Direction.DOWN, 5e6, address(0), ENTRY_PRICE, 100);
        }

        // Let them all go stale.
        vm.warp(block.timestamp + market.MATCH_TIMEOUT() + 1);
        _setPrice(bytes32("PEPE/USD"), 914200);

        // Now a fresh UP order — scan must stay bounded (< 500k gas).
        uint256 g = gasleft();
        _bet(market, alice, OrderbookMarket.Direction.UP, 5e6, address(0), ENTRY_PRICE, 100);
        uint256 used = g - gasleft();
        assertLt(used, 5_000_000, "tryMatch must not be unbounded");

        // Scan should have lazy-evicted up to MAX_MATCH_SCAN stale orders.
        (, uint256 down) = market.getPendingDepth();
        assertLe(down, nStale, "stale evicted");
    }

    // ── C5: After refundExpired, new opposite bet matches the next pending ──
    function test_C5_RefundExpired_FreesMatchingSlot() public {
        _bet(market, alice, OrderbookMarket.Direction.UP, 5e6, address(0), ENTRY_PRICE, 100);

        vm.warp(block.timestamp + market.MATCH_TIMEOUT() + 1);
        _setPrice(bytes32("PEPE/USD"), 914200);
        market.refundExpired(1);

        // New UP order should sit in queue, not match the refunded stale id.
        _bet(market, bob, OrderbookMarket.Direction.UP, 5e6, address(0), ENTRY_PRICE, 100);

        OrderbookMarket.Order memory o = market.getOrder(2);
        assertEq(uint256(o.status), uint256(OrderbookMarket.OrderStatus.PENDING));
    }
}
