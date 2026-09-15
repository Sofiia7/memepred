// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./PoolOrderbookMarket.sol";
import "./LiquidityPool.sol";
import "./FeeDistributor.sol";
import "./ReferralRegistry.sol";
import "./interfaces/IUniswapV3.sol";

/**
 * @title  PoolMarketFactory
 * @notice Creates PoolOrderbookMarket clones for Uniswap v3 pools, on
 *         Robinhood Chain. Permissionless, gated entirely on chain.
 *
 * @dev    A neighbour of MarketFactory, which keeps its multisig feed
 *         whitelist and keeps serving Base untouched.
 *
 *         **Why permissionless.** 496 pools a day are created on this chain
 *         (measured). A whitelist that a multisig has to sign for cannot keep
 *         up with that, and one that a hot wallet can write to is not a
 *         whitelist. So the admission rule moves into the contract, where it is
 *         the same rule for everyone and nobody has to be trusted to apply it.
 *
 *         **What the gates are actually defending against.** A pool is just an
 *         address until something vouches for it. Anyone can deploy a contract
 *         that answers slot0() and observe() with numbers of their choosing,
 *         create a market on it, and then quote whatever price wins their own
 *         bet. Gate 1 is the whole defence: the canonical v3 factory has to
 *         agree that this address is the pool for that pair and tier. The rest
 *         are about whether a genuine pool is fit to price a bet.
 */
