// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The one function PoolOrderbookMarket needs from its resolver.
 *
 * Declared as an interface rather than importing PoolOracleResolver so the
 * market depends on a signature instead of on a contract - it already holds the
 * resolver as an immutable address chosen at deployment, and nothing about
 * pricing an entry requires knowing which implementation answers.
 */
interface IPoolPriceSource {
    /// @notice Current strike for a market, as a WAD price of its token in WETH.
    function spotPriceWad(bytes32 feedId) external view returns (uint256);
}
