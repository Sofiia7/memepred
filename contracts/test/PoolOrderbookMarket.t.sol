// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/PoolOrderbookMarket.sol";
import "../src/PoolOracleResolver.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "./mocks/MockUniswapV3Pool.sol";
import "./mocks/MockMarketRegistry.sol";
import "./mocks/MockWETH.sol";

/**
 * PoolOrderbookMarket end to end: bet, match, settle, claim - with no signed
 * payload anywhere in the file.
 *
 * That absence is the point. Every equivalent test on the Base path has to
 * hand-assemble calldata, because a RedStone price is appended to it rather
 * than passed as an argument; the helpers that do it are a hundred lines of
 * RedstoneTest.sol and both the frontend and the keeper have shipped bugs from
 * getting them wrong. Here `market.placeBet(...)` is just a call, and a test
 * that reads like ordinary Solidity is evidence the product will too.
 */
contract PoolOrderbookMarketTest is Test {
    PoolOrderbookMarket market;
    PoolOracleResolver resolver;
    MockUniswapV3Pool pool;
    MockWETH weth;
    LiquidityPool lp;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");
    address memecoin = makeAddr("memecoin");
    address multisig = makeAddr("multisig");

    uint256 constant DURATION = 15 minutes;
    uint32 constant T0 = 1_787_000_000;

    function setUp() public {
        vm.warp(T0);

        weth = new MockWETH();
        resolver = new PoolOracleResolver(address(weth));
        resolver.addKeeper(keeper);

        pool = new MockUniswapV3Pool(memecoin, address(weth), 10000);
        pool.pushTick(T0 - 7200, 0); // price 1.0 WETH per token, flat

        GenesisNFT genesisNFT = new GenesisNFT("ipfs://test/");
        lp = new LiquidityPool(IERC20(address(weth)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(lp));

        market = new PoolOrderbookMarket(
            address(weth),
            address(resolver),
            address(lp),
            makeAddr("feeDistrib"),
            address(0),
            multisig,
            bytes32(uint256(uint160(address(pool)))),
            DURATION
        );

        MockMarketRegistry registry = new MockMarketRegistry();
        registry.register(address(market));
        lp.setMarketFactory(address(registry));
        lp.authorizeMarket(address(market));

        _fund(alice);
        _fund(bob);
    }

    function _fund(address who) internal {
        weth.mint(who, 10 ether);
        vm.prank(who);
        weth.approve(address(market), type(uint256).max);
    }

    /// A bet, with no payload, no calldata surgery, no helper.
    function _bet(address who, OrderbookMarket.Direction dir, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return market.placeBet(dir, amount, address(0), 1e18, 100);
    }

    // ── THE POINT ────────────────────────────────────────────
    /**
     * placeBet is an ordinary transaction.
     *
     * On Base the same call is impossible without appending a signed RedStone
     * payload to the calldata, which is why neither wagmi's writeContract nor a
     * block explorer can make it. This test would not compile against
     * OrderbookMarket.
     */
    function test_PlaceBetIsAnOrdinaryCall() public {
        uint256 orderId = _bet(alice, OrderbookMarket.Direction.UP, 0.01 ether);
        assertEq(orderId, 1);
        assertEq(weth.balanceOf(address(market)), 0.01 ether, "stake was taken");
    }

    /// The strike is the pool's TWAP, reached through the resolver rather than
    /// recomputed here.
    function test_StrikeComesFromThePoolTwap() public {
        MockUniswapV3Pool p2 = new MockUniswapV3Pool(memecoin, address(weth), 10000);
        p2.pushTick(T0 - 7200, 6932); // ~2.0 WETH per token
        PoolOrderbookMarket m2 = _marketOn(p2);

        vm.prank(alice);
        // expectedPrice must be near 2e18 now, not 1e18: slippage is checked
        // against whatever the pool says.
        uint256 id = m2.placeBet(OrderbookMarket.Direction.UP, 0.01 ether, address(0), 2000036323830794752, 100);
        assertEq(id, 1);

        vm.prank(bob);
        vm.expectRevert("price slippage exceeded");
        m2.placeBet(OrderbookMarket.Direction.DOWN, 0.01 ether, address(0), 1e18, 100);
    }

    // ── STAKE BOUNDS IN WETH ─────────────────────────────────
    function test_StakeBoundsAreStatedInWeth() public view {
        assertEq(market.MIN_BET(), 0.005 ether);
        assertEq(market.MAX_BET(), 0.04 ether);
        assertEq(market.MAX_TRADER_LP_EXPOSURE(), 0.12 ether);
    }

    /// The inherited USDC floor of 1e6 wei would be dust here; the override is
    /// what makes the floor mean anything.
    function test_BelowMinBetIsRejected() public {
        vm.prank(alice);
        vm.expectRevert("below min");
        market.placeBet(OrderbookMarket.Direction.UP, 0.0049 ether, address(0), 1e18, 100);

        // Exactly at the inherited USDC value, which must now be far too small.
        vm.prank(alice);
        vm.expectRevert("below min");
        market.placeBet(OrderbookMarket.Direction.UP, 1e6, address(0), 1e18, 100);
    }

    function test_AboveMaxBetIsRejected() public {
        vm.prank(alice);
        vm.expectRevert("above max");
        market.placeBet(OrderbookMarket.Direction.UP, 0.041 ether, address(0), 1e18, 100);
    }

    // ── ROUND TRIP ───────────────────────────────────────────
    /**
     * Two opposite bets match, the pool moves up, the keeper settles from the
     * pool's own history, and the UP side claims the whole bank.
     */
    function test_RoundTrip_UpWins() public {
        _bet(alice, OrderbookMarket.Direction.UP, 0.02 ether);
        _bet(bob, OrderbookMarket.Direction.DOWN, 0.02 ether);

        OrderbookMarket.Match memory m = market.getMatch(1);
        assertEq(m.amount, 0.02 ether, "matched");
        assertEq(m.entryPrice, 1e18, "struck at the pool's flat price");
        assertEq(m.settleAt, block.timestamp + DURATION);

        // The token appreciates well before the exit window opens, so the whole
        // window sees the higher price.
        pool.pushTick(uint32(m.settleAt - 600), 6932);
        vm.warp(m.settleAt + 1);

        vm.prank(keeper);
        assertEq(resolver.resolveOrderbookMarketBatch(address(market), 10), 1);

        m = market.getMatch(1);
        assertTrue(m.settled, "settled");
        assertTrue(m.upWon, "up won");

        uint256 before = weth.balanceOf(alice);
        vm.prank(alice);
        market.claim(1);
        assertEq(weth.balanceOf(alice) - before, 0.04 ether, "winner takes the bank at feeBps 0");
    }

    /// The mirror case, so a bug that always picks one side cannot hide.
    function test_RoundTrip_DownWins() public {
        _bet(alice, OrderbookMarket.Direction.UP, 0.02 ether);
        _bet(bob, OrderbookMarket.Direction.DOWN, 0.02 ether);

        OrderbookMarket.Match memory m = market.getMatch(1);
        pool.pushTick(uint32(m.settleAt - 600), -6932);
        vm.warp(m.settleAt + 1);

        vm.prank(keeper);
        resolver.resolveOrderbookMarketBatch(address(market), 10);

        m = market.getMatch(1);
        assertTrue(m.settled);
        assertFalse(m.upWon, "down won");

        uint256 before = weth.balanceOf(bob);
        vm.prank(bob);
        market.claim(2); // claim takes an order id, and bob's was the second
        assertEq(weth.balanceOf(bob) - before, 0.04 ether);
    }

    function test_RoundTrip_TieRefundsBothSides() public {
        _bet(alice, OrderbookMarket.Direction.UP, 0.02 ether);
        _bet(bob, OrderbookMarket.Direction.DOWN, 0.02 ether);
        OrderbookMarket.Match memory m = market.getMatch(1);

        vm.warp(m.settleAt + 1);
        uint256 aliceBefore = weth.balanceOf(alice);
        uint256 bobBefore = weth.balanceOf(bob);
        vm.prank(keeper);
        assertEq(resolver.resolveOrderbookMarketBatch(address(market), 10), 1);

        m = market.getMatch(1);
        assertTrue(m.settled);
        assertEq(m.exitPrice, m.entryPrice);
        assertEq(weth.balanceOf(alice) - aliceBefore, 0.02 ether, "UP refunded");
        assertEq(weth.balanceOf(bob) - bobBefore, 0.02 ether, "DOWN refunded");
    }

    /// A pool that dies under an open position leaves the match unsettleable,
    /// which is what emergencyRefundMatch exists for. The stake is not lost.
    function test_DeadPoolLeavesTheMatchRefundable() public {
        _bet(alice, OrderbookMarket.Direction.UP, 0.02 ether);
        _bet(bob, OrderbookMarket.Direction.DOWN, 0.02 ether);

        OrderbookMarket.Match memory m = market.getMatch(1);
        pool.setLiquidity(0);
        vm.warp(m.settleAt + 1);

        vm.prank(keeper);
        assertEq(resolver.resolveOrderbookMarketBatch(address(market), 10), 0, "cannot settle");

        vm.warp(block.timestamp + market.SETTLE_GRACE() + 1);
        uint256 aliceBefore = weth.balanceOf(alice);
        uint256 bobBefore = weth.balanceOf(bob);
        market.emergencyRefundMatch(1); // permissionless

        assertEq(weth.balanceOf(alice) - aliceBefore, 0.02 ether, "alice refunded");
        assertEq(weth.balanceOf(bob) - bobBefore, 0.02 ether, "bob refunded");
    }

    /**
     * A match more than SETTLE_GRACE overdue must not hide a fresh, perfectly
     * settleable match on the SAME market behind it in the same batch call.
     *
     * Before the resolver skipped past-grace matches itself,
     * OrderbookMarket.settleMatch would revert "settlement window expired"
     * for the old one, and that revert took the whole
     * resolveOrderbookMarketBatch transaction down with it - including
     * whatever it would otherwise have settled.
     */
    function test_PastGraceMatch_DoesNotBlockAFreshMatchInTheSameBatch() public {
        _bet(alice, OrderbookMarket.Direction.UP, 0.02 ether);
        _bet(bob, OrderbookMarket.Direction.DOWN, 0.02 ether);
        OrderbookMarket.Match memory old = market.getMatch(1);

        // Let match 1 age well past SETTLE_GRACE, with nobody ever settling
        // or emergency-refunding it.
        vm.warp(old.settleAt + market.SETTLE_GRACE() + 1);

        // A fresh pair matches now, due well within grace.
        _bet(alice, OrderbookMarket.Direction.UP, 0.02 ether);
        _bet(bob, OrderbookMarket.Direction.DOWN, 0.02 ether);
        OrderbookMarket.Match memory fresh = market.getMatch(2);
        assertEq(fresh.amount, 0.02 ether, "second match formed");

        uint256 aliceBefore = weth.balanceOf(alice);
        vm.warp(fresh.settleAt + 1);
        vm.prank(keeper);
        uint256 handled = resolver.resolveOrderbookMarketBatch(address(market), 10);

        // Audit L02: the overdue match is no longer left for emergencyRefundMatch,
        // the resolver refunds it in the same call (a final state, so it counts).
        assertEq(handled, 2, "the fresh match settles and the overdue one is refunded");
        assertTrue(market.getMatch(1).settled, "the overdue match was refunded by the resolver");
        assertTrue(market.getMatch(2).settled, "the fresh match is not held hostage by the overdue one");
        assertGe(weth.balanceOf(alice) - aliceBefore, 0.02 ether, "alice got her stake back from the overdue match");
    }

    /**
     * MAX_TRADER_LP_EXPOSURE's own comment says markets being recreated every
     * few minutes naturally resets it - but on this chain a market has no
     * close time and lives forever, so a cap that only ever grows becomes a
     * LIFETIME ban from the LP the moment a trader's closed positions add up
     * to it, even though the capital those positions used is long back in the
     * vault and free to be matched against again. Releasing it on settle (or
     * tie, or refund) keeps the cap doing its real job - bounding concurrent
     * exposure to one address - without also permanently blacklisting anyone
     * who simply keeps using the product.
     */
    function test_TraderLpExposure_ReleasesOnSettle_NotLifetimeLocked() public {
        weth.mint(address(this), 10 ether);
        weth.approve(address(lp), 10 ether);
        lp.deposit(10 ether, address(this));

        // Three max-size bets exactly exhaust alice's 0.12 ether LP cap.
        _bet(alice, OrderbookMarket.Direction.UP, 0.04 ether);
        _bet(alice, OrderbookMarket.Direction.UP, 0.04 ether);
        _bet(alice, OrderbookMarket.Direction.UP, 0.04 ether);
        assertEq(market.traderLpExposure(alice), 0.12 ether, "cap exactly exhausted");

        // A fourth bet has no LP room left and simply rests, unmatched.
        uint256 fourthId = _bet(alice, OrderbookMarket.Direction.UP, 0.04 ether);
        assertEq(market.getOrder(fourthId).filledAmount, 0, "no LP room left");

        // Settle ONLY the FIRST match - resolveOrderbookMatch, not the batch,
        // so matches 2 and 3 (formed in the same block, same settleAt) stay
        // open and this isolates what releasing exactly ONE match's share
        // actually does.
        OrderbookMarket.Match memory m1 = market.getMatch(1);
        pool.pushTick(uint32(m1.settleAt - 600), 6932); // decisive move, not a tie
        vm.warp(m1.settleAt + 1);
        resolver.resolveOrderbookMatch(address(market), 1);
        assertTrue(market.getMatch(1).settled);
        assertFalse(market.getMatch(2).settled, "2 and 3 deliberately left open");

        assertEq(
            market.traderLpExposure(alice),
            0.08 ether,
            "settling one 0.04 LP match releases exactly its own 0.04, not locked forever"
        );

        // With room freed, a fifth bet can now reach the LP again. Wide
        // slippage: the earlier price push is still live and this test does
        // not care what the exact strike is, only that the bet is not
        // rejected for lack of LP room.
        vm.prank(alice);
        uint256 fifthId = market.placeBet(OrderbookMarket.Direction.UP, 0.04 ether, address(0), 2e18, 5000);
        assertEq(market.getOrder(fifthId).filledAmount, 0.04 ether, "freed cap lets a new bet reach the LP");
    }

    /// The same release must happen on a TIE - it goes through a different
    /// code path (_refundTiedMatch) than a normal win/loss settlement.
    function test_TraderLpExposure_ReleasesOnTie() public {
        weth.mint(address(this), 10 ether);
        weth.approve(address(lp), 10 ether);
        lp.deposit(10 ether, address(this));

        _bet(alice, OrderbookMarket.Direction.UP, 0.04 ether);
        assertEq(market.traderLpExposure(alice), 0.04 ether);

        OrderbookMarket.Match memory m1 = market.getMatch(1);
        vm.warp(m1.settleAt + 1); // pool never moves: exact tie
        vm.prank(keeper);
        resolver.resolveOrderbookMarketBatch(address(market), 10);
        assertEq(market.getMatch(1).exitPrice, market.getMatch(1).entryPrice, "tied");

        assertEq(market.traderLpExposure(alice), 0, "a tied LP match releases its exposure too");
    }

    /// And on an emergency refund - the third and last terminal path for an
    /// LP-matched match.
    function test_TraderLpExposure_ReleasesOnEmergencyRefund() public {
        weth.mint(address(this), 10 ether);
        weth.approve(address(lp), 10 ether);
        lp.deposit(10 ether, address(this));

        _bet(alice, OrderbookMarket.Direction.UP, 0.04 ether);
        assertEq(market.traderLpExposure(alice), 0.04 ether);

        OrderbookMarket.Match memory m1 = market.getMatch(1);
        pool.setLiquidity(0); // unpriceable
        vm.warp(m1.settleAt + market.SETTLE_GRACE() + 1);
        market.emergencyRefundMatch(1);

        assertEq(market.traderLpExposure(alice), 0, "an emergency-refunded LP match releases its exposure too");
    }

    /// An entry cannot be struck against a pool that cannot price itself.
    function test_EntryRevertsWhenThePoolCannotPrice() public {
        pool.setForceOld(true);
        vm.prank(alice);
        vm.expectRevert("pool cannot price entry");
        market.placeBet(OrderbookMarket.Direction.UP, 0.01 ether, address(0), 1e18, 100);
    }

    // ── helpers ──────────────────────────────────────────────
    function _marketOn(MockUniswapV3Pool p) internal returns (PoolOrderbookMarket m) {
        GenesisNFT g = new GenesisNFT("ipfs://test/");
        LiquidityPool l = new LiquidityPool(IERC20(address(weth)), address(g));
        g.setLiquidityPool(address(l));

        m = new PoolOrderbookMarket(
            address(weth),
            address(resolver),
            address(l),
            makeAddr("feeDistrib"),
            address(0),
            multisig,
            bytes32(uint256(uint160(address(p)))),
            DURATION
        );
        MockMarketRegistry r = new MockMarketRegistry();
        r.register(address(m));
        l.setMarketFactory(address(r));
        l.authorizeMarket(address(m));

        vm.prank(alice);
        weth.approve(address(m), type(uint256).max);
        vm.prank(bob);
        weth.approve(address(m), type(uint256).max);
    }
}
