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

contract OrderbookMarketTest is RedstoneTest {
    OrderbookMarket market;
    LiquidityPool   pool;
    GenesisNFT      genesisNFT;
    MockUSDC        usdc;

    address resolver;
    address feeDistrib    = makeAddr("feeDistrib");
    address multisig      = makeAddr("multisig");
    address alice         = makeAddr("alice");
    address bob           = makeAddr("bob");
    address lpProvider    = makeAddr("lpProvider");
    address referrer      = makeAddr("referrer");

    uint256 constant ENTRY_PRICE = 9142e12; // normalized price
    uint256 constant DURATION    = 15 minutes;

    function setUp() public {
        resolver = makeAddr("resolver");
        // ENTRY_PRICE = 9142e12. So 914200 * 1e18 / 10^8 = 914200 * 1e10 = 9142e12
        _setPrice(bytes32("PEPE/USD"), 914200);
        usdc       = new MockUSDC();
        genesisNFT = new GenesisNFT("ipfs://test/");
        pool       = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        market = new OrderbookMarketHarness(
            address(usdc),
            resolver,
            address(pool),
            feeDistrib,
            address(0), // referralRegistry — not exercised in these tests
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

        // Fund users
        usdc.mint(alice,      1000e6);
        usdc.mint(bob,        1000e6);
        usdc.mint(lpProvider, 1000e6);

        vm.prank(alice);      usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);        usdc.approve(address(market), type(uint256).max);
        vm.prank(lpProvider); usdc.approve(address(pool),   type(uint256).max);
    }

    // ── PvP MATCHING ──────────────────────────────────────
    function test_Match_PvP_Success() public {
        // Alice bets UP
        uint256 aliceOrderId = _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);

        // Bob bets DOWN — should match with Alice
        uint256 bobOrderId = _bet(market, bob, OrderbookMarket.Direction.DOWN, 25e6, address(0), ENTRY_PRICE, 100);

        OrderbookMarket.Order memory aliceOrder = market.getOrder(aliceOrderId);
        OrderbookMarket.Order memory bobOrder   = market.getOrder(bobOrderId);

        assertEq(uint(aliceOrder.status), uint(OrderbookMarket.OrderStatus.MATCHED));
        assertEq(uint(bobOrder.status),   uint(OrderbookMarket.OrderStatus.MATCHED));
        assertEq(aliceOrder.matchId, bobOrder.matchId);
    }

    // ── LP FALLBACK ───────────────────────────────────────
    function test_Match_LP_Fallback() public {
        // LP deposits
        vm.prank(lpProvider);
        pool.deposit(500e6, lpProvider);

        // Alice bets UP — no PvP opponent → LP matches
        uint256 orderId = _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);

        OrderbookMarket.Order memory order = market.getOrder(orderId);
        assertEq(uint(order.status), uint(OrderbookMarket.OrderStatus.MATCHED));

        OrderbookMarket.Match memory m = market.getMatch(order.matchId);
        assertTrue(m.lpMatch);
    }

    // ── REFUND IF NO MATCH ────────────────────────────────
    function test_Refund_If_No_Match() public {
        // Alice bets UP — no opponent, no LP
        uint256 orderId = _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);

        // 5 minutes pass
        vm.warp(block.timestamp + 5 minutes + 1);

        uint256 balBefore = usdc.balanceOf(alice);
        market.refundExpired(orderId);
        assertEq(usdc.balanceOf(alice) - balBefore, 25e6);

        OrderbookMarket.Order memory order = market.getOrder(orderId);
        assertEq(uint(order.status), uint(OrderbookMarket.OrderStatus.REFUNDED));
    }

    // ── SETTLE & CLAIM (PvP) ──────────────────────────────
    function test_Settle_And_Claim_PvP() public {
        _bet(market, alice, OrderbookMarket.Direction.UP, 50e6, address(0), ENTRY_PRICE, 100);
        _bet(market, bob, OrderbookMarket.Direction.DOWN, 50e6, address(0), ENTRY_PRICE, 100);

        // Fast forward past duration
        vm.warp(block.timestamp + DURATION + 1);

        // Settle (UP won: exit > entry)
        vm.prank(resolver);
        market.settleMatch(1, ENTRY_PRICE + 100);

        // Alice claims
        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        market.claim(1); // orderId = 1

        // Alice should get 100 USDC (50+50, FEE=0%)
        assertEq(usdc.balanceOf(alice) - balBefore, 100e6);
    }

    // ── SETTLE & CLAIM (LP) ───────────────────────────────
    function test_Settle_And_Claim_LP() public {
        vm.prank(lpProvider);
        pool.deposit(500e6, lpProvider);

        uint256 orderId = _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);

        vm.warp(block.timestamp + DURATION + 1);

        // UP won
        vm.prank(resolver);
        market.settleMatch(1, ENTRY_PRICE + 100);

        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        market.claim(orderId);

        // 25*2 = 50e6 gross, minus LP_TAKER_FEE_BPS (1%) charged on LP-match
        // wins to fund the pool (Sprint 5.5 LP-economics fix).
        uint256 expectedFee = (50e6 * market.LP_TAKER_FEE_BPS()) / 10_000;
        assertEq(usdc.balanceOf(alice) - balBefore, 50e6 - expectedFee);
    }

    // ── REVERTS ───────────────────────────────────────────
    function test_PlaceBet_Reverts_BelowMin() public {
        (bool rsOk, bytes memory rsRet) = _tryBet(market, alice, OrderbookMarket.Direction.UP, 0.5e6, address(0), ENTRY_PRICE, 100);
        assertFalse(rsOk, "expected revert: below min");
        assertEq(_rsReason(rsRet, ""), ": below min");
    }

    function test_PlaceBet_Reverts_AboveMax() public {
        (bool rsOk, bytes memory rsRet) = _tryBet(market, alice, OrderbookMarket.Direction.UP, 101e6, address(0), ENTRY_PRICE, 100);
        assertFalse(rsOk, "expected revert: above max");
        assertEq(_rsReason(rsRet, ""), ": above max");
    }

    function test_PlaceBet_Reverts_SelfReferral() public {
        (bool rsOk, bytes memory rsRet) = _tryBet(market, alice, OrderbookMarket.Direction.UP, 10e6, alice, ENTRY_PRICE, 100);
        assertFalse(rsOk, "expected revert: self referral");
        assertEq(_rsReason(rsRet, ""), ": self referral");
    }

    /// @dev Sprint 5.5: proves ENTRY_MAX_PRICE_AGE actually blocks a stale
    ///      Pyth price. Before this session MockPyth ignored the `age` arg
    ///      entirely, so this protection existed in the contract but had
    ///      never been exercised by any test.
    /**
     * Staleness has to be constructed deliberately now. Under Pyth a price sat
     * on-chain and went stale where it lay, so warping forward was enough; with
     * a pull oracle the caller mints the price at call time, so the only way to
     * be stale is to bring an old payload on purpose - which is exactly what a
     * sniper would do, and exactly what this has to reject.
     */
    function test_PlaceBet_Reverts_StalePrice() public {
        (bool rsOk, bytes memory rsRet) = _tryBetAged(
            market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100,
            market.ENTRY_MAX_PRICE_AGE() + 1
        );
        assertFalse(rsOk, "a price older than the entry window must be rejected");
        assertEq(_rsReason(rsRet, ""), ": price too old");
    }

    function test_PlaceBet_AcceptsAPriceInsideTheEntryWindow() public {
        (bool rsOk,) = _tryBetAged(
            market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100,
            market.ENTRY_MAX_PRICE_AGE() - 1
        );
        assertTrue(rsOk, "a price inside the entry window must be accepted");
    }

    function test_PlaceBet_Succeeds_AfterRefreshingStalePrice() public {
        vm.warp(block.timestamp + market.ENTRY_MAX_PRICE_AGE() + 1);
        _setPrice(bytes32("PEPE/USD"), 914200); // refresh
        uint256 orderId = _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);
        OrderbookMarket.Order memory o = market.getOrder(orderId);
        assertEq(o.amount, 25e6, "bet placed once price is fresh again");
    }

    function test_Claim_Reverts_NotYourOrder() public {
        _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);
        _bet(market, bob, OrderbookMarket.Direction.DOWN, 25e6, address(0), ENTRY_PRICE, 100);

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(resolver);
        market.settleMatch(1, ENTRY_PRICE + 100);

        vm.prank(bob);
        vm.expectRevert("not your order");
        market.claim(1); // orderId 1 belongs to alice
    }

    function test_Refund_Reverts_NotExpired() public {
        uint256 orderId = _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);

        vm.expectRevert("not expired");
        market.refundExpired(orderId);
    }

    function test_Settle_Reverts_OnlyResolver() public {
        _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);
        _bet(market, bob, OrderbookMarket.Direction.DOWN, 25e6, address(0), ENTRY_PRICE, 100);

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(alice);
        vm.expectRevert("only resolver");
        market.settleMatch(1, ENTRY_PRICE + 100);
    }

    // ── VIEWS ─────────────────────────────────────────────
    function test_GetPendingDepth() public {
        _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);

        (uint256 up, uint256 down) = market.getPendingDepth();
        assertEq(up, 1);
        assertEq(down, 0);
    }

    function test_GetTraderOrders() public {
        _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);

        uint256[] memory orderIds = market.getTraderOrders(alice);
        assertEq(orderIds.length, 1);
        assertEq(orderIds[0], 1);
    }

    function test_GetPendingSettlements() public {
        _bet(market, alice, OrderbookMarket.Direction.UP, 25e6, address(0), ENTRY_PRICE, 100);
        _bet(market, bob, OrderbookMarket.Direction.DOWN, 25e6, address(0), ENTRY_PRICE, 100);

        // Not ready yet
        uint256[] memory ready = market.getPendingSettlements();
        assertEq(ready.length, 0);

        // After duration
        vm.warp(block.timestamp + DURATION + 1);
        ready = market.getPendingSettlements();
        assertEq(ready.length, 1);
        assertEq(ready[0], 1); // matchId = 1
    }

    // ── ADMIN ─────────────────────────────────────────────
    function test_Pause_OnlyMultisig() public {
        vm.prank(multisig);
        market.pause();

        (bool rsOk,) = _tryBet(market, alice, OrderbookMarket.Direction.UP, 10e6, address(0), ENTRY_PRICE, 100);
        assertFalse(rsOk, "expected the bet to be rejected");
    }

    function test_Pause_Reverts_NonMultisig() public {
        vm.prank(alice);
        vm.expectRevert("only multisig");
        market.pause();
    }

    // ── FUZZ ──────────────────────────────────────────────
    function testFuzz_PlaceBet_AmountRange(uint256 amount) public {
        amount = bound(amount, 1e6, 100e6);
        _bet(market, alice, OrderbookMarket.Direction.UP, amount, address(0), ENTRY_PRICE, 100);

        (uint256 up,) = market.getPendingDepth();
        assertEq(up, 1);
    }

    function testFuzz_Settle_Payout(uint256 upAmount, uint256 downAmount) public {
        upAmount   = bound(upAmount,   1e6, 100e6);
        downAmount = bound(downAmount, 1e6, 100e6);

        usdc.mint(alice, upAmount);
        usdc.mint(bob,   downAmount);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(market), type(uint256).max);

        _bet(market, alice, OrderbookMarket.Direction.UP, upAmount, address(0), ENTRY_PRICE, 100);
        _bet(market, bob, OrderbookMarket.Direction.DOWN, downAmount, address(0), ENTRY_PRICE, 100);

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(resolver);
        market.settleMatch(1, ENTRY_PRICE + 100);

        // Winner (alice, UP) should get payout
        uint256 matchAmount = upAmount < downAmount ? upAmount : downAmount;
        OrderbookMarket.Order memory o = market.getOrder(1);
        // Payout should be matchAmount * 2 (minus 0% fee)
        assertEq(o.payout, matchAmount * 2);
    }

    // ── FEE ───────────────────────────────────────────────
    // The propose/apply timelock used to live on the market and was
    // unreachable there - 48h of timelock on a contract that lives at most
    // 24h. It is MarketFactory's now; see LaunchBlockers.t.sol. What remains
    // here is that a market holds the fee it was created with.

    function test_Fee_DirectDeployStartsAtZero() public view {
        assertEq(market.feeBps(), 0);
    }

    function test_Fee_IsNotChangeableOnAnOpenMarket() public {
        // No entrypoint exists to move it, deliberately: a position must
        // settle on the terms it was opened under.
        assertEq(market.feeBps(), 0);
    }

    // ── SLIPPAGE TESTS ────────────────────────────────────
    function test_Slippage_Revert_HighDeviation() public {
        // actual price is 9142e12
        // user expects 9000e12, but actual is 9142e12
        // diff = 142e12. spread = 142e12 * 10_000 / 9000e12 = 157 bps
        uint256 expectedPrice = 9000e12;
        
        // _tryBet rather than vm.expectRevert: the low-level call is caught in
        // the helper instead of propagating, so the cheatcode would never be
        // satisfied and the test would fail for an unrelated reason.
        (bool ok, bytes memory ret) = _tryBet(
            market, alice, OrderbookMarket.Direction.UP, 25e6, address(0),
            expectedPrice,
            150 // allow only 1.5% (150 bps), spread is 157.7
        );
        assertFalse(ok, "slippage beyond tolerance must be rejected");
        assertEq(_rsReason(ret, ""), ": price slippage exceeded");
    }

    function test_Slippage_Success_WithinDeviation() public {
        // diff = 142 bps approx
        uint256 expectedPrice = 9000e12;
        
        _bet(
            market, alice, OrderbookMarket.Direction.UP, 25e6, address(0),
            expectedPrice,
            200 // allow 2%
        );

        OrderbookMarket.Order memory o = market.getOrder(1);
        assertEq(uint(o.status), uint(OrderbookMarket.OrderStatus.PENDING)); // added to queue
    }
}
