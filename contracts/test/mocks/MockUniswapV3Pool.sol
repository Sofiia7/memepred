// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../src/interfaces/IUniswapV3.sol";
import "../../src/lib/TickMath.sol";

/**
 * A Uniswap v3 pool's oracle, faithfully enough for PoolOracleResolver.
 *
 * Not a stub that returns a fixed number: the properties under test are all
 * about *time* - that the exit price is anchored at a match's settleAt rather
 * than at the keeper's block, and that a window reaching past the observation
 * ring fails cleanly. A mock that ignored secondsAgos would pass those tests
 * while the real pool failed them.
 *
 * So this integrates the tick over time the way Oracle.sol does. The tick is
 * piecewise constant between writes, tickCumulative is its integral, and
 * observe() reverts 'OLD' for anything before the oldest recorded segment -
 * which is the single most important behaviour to reproduce, because it is the
 * one that turns into MatchUnpriceable in production.
 */
contract MockUniswapV3Pool is IUniswapV3Pool {
    struct Segment {
        uint32 startTs;
        int24 tick;
    }

    Segment[] public segments;

    address public override token0;
    address public override token1;
    uint24 public override fee;
    uint128 internal poolLiquidity;
    uint16 internal cardinality;
    uint16 internal cardinalityNext;

    /// Set true to make observe() revert the way a ring too small for the
    /// window does, regardless of the recorded segments.
    bool public forceOld;

    constructor(address _token0, address _token1, uint24 _fee) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        poolLiquidity = 1e18;
        cardinality = 1;
        cardinalityNext = 1;
    }

    // ── test controls ────────────────────────────────────────
    /// Record that the tick became `tick` at `startTs` and stayed there.
    function pushTick(uint32 startTs, int24 tick) external {
        require(segments.length == 0 || startTs > segments[segments.length - 1].startTs, "non-monotonic");
        segments.push(Segment({startTs: startTs, tick: tick}));
    }

    function setLiquidity(uint128 l) external {
        poolLiquidity = l;
    }

    function setCardinality(uint16 c, uint16 next) external {
        cardinality = c;
        cardinalityNext = next;
    }

    function setForceOld(bool v) external {
        forceOld = v;
    }

    function setTokens(address _token0, address _token1) external {
        token0 = _token0;
        token1 = _token1;
    }

    // ── IUniswapV3Pool ───────────────────────────────────────
    function liquidity() external view override returns (uint128) {
        return poolLiquidity;
    }

    function slot0()
        external
        view
        override
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 obsCardinality,
            uint16 obsNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        int24 t = _tickAt(uint32(block.timestamp));
        // A real pool's sqrtPriceX96 and tick agree by construction, and
        // PoolMarketFactory.wethDepth reads both - so deriving one from the
        // other here keeps the mock from admitting a pool state that cannot
        // exist on chain.
        return (TickMath.getSqrtRatioAtTick(t), t, 0, cardinality, cardinalityNext, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        override
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!forceOld, "OLD");
        require(segments.length > 0, "OLD");

        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);

        for (uint256 i = 0; i < secondsAgos.length; i++) {
            uint32 target = uint32(block.timestamp) - secondsAgos[i];
            // The real pool reverts when the requested point predates its
            // oldest observation; everything else about this mock exists to
            // make that boundary reachable in a test.
            require(target >= segments[0].startTs, "OLD");
            tickCumulatives[i] = _cumulativeAt(target);
        }
    }

    function increaseObservationCardinalityNext(uint16 next) external override {
        if (next > cardinalityNext) cardinalityNext = next;
        // The real pool grows `cardinality` on the next write, not here. Tests
        // that care about that use setCardinality directly.
    }

    // ── internals ────────────────────────────────────────────
    function _tickAt(uint32 ts) internal view returns (int24) {
        int24 tick = segments.length > 0 ? segments[0].tick : int24(0);
        for (uint256 i = 0; i < segments.length; i++) {
            if (segments[i].startTs > ts) break;
            tick = segments[i].tick;
        }
        return tick;
    }

    /// Integral of the tick from segments[0].startTs to `ts`.
    function _cumulativeAt(uint32 ts) internal view returns (int56) {
        int56 acc = 0;
        for (uint256 i = 0; i < segments.length; i++) {
            uint32 from = segments[i].startTs;
            if (from >= ts) break;
            uint32 to = (i + 1 < segments.length && segments[i + 1].startTs < ts) ? segments[i + 1].startTs : ts;
            acc += int56(segments[i].tick) * int56(uint56(to - from));
        }
        return acc;
    }
}
