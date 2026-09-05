// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./LiquidityPool.sol";

/**
 * @title  PoolLiquidityPool
 * @notice LiquidityPool for a chain that stakes an eighteen-decimal token.
 *
 * @dev    The neighbour of LiquidityPool, not a replacement: same storage, same
 *         entrypoints, same events, same everything except the one number that
 *         was denominated in dollars.
 *
 *         `MIN_DEPOSIT` is `50e6` upstream, written and meant as fifty USDC. On
 *         a WETH-staking chain the same integer is 0.00000000005 WETH, so the
 *         floor silently ceases to exist. Measured on Robinhood Chain testnet
 *         before this contract was written: `MIN_DEPOSIT()` read back as
 *         0.00000000005, and all twenty Genesis NFTs together cost
 *         0.000000001 WETH.
 *
 *         That is the whole attack. `deposit(assets, receiver)` mints a Genesis
 *         NFT to an arbitrary caller-supplied `receiver` on their first deposit,
 *         only twenty exist, and each carries 1.5x fee weight for the life of
 *         the vault. With a real floor, sweeping all twenty costs 1,000 USDC;
 *         without one it costs dust, after which the same actor deposits real
 *         capital into those twenty addresses and collects 1.5x on it forever
 *         while every honest LP is diluted. Nothing reverts and nothing looks
 *         wrong on chain.
 *
 *         The floor here is ten times MIN_BET, which puts all twenty Genesis
 *         NFTs at 1 WETH - a barrier of the same shape as the one 50 USDC gives
 *         on Base, expressed in what this chain actually stakes.
 */
contract PoolLiquidityPool is LiquidityPool {
    /// @notice Ten times PoolOrderbookMarket.MIN_BET.
    uint256 public constant MIN_DEPOSIT_WEI = 0.05 ether;

    constructor(IERC20 _weth, address _genesisNFT) LiquidityPool(_weth, _genesisNFT) {}

    function MIN_DEPOSIT() public view virtual override returns (uint256) {
        return MIN_DEPOSIT_WEI;
    }
}
