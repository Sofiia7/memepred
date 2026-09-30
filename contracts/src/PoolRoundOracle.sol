// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IUniswapV3.sol";
import "./lib/TickMath.sol";

/**
 * @title  PoolRoundOracle
 * @notice Reads a Uniswap v3 pool's own TWAP for PoolRounds.
 *
 * @dev    The rules are PoolOracleResolver's, carried over rather than
 *         imported: the resolver is a contract with roles and a market it
 *         settles, its helpers are internal, and the task forbids touching it.
 *         What is copied, with the resolver's line numbers at the time of
 *         copying (contracts/src/PoolOracleResolver.sol):
 *
 *           - exit window = duration / 5, floored at 30 s, capped at 300 s (:372-377);
 *           - anchor = the last window / 3 seconds of that window (:114, :402-403);
 *           - window average vs anchor average beyond 200 bps is a permanent
 *             refund (:116, :344-346);
 *           - observe() reverting 'OLD' is permanent ("history gone"), any other
 *             failure is "try later" (:418-431);
 *           - mean tick floored toward minus infinity and range-checked (:473-484);
 *           - tick to a WAD quote of the non-WETH token in WETH (:498-510);
 *           - spread in bps against the mean of the two (:512-516).
 *
 *         From contracts/src/PoolMarketFactory.sol (the listing gate):
 *
 *           - wethDepth: WETH against in-range liquidity, L * sqrt(P) or L / sqrt(P) (:275-284);
 *           - canServeWindow: one observe() of the window ending now (:287-298).
 *
 *         What differs: the caller passes absolute timestamps instead of ages,
 *         and any number of them go into ONE observe() call. PoolRounds reads the
 *         strike window and the exit window together when the strike was not
 *         fixed separately, and a second observe() would be a second binary
 *         search over the ring on a real pool.
 */