contract PoolMarketFactory is Ownable {
    // ── CHAIN CONFIG ───────────────────────────────────────
    /// Canonical Uniswap v3 factory. The only thing that can vouch for a pool.
    IUniswapV3Factory public immutable v3Factory;
    address public immutable weth;

    address public immutable resolver;
    address public immutable feeDistributor;
    address public immutable referralRegistry;
    address public immutable liquidityPool;
    address public multisig;

    /// @notice The PoolOrderbookMarket every market is an EIP-1167 clone of.
    ///         Deployed by this contract's constructor, because
    ///         OrderbookMarket takes its `factory` immutable from msg.sender
    ///         and gates initialize() on it.
    address public immutable marketImplementation;

    // ── ADMISSION GATES ────────────────────────────────────
    /**
     * Minimum WETH depth a pool must hold.
     *
     * Depth, not the raw uint128 `liquidity()` the design doc called for.
     * Raw L is not comparable between pools: it is measured in units of
     * sqrt(token0 * token1), so its magnitude depends on the token's price
     * scale, not on how much value is in the pool. The 24h scan has pools with
     * identical L and different depth (BURGERKING at 1.36 ETH and BONK at 1.43
     * ETH both report L = 36819258015569838458222). Gating on L would admit and
     * reject pools for reasons unrelated to how hard they are to move.
     *
     * Deliberately low. The scan puts the median graduated pool at 1.5 ETH and
     * the launchpad's standard graduation at about 12.5 ETH, so 2 ETH admits
     * most of what graduates. The high bar is the keeper's, not the contract's:
     * it onboards only deep pools at its own expense, and anyone who wants a
     * market on a thinner pool may create one and pay for it themselves. Making
     * the contract enforce the keeper's threshold would take that away.
     */
    uint256 public constant MIN_POOL_WETH_DEPTH = 2 ether;

    /**
     * Observation ring capacity a pool must already have.
     *
     * 300, not the 60 the design doc specified. Uniswap writes at most one
     * observation per SECOND, so slots buy seconds, not blocks - 60 slots hold
     * 173 seconds on the busiest pool measured, against the 180 a 15-minute
     * market's exit window needs, and only 60 seconds if the pool is trading
     * every second. 300 covers the window with room for the keeper to sit out a
     * gas spike rather than settle into one.
     *
     * This is capacity, not history, which is why it is not the only gate -
     * see canServeWindow.
     */
    uint16 public constant MIN_CARDINALITY = 300;
    /// @dev Mirrors PoolOracleResolver.ENTRY_TWAP_WINDOW. A market must be
    /// able to price its first entry as well as its eventual exit.
    uint256 public constant ENTRY_TWAP_WINDOW = 60 seconds;

    /// Fee tiers a market may be created on. The 24h scan found 202 pools at
    /// 10000, 18 at 3000 and 7 at 500 - and 65 at the 100 tier, none of which
    /// held more than 10 ETH or would pass the depth gate anyway.
    mapping(uint24 => bool) public allowedFeeTier;

    uint256[] public allowedDurations;

    // ── STATE ──────────────────────────────────────────────
    /// feedId (the pool address) → markets created for it, one per duration.
    mapping(bytes32 => address[]) public activeMarkets;
    mapping(address => bool) public isMarket;
    mapping(bytes32 => bool) public feedPaused;

    /// keccak256(feedId, duration) → the market, or zero. A market has no
    /// close time and lives forever, so this is a permanent record rather than
    /// MarketFactory's rolling cooldown: with creation open to anyone, a
    /// cooldown would let a caller mint a fresh market for the same slot every
    /// minute, each one authorised against the shared LP vault.
    mapping(bytes32 => address) public marketFor;

    // ── PROTOCOL FEE ───────────────────────────────────────
    uint256 public feeBps;
    uint256 public pendingFeeBps;
    uint256 public feeChangeAvailableAt;
    uint256 public constant FEE_TIMELOCK = 48 hours;
    uint256 public constant FEE_MAX = 100; // max 1%, and it cannot be raised

    /// See MarketFactory for why the emergency sweep is bounded. Here it is
    /// slack rather than load-bearing: a pool gets one market per duration and
    /// never another, so the list is three long, not hundreds.
    uint256 public constant PAUSE_SWEEP_LIMIT = 64;

    address public emergencyPauser;

    event MarketCreated(address indexed market, bytes32 indexed feedId, uint256 duration, uint256 timestamp);
    event EmergencyPauserSet(address indexed pauser);
    event MultisigChanged(address indexed previous, address indexed current);
    event FeedPaused(bytes32 indexed feedId, address indexed by);
    event FeedUnpaused(bytes32 indexed feedId);
    event FeeChangeProposed(uint256 newFeeBps, uint256 availableAt);
    event FeeChanged(uint256 newFeeBps);
    event FeeTierSet(uint24 indexed fee, bool allowed);

    error ZeroAddress();
    error NotCanonicalPool();
    error NotAWethPair();
    error PoolTooThin(uint256 depth);
    error CardinalityTooLow(uint16 have, uint16 need);
    error FeeTierNotAllowed(uint24 fee);
    error DurationNotAllowed(uint256 duration);
    error MarketExists(address market);
    error FeedIsPaused();
    error PoolCannotServeWindow(uint256 window);

    constructor(
        address _weth,
        address _v3Factory,
        address _resolver,
        address _feeDistributor,
        address _referralRegistry,
        address _multisig,
        address _liquidityPool
    ) Ownable(msg.sender) {
        if (
            _weth == address(0) || _v3Factory == address(0) || _resolver == address(0) || _feeDistributor == address(0)
                || _referralRegistry == address(0) || _multisig == address(0) || _liquidityPool == address(0)
        ) revert ZeroAddress();

        weth = _weth;
        v3Factory = IUniswapV3Factory(_v3Factory);
        resolver = _resolver;
        feeDistributor = _feeDistributor;
        referralRegistry = _referralRegistry;
        multisig = _multisig;
        liquidityPool = _liquidityPool;
        // Permanent markets snapshot their creation fee. A non-zero launch
        // value prevents a third party from permanently occupying a slot at
        // zero before governance can complete its first timelocked change.
        feeBps = FEE_MAX;

        marketImplementation = _deployMarketImplementation(
            _weth, _resolver, _liquidityPool, _feeDistributor, _referralRegistry, _multisig
        );

        allowedDurations.push(60);
        allowedDurations.push(300);
        allowedDurations.push(900);

        allowedFeeTier[500] = true;
        allowedFeeTier[3000] = true;
        allowedFeeTier[10000] = true;
    }

    // ── CREATE ─────────────────────────────────────────────
    /**
     * @notice Create the market for (pool, duration). Anyone may call this;
     *         every condition is checked here rather than trusted to a caller.
     * @param pool      A Uniswap v3 pool paired with WETH.
     * @param duration  One of the allowed durations.
     */
    function createMarket(address pool, uint256 duration) external returns (address market) {
        bytes32 feedId = feedIdFor(pool);
        if (feedPaused[feedId]) revert FeedIsPaused();
        if (!_isDurationAllowed(duration)) revert DurationNotAllowed(duration);

        bytes32 slot = keccak256(abi.encodePacked(feedId, duration));
        if (marketFor[slot] != address(0)) revert MarketExists(marketFor[slot]);

        _assertPoolIsFit(IUniswapV3Pool(pool), duration);

        market = Clones.clone(marketImplementation);
        PoolOrderbookMarket(market).initialize(feedId, duration, multisig, feeBps);

        marketFor[slot] = market;
        activeMarkets[feedId].push(market);
        isMarket[market] = true;

        // Markets are permissionless PvP venues. LP capital is separate: its
        // owner must explicitly authorize selected factory-created markets
        // after reviewing the pool and aggregate risk.
        FeeDistributor(feeDistributor).authorizeMarket(market);
        ReferralRegistry(referralRegistry).authorizeMarket(market);

        emit MarketCreated(market, feedId, duration, block.timestamp);
    }

    /**
     * @dev Every admission rule, in one place, reverting with which one failed.
     *      Split out so the same checks can be read without sending a
     *      transaction - see canCreateMarket.
     */
    function _assertPoolIsFit(IUniswapV3Pool pool, uint256 duration) internal view {
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee();

        // 1. The pool is the one the canonical factory made for this pair and
        //    tier. Without this every other check is being asked of a contract
        //    the attacker wrote.
        if (v3Factory.getPool(token0, token1, fee) != address(pool)) revert NotCanonicalPool();

        // 2. Stakes are in WETH, so the price has to be quoted in WETH.
        if (token0 != weth && token1 != weth) revert NotAWethPair();

        if (!allowedFeeTier[fee]) revert FeeTierNotAllowed(fee);

        // 3. Deep enough that moving the price costs more than winning a
        //    capped bet is worth.
        uint256 depth = wethDepth(pool);
        if (depth < MIN_POOL_WETH_DEPTH) revert PoolTooThin(depth);

        // 4. Room in the observation ring for the windows we will ask for.
        (,,, uint16 cardinality,,,) = pool.slot0();
        if (cardinality < MIN_CARDINALITY) revert CardinalityTooLow(cardinality, MIN_CARDINALITY);

        // 5. And history actually in it. This is not implied by (4): Uniswap
        //    grows cardinality to cardinalityNext in a single step on the first
        //    write after somebody pays, so a pool can report 300 slots while
        //    holding two seconds of prices. Asking the pool to serve the window
        //    is the only check that distinguishes capacity from history, and
        //    the window is this market's own. It must serve both the entry
        //    strike's 60 seconds and the duration-derived exit window.
        uint256 window = twapWindowFor(duration);
        if (!canServeWindow(pool, window)) revert PoolCannotServeWindow(window);
        if (window < ENTRY_TWAP_WINDOW && !canServeWindow(pool, ENTRY_TWAP_WINDOW)) {
            revert PoolCannotServeWindow(ENTRY_TWAP_WINDOW);
        }
    }

    // ── VIEWS THE KEEPER AND THE UI USE ────────────────────
    /// @notice feedId stays bytes32 everywhere; on this chain it is a pool.
    function feedIdFor(address pool) public pure returns (bytes32) {
        return bytes32(uint256(uint160(pool)));
    }

    /**
     * @notice WETH held against the pool's in-range liquidity.
     * @dev    The virtual reserve implied by L and the current price: for a
     *         full-range position this is the real balance, for a concentrated
     *         one it is an upper bound. Uniswap's own identities, x = L/sqrt(P)
     *         and y = L*sqrt(P), through OpenZeppelin's 512-bit mulDiv because
     *         L * sqrtPriceX96 overflows uint256 at the top of the tick range.
     */
    function wethDepth(IUniswapV3Pool pool) public view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        if (sqrtPriceX96 == 0) return 0;
        uint256 l = uint256(pool.liquidity());
        uint256 q96 = 1 << 96;

        return pool.token1() == weth
            ? Math.mulDiv(l, sqrtPriceX96, q96)  // y = L * sqrt(P)
            : Math.mulDiv(l, q96, sqrtPriceX96); // x = L / sqrt(P)
    }

    /// @notice Whether the pool can price a window ending now, `window` long.
    function canServeWindow(IUniswapV3Pool pool, uint256 window) public view returns (bool) {
        uint32[] memory secondsAgos = new uint32[](2);
        // safe: window is clamped to TWAP_WINDOW_CAP by twapWindowFor.
        // forge-lint: disable-next-line(unsafe-typecast)
        secondsAgos[0] = uint32(window);
        secondsAgos[1] = 0;
        try pool.observe(secondsAgos) returns (int56[] memory, uint160[] memory) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Mirrors PoolOracleResolver._twapWindowFor. Public so the keeper and
    ///      the UI can tell a caller which window a pool is failing.
    function twapWindowFor(uint256 duration) public pure returns (uint256) {
        uint256 scaled = duration / 5;
        if (scaled > 5 minutes) return 5 minutes;
        if (scaled < 30 seconds) return 30 seconds;
        return scaled;
    }

    /**
     * @dev Deliberately absent: a canCreateMarket() view that flattens the
     *      failures above into a string. Every rejection here is a custom error
     *      naming exactly what failed and carrying the offending value, and any
     *      caller that can read this ABI decodes it from a simulated
     *      createMarket for free. The keeper's real question - "must I pay for
     *      cardinality before this pool is usable?" - is answered directly by
     *      wethDepth, slot0 and canServeWindow, without a transaction.
     */

    function getActiveMarkets(bytes32 feedId) external view returns (address[] memory) {
        return activeMarkets[feedId];
    }

    // ── IMPLEMENTATION ─────────────────────────────────────
    /**
     * @dev Deploys the contract every market clones. Virtual for the same
     *      reason MarketFactory's is: the implementation must be deployed by
     *      the factory, because OrderbookMarket takes `factory` from msg.sender
     *      and gates initialize() on it, so overriding this is the only way a
     *      test can substitute a different market.
     */
    function _deployMarketImplementation(
        address _weth,
        address _resolver,
        address _liquidityPool,
        address _feeDistributor,
        address _referralRegistry,
        address _multisig
    ) internal virtual returns (address) {
        // Zeroed per-instance config leaves it permanently initialized, so
        // nobody can call initialize() on the implementation itself.
        return address(
            new PoolOrderbookMarket(
                _weth, _resolver, _liquidityPool, _feeDistributor, _referralRegistry, _multisig, bytes32(0), 0
            )
        );
    }

    // ── ADMIN ──────────────────────────────────────────────
    /// @notice Stop trading on a pool. Same asymmetry as MarketFactory: a
    ///         low-trust hot wallet may stop it, only the multisig restarts it.
    function pauseMarketsForFeed(bytes32 feedId) external {
        require(msg.sender == owner() || msg.sender == emergencyPauser, "not authorized");
        feedPaused[feedId] = true;
        emit FeedPaused(feedId, msg.sender);

        address[] storage list = activeMarkets[feedId];
        uint256 len = list.length;
        uint256 stop = len > PAUSE_SWEEP_LIMIT ? len - PAUSE_SWEEP_LIMIT : 0;
        for (uint256 i = len; i > stop; i--) {
            try OrderbookMarket(list[i - 1]).pauseByFactory() {} catch {}
        }
    }

    function unpauseFeed(bytes32 feedId) external onlyOwner {
        feedPaused[feedId] = false;
        emit FeedUnpaused(feedId);
    }

    function setMultisig(address newMultisig) external onlyOwner {
        if (newMultisig == address(0)) revert ZeroAddress();
        emit MultisigChanged(multisig, newMultisig);
        multisig = newMultisig;
    }

    function setEmergencyPauser(address pauser) external onlyOwner {
        emergencyPauser = pauser;
        emit EmergencyPauserSet(pauser);
    }

    /// @notice Open or close a fee tier. Tiers are chain configuration, not
    ///         economics, so this needs no timelock - it cannot reach a market
    ///         that already exists.
    function setFeeTier(uint24 fee, bool allowed) external onlyOwner {
        allowedFeeTier[fee] = allowed;
        emit FeeTierSet(fee, allowed);
    }

    function proposeNewFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= FEE_MAX, "fee too high");
        pendingFeeBps = newFeeBps;
        feeChangeAvailableAt = block.timestamp + FEE_TIMELOCK;
        emit FeeChangeProposed(newFeeBps, feeChangeAvailableAt);
    }

    function applyNewFee() external onlyOwner {
        require(feeChangeAvailableAt != 0, "no proposal");
        require(block.timestamp >= feeChangeAvailableAt, "timelock");
        feeBps = pendingFeeBps;
        feeChangeAvailableAt = 0;
        emit FeeChanged(feeBps);
    }

    function _isDurationAllowed(uint256 dur) internal view returns (bool) {
        for (uint256 i = 0; i < allowedDurations.length; i++) {
            if (allowedDurations[i] == dur) return true;
        }
        return false;
    }
}
