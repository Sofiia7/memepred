// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../src/interfaces/IUniswapV3.sol";

/**
 * The canonical-pool registry, which is the only gate that distinguishes a real
 * pool from a contract someone wrote to answer slot0() with whatever they like.
 *
 * Tests register the pools that are meant to be genuine and leave the
 * counterfeit ones out, which is exactly the distinction the real factory draws.
 */
contract MockUniswapV3Factory is IUniswapV3Factory {
    mapping(bytes32 => address) internal pools;

    /**
     * The event poolWatcher listens for, with Uniswap's exact signature and
     * topic layout.
     *
     * Not decoration: the watcher's whole job starts here, and a stand-in
     * factory that only answered getPool would let a soak run for two days
     * without ever exercising the path from PoolCreated to createMarket -
     * which is the thing the soak is supposed to prove.
     */
    event PoolCreated(
        address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool
    );

    function register(address tokenA, address tokenB, uint24 fee, address pool) external {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pools[_key(tokenA, tokenB, fee)] = pool;
        emit PoolCreated(t0, t1, fee, int24(uint24(fee) / 50), pool);
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view override returns (address) {
        return pools[_key(tokenA, tokenB, fee)];
    }

    function _key(address a, address b, uint24 fee) internal pure returns (bytes32) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encodePacked(t0, t1, fee));
    }
}
