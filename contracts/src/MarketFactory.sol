// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./OrderbookMarket.sol";

/**
 * @title MarketFactory
 * @notice Creates OrderbookMarket instances via direct deployment.
 *         Keeper calls createMarket() every N minutes.
 */
contract MarketFactory is Ownable {

    // ── CONFIG ─────────────────────────────────────────────
    address public immutable usdc;
    address public immutable resolver;
    address public immutable feeDistributor;
    address public immutable multisig;
    address public immutable liquidityPool;

    // feedId → list of active markets
    mapping(bytes32 => address[]) public activeMarkets;

    // Allowed durations in seconds
    uint256[] public allowedDurations;

    // Whitelisted coins
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
        address _multisig,
        address _liquidityPool
    ) Ownable(msg.sender) {
        usdc           = _usdc;
        resolver       = _resolver;
        feeDistributor = _feeDistributor;
        multisig       = _multisig;
        liquidityPool  = _liquidityPool;

        // Default durations
        allowedDurations.push(5 minutes);
        allowedDurations.push(15 minutes);
        allowedDurations.push(1 hours);
        allowedDurations.push(4 hours);
        allowedDurations.push(24 hours);
    }

    // ── CREATE MARKET ──────────────────────────────────────
    /**
     * @notice Create a new OrderbookMarket via direct deployment.
     * @param feedId      Pyth price feed ID
     * @param duration    Duration in seconds
     */
    function createMarket(
        bytes32 feedId,
        uint256 duration
    ) external returns (address market) {
        require(msg.sender == resolver || msg.sender == owner(), "unauthorized");
        require(allowedFeeds[feedId], "feed not whitelisted");
        require(_isDurationAllowed(duration), "duration not allowed");

        // Direct deployment (no clone pattern — OrderbookMarket uses immutables)
        OrderbookMarket m = new OrderbookMarket(
            usdc,
            resolver,
            liquidityPool,
            feeDistributor,
            multisig,
            feedId,
            duration
        );

        market = address(m);
        activeMarkets[feedId].push(market);
        emit MarketCreated(market, feedId, duration, block.timestamp);
    }

    // ── ADMIN ──────────────────────────────────────────────
    function addFeed(bytes32 feedId) external onlyOwner {
        allowedFeeds[feedId] = true;
        feedIds.push(feedId);
    }

    function removeFeed(bytes32 feedId) external onlyOwner {
        allowedFeeds[feedId] = false;
    }

    // ── VIEWS ──────────────────────────────────────────────
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
