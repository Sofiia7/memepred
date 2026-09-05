// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/lib/TickMath.sol";
import "./fixtures/TickMathVectors.sol";

/**
 * Checks the vendored TickMath against Uniswap's own deployed code.
 *
 * src/lib/TickMath.sol is a hand-transcribed copy: v3-core pins solc <0.8 and
 * cannot be compiled into this build, so there was no way to reference it. The
 * twenty magic constants in the ladder are the entire implementation, and a
 * wrong hex digit in any of them would not revert - it would return a slightly
 * wrong price forever, on the contract that decides who wins a bet.
 *
 * So none of the expectations here were written by whoever transcribed the
 * file. Every Uniswap v3 pool stores slot0().tick and slot0().sqrtPriceX96
 * together and keeps them consistent by construction, so 224 live pools on
 * Robinhood Chain supply 224 independent (input, output) pairs. If the copy
 * drifted from the original, these stop bracketing.
 */
contract TickMathTest is Test, TickMathVectors {
    function setUp() public {
        _loadVectors();
    }

    /**
     * The invariant every initialised v3 pool satisfies on chain:
     *
     *     getSqrtRatioAtTick(tick) <= sqrtPriceX96 < getSqrtRatioAtTick(tick+1)
     *
     * The tick is defined as the floor of log_1.0001(price), so the pool's own
     * price must sit inside the tick's half-open range. Any transcription error
     * shifts our ladder off Uniswap's and breaks the bracket.
     */
    function test_BracketsEveryLivePoolPrice() public view {
        uint256 n = vecTick.length;
        assertGt(n, 200, "fixture should carry the full scan");

        for (uint256 i = 0; i < n; i++) {
            int24 tick = vecTick[i];
            uint160 sqrtPriceX96 = vecSqrt[i];

            uint160 lo = TickMath.getSqrtRatioAtTick(tick);
            assertLe(lo, sqrtPriceX96, string.concat("lower bound broken at tick ", vm.toString(tick)));

            if (tick < TickMath.MAX_TICK) {
                uint160 hi = TickMath.getSqrtRatioAtTick(tick + 1);
                assertLt(sqrtPriceX96, hi, string.concat("upper bound broken at tick ", vm.toString(tick)));
            }
        }
    }

    /// The two published boundary values, which pin both ends of the ladder.
    function test_BoundsMatchUniswapConstants() public pure {
        assertEq(TickMath.getSqrtRatioAtTick(TickMath.MIN_TICK), TickMath.MIN_SQRT_RATIO, "MIN_SQRT_RATIO");
        assertEq(TickMath.getSqrtRatioAtTick(TickMath.MAX_TICK), TickMath.MAX_SQRT_RATIO, "MAX_SQRT_RATIO");
    }

    /// Tick 0 is price 1.0, i.e. exactly 2^96 in Q64.96.
    function test_TickZeroIsUnity() public pure {
        assertEq(TickMath.getSqrtRatioAtTick(0), uint160(1) << 96);
    }

    /**
     * Reciprocity: sqrt(1.0001^-t) * sqrt(1.0001^t) == 1, so the two ratios must
     * multiply back to 2^192 give or take the rounding-up the downcast does.
     * Catches a constant that is wrong in a way symmetric ticks would hide.
     */
    function testFuzz_PositiveAndNegativeTicksAreReciprocal(int24 tick) public pure {
        tick = int24(bound(int256(tick), 1, int256(TickMath.MAX_TICK)));

        uint256 up = TickMath.getSqrtRatioAtTick(tick);
        uint256 down = TickMath.getSqrtRatioAtTick(-tick);
        uint256 product = up * down;
        uint256 unity = uint256(1) << 192;

        // Both ends round up, so the product lands at or just above 2^192.
        // The slack scales with the larger factor, which is what a Q64.96
        // round-up is worth at that magnitude.
        assertGe(product, unity - (up + down));
        assertLe(product, unity + 2 * (up + down));
    }

    /// Monotonicity across the whole range: a higher tick is a higher price.
    function testFuzz_StrictlyIncreasing(int24 tick) public pure {
        tick = int24(bound(int256(tick), int256(TickMath.MIN_TICK), int256(TickMath.MAX_TICK) - 1));
        assertLt(TickMath.getSqrtRatioAtTick(tick), TickMath.getSqrtRatioAtTick(tick + 1));
    }

    function test_RevertsOutsideRange() public {
        vm.expectRevert(TickMath.TickOutOfRange.selector);
        this.callGetSqrtRatioAtTick(TickMath.MAX_TICK + 1);

        vm.expectRevert(TickMath.TickOutOfRange.selector);
        this.callGetSqrtRatioAtTick(TickMath.MIN_TICK - 1);
    }

    function callGetSqrtRatioAtTick(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(tick);
    }
}
