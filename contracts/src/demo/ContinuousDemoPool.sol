// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IUniswapV3.sol";
import "../lib/TickMath.sol";

/**
 * TESTNET DEMO ONLY. An immutable, deterministic price schedule, not a traded
 * Uniswap pool. Both spot and cumulative oracle reads use the same schedule.
 * The 256-step path repeats; its integral is computed in constant time, so
 * time passing never grows storage, gas, or an observation backlog. There is
 * no price setter or updater wallet. Reconstructed history is simulated too.
 */
contract ContinuousDemoPool is IUniswapV3Pool {
    uint256 public constant STEP_SECONDS = 20;
    uint256 public constant CYCLE_STEPS = 256;
    address public immutable override token0;
    address public immutable override token1;
    uint24 public constant override fee = 3000;
    uint128 public constant DEMO_LIQUIDITY = 1000 ether;
    bytes32 public immutable seed;
    int24[256] private ticks;
    int56[257] private prefix;
    uint16 private capacity = 900;

    constructor(address a, address b, bytes32 demoSeed) {
        require(block.chainid == 46630 || block.chainid == 31337, "Testnet demo only");
        require(a != address(0) && b != address(0) && a < b, "Sorted distinct tokens required");
        token0 = a;
        token1 = b;
        seed = demoSeed;
        uint256 phase = uint256(demoSeed) % 64;
        for (uint256 i; i < CYCLE_STEPS; ++i) {
            uint256 p = (i + phase) % 64;
            uint256 q = (i + phase) % 16;
            int24 longWave = int24(uint24(p <= 32 ? p : 64 - p)) * 8 - 128;
            int24 shortWave = int24(uint24(q <= 8 ? q : 16 - q)) * 4 - 16;
            int24 noise = int24(uint24(uint256(keccak256(abi.encode(demoSeed, i))) % 17)) - 8;
            ticks[i] = longWave + shortWave + noise;
            prefix[i + 1] = prefix[i] + int56(ticks[i]);
        }
    }

    function liquidity() external pure override returns (uint128) {
        return DEMO_LIQUIDITY;
    }

    function slot0() external view override returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        int24 tick = tickAt(uint32(block.timestamp));
        return (TickMath.getSqrtRatioAtTick(tick), tick, 0, capacity, capacity, 0, true);
    }

    function tickAt(uint32 timestamp) public view returns (int24) {
        return ticks[(uint256(timestamp) / STEP_SECONDS) % CYCLE_STEPS];
    }

    function cumulativeAt(uint32 timestamp) public view returns (int56) {
        uint256 steps = uint256(timestamp) / STEP_SECONDS;
        uint256 index = steps % CYCLE_STEPS;
        int56 cycles = int56(uint56(steps / CYCLE_STEPS));
        int56 sum = cycles * prefix[CYCLE_STEPS] + prefix[index];
        return
            sum * int56(uint56(STEP_SECONDS)) + int56(ticks[index]) * int56(uint56(uint256(timestamp) % STEP_SECONDS));
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        override
        returns (int56[] memory cumulativeTicks, uint160[] memory cumulativeLiquidity)
    {
        cumulativeTicks = new int56[](secondsAgos.length);
        cumulativeLiquidity = new uint160[](secondsAgos.length);
        uint32 nowTs = uint32(block.timestamp);
        for (uint256 i; i < secondsAgos.length; ++i) {
            require(secondsAgos[i] <= nowTs, "OLD");
            uint32 target = nowTs - secondsAgos[i];
            cumulativeTicks[i] = cumulativeAt(target);
            cumulativeLiquidity[i] = uint160((uint256(target) << 128) / DEMO_LIQUIDITY);
        }
    }

    function increaseObservationCardinalityNext(uint16 next) external override {
        if (next > capacity) capacity = next;
    }
}
