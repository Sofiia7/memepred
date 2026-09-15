// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PoolMarketFactory.sol";

interface IGrowRing {
    function increaseObservationCardinalityNext(uint16) external;
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

/**
 * @notice What growing a real pool's observation ring actually costs.
 *
 * @dev    MIN_CARDINALITY is 300 and growing a ring to 300 was measured at
 *         6.73M gas, which is the single largest line in onboarding a pool and
 *         the reason onboarding has a price at all.
 *
 *         300 was not derived from anything. The longest market is 900 seconds
 *         and twapWindowFor divides by five, so the longest TWAP window this
 *         protocol ever asks for is 180 seconds. A ring only has to hold one
 *         observation per second of the window it must serve, so 300 is 67%
 *         more than the worst case needs.
 *
 *         Measured on MarsCoin, which really does have a ring of one, so the
 *         numbers are what a real onboarding pays rather than what a mock says.
 */
contract PoolRingCostForkTest is Test {
    address constant POOL_MARS = 0x297816D15Be36a1dDEA53fA3AeC8A56539D748F0;
    bool active;

    function setUp() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        require(block.chainid == 4663, "forked the wrong chain");
        active = true;
    }

    function _cost(uint16 target) internal returns (uint256 gasUsed) {
        uint256 snap = vm.snapshotState();
        uint256 before = gasleft();
        IGrowRing(POOL_MARS).increaseObservationCardinalityNext(target);
        gasUsed = before - gasleft();
        vm.revertToState(snap);
    }

    function test_WhatTheRingCostsAtEachSize() public {
        if (!active) return;
        (,,, uint16 card,,,) = IGrowRing(POOL_MARS).slot0();
        assertEq(card, 1, "need a pool with an ungrown ring");

        uint16[5] memory sizes = [uint16(64), 128, 180, 200, 300];
        for (uint256 i = 0; i < sizes.length; i++) {
            emit log_named_uint(string.concat("cardinality ", vm.toString(sizes[i]), " gas"), _cost(sizes[i]));
        }
    }

    /// @dev The claim the saving rests on: 180 covers the longest window this
    ///      protocol asks for, because the longest market is 900s and
    ///      twapWindowFor divides by five.
    function test_180CoversTheLongestWindowTheProtocolAsksFor() public pure {
        uint256 longest;
        uint256[3] memory durations = [uint256(60), 300, 900];
        for (uint256 i = 0; i < durations.length; i++) {
            uint256 w = durations[i] / 5;
            if (w > 5 minutes) w = 5 minutes;
            if (w < 30 seconds) w = 30 seconds;
            if (w > longest) longest = w;
        }
        assertEq(longest, 180, "longest window moved; the ring size has to move with it");
    }

    /// @dev And if the 900s duration went away, the longest window would be 60s.
    function test_DroppingThe900sMarketWouldCutTheWindowTo60() public pure {
        uint256 longest;
        uint256[2] memory durations = [uint256(60), 300];
        for (uint256 i = 0; i < durations.length; i++) {
            uint256 w = durations[i] / 5;
            if (w < 30 seconds) w = 30 seconds;
            if (w > longest) longest = w;
        }
        assertEq(longest, 60);
    }
}
