// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Stands in for MarketFactory where a suite deploys an OrderbookMarket
 * directly instead of going through the factory.
 *
 * LiquidityPool.authorizeMarket now asks the configured factory whether the
 * address it is being handed is a market it actually created - without that,
 * the owner could authorize their own EOA and drain the pool. A directly
 * deployed market has no factory to vouch for it, so these suites supply one.
 */
contract MockMarketRegistry {
    mapping(address => bool) public isMarket;

    function register(address market) external {
        isMarket[market] = true;
    }
}