library PoolRoundOracle {
    uint256 internal constant TWAP_WINDOW_CAP = 5 minutes;
    uint256 internal constant MIN_TWAP_WINDOW = 30 seconds;
    uint256 internal constant ANCHOR_FRACTION = 3;
    uint256 internal constant MAX_SPREAD_BPS = 200;

    enum Status {
        OK,
        HISTORY_GONE, // observe() reverted 'OLD': the ring will never reach back again
        UNREADABLE // any other failure: may pass later
    }

    /// A pool reported a mean tick outside Uniswap's own tick range.
    error TickOutOfPoolRange(int56 meanTick);

    /// @dev PoolOracleResolver._twapWindowFor, same numbers.
    function exitWindowFor(uint256 duration) internal pure returns (uint256) {
        uint256 scaled = duration / 5;
        if (scaled > TWAP_WINDOW_CAP) return TWAP_WINDOW_CAP;
        if (scaled < MIN_TWAP_WINDOW) return MIN_TWAP_WINDOW;
        return scaled;
    }

    /// @dev The anchor sub-window of the exit window, at least one second.
    function anchorWindowFor(uint256 exitWindow) internal pure returns (uint256 a) {
        a = exitWindow / ANCHOR_FRACTION;
        if (a == 0) a = 1;
    }

    /**
     * @notice Cumulative ticks and cumulative seconds-per-liquidity at each of
     *         `timestamps`, in one observe() call.
     * @dev    Every timestamp must already be in the past or present; a future
     *         one is UNREADABLE, never a refund, because a refund cannot be
     *         undone and "not yet" must mean "wait". An age that does not fit
     *         uint32 is HISTORY_GONE, as in the resolver.
     */
    function cumulativesAt(IUniswapV3Pool pool, uint256[] memory timestamps)
        internal
        view
        returns (Status status, int56[] memory cumulatives, uint160[] memory splCumulatives)
    {
        uint32[] memory secondsAgos = new uint32[](timestamps.length);
        for (uint256 i = 0; i < timestamps.length; i++) {
            if (timestamps[i] > block.timestamp) return (Status.UNREADABLE, cumulatives, splCumulatives);
            uint256 age = block.timestamp - timestamps[i];
            if (age > type(uint32).max) return (Status.HISTORY_GONE, cumulatives, splCumulatives);
            // safe: bounds-checked against uint32 on the line above.
            // forge-lint: disable-next-line(unsafe-typecast)
            secondsAgos[i] = uint32(age);
        }
        try pool.observe(secondsAgos) returns (int56[] memory c, uint160[] memory spl) {
            if (c.length != timestamps.length || spl.length != timestamps.length) {
                return (Status.UNREADABLE, cumulatives, splCumulatives);
            }
            return (Status.OK, c, spl);
        } catch Error(string memory reason) {
            // Uniswap's own 'OLD': the ring does not reach the oldest point and
            // never will again. Anything else with a reason is not proof of that.
            if (keccak256(bytes(reason)) == keccak256("OLD")) {
                return (Status.HISTORY_GONE, cumulatives, splCumulatives);
            }
            return (Status.UNREADABLE, cumulatives, splCumulatives);
        } catch {
            // No reason at all (panic, custom error, out of gas inside the pool).
            return (Status.UNREADABLE, cumulatives, splCumulatives);
        }
    }

    /**
     * @dev WETH depth the pool actually carried over a window: the harmonic-mean
     *      in-range liquidity of the window (Uniswap's OracleLibrary.consult:
     *      window << 128 / delta of secondsPerLiquidityCumulativeX128) valued at
     *      the window's mean tick, with the wethDepth formula. The accumulator is
     *      uint160 and wraps, so the delta is taken unchecked, as Uniswap does.
     *      A window with no in-range liquidity accrues as liquidity 1, so it comes
     *      out as a depth of (almost) nothing. A delta of zero cannot come from a
     *      real pool; it is read as zero depth, never as unlimited depth.
     */
    function windowDepth(uint160 splStart, uint160 splEnd, uint256 window, int24 tick, bool wethIsToken0)
        internal
        pure
        returns (uint256)
    {
        uint160 delta;
        unchecked {
            delta = splEnd - splStart;
        }
        if (delta == 0) return 0;
        return depthAt((window << 128) / delta, TickMath.getSqrtRatioAtTick(tick), wethIsToken0);
    }

    /**
     * @dev Mean tick between two cumulatives `window` seconds apart. The floor
     *      adjustment is Uniswap's (Solidity truncates toward zero, which would
     *      make every negative mean one tick high). The range check is the
     *      resolver's: int56 -> int24 wraps silently and can land back inside
     *      the range with a wrong price.
     */
    function meanTick(int56 cumStart, int56 cumEnd, uint256 window) internal pure returns (int24) {
        int56 delta = cumEnd - cumStart;
        // safe: window is at most max(TWAP_WINDOW_CAP, strike window of at most 600 s) at every call site.
        // forge-lint: disable-next-line(unsafe-typecast)
        int56 w = int56(uint56(window));
        int56 mean = delta / w;
        if (delta < 0 && delta % w != 0) mean--;
        if (mean < TickMath.MIN_TICK || mean > TickMath.MAX_TICK) revert TickOutOfPoolRange(mean);
        // safe: bounds-checked against the tick range on the line above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return int24(mean);
    }

    /**
     * @dev One unit (1e18) of the pool's non-WETH token, quoted in WETH. Uniswap's
     *      OracleLibrary.getQuoteAtTick for a WETH quote and a 1e18 base, as in
     *      PoolOracleResolver._quoteWad. The orientation is passed in because
     *      PoolRounds stores it when the pool is listed.
     */
    function quoteWad(bool wethIsToken0, int24 tick) internal pure returns (uint256) {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
        bool baseIsToken0 = !wethIsToken0;
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            return baseIsToken0 ? Math.mulDiv(ratioX192, 1e18, 1 << 192) : Math.mulDiv(1 << 192, 1e18, ratioX192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
        return baseIsToken0 ? Math.mulDiv(ratioX128, 1e18, 1 << 128) : Math.mulDiv(1 << 128, 1e18, ratioX128);
    }

    /**
     * @dev PoolMarketFactory.wethDepth: the WETH reserve implied by in-range
     *      liquidity and the current price (a real balance for a full-range
     *      position, an upper bound for a concentrated one), through a 512-bit
     *      mulDiv because L * sqrtPriceX96 can overflow uint256.
     */
    function wethDepth(IUniswapV3Pool pool, bool wethIsToken0) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        return depthAt(uint256(pool.liquidity()), sqrtPriceX96, wethIsToken0);
    }

    /// @dev The wethDepth formula for a given liquidity and price.
    function depthAt(uint256 l, uint160 sqrtPriceX96, bool wethIsToken0) internal pure returns (uint256) {
        if (sqrtPriceX96 == 0) return 0;
        uint256 q96 = 1 << 96;
        return wethIsToken0
            ? Math.mulDiv(l, q96, sqrtPriceX96)  // x = L / sqrt(P), WETH is token0
            : Math.mulDiv(l, sqrtPriceX96, q96); // y = L * sqrt(P), WETH is token1
    }

    /// @dev PoolMarketFactory.canServeWindow: the pool can price a window ending now, `window` long.
    function canServeWindow(IUniswapV3Pool pool, uint256 window) internal view returns (bool) {
        if (window > type(uint32).max) return false;
        uint32[] memory secondsAgos = new uint32[](2);
        // safe: bounds-checked against uint32 on the line above.
        // forge-lint: disable-next-line(unsafe-typecast)
        secondsAgos[0] = uint32(window);
        secondsAgos[1] = 0;
        try pool.observe(secondsAgos) returns (int56[] memory, uint160[] memory) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev PoolOracleResolver._spread: difference in bps of the mean of the two.
    function spreadBps(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0 || b == 0) return 10_000;
        uint256 diff = a > b ? a - b : b - a;
        return (diff * 10_000) / ((a + b) / 2);
    }
}
