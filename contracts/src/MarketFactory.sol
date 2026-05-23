// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./OrderbookMarket.sol";
import "./LiquidityPool.sol";
import "./FeeDistributor.sol";
import "./ReferralRegistry.sol";

/**
 * @title MarketFactory
 * @notice Creates OrderbookMarket instances and authorizes them on the shared
 *         LP vault, FeeDistributor, and ReferralRegistry in one transaction.
 *         Keeper calls createMarket() every N minutes.
 */
contract MarketFactory is Ownable {

    // ── CONFIG ─────────────────────────────────────────────
    address public immutable usdc;
    address public immutable resolver;
    address public immutable feeDistributor;
    address public immutable referralRegistry;
    address public immutable multisig;
    address public immutable liquidityPool;

    // feedId → list of active markets
    mapping(bytes32 => address[]) public activeMarkets;

    uint256[] public allowedDurations;

    mapping(bytes32 => bool) public allowedFeeds;
    bytes32[] public feedIds;

    event MarketCreated(
        address indexed market,
        bytes32 indexed feedId,
        uint256 duration,
        uint256 timestamp
    );

    constructor(
        address _usdc,
        address _resolver,
        address _feeDistributor,
        address _referralRegistry,
        address _multisig,
        address _liquidityPool
    ) Ownable(msg.sender) {
        require(_usdc != address(0) && _resolver != address(0)
             && _feeDistributor != address(0) && _referralRegistry != address(0)
             && _multisig != address(0) && _liquidityPool != address(0), "zero address");
        usdc             = _usdc;
        resolver         = _resolver;
        feeDistributor   = _feeDistributor;
        referralRegistry = _referralRegistry;
        multisig         = _multisig;
        liquidityPool    = _liquidityPool;

        allowedDurations.push(5 minutes);
        allowedDurations.push(15 minutes);
        allowedDurations.push(1 hours);
        allowedDurations.push(4 hours);
        allowedDurations.push(24 hours);
    }

    function createMarket(
        bytes32 feedId,
        uint256 duration
    ) external returns (address market) {
        require(msg.sender == resolver || msg.sender == owner(), "unauthorized");
        require(allowedFeeds[feedId], "feed not whitelisted");
        require(_isDurationAllowed(duration), "duration not allowed");

        OrderbookMarket m = new OrderbookMarket(
            usdc,
            resolver,
            liquidityPool,
            feeDistributor,
            referralRegistry,
            multisig,
            feedId,
            duration
        );

        market = address(m);
        activeMarkets[feedId].push(market);

        // Authorize this market on shared infra (one tx, atomic).
        LiquidityPool   (liquidityPool)   .authorizeMarket(market);
        FeeDistributor  (feeDistributor)  .authorizeMarket(market);
        ReferralRegistry(referralRegistry).authorizeMarket(market);

        emit MarketCreated(market, feedId, duration, block.timestamp);
    }

    function addFeed(bytes32 feedId) external onlyOwner {
        allowedFeeds[feedId] = true;
        feedIds.push(feedId);
    }

    function removeFeed(bytes32 feedId) external onlyOwner {
        allowedFeeds[feedId] = false;
    }

    function getActiveMarkets(bytes32 feedId) external view returns (address[] memory) {
        return activeMarkets[feedId];
    }

    function getAllFeedIds() external view returns (bytes32[] memory) {
        return feedIds;
    }

    function _isDurationAllowed(uint256 dur) internal view returns (bool) {
        for (uint i = 0; i < allowedDurations.length; i++) {
            if (allowedDurations[i] == dur) return true;
        }
        return false;
    }
}
