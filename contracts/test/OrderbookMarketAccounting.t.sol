// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/OrderbookMarket.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockPyth.sol";

contract MockResolverA {
    address public pyth;
    constructor(address _pyth) { pyth = _pyth; }
    function settleMatch(address market, uint256 matchId, uint256 exitPrice) external {
        OrderbookMarket(market).settleMatch(matchId, exitPrice);
    }
}

/// @title OrderbookMarketAccounting
/// @notice Proves Sprint 1.1 / 1.2 accounting invariants for the refactored
///         OrderbookMarket:
///
///         INV-1 (No stuck funds)
///           For every order, deposited == claimed + refunded + (still in
///           active matches). After every match settles, the equation closes
///           to deposited == claimed + refunded.
///
///         INV-2 (Partial-fill never burns USDC)
///           In a PvP unequal-size match, the bigger side gets the unmatched
///           portion back as either (a) a queued remainder that later matches
///           or refunds, or (b) immediate dust refund. Never lost.
///
///         INV-3 (LP partial match)
///           When LP can only cover X of Y requested, the market match record
///           reflects X, NOT Y. The (Y - X) portion is queued and refundable.
contract OrderbookMarketAccountingTest is Test {
    OrderbookMarket market;
    LiquidityPool   pool;
    GenesisNFT      genesisNFT;
    MockUSDC        usdc;
    MockPyth        pyth;
    MockResolverA   resolver;

    address feeDistrib = makeAddr("feeDistrib");
    address multisig   = makeAddr("multisig");
    address alice      = makeAddr("alice");
    address bob        = makeAddr("bob");
    address carol      = makeAddr("carol");
    address lp1        = makeAddr("lp1");

    bytes32 constant FEED = bytes32("PEPE/USD");
    uint256 constant DURATION = 15 minutes;
    uint256 constant ENTRY_PRICE = 9142e10;

    function setUp() public {
        pyth     = new MockPyth();
        resolver = new MockResolverA(address(pyth));
        pyth.setPrice(FEED, 9142, -8);

        usdc       = new MockUSDC();
        genesisNFT = new GenesisNFT("ipfs://test/");
        pool       = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        market = new OrderbookMarket(
            address(usdc),
            address(resolver),
            address(pool),
            feeDistrib,
            address(0),
            multisig,
            FEED,
            DURATION
        );
        pool.authorizeMarket(address(market));

        // Fund users
        for (uint256 i = 0; i < 4; i++) {
            address a = [alice, bob, carol, lp1][i];
            usdc.mint(a, 10_000e6);
            vm.prank(a); usdc.approve(address(market), type(uint256).max);
            vm.prank(a); usdc.approve(address(pool),   type(uint256).max);
        }
    }

    // ════════════════════════════════════════════════════════
    //  INV-1 / INV-2: PARTIAL PvP — bigger side gets remainder
    // ════════════════════════════════════════════════════════

    /// @notice Alice 50 UP vs Bob 30 DOWN.
    ///         Match created for 30 USDC each side.
    ///         Alice's remaining 20 USDC queued (>= MIN_BET).
    ///         No USDC silently stuck.
    function test_PartialMatch_RemainderQueued() public {
        // Bob first, so Alice's bigger order matches against him.
        vm.prank(bob);   uint256 bobId   = market.placeBet(OrderbookMarket.Direction.DOWN, 30e6, address(0), ENTRY_PRICE, 100);
        vm.prank(alice); uint256 aliceId = market.placeBet(OrderbookMarket.Direction.UP,   50e6, address(0), ENTRY_PRICE, 100);

        OrderbookMarket.Order memory ao = market.getOrder(aliceId);
        OrderbookMarket.Order memory bo = market.getOrder(bobId);

        assertEq(ao.filledAmount,       30e6, "Alice filled = matched 30");
        assertEq(ao.amount,             50e6, "Alice deposit unchanged");
        assertEq(ao.pendingSettlements, 1,    "Alice 1 pending match");
        assertEq(uint(ao.status),       uint(OrderbookMarket.OrderStatus.PENDING), "Alice still in queue");

        assertEq(bo.filledAmount,       30e6, "Bob fully filled");
        assertEq(uint(bo.status),       uint(OrderbookMarket.OrderStatus.MATCHED));

        // Alice's 20 USDC remainder must still be in the contract, queueable.
        (uint256 up, uint256 dn) = market.getPendingDepth();
        assertEq(up, 1, "Alice remainder queued on UP side");
        assertEq(dn, 0, "Bob removed from DOWN side");
    }

    /// @notice Bigger-side remainder is later matched by a 2nd counterparty —
    ///         end state: Alice 50 fully filled across 2 matches, no leftover.
    function test_PartialMatch_RemainderMatchedByLater() public {
        vm.prank(bob);   market.placeBet(OrderbookMarket.Direction.DOWN, 30e6, address(0), ENTRY_PRICE, 100);
        vm.prank(alice); uint256 aliceId = market.placeBet(OrderbookMarket.Direction.UP,   50e6, address(0), ENTRY_PRICE, 100);
        vm.prank(carol); market.placeBet(OrderbookMarket.Direction.DOWN, 20e6, address(0), ENTRY_PRICE, 100);

        OrderbookMarket.Order memory ao = market.getOrder(aliceId);
        assertEq(ao.filledAmount,       50e6, "Alice fully filled");
        assertEq(ao.pendingSettlements, 2,    "Alice in 2 matches");
        assertEq(uint(ao.status),       uint(OrderbookMarket.OrderStatus.MATCHED));

        (uint256 up, uint256 dn) = market.getPendingDepth();
        assertEq(up, 0); assertEq(dn, 0);
    }

    /// @notice INV-1: After all matches settle and Alice claims, sum of all
    ///         outgoing USDC equals sum of incoming deposits. No leakage.
    function test_PartialMatch_USDCConservation() public {
        uint256 startBob   = usdc.balanceOf(bob);
        uint256 startAlice = usdc.balanceOf(alice);
        uint256 startCarol = usdc.balanceOf(carol);

        vm.prank(bob);   market.placeBet(OrderbookMarket.Direction.DOWN, 30e6, address(0), ENTRY_PRICE, 100);
        vm.prank(alice); uint256 aliceId = market.placeBet(OrderbookMarket.Direction.UP, 50e6, address(0), ENTRY_PRICE, 100);
        vm.prank(carol); market.placeBet(OrderbookMarket.Direction.DOWN, 20e6, address(0), ENTRY_PRICE, 100);

        // Time-travel past settle.
        vm.warp(block.timestamp + DURATION + 1);

        // Alice wins both matches: exitPrice > entryPrice.
        // Match id 1 = Alice/Bob 30, match 2 = Alice/Carol 20.
        resolver.settleMatch(address(market), 1, ENTRY_PRICE * 2);
        resolver.settleMatch(address(market), 2, ENTRY_PRICE * 2);

        OrderbookMarket.Order memory ao = market.getOrder(aliceId);
        assertEq(ao.pendingSettlements, 0);
        assertEq(uint(ao.status), uint(OrderbookMarket.OrderStatus.SETTLED));
        // payout = (30*2) + (20*2) = 100 USDC at feeBps=0
        assertEq(ao.payout, 100e6, "Alice wins entire 100 USDC pool");

        vm.prank(alice); market.claim(aliceId);

        // Conservation: net USDC change across all participants equals 0.
        // Bob: -30, Carol: -20, Alice: -50 + 100 = +50. Sum = 0.
        int256 dAlice = int256(usdc.balanceOf(alice)) - int256(startAlice);
        int256 dBob   = int256(usdc.balanceOf(bob))   - int256(startBob);
        int256 dCarol = int256(usdc.balanceOf(carol)) - int256(startCarol);
        assertEq(dAlice + dBob + dCarol, 0, "USDC conservation closed");
        assertEq(dAlice, int256(50e6));
        assertEq(dBob,   int256(-30e6));
        assertEq(dCarol, int256(-20e6));
    }

    /// @notice INV-2: If the bigger side's remainder is below MIN_BET,
    ///         it's refunded as dust immediately — not silently lost.
    function test_PartialMatch_SubMinBetDustRefunded() public {
        // Bob 5 DOWN, Alice 5.5 UP → match 5, leftover 0.5 < MIN_BET → refund 0.5.
        usdc.mint(alice, 100e6);
        uint256 startAlice = usdc.balanceOf(alice);
        vm.prank(bob);   market.placeBet(OrderbookMarket.Direction.DOWN, 5e6,    address(0), ENTRY_PRICE, 100);
        vm.prank(alice); uint256 aId = market.placeBet(OrderbookMarket.Direction.UP, 5_500_000, address(0), ENTRY_PRICE, 100);

        OrderbookMarket.Order memory ao = market.getOrder(aId);
        assertEq(ao.filledAmount,       5e6, "Alice matched 5");
        assertTrue(ao.unmatchedRefunded, "dust marked refunded");
        assertEq(uint(ao.status), uint(OrderbookMarket.OrderStatus.MATCHED));

        // Alice's net change so far: -5.5 + 0.5 refund = -5
        int256 dAlice = int256(usdc.balanceOf(alice)) - int256(startAlice);
        assertEq(dAlice, int256(-5e6), "deposit minus dust = 5 still at risk");
    }

    // ════════════════════════════════════════════════════════
    //  INV-3: LP partial match returns actual matchedAmount
    // ════════════════════════════════════════════════════════

    /// @notice Small pool: 50 USDC deposit → per-market cap = 5% = 2.5 USDC.
    ///         Alice bets 25 UP. LP matches ≤ 2.5 USDC; remainder ≥ ~22 queued.
    ///         Proves Sprint 1.2: tryMatch returns ACTUAL matched amount, not
    ///         the originally requested 25.
    function test_LP_PartialMatch_QueueRemainder() public {
        // MIN_DEPOSIT = 50e6 — exactly at the floor.
        usdc.mint(lp1, 1_000e6);
        vm.prank(lp1); usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp1); pool.deposit(50e6, lp1);

        uint256 cap = (50e6 * pool.PER_MARKET_MAX_EXPOSURE_BPS()) / 10_000;
        assertEq(cap, 25e5, "2.5 USDC per-market cap");

        vm.prank(alice); uint256 aId = market.placeBet(OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);
        OrderbookMarket.Order memory ao = market.getOrder(aId);

        assertLe(ao.filledAmount, 25e5 + 1, "LP capped match");
        assertGt(ao.amount, ao.filledAmount, "remainder exists");
        assertEq(uint(ao.status), uint(OrderbookMarket.OrderStatus.PENDING), "remainder in queue");

        (uint256 up, ) = market.getPendingDepth();
        assertEq(up, 1, "remainder queued on UP");
    }

    // ════════════════════════════════════════════════════════
    //  Edge cases — refundExpired on partial fills
    // ════════════════════════════════════════════════════════

    /// @notice After a partial fill that times out, the unmatched portion
    ///         is refunded and the matched portion still settles to a claim.
    function test_RefundExpired_PartialFill_KeepsMatchedPortion() public {
        // Bob 30 DOWN vs Alice 50 UP → match 30, Alice queues 20.
        vm.prank(bob);   market.placeBet(OrderbookMarket.Direction.DOWN, 30e6, address(0), ENTRY_PRICE, 100);
        uint256 preAlice = usdc.balanceOf(alice);
        vm.prank(alice); uint256 aId = market.placeBet(OrderbookMarket.Direction.UP, 50e6, address(0), ENTRY_PRICE, 100);

        // After MATCH_TIMEOUT, refund the unmatched 20.
        vm.warp(block.timestamp + market.MATCH_TIMEOUT() + 1);
        market.refundExpired(aId);

        OrderbookMarket.Order memory ao = market.getOrder(aId);
        assertTrue(ao.unmatchedRefunded);
        assertEq(ao.filledAmount, 30e6);
        // Alice net so far: -50 + 20 refund = -30 USDC at risk.
        assertEq(int256(usdc.balanceOf(alice)) - int256(preAlice), int256(-30e6));

        // Wait for settle, Alice wins.
        vm.warp(block.timestamp + DURATION + 1);
        resolver.settleMatch(address(market), 1, ENTRY_PRICE * 2);

        ao = market.getOrder(aId);
        assertEq(ao.pendingSettlements, 0);
        assertEq(uint(ao.status), uint(OrderbookMarket.OrderStatus.SETTLED));
        assertEq(ao.payout, 60e6, "60 USDC payout from matched portion");

        vm.prank(alice); market.claim(aId);
        // Final Alice net: -30 + 60 = +30 profit. Matches Bob's loss exactly.
        assertEq(int256(usdc.balanceOf(alice)) - int256(preAlice), int256(30e6));
    }

    /// @notice Pure-unmatched expired order goes to REFUNDED with full deposit back.
    function test_RefundExpired_NoFill_FullRefund() public {
        uint256 preAlice = usdc.balanceOf(alice);
        vm.prank(alice); uint256 aId = market.placeBet(OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);

        vm.warp(block.timestamp + market.MATCH_TIMEOUT() + 1);
        market.refundExpired(aId);

        OrderbookMarket.Order memory ao = market.getOrder(aId);
        assertEq(uint(ao.status), uint(OrderbookMarket.OrderStatus.REFUNDED));
        assertEq(int256(usdc.balanceOf(alice)) - int256(preAlice), int256(0));
    }

    /// @notice Double-refundExpired must revert.
    function test_RefundExpired_NotIdempotent() public {
        vm.prank(alice); uint256 aId = market.placeBet(OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);
        vm.warp(block.timestamp + market.MATCH_TIMEOUT() + 1);
        market.refundExpired(aId);
        vm.expectRevert("already refunded");
        market.refundExpired(aId);
    }

    // ════════════════════════════════════════════════════════
    //  expectedPrice guard
    // ════════════════════════════════════════════════════════

    function test_PlaceBet_RejectsZeroExpectedPrice() public {
        vm.prank(alice);
        vm.expectRevert("expectedPrice zero");
        market.placeBet(OrderbookMarket.Direction.UP, 25e6, address(0), 0, 100);
    }

    // ════════════════════════════════════════════════════════
    //  Pagination — getReadySettlements
    // ════════════════════════════════════════════════════════

    function test_GetReadySettlements_Pagination() public {
        // Create 4 matches.
        for (uint256 i = 0; i < 4; i++) {
            address a = makeAddr(string(abi.encodePacked("trader", i)));
            address b = makeAddr(string(abi.encodePacked("trader_b", i)));
            usdc.mint(a, 100e6); usdc.mint(b, 100e6);
            vm.prank(a); usdc.approve(address(market), type(uint256).max);
            vm.prank(b); usdc.approve(address(market), type(uint256).max);
            vm.prank(a); market.placeBet(OrderbookMarket.Direction.UP,   25e6, address(0), ENTRY_PRICE, 100);
            vm.prank(b); market.placeBet(OrderbookMarket.Direction.DOWN, 25e6, address(0), ENTRY_PRICE, 100);
        }
        vm.warp(block.timestamp + DURATION + 1);

        uint256[] memory page1 = market.getReadySettlements(0, 2);
        uint256[] memory page2 = market.getReadySettlements(2, 2);
        assertEq(page1.length, 2);
        assertEq(page2.length, 2);
        assertEq(page1[0], 1);
        assertEq(page2[1], 4);

        uint256[] memory all = market.getReadySettlements(0, 0);
        assertEq(all.length, 4);
    }
}
