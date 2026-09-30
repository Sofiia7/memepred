// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/interfaces/IUniswapV3.sol";
import "../src/lib/TickMath.sol";

/**
 * Stand-in for a Uniswap v3 pool's oracle, for PoolRounds. The same controls
 * as mocks/MockUniswapV3Pool.sol (which is left untouched), plus what that mock
 * does not have and PoolRounds now reads: the second array of observe(),
 * secondsPerLiquidityCumulativeX128, from a liquidity history.
 *
 * Ticks and liquidity are two piecewise-constant timelines. The tick is
 * integrated into tickCumulative; the liquidity into
 * secondsPerLiquidityCumulativeX128 += (seconds << 128) / max(liquidity, 1),
 * Uniswap's own formula (Oracle.transform), so a window with no in-range
 * liquidity accrues as if liquidity were 1. setLiquidity(l) takes effect from
 * the current block timestamp on; the past is not rewritten.
 */
contract PoolRoundMockPool is IUniswapV3Pool {
    struct Segment {
        uint32 startTs;
        int24 tick;
    }

    struct LiqSegment {
        uint32 startTs;
        uint128 liquidity;
    }

    Segment[] public segments;
    LiqSegment[] public liqSegments;

    address public override token0;
    address public override token1;
    uint24 public override fee;
    uint16 internal cardinality;
    uint16 internal cardinalityNext;
    bool public forceOld;
    uint8 public forceOtherRevert;

    constructor(address _token0, address _token1, uint24 _fee) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        cardinality = 1;
        cardinalityNext = 1;
        liqSegments.push(LiqSegment({startTs: 0, liquidity: 1e18}));
    }

    // ── test controls ────────────────────────────────────────
    function pushTick(uint32 startTs, int24 tick) external {
        require(segments.length == 0 || startTs > segments[segments.length - 1].startTs, "non-monotonic");
        segments.push(Segment({startTs: startTs, tick: tick}));
    }

    /// From now on the in-range liquidity is `l`.
    function setLiquidity(uint128 l) external {
        uint32 nowTs = uint32(block.timestamp);
        LiqSegment storage last = liqSegments[liqSegments.length - 1];
        if (last.startTs >= nowTs) last.liquidity = l;
        else liqSegments.push(LiqSegment({startTs: nowTs, liquidity: l}));
    }

    /// From `startTs` on the in-range liquidity is `l` (a scheduled change, for windows in the future).
    function pushLiquidity(uint32 startTs, uint128 l) external {
        require(startTs > liqSegments[liqSegments.length - 1].startTs, "non-monotonic");
        liqSegments.push(LiqSegment({startTs: startTs, liquidity: l}));
    }

    function setCardinality(uint16 c, uint16 next) external {
        cardinality = c;
        cardinalityNext = next;
    }

    function setForceOld(bool v) external {
        forceOld = v;
    }

    function setForceOtherRevert(uint8 mode) external {
        forceOtherRevert = mode;
    }

    // ── IUniswapV3Pool ───────────────────────────────────────
    function liquidity() external view override returns (uint128) {
        return _liqAt(uint32(block.timestamp));
    }

    function slot0() external view override returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        int24 t = _tickAt(uint32(block.timestamp));
        return (TickMath.getSqrtRatioAtTick(t), t, 0, cardinality, cardinalityNext, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        override
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!forceOld, "OLD");
        if (forceOtherRevert == 1) revert("LOK");
        if (forceOtherRevert == 2) revert();
        require(segments.length > 0, "OLD");
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            uint32 target = uint32(block.timestamp) - secondsAgos[i];
            require(target >= segments[0].startTs, "OLD");
            tickCumulatives[i] = _cumulativeAt(target);
            secondsPerLiquidityCumulativeX128s[i] = _splAt(target);
        }
    }

    function increaseObservationCardinalityNext(uint16 next) external override {
        if (next > cardinalityNext) cardinalityNext = next;
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

    function _liqAt(uint32 ts) internal view returns (uint128 l) {
        for (uint256 i = 0; i < liqSegments.length; i++) {
            if (liqSegments[i].startTs > ts) break;
            l = liqSegments[i].liquidity;
        }
    }

    function _cumulativeAt(uint32 ts) internal view returns (int56 acc) {
        for (uint256 i = 0; i < segments.length; i++) {
            uint32 from = segments[i].startTs;
            if (from >= ts) break;
            uint32 to = (i + 1 < segments.length && segments[i + 1].startTs < ts) ? segments[i + 1].startTs : ts;
            acc += int56(segments[i].tick) * int56(uint56(to - from));
        }
    }

    /// Integral of 1 / max(liquidity, 1) from the first segment's start to `ts`, Q128, wrapping like Uniswap's uint160.
    function _splAt(uint32 ts) internal view returns (uint160 acc) {
        uint32 origin = segments[0].startTs;
        unchecked {
            for (uint256 i = 0; i < liqSegments.length; i++) {
                uint32 from = liqSegments[i].startTs < origin ? origin : liqSegments[i].startTs;
                uint32 end = i + 1 < liqSegments.length ? liqSegments[i + 1].startTs : ts;
                if (end > ts) end = ts;
                if (end <= from) continue;
                uint128 l = liqSegments[i].liquidity;
                acc += uint160((uint256(end - from) << 128) / (l > 0 ? l : 1));
            }
        }
    }
}
