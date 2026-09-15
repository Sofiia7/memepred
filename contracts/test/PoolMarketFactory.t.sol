// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/PoolMarketFactory.sol";
import "../src/PoolOracleResolver.sol";
import "../src/LiquidityPool.sol";
import "../src/FeeDistributor.sol";
import "../src/ReferralRegistry.sol";
import "../src/GenesisNFT.sol";
import "./mocks/MockUniswapV3Pool.sol";
import "./mocks/MockUniswapV3Factory.sol";
import "./mocks/MockWETH.sol";

/**
 * PoolMarketFactory: admission.
 *
 * createMarket is open to anyone, so every one of these gates is the only thing
 * standing between a market and whoever wants one on terms of their choosing.
 * There is a test per gate because a gate that silently stops working is
 * indistinguishable from one that was never there.
 */
contract PoolMarketFactoryTest is Test {
    PoolMarketFactory factory;
    PoolOracleResolver resolver;
    MockUniswapV3Factory v3Factory;
    MockWETH weth;
    LiquidityPool lp;
    FeeDistributor feeDistributor;
    ReferralRegistry referralRegistry;

    address memecoin = makeAddr("memecoin");
    address multisig = makeAddr("multisig");
    address anyone = makeAddr("anyone");
    address pauser = makeAddr("pauser");

    uint24 constant FEE = 10000;
    uint32 constant T0 = 1_787_000_000;
    uint256 constant D15 = 900; // exit window 180s

    function setUp() public {
        vm.warp(T0);

        weth = new MockWETH();
        v3Factory = new MockUniswapV3Factory();
        resolver = new PoolOracleResolver(address(weth));

        GenesisNFT genesisNFT = new GenesisNFT("ipfs://test/");
        lp = new LiquidityPool(IERC20(address(weth)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(lp));
        feeDistributor = new FeeDistributor(address(weth), multisig, address(lp), multisig);
        referralRegistry = new ReferralRegistry();

        factory = new PoolMarketFactory(
            address(weth),
            address(v3Factory),
            address(resolver),
            address(feeDistributor),
            address(referralRegistry),
            multisig,
            address(lp)
        );

        lp.setMarketFactory(address(factory));
        feeDistributor.setMarketFactory(address(factory));
        referralRegistry.setMarketFactory(address(factory));
    }

    /// A pool that passes every gate: canonical, WETH-paired, deep, with a full
    /// observation ring and real history behind it.
    function _goodPool() internal returns (MockUniswapV3Pool pool) {
        pool = new MockUniswapV3Pool(memecoin, address(weth), FEE);
        pool.pushTick(T0 - 7200, 0); // price 1.0, so depth == liquidity
        pool.setLiquidity(10 ether);
        pool.setCardinality(300, 300);
        v3Factory.register(memecoin, address(weth), FEE, address(pool));
    }

    // ── THE HAPPY PATH ───────────────────────────────────────
    function test_AnyoneMayCreateAMarket() public {
        MockUniswapV3Pool pool = _goodPool();

        vm.prank(anyone);
        address market = factory.createMarket(address(pool), D15);

        assertTrue(market != address(0));
        assertTrue(factory.isMarket(market));
        assertEq(PoolOrderbookMarket(market).duration(), D15);
        assertEq(PoolOrderbookMarket(market).feedId(), factory.feedIdFor(address(pool)));
        assertEq(factory.getActiveMarkets(factory.feedIdFor(address(pool))).length, 1);
    }

    /// PvP infrastructure is immediate. LP capital remains opt-in and is only
    /// granted by the vault owner after the specific market is reviewed.
    function test_MarketDoesNotAutomaticallyReceiveLpCapital() public {
        MockUniswapV3Pool pool = _goodPool();
        vm.prank(anyone);
        address market = factory.createMarket(address(pool), D15);

        assertFalse(lp.isAuthorizedMarket(market), "LP must be opt-in");
        assertTrue(feeDistributor.isAuthorizedMarket(market), "fee distributor");
        assertTrue(referralRegistry.authorizedMarkets(market), "referral registry");

        lp.authorizeMarket(market);
        assertTrue(lp.isAuthorizedMarket(market), "owner may opt this market into LP");
    }

    /// Each duration is its own market, and each is created once.
    function test_OneMarketPerDuration() public {
        MockUniswapV3Pool pool = _goodPool();
        vm.startPrank(anyone);
        factory.createMarket(address(pool), 60);
        factory.createMarket(address(pool), 300);
        factory.createMarket(address(pool), D15);
        vm.stopPrank();
        assertEq(factory.getActiveMarkets(factory.feedIdFor(address(pool))).length, 3);
    }

    // ── GATE 1: THE POOL IS REAL ─────────────────────────────
    /**
     * The gate the others depend on. This pool answers every call correctly and
     * looks perfect - it is simply not the pool the canonical factory made, so
     * whoever deployed it chooses what the price is.
     */
    function test_Rejects_PoolTheCanonicalFactoryDoesNotKnow() public {
        MockUniswapV3Pool counterfeit = new MockUniswapV3Pool(memecoin, address(weth), FEE);
        counterfeit.pushTick(T0 - 7200, 0);
        counterfeit.setLiquidity(1000 ether);
        counterfeit.setCardinality(300, 300);
        // deliberately not registered

        vm.expectRevert(PoolMarketFactory.NotCanonicalPool.selector);
        vm.prank(anyone);
        factory.createMarket(address(counterfeit), D15);
    }

    /// A pool registered for a different fee tier than it reports is likewise
    /// not the canonical pool for what it claims to be.
    function test_Rejects_PoolRegisteredUnderAnotherTier() public {
        MockUniswapV3Pool pool = new MockUniswapV3Pool(memecoin, address(weth), FEE);
        pool.pushTick(T0 - 7200, 0);
        pool.setLiquidity(10 ether);
        pool.setCardinality(300, 300);
        v3Factory.register(memecoin, address(weth), 3000, address(pool)); // wrong tier

        vm.expectRevert(PoolMarketFactory.NotCanonicalPool.selector);
        vm.prank(anyone);
        factory.createMarket(address(pool), D15);
    }

    // ── GATE 2: WETH PAIR ────────────────────────────────────
    function test_Rejects_PoolWithoutWeth() public {
        address other = makeAddr("otherToken");
        MockUniswapV3Pool pool = new MockUniswapV3Pool(memecoin, other, FEE);
        pool.pushTick(T0 - 7200, 0);
        pool.setLiquidity(10 ether);
        pool.setCardinality(300, 300);
        v3Factory.register(memecoin, other, FEE, address(pool));

        vm.expectRevert(PoolMarketFactory.NotAWethPair.selector);
        vm.prank(anyone);
        factory.createMarket(address(pool), D15);
    }

    // ── GATE 3: DEPTH ────────────────────────────────────────
    function test_Rejects_ThinPool() public {
        MockUniswapV3Pool pool = _goodPool();
        pool.setLiquidity(1 ether); // below MIN_POOL_WETH_DEPTH at price 1.0

        vm.expectRevert(abi.encodeWithSelector(PoolMarketFactory.PoolTooThin.selector, 1 ether));
        vm.prank(anyone);
        factory.createMarket(address(pool), D15);
    }

    function test_AcceptsExactlyAtTheDepthThreshold() public {
        MockUniswapV3Pool pool = _goodPool();
        pool.setLiquidity(2 ether);
        vm.prank(anyone);
        factory.createMarket(address(pool), D15); // must not revert
    }

    /**
     * Depth is the WETH side, not the raw uint128. The same liquidity at a
     * different price is a different amount of WETH, which is the whole reason
     * the gate is not on liquidity() as the design doc had it.
     */
    function test_DepthFollowsPriceNotRawLiquidity() public {
        MockUniswapV3Pool pool = _goodPool();
        pool.setLiquidity(10 ether);
        uint256 atUnity = factory.wethDepth(pool);

        MockUniswapV3Pool cheap = new MockUniswapV3Pool(memecoin, address(weth), FEE);
        cheap.pushTick(T0 - 7200, -6932); // token worth ~0.5 WETH
        cheap.setLiquidity(10 ether); // identical L
        cheap.setCardinality(300, 300);

        uint256 atHalf = factory.wethDepth(cheap);
        assertLt(atHalf, atUnity, "same L, less WETH behind it");
        // y = L * sqrt(P): at P = 0.5 that is L / sqrt(2).
        assertApproxEqRel(atHalf, (atUnity * 7071) / 10000, 1e15);
    }

    /// With WETH as token0 the depth is the other side of the identity. Getting
    /// this backwards would misjudge every pool with a low-address memecoin.
    function test_DepthHandlesEitherTokenOrder() public {
        MockUniswapV3Pool a = new MockUniswapV3Pool(memecoin, address(weth), FEE);
        a.pushTick(T0 - 7200, 0);
        a.setLiquidity(10 ether);

        MockUniswapV3Pool b = new MockUniswapV3Pool(address(weth), memecoin, FEE);
        b.pushTick(T0 - 7200, 0);
        b.setLiquidity(10 ether);

        // At tick 0 the price is 1.0, so both orderings give the same depth.
        assertEq(factory.wethDepth(a), 10 ether);
        assertEq(factory.wethDepth(b), 10 ether);
    }

    // ── GATE 4: RING CAPACITY ────────────────────────────────
    function test_Rejects_CardinalityBelowThreshold() public {
        MockUniswapV3Pool pool = _goodPool();
        pool.setCardinality(299, 300);

        vm.expectRevert(abi.encodeWithSelector(PoolMarketFactory.CardinalityTooLow.selector, uint16(299), uint16(300)));
        vm.prank(anyone);
        factory.createMarket(address(pool), D15);
    }

    /// The state 98.6% of pools on this chain are actually in.
    function test_Rejects_FreshPoolWithCardinalityOne() public {
        MockUniswapV3Pool pool = _goodPool();
        pool.setCardinality(1, 1);

        vm.expectRevert(abi.encodeWithSelector(PoolMarketFactory.CardinalityTooLow.selector, uint16(1), uint16(300)));
        vm.prank(anyone);
        factory.createMarket(address(pool), D15);
    }

    /// Paying for the ring is not the same as having filled it: Uniswap raises
    /// cardinality to cardinalityNext in one step, so `Next` alone proves
    /// nothing about capacity yet.
    function test_Rejects_WhenOnlyCardinalityNextWasRaised() public {
        MockUniswapV3Pool pool = _goodPool();
        pool.setCardinality(1, 1);
        pool.increaseObservationCardinalityNext(300);

        vm.expectRevert(abi.encodeWithSelector(PoolMarketFactory.CardinalityTooLow.selector, uint16(1), uint16(300)));
        vm.prank(anyone);
        factory.createMarket(address(pool), D15);
    }

    // ── GATE 5: ACTUAL HISTORY ───────────────────────────────
    /**
     * The gate the design doc did not have, and the one that catches what the
     * cardinality check cannot.
     *
     * This pool reports a full 300-slot ring and holds ten seconds of prices.
     * Cardinality says nothing about that, because Uniswap grows the ring in a
     * single step on the first write after somebody pays for it. Only asking
     * the pool to serve the window separates capacity from history.
     */
    function test_Rejects_FullRingWithNoHistoryInIt() public {
        MockUniswapV3Pool pool = new MockUniswapV3Pool(memecoin, address(weth), FEE);
        pool.pushTick(uint32(block.timestamp) - 10, 0); // ten seconds of prices
        pool.setLiquidity(10 ether);
        pool.setCardinality(300, 300);
        v3Factory.register(memecoin, address(weth), FEE, address(pool));

        vm.expectRevert(abi.encodeWithSelector(PoolMarketFactory.PoolCannotServeWindow.selector, uint256(180)));
        vm.prank(anyone);
        factory.createMarket(address(pool), D15);
    }

    /**
     * And the useful consequence: a young pool earns its short markets first.
     * Ten seconds is not enough for anything, but a pool with 60 seconds of
     * history can carry a 60-second market (window 30s) while still failing the
     * 15-minute one (window 180s).
     */
    function test_ShortMarketIsAvailableBeforeTheLongOne() public {
        MockUniswapV3Pool pool = new MockUniswapV3Pool(memecoin, address(weth), FEE);
        pool.pushTick(uint32(block.timestamp) - 60, 0);
        pool.setLiquidity(10 ether);
        pool.setCardinality(300, 300);
        v3Factory.register(memecoin, address(weth), FEE, address(pool));

        vm.prank(anyone);
        factory.createMarket(address(pool), 60); // window 30s, fits

        vm.expectRevert(abi.encodeWithSelector(PoolMarketFactory.PoolCannotServeWindow.selector, uint256(180)));
        vm.prank(anyone);
        factory.createMarket(address(pool), D15);
    }

    // ── GATE 6: FEE TIER ─────────────────────────────────────
    function test_Rejects_DisallowedFeeTier() public {
        MockUniswapV3Pool pool = new MockUniswapV3Pool(memecoin, address(weth), 100);
        pool.pushTick(T0 - 7200, 0);
        pool.setLiquidity(10 ether);
        pool.setCardinality(300, 300);
        v3Factory.register(memecoin, address(weth), 100, address(pool));

        vm.expectRevert(abi.encodeWithSelector(PoolMarketFactory.FeeTierNotAllowed.selector, uint24(100)));
        vm.prank(anyone);
        factory.createMarket(address(pool), D15);
    }

    function test_OwnerMayOpenAFeeTier() public {
        MockUniswapV3Pool pool = new MockUniswapV3Pool(memecoin, address(weth), 100);
        pool.pushTick(T0 - 7200, 0);
        pool.setLiquidity(10 ether);
        pool.setCardinality(300, 300);
        v3Factory.register(memecoin, address(weth), 100, address(pool));

        factory.setFeeTier(100, true);
        vm.prank(anyone);
        factory.createMarket(address(pool), D15); // must not revert
    }

    function test_FeeTierIsOwnerOnly() public {
        vm.prank(anyone);
        vm.expectRevert();
        factory.setFeeTier(100, true);
    }

    // ── GATE 7: DURATION AND DUPLICATES ──────────────────────
    function test_Rejects_DisallowedDuration() public {
        MockUniswapV3Pool pool = _goodPool();
        vm.expectRevert(abi.encodeWithSelector(PoolMarketFactory.DurationNotAllowed.selector, uint256(3600)));
        vm.prank(anyone);
        factory.createMarket(address(pool), 3600);
    }

    /**
     * Once, ever - not MarketFactory's rolling cooldown. With creation open to
     * anyone a cooldown would let a caller mint a fresh market for the same
     * slot every minute, each authorised against the shared LP vault.
     */
    function test_Rejects_DuplicateForever() public {
        MockUniswapV3Pool pool = _goodPool();
        vm.prank(anyone);
        address first = factory.createMarket(address(pool), D15);

        vm.expectRevert(abi.encodeWithSelector(PoolMarketFactory.MarketExists.selector, first));
        vm.prank(anyone);
        factory.createMarket(address(pool), D15);

        // and still, a very long time later
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(abi.encodeWithSelector(PoolMarketFactory.MarketExists.selector, first));
        vm.prank(anyone);
        factory.createMarket(address(pool), D15);
    }

    // ── EMERGENCY STOP ───────────────────────────────────────
    /// Pausing must also stop new markets, or the stop is cosmetic - anyone can
    /// simply create a fresh one, which is the failure MarketFactory documents.
    function test_PauseStopsCreationAndFreezesLiveMarkets() public {
        MockUniswapV3Pool pool = _goodPool();
        bytes32 feedId = factory.feedIdFor(address(pool));

        vm.prank(anyone);
        address market = factory.createMarket(address(pool), 60);

        factory.setEmergencyPauser(pauser);
        vm.prank(pauser);
        factory.pauseMarketsForFeed(feedId);

        assertTrue(PoolOrderbookMarket(market).paused(), "live market frozen");

        vm.expectRevert(PoolMarketFactory.FeedIsPaused.selector);
        vm.prank(anyone);
        factory.createMarket(address(pool), 300);
    }

    /// Asymmetric on purpose: a hot wallet may stop trading, only the multisig
    /// restarts it.
    function test_UnpauseIsOwnerOnly() public {
        MockUniswapV3Pool pool = _goodPool();
        bytes32 feedId = factory.feedIdFor(address(pool));
        factory.setEmergencyPauser(pauser);

        vm.prank(pauser);
        factory.pauseMarketsForFeed(feedId);

        vm.prank(pauser);
        vm.expectRevert();
        factory.unpauseFeed(feedId);

        factory.unpauseFeed(feedId);
        vm.prank(anyone);
        factory.createMarket(address(pool), 60);
    }

    // ── FEE ──────────────────────────────────────────────────
    function test_FeeIsCappedAtOnePercentAndTimelocked() public {
        vm.expectRevert("fee too high");
        factory.proposeNewFee(101);

        factory.proposeNewFee(100);
        vm.expectRevert("timelock");
        factory.applyNewFee();

        vm.warp(block.timestamp + factory.FEE_TIMELOCK());
        factory.applyNewFee();
        assertEq(factory.feeBps(), 100);
    }

    /// A market keeps the fee it was created under, so an open position always
    /// settles on the terms it was opened on.
    function test_MarketSnapshotsTheFeeAtCreation() public {
        MockUniswapV3Pool pool = _goodPool();
        vm.prank(anyone);
        address before = factory.createMarket(address(pool), 60);
        assertEq(PoolOrderbookMarket(before).feeBps(), 100);

        factory.proposeNewFee(50);
        vm.warp(block.timestamp + factory.FEE_TIMELOCK());
        factory.applyNewFee();

        vm.prank(anyone);
        address afterFee = factory.createMarket(address(pool), 300);
        assertEq(PoolOrderbookMarket(afterFee).feeBps(), 50, "new market takes the new fee");
        assertEq(PoolOrderbookMarket(before).feeBps(), 100, "existing market keeps the old one");
    }

    // ── IMPLEMENTATION ───────────────────────────────────────
    /// The clone target must be unusable directly, or somebody claims it.
    function test_ImplementationIsAlreadyInitialised() public {
        PoolOrderbookMarket impl = PoolOrderbookMarket(factory.marketImplementation());
        vm.expectRevert();
        impl.initialize(bytes32(uint256(1)), 60, multisig, 0);
    }

    // ── COST ─────────────────────────────────────────────────
    /**
     * TZ §7 row 2: what onboarding one pool costs.
     *
     * This is the whole per-pool spend besides the observation ring, and it is
     * paid three times per pool (once per duration). Reported rather than
     * asserted: a threshold here would break on unrelated changes, and the
     * number only means anything next to the gas price, which lives in
     * docs/rhc/measurements.
     */
    function test_CreateMarketGas() public {
        MockUniswapV3Pool pool = _goodPool();

        vm.prank(anyone);
        uint256 before = gasleft();
        factory.createMarket(address(pool), D15);
        uint256 used = before - gasleft();

        emit log_named_uint("createMarket gas (clone + 5 gates + 3 authorisations)", used);
        assertLt(used, 1_500_000, "a market must stay cheap enough to onboard freely");
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(PoolMarketFactory.ZeroAddress.selector);
        new PoolMarketFactory(
            address(0),
            address(v3Factory),
            address(resolver),
            address(feeDistributor),
            address(referralRegistry),
            multisig,
            address(lp)
        );
    }

    // ── WHY MIN_CARDINALITY IS 300 ────────────────────────

    /**
     * MIN_CARDINALITY is not a preference, it is arithmetic: the longest exit
     * window plus however late the keeper is allowed to be.
     *
     * `_twapWadAt` asks the pool for `age + window` seconds of history, where
     * `age` is how far past settleAt the settlement is running, and nothing
     * caps age - MAX_PRICE_AGE only decides whether the live-price sanity check
     * runs, not how far back observe() reaches. A pool trading every second
     * writes one observation per second, so on a pump the ring holds exactly
     * `cardinality` seconds and the delay budget is `cardinality - window`.
     *
     * That budget is what a market costs when it runs out: observe reverts OLD,
     * the match is MatchUnpriceable, and the stake sits locked until
     * emergencyRefundMatch opens a day later.
     *
     * Measured over 148 real settlements on 46630: p50 33s, p90 56s, p95 61s,
     * p99 65s, bounded by the keeper's 60s tick. The one outlier at 16,983s was
     * this machine rebooting, which no ring size survives.
     *
     * So 300 leaves 120 seconds, a little under twice the measured p99. This
     * test exists because 200 was proposed as a 28% saving on onboarding, which
     * would have left 20 seconds - below the p99 the system already produces
     * when nothing is wrong.
     */
    function test_MinCardinalityIsTheLongestWindowPlusARealDelayBudget() public view {
        uint256 longestWindow;
        for (uint256 i = 0; i < 3; i++) {
            uint256 w = factory.twapWindowFor(factory.allowedDurations(i));
            if (w > longestWindow) longestWindow = w;
        }
        assertEq(longestWindow, 180, "longest exit window moved; the ring has to move with it");

        uint256 budget = factory.MIN_CARDINALITY() - longestWindow;
        assertGt(
            budget,
            65,
            "delay budget is under the measured p99 settlement delay: matches will strand on a busy pool"
        );
        assertGe(budget, 120, "delay budget fell below two keeper ticks plus a gas spike");
    }

    /// @dev And the coupling in the other direction, so the saving is findable
    ///      rather than lost: it is the 900s market that forces a 180s window.
    ///      Without it the longest window is 60s, and the same delay budget
    ///      would fit in a ring of 180 rather than 300.
    function test_ItIsThe900sMarketThatForcesTheWindowTo180() public view {
        assertEq(factory.twapWindowFor(900), 180);
        assertEq(factory.twapWindowFor(300), 60);
        assertEq(factory.twapWindowFor(60), 30);
    }
}
