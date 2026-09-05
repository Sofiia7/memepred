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
