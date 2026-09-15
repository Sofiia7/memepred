// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./LiquidityPool.sol";

interface IPoolMarketMetadata {
    function feedId() external view returns (bytes32);
}

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
    /// @notice All durations of one price source share this exposure ceiling.
    /// A per-market 5% cap alone lets the same token consume 15% through the
    /// 60/300/900 second markets before the vault's global 10% cap catches it.
    uint256 public constant MAX_FEED_EXPOSURE_BPS = 500;
    mapping(bytes32 => uint256) public feedExposure;

    constructor(IERC20 _weth, address _genesisNFT) LiquidityPool(_weth, _genesisNFT) {}

    function MIN_DEPOSIT() public view virtual override returns (uint256) {
        return MIN_DEPOSIT_WEI;
    }

    function tryMatch(uint256 orderId, uint256 amount, bool userIsUp, uint256 matchId)
        public
        virtual
        override
        returns (uint256 matchedAmount)
    {
        // Declined, not reverted. PoolMarketFactory.createMarket no longer
        // authorizes new markets on this vault - LP access is a separate
        // owner action now - so an unreviewed market is the ordinary case,
        // not an attack. super.tryMatch() would revert here via
        // onlyAuthorizedMarket, and _tryLpMatch calls this with no try/catch,
        // which turned every order not fully filled by the PvP queue into a
        // guaranteed-revert placeBet the moment the vault held any assets -
        // including plain maker orders on an empty book. Same reasoning as
        // the paused() early return this mirrors.
        if (!isAuthorizedMarket[msg.sender]) return 0;

        bytes32 feed = IPoolMarketMetadata(msg.sender).feedId();
        uint256 feedCap = (totalAssets() * MAX_FEED_EXPOSURE_BPS) / 10_000;
        uint256 feedAvail = feedCap > feedExposure[feed] ? feedCap - feedExposure[feed] : 0;
        if (feedAvail == 0) return 0;

        uint256 cappedAmount = amount < feedAvail ? amount : feedAvail;
        matchedAmount = super.tryMatch(orderId, cappedAmount, userIsUp, matchId);
        if (matchedAmount > 0) feedExposure[feed] += matchedAmount;
    }

    function onMatchRefunded(uint256 matchId) public virtual override {
        bytes32 feed = IPoolMarketMetadata(msg.sender).feedId();
        uint256 amount = activeMatches[msg.sender][matchId].amount;
        super.onMatchRefunded(matchId);
        feedExposure[feed] -= amount;
    }

    function onMatchSettled(uint256 matchId, bool upWon) public virtual override {
        bytes32 feed = IPoolMarketMetadata(msg.sender).feedId();
        uint256 amount = activeMatches[msg.sender][matchId].amount;
        super.onMatchSettled(matchId, upWon);
        feedExposure[feed] -= amount;
    }
}
