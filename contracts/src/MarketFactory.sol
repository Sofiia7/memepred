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

    /// @notice Defense-in-depth cooldown against duplicate markets. The
    ///         off-chain keeper (marketCreator.ts) already dedupes by
    ///         querying its own DB before calling createMarket, but that DB
    ///         can be stale or desynced from chain state — this guards
    ///         on-chain against two live markets ever existing for the same
    ///         (feedId, duration) back-to-back. Kept short (well under the
    ///         shortest allowed duration's 50%-early-rollover point) so it
    ///         never fights the intended "create the next market once the
    ///         current one is halfway to close" rollover strategy.
    uint256 public constant MIN_CREATE_INTERVAL = 60 seconds;
    mapping(bytes32 => uint256) public lastCreatedAt; // key = keccak256(feedId, duration)

    mapping(bytes32 => bool) public allowedFeeds;
    bytes32[] public feedIds;
    mapping(bytes32 => bool) private _feedSeen; // tracks membership in feedIds[] to prevent dup pushes on re-add

    /// @notice Low-trust hot wallet allowed to call `pauseMarketsForFeed`
    ///         (e.g. the keeper) when an oracle feed goes stale. Cannot unpause;
    ///         unpause still requires the multisig acting on each market.
    address public emergencyPauser;

    /// @notice Low-trust hot wallet allowed to call `createMarket` (e.g. the
    ///         keeper, on a cron). It can only spin up markets for already
    ///         whitelisted feeds with allowed durations — no fund access, no
    ///         ability to change config. This avoids requiring the multisig to
    ///         sign a tx every N minutes just to keep fresh markets rolling.
    address public marketCreator;

    event MarketCreated(
        address indexed market,
        bytes32 indexed feedId,
        uint256 duration,
        uint256 timestamp
    );
    event EmergencyPauserSet(address indexed pauser);
    event MarketCreatorSet(address indexed creator);

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
        require(
            msg.sender == resolver || msg.sender == owner() || msg.sender == marketCreator,
            "unauthorized"
        );
        require(allowedFeeds[feedId], "feed not whitelisted");
        require(_isDurationAllowed(duration), "duration not allowed");

        bytes32 slot = keccak256(abi.encodePacked(feedId, duration));
        require(
            lastCreatedAt[slot] == 0 || block.timestamp >= lastCreatedAt[slot] + MIN_CREATE_INTERVAL,
            "duplicate market slot"
        );
        lastCreatedAt[slot] = block.timestamp;

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
        if (!_feedSeen[feedId]) {
            _feedSeen[feedId] = true;
            feedIds.push(feedId);
        }
    }

    function removeFeed(bytes32 feedId) external onlyOwner {
        allowedFeeds[feedId] = false;
    }

    /// @notice Pause all currently active markets for a given feed in one call.
    ///         Callable by owner (multisig) OR by the dedicated emergencyPauser
    ///         hot wallet (typically the keeper) when the feed is detected as
    ///         stale. Bounded by feed market count.
    function pauseMarketsForFeed(bytes32 feedId) external {
        require(
            msg.sender == owner() || msg.sender == emergencyPauser,
            "not authorized"
        );
        address[] storage list = activeMarkets[feedId];
        for (uint256 i = 0; i < list.length; i++) {
            try OrderbookMarket(list[i]).pauseByFactory() {} catch {}
        }
    }

    /// @notice Owner-only setter for the low-trust emergency pauser hot wallet.
    ///         Rotate this when the keeper key is rotated.
    function setEmergencyPauser(address pauser) external onlyOwner {
        emergencyPauser = pauser;
        emit EmergencyPauserSet(pauser);
    }

    /// @notice Owner-only setter for the low-trust market-creator hot wallet
    ///         (typically the keeper). Rotate alongside the keeper key.
    function setMarketCreator(address creator) external onlyOwner {
        marketCreator = creator;
        emit MarketCreatorSet(creator);
    }

    function getActiveMarkets(bytes32 feedId) external view returns (address[] memory) {
        return activeMarkets[feedId];
    }

    /// @notice Returns only currently-enabled feeds (Audit fix S5, 2026-07-05:
    ///         previously returned every feed ever added, including removed
    ///         ones, forcing every caller — notably the off-chain keeper's
    ///         marketCreator.ts — to separately re-check allowedFeeds()).
    function getAllFeedIds() external view returns (bytes32[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < feedIds.length; i++) {
            if (allowedFeeds[feedIds[i]]) count++;
        }
        bytes32[] memory active = new bytes32[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < feedIds.length; i++) {
            if (allowedFeeds[feedIds[i]]) active[idx++] = feedIds[i];
        }
        return active;
    }

    function _isDurationAllowed(uint256 dur) internal view returns (bool) {
        for (uint i = 0; i < allowedDurations.length; i++) {
            if (allowedDurations[i] == dur) return true;
        }
        return false;
    }
}
