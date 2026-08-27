// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
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
    /// @notice Protocol admin: pauses markets, owns the fee. NOT immutable.
    ///         It used to be, on this contract and on every market clone, with
    ///         no setter anywhere - which made "launch behind an EOA and move
    ///         to a Safe once there is money worth protecting" impossible, and
    ///         made a lost key a full protocol redeploy.
    address public multisig;
    address public immutable liquidityPool;

    /// @notice The OrderbookMarket every market is an EIP-1167 clone of.
    ///         Deployed by this contract's own constructor rather than passed
    ///         in, so that OrderbookMarket.factory (which it takes from
    ///         msg.sender) resolves to this factory — that immutable is what
    ///         gates both pauseByFactory() and initialize() on every clone.
    address public immutable marketImplementation;

    // feedId → list of active markets
    mapping(bytes32 => address[]) public activeMarkets;

    /// @notice Markets this factory created. LiquidityPool checks it before
    ///         granting a market access to pooled funds.
    mapping(address => bool) public isMarket;

    /// @notice Feeds where trading is stopped. Set by pauseMarketsForFeed and
    ///         checked by createMarket, so the keeper's next tick cannot undo
    ///         an emergency stop by rolling a fresh market - which is what
    ///         happened before, making the stop worth at most a few minutes.
    mapping(bytes32 => bool) public feedPaused;

    // ── PROTOCOL FEE ───────────────────────────────────────
    /// @notice Fee applied to markets created from here on, in bps.
    ///
    ///         This lived on each market clone, together with a 48h timelock.
    ///         No clone ever lived that long - the longest market runs 24h and
    ///         is replaced at duration/2 - so applyNewFee could never be
    ///         reached on any of them and the fee was permanently stuck at 0.
    ///         On the factory the timelock is against something permanent, and
    ///         markets take a snapshot of the fee at creation so an open
    ///         position always settles on the terms it was opened under.
    uint256 public feeBps;
    uint256 public pendingFeeBps;
    uint256 public feeChangeAvailableAt;
    uint256 public constant FEE_TIMELOCK = 48 hours;
    uint256 public constant FEE_MAX      = 100;        // max 1%

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
    event MultisigChanged   (address indexed previous, address indexed current);
    event FeedPaused        (bytes32 indexed feedId, address indexed by);
    event FeedUnpaused      (bytes32 indexed feedId);
    event FeeChangeProposed (uint256 newFeeBps, uint256 availableAt);
    event FeeChanged        (uint256 newFeeBps);
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
        feeBps           = 0;
        liquidityPool    = _liquidityPool;

        // Deploy the clone target once, here. Passing zeroed per-instance
        // config leaves it permanently initialized (OrderbookMarket._init
        // runs in the constructor), so nobody can call initialize() on the
        // implementation itself.
        marketImplementation = address(new OrderbookMarket(
            _usdc,
            _resolver,
            _liquidityPool,
            _feeDistributor,
            _referralRegistry,
            _multisig,
            bytes32(0),
            0
        ));

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
        // Without this the emergency stop is cosmetic: pauseMarketsForFeed
        // freezes the markets that exist right now, and the keeper's cron
        // replaces them minutes later.
        require(!feedPaused[feedId],  "feed paused");
        require(_isDurationAllowed(duration), "duration not allowed");

        bytes32 slot = keccak256(abi.encodePacked(feedId, duration));
        require(
            lastCreatedAt[slot] == 0 || block.timestamp >= lastCreatedAt[slot] + MIN_CREATE_INTERVAL,
            "duplicate market slot"
        );
        lastCreatedAt[slot] = block.timestamp;

        // Sprint 5.6: was `new OrderbookMarket(...)` — a full ~3.85M-gas
        // contract deployment per market. At the keeper's rollover cadence
        // (a fresh market per feed × duration every duration/2) that was the
        // single largest running cost of the protocol, burning gas at a rate
        // set by the market matrix rather than by user activity. An EIP-1167
        // clone costs ~45k instead, since the 16.8kB of runtime code is
        // deployed once (marketImplementation) and shared by delegatecall.
        // Per-instance config moves into initialize() — see the PER-INSTANCE
        // CONFIG note in OrderbookMarket.
        market = Clones.clone(marketImplementation);
        // Admin and fee are passed in rather than baked into the clone's code,
        // so both can change without redeploying. The market keeps whatever it
        // is given here for its whole (short) life.
        OrderbookMarket(market).initialize(feedId, duration, multisig, feeBps);

        activeMarkets[feedId].push(market);
        isMarket[market] = true;

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
        // Order matters: stop new markets first, then freeze the live ones.
        // The flag is the part that actually holds, since the loop only ever
        // covers markets that already exist.
        feedPaused[feedId] = true;
        emit FeedPaused(feedId, msg.sender);

        address[] storage list = activeMarkets[feedId];
        for (uint256 i = 0; i < list.length; i++) {
            try OrderbookMarket(list[i]).pauseByFactory() {} catch {}
        }
    }

    /// @notice Resume market creation on a feed. Owner only, deliberately
    ///         asymmetric with pauseMarketsForFeed: a low-trust hot wallet may
    ///         stop trading when an oracle misbehaves, but restarting it is a
    ///         judgement call that belongs to the multisig. Individual markets
    ///         paused by the sweep above still need their own unpause.
    function unpauseFeed(bytes32 feedId) external onlyOwner {
        feedPaused[feedId] = false;
        emit FeedUnpaused(feedId);
    }

    /// @notice Move protocol admin, e.g. from the launch EOA to a Safe.
    ///         Markets created after this answer to the new address; markets
    ///         already open keep the old one until they expire, which is at
    ///         most one market duration.
    function setMultisig(address newMultisig) external onlyOwner {
        require(newMultisig != address(0), "zero address");
        emit MultisigChanged(multisig, newMultisig);
        multisig = newMultisig;
    }

    /// @notice Start the timelock on a protocol fee change.
    function proposeNewFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= FEE_MAX, "fee too high");
        pendingFeeBps        = newFeeBps;
        feeChangeAvailableAt = block.timestamp + FEE_TIMELOCK;
        emit FeeChangeProposed(newFeeBps, feeChangeAvailableAt);
    }

    /// @notice Apply a fee change once its timelock has run.
    function applyNewFee() external onlyOwner {
        require(feeChangeAvailableAt != 0,               "no proposal");
        require(block.timestamp >= feeChangeAvailableAt, "timelock");
        feeBps               = pendingFeeBps;
        feeChangeAvailableAt = 0;
        emit FeeChanged(feeBps);
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
