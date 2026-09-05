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

    function register(address tokenA, address tokenB, uint24 fee, address pool) external {
        pools[_key(tokenA, tokenB, fee)] = pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view override returns (address) {
        return pools[_key(tokenA, tokenB, fee)];
    }

    function _key(address a, address b, uint24 fee) internal pure returns (bytes32) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encodePacked(t0, t1, fee));
    }
}
