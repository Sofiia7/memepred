// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PoolOracleResolver.sol";

/**
 * @notice PoolOracleResolver against the Uniswap v3 pools that actually exist
 *         on Robinhood Chain mainnet, rather than a mock.
 *
 * @dev    Everything else in this suite prices a MockUniswapV3Pool: a pool that
 *         integrates a tick the test told it to hold, with an observation ring
 *         the test told it to have. That proves the arithmetic and proves
 *         nothing about `observe()` on a real pool, which is the call the whole
 *         design rests on.
 *
 *         So this file forks 4663 and reads three pools that exist:
 *
 *           RMHT      cardinality 1801, ~93 ETH deep
 *           RBLX      cardinality  120, ~136 ETH deep, other fee tier
 *           MarsCoin  cardinality    1, ~523 ETH deep
 *
 *         The first version of this file asserted that MarsCoin must revert,
 *         because cardinality 1 means there is no history to average. It does
 *         not revert, and finding that out is most of why this file exists.
 *
 *         `observe` reverts with OLD only when the requested time reaches back
 *         past the OLDEST stored observation. When the newest observation is
 *         older than the window - which is the normal state of a pool nobody
 *         has swapped recently - every point in the window lands after it, and
 *         the pool extrapolates all of them forward at the current tick. The
 *         call succeeds and returns the spot tick exactly.
 *
 *         Measured live while writing this: MarsCoin's single observation was
 *         33 hours old, RMHT's newest was 51 hours old, RBLX's 16 minutes, and
 *         all three returned a "60 second mean tick" identical to slot0's tick.
 *
 *         That is correct, not broken: no swaps in the window means the tick
 *         did not move in the window, so the average is the spot. The guarantee
 *         a TWAP gives is unchanged - manipulation has to be held for the whole
 *         window. What it does mean is that the cardinality gate buys capacity
 *         for future history, not observability now, and that on a pool with
 *         the measured median depth of 1.5 ETH holding a price for sixty
 *         seconds is cheap. The depth gates, not the oracle, are what stand
 *         between a market and that.
 *
 *         Pinned to no block on purpose. The public RPC keeps ~8.4 minutes of
 *         state, so a fixed block cannot be replayed and this cannot run in CI;
 *         it is a check you run against the chain as it is, which is the only
 *         way this particular question can be answered at all. Skipped unless
 *         RHC_MAINNET_RPC is set, so `forge test` stays green offline.
 */
contract PoolOracleResolverForkTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    address constant POOL_RMHT = 0xabe3B1fF5Fc6a9638D0c46f2379B20f7e6173bEe; // card 1801
    address constant POOL_RBLX = 0x6d25417718A8D6c529130a8ccC4BfBf0a18219D3; // card 120
    address constant POOL_MARS = 0x297816D15Be36a1dDEA53fA3AeC8A56539D748F0; // card 1

    PoolOracleResolver resolver;
    bool active;

    function setUp() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        require(block.chainid == 4663, "forked the wrong chain");
        resolver = new PoolOracleResolver(WETH);
        active = true;
    }

    function feedOf(address pool) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(pool)));
    }

    /// @dev The pool's own instantaneous price, derived from slot0 rather than
    ///      from observe(), so the comparison below does not run the resolver's
    ///      arithmetic against itself.
    function spotFromSlot0(address pool) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        bool baseIsToken0 = IUniswapV3Pool(pool).token0() != WETH;
        uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
        return baseIsToken0
            ? Math.mulDiv(ratioX192, 1e18, 1 << 192)
            : Math.mulDiv(1 << 192, 1e18, ratioX192);
    }

    function _pricesRealPool(address pool, string memory label) internal {
        uint256 price = resolver.spotPriceWad(feedOf(pool));
        assertGt(price, 0, string.concat(label, ": priced at zero"));

        // A 60s TWAP and the instantaneous price should not be far apart on a
        // pool with a filled ring. 10% is loose enough for a memecoin and tight
        // enough that a wrong decimals or a flipped reciprocal fails it.
        uint256 spot = spotFromSlot0(pool);
        uint256 hi = price > spot ? price : spot;
        uint256 lo = price > spot ? spot : price;
        assertLt((hi - lo) * 100 / hi, 10, string.concat(label, ": TWAP far from spot"));

        emit log_named_uint(string.concat(label, " twap wad"), price);
        emit log_named_uint(string.concat(label, " spot wad"), spot);
    }

    function test_PricesARealPoolWithAFilledObservationRing() public {
        if (!active) return;
        _pricesRealPool(POOL_RMHT, "RMHT");
    }

    function test_PricesARealPoolOnADifferentFeeTier() public {
        if (!active) return;
        _pricesRealPool(POOL_RBLX, "RBLX");
    }

    /**
     * The behaviour the first draft of this file got wrong, pinned down so the
     * next reader does not have to rediscover it on mainnet.
     *
     * One observation, 33 hours stale, and `spotPriceWad` answers rather than
     * reverting. The window is entirely after the stored observation, so the
     * pool extrapolates it forward at the current tick and the "average" is the
     * spot price. 288 of 292 WETH pools measured over a day look like this.
     */
    function test_ASingleStaleObservationIsPricedAnyway_NotRefused() public {
        if (!active) return;
        (, int24 spotTick,, uint16 cardinality,,,) = IUniswapV3Pool(POOL_MARS).slot0();
        assertEq(cardinality, 1, "MarsCoin grew a ring; pick another single-observation pool");

        // Not a revert. This is the point.
        uint256 price = resolver.spotPriceWad(feedOf(POOL_MARS));
        assertGt(price, 0, "a one-observation pool still gets a price");

        assertEq(
            _meanTickOver(POOL_MARS, 60),
            spotTick,
            "expected the extrapolated mean to be exactly the spot tick"
        );
    }

    /// @dev And it is not particular to cardinality 1: a deep ring nobody has
    ///      written to recently behaves the same way.
    function test_ADeepRingThatIsStaleAlsoReturnsTheSpotTick() public {
        if (!active) return;
        (, int24 spotTick,, uint16 cardinality,,,) = IUniswapV3Pool(POOL_RMHT).slot0();
        assertGt(cardinality, 300, "expected RMHT to have a grown ring");
        assertEq(_meanTickOver(POOL_RMHT, 60), spotTick, "a grown ring is not a fresh one");
    }

    /// @dev The only thing that does make it refuse: a window reaching back past
    ///      the oldest observation the pool holds. Asked for a year, every one
    ///      of these pools is too young.
    function test_RefusesAWindowOlderThanThePoolItself() public {
        if (!active) return;
        uint32[] memory ago = new uint32[](2);
        ago[0] = 365 days;
        ago[1] = 0;
        for (uint256 i = 0; i < 3; i++) {
            address pool = [POOL_RMHT, POOL_RBLX, POOL_MARS][i];
            vm.expectRevert();
            IUniswapV3Pool(pool).observe(ago);
        }
    }

    function _meanTickOver(address pool, uint32 window) internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        ago[1] = 0;
        (int56[] memory c,) = IUniswapV3Pool(pool).observe(ago);
        return int24((c[1] - c[0]) / int56(uint56(window)));
    }
}
