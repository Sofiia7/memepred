// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Minimal Uniswap v3 surface, declared locally.
 *
 * The published interfaces pin `pragma solidity >=0.5.0 <0.8.0`, so they cannot
 * be remapped into this build the way RedStone's are. Only what
 * PoolOracleResolver and PoolMarketFactory actually call is declared, and every
 * signature is checked against the deployed factory on Robinhood Chain by
 * scripts/rhc/scan-pools.mjs, which reads all of them over plain eth_call.
 */
interface IUniswapV3Pool {
    /**
     * @notice Cumulative tick and liquidity values at each `secondsAgos`.
     * @dev    Reverts with 'OLD' when the oldest stored observation is newer
     *         than the requested point - i.e. when the pool's observation ring
     *         is too small for the window. That revert is a supported outcome
     *         here, not a failure: it means the match cannot be priced, and the
     *         caller turns it into MatchUnpriceable rather than a guessed price.
     */
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /// @notice In-range liquidity. Zero means nothing is quotable at any price.
    function liquidity() external view returns (uint128);

    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);

    /// @notice Permissionless: anyone may pay to grow the observation ring.
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

interface IUniswapV3Factory {
    /**
     * @notice The canonical pool for a token pair and fee tier, or address(0).
     * @dev    This is the whole defence against a counterfeit pool: anyone can
     *         deploy a contract answering slot0() and observe() with whatever
     *         they like, but only the factory's own registry can vouch that a
     *         given address is the pool it claims to be.
     */
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}
