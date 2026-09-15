// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@redstone-finance/evm-connector/contracts/data-services/PrimaryProdDataServiceConsumerBase.sol";

interface ILiquidityPool {
    /// @return matchedAmount actual USDC the pool took from `amount` (0 .. amount).
    function tryMatch(uint256 orderId, uint256 amount, bool userIsUp, uint256 matchId)
        external
        returns (uint256 matchedAmount);

    function onMatchSettled(uint256 matchId, bool upWon) external;
    function onMatchRefunded(uint256 matchId) external;
}

interface IFeeDistributor {
    function distributeFee(uint256 totalFee, address referrer) external;
}

interface IReferralRegistry {
    function register(address referee, address referrer) external;
    function referrerOf(address referee) external view returns (address);
}

/**
 * @title OrderbookMarket
 * @notice Rolling market with async matching and multi-fill orders.
 *
 *  Order lifecycle:
 *      placeBet  → PENDING (filledAmount < amount, in queue)
 *               → MATCHED  (filledAmount == amount)
 *               → SETTLED  (all matches settled AND
 *                          (filledAmount == amount OR unmatchedRefunded))
 *               → CLAIMED
 *      placeBet → REFUNDED (refundExpired before any fill)
 *
 *  Multi-fill design (Sprint 1.1):
 *      A single Order can be matched against multiple counterparties (or against
 *      the LP pool in partial amounts) before becoming fully MATCHED. Each
 *      individual match has its own Match record with its own m.amount and
 *      entryPrice. Order.payout accumulates winnings across all matches; claim
 *      pays the total once Order.pendingSettlements reaches 0. This eliminates
 *      the previous bug where the larger side of an unequal PvP match silently
 *      lost the unmatched portion of their stake.
 */
contract OrderbookMarket is ReentrancyGuard, Pausable, PrimaryProdDataServiceConsumerBase {
    using SafeERC20 for IERC20;

    // ── TYPES ──────────────────────────────────────────────
    enum Direction {
        UP,
        DOWN
    }
    enum OrderStatus {
        PENDING,
        MATCHED,
        SETTLED,
        CLAIMED,
        REFUNDED
    }

    struct Order {
        address trader;
        Direction direction;
        uint256 amount; // total deposit; immutable after placeBet
        uint256 filledAmount; // matched so far; <= amount
        address referrer;
        OrderStatus status;
        uint256 placedAt;
        uint256 matchId; // FIRST match for back-compat / view ease (0 if none)
        uint256 pendingSettlements; // matches yet to settle
        uint256 payout; // accumulated winnings (claimable when pendingSettlements == 0)
        bool unmatchedRefunded; // refundExpired already returned the unmatched portion
    }

    struct Match {
        uint256 upOrderId;
        uint256 downOrderId;
        uint256 amount; // per-side stake = matched amount
        uint256 entryPrice; // price at match creation
        uint256 settleAt; // matched-at + duration
        uint256 exitPrice;
        bool settled;
        bool upWon;
        bool lpMatch; // true when one side is the LP pool
    }

    // ── CONSTANTS ──────────────────────────────────────────
    /**
     * Stake bounds. Functions rather than constants so a subclass settling in
     * another currency can restate the same economic limits in that currency's
     * decimals - these are 6-decimal USDC amounts, and 1e6 means one dollar
     * here and one attoWETH-ish nothing anywhere else.
     *
     * The values are unchanged and the ABI is unchanged with them: the getter
     * Solidity generates for a public constant is already `view`, with this
     * name, no inputs and a uint256 out, so no caller on or off chain can tell
     * these apart from what they replaced.
     *
     * The cost is that an internal read becomes a jump instead of a push.
     * That is the only edit this branch makes to a contract Base runs, so it is
     * measured rather than assumed - see docs/rhc/measurements/README.md.
     */
    function MIN_BET() public view virtual returns (uint256) {
        return 1e6; // 1 USDC
    }

    /// @notice Smallest amount that may create a separately settled match.
    /// @dev A bet floor alone is insufficient when partial fills leave a
    ///      sub-floor remainder. The default preserves Base behaviour.
    function MIN_MATCH_AMOUNT() public view virtual returns (uint256) {
        return MIN_BET();
    }

    function MAX_BET() public view virtual returns (uint256) {
        return 100e6; // 100 USDC, remove after audit
    }
    uint256 public constant MATCH_TIMEOUT = 5 minutes; // PENDING → refundExpired
    uint256 public constant SETTLE_GRACE = 24 hours; // MATCHED → emergencyRefundMatch

    // Sprint 5.6: 45 -> 20. The 45s figure existed to keep the bare
    // placeBet() overload usable between the keeper's 30s pushes. That
    // overload is gone (see placeBet), so the bound no longer has to
    // accommodate a keeper cadence at all — every bet now carries its own
    // update and the stored price is whatever the caller just submitted.
    //
    // It is still load-bearing, and this is the subtle part: Pyth's
    // updatePriceFeeds SILENTLY NO-OPS when handed an update older than what
    // is already stored — it does not revert. So requiring non-empty update
    // data does not by itself guarantee freshness: a sniper can submit a
    // deliberately old but valid VAA, have it ignored, and still read a stale
    // strike. This bound is what makes that unprofitable.
    //
    // 20s is chosen against the honest path, not the attacker's: fetch from
    // Hermes (~1s), sign, land within a block or two on Base (~2-4s). That
    // leaves wide margin, while a normal update makes the effective age ~0.
    // Tightening further starts rejecting slow signers for no extra security,
    // since the honest case never approaches the bound.
    uint256 public constant ENTRY_MAX_PRICE_AGE = 20;

    /// A price claiming to be from the future is worth even less than a stale
    /// one; allow only enough slack for ordinary clock skew between signers.
    uint256 public constant ENTRY_MAX_PRICE_AHEAD = 10;

    /**
     * @inheritdoc RedstoneConsumerBase
     * @dev Stated here rather than inherited. RedStone's defaults are 3 minutes
     *      back and 1 minute forward, which on a 5-minute market is most of the
     *      bet: someone could watch the price move and enter at a strike they
     *      already know is wrong. This is the guard the long comment on
     *      placeBet is about, so it must not be a value their next release can
     *      change under us.
     */
    function validateTimestamp(uint256 receivedTimestampMilliseconds) public view override {
        uint256 receivedSeconds = receivedTimestampMilliseconds / 1000;
        if (receivedSeconds > block.timestamp) {
            require(receivedSeconds - block.timestamp <= ENTRY_MAX_PRICE_AHEAD, "price from the future");
        } else {
            require(block.timestamp - receivedSeconds <= ENTRY_MAX_PRICE_AGE, "price too old");
        }
    }

    // ── LP ECONOMICS (Sprint 5.5 audit fix) ────────────────
    // PvP matches never cost the pool anything; only LP-matched wagers put
    // the pool's capital at risk. Charging this fee ONLY when the user beats
    // the LP (i.e. only ever taken out of a payout the pool would otherwise
    // pay in full) gives the pool a structural edge instead of a flat 0% EV
    // against informed order flow.
    uint256 public constant LP_TAKER_FEE_BPS = 100; // 1% of totalPool on LP-match user wins

    // Caps how much of the pool a single address can draw against within one
    // market instance's lifetime (markets are recreated every few minutes,
    // which naturally resets this), independent of the pool's own global/
    // per-market exposure caps. Bounds the damage from an address repeatedly
    // hitting the LP at a favorable/stale price.
    /// @dev 3x MAX_BET. Virtual for the same reason MAX_BET is; see there.
    function MAX_TRADER_LP_EXPOSURE() public view virtual returns (uint256) {
        return 300e6;
    }

    // ── FEE ────────────────────────────────────────────────
    /// @notice Protocol fee for this market, in bps. Snapshotted from the
    ///         factory by _init() and then fixed for this market's life, so a
    ///         position always settles on the terms it was opened under.
    ///
    ///         The propose/apply timelock used to live here. It could never
    ///         complete: FEE_TIMELOCK is 48h and no market clone survives
    ///         longer than 24h, so the fee was permanently stuck at zero. It
    ///         now lives on MarketFactory, which is permanent.
    ///
    ///         No inline initializer, deliberately. Inline field initializers
    ///         compile into the constructor, which a clone never runs.
    uint256 public feeBps;

    // ── IMMUTABLES ─────────────────────────────────────────
    // These are identical for every market instance, so they stay immutable:
    // immutables live in the *implementation's* runtime code, and an EIP-1167
    // clone delegatecalls into exactly that code, so clones read them
    // correctly for free — no storage slot, no per-market SSTORE.
    IERC20 public immutable usdc;
    address public immutable resolver;
    address public immutable liquidityPool;
    address public immutable feeDistributor;
    address public immutable referralRegistry;
    address public immutable factory;

    // ── PER-INSTANCE CONFIG ────────────────────────────────
    // Sprint 5.6: these two differ per market, so they CANNOT be immutable
    // once markets are clones — a clone shares the implementation's code and
    // therefore its immutables. They move to storage, written once by
    // _init() (from either the constructor or initialize()).
    bytes32 public feedId;
    uint256 public duration;

    /// @notice Protocol admin for this market. Also moved out of immutables:
    ///         it was frozen into the implementation's code, so every clone
    ///         shared one address that could never be changed, and moving to a
    ///         Safe after launch meant redeploying everything. The factory
    ///         passes its current multisig at creation.
    address public multisig;

    /// @dev Set by _init(). Guards against a clone being re-initialized, and
    ///      is set in the constructor so a directly-deployed instance — which
    ///      includes the implementation the factory clones from — can never
    ///      be initialized by anyone afterwards.
    bool private _initialized;

    // ── STATE ──────────────────────────────────────────────
    // NOTE: deliberately no inline `= 1` initializers here. Inline field
    // initializers are compiled into the constructor, and a clone's storage
    // starts empty because its constructor never runs — these would silently
    // be 0 for every cloned market. Order/match id 0 is used as the "none"
    // sentinel (see Order.matchId), so that would be a correctness bug, not
    // just cosmetics. _init() sets both instead.
    uint256 public nextOrderId;
    uint256 public nextMatchId;

    mapping(uint256 => Order) public orders;
    mapping(uint256 => Match) public matches;

    // Bounded scan + index back-reference so queue removal is O(1).
    uint256 public constant MAX_MATCH_SCAN = 32;
    uint256[] public pendingUpQueue;
    uint256[] public pendingDownQueue;
    mapping(uint256 => uint256) private _queueIndex; // orderId → (idx+1); 0 = not queued

    // trader → their orderIds (append-only)
    mapping(address => uint256[]) public traderOrders;

    // trader → cumulative amount matched against the LP pool this market
    // instance's lifetime. Bounded by MAX_TRADER_LP_EXPOSURE.
    mapping(address => uint256) public traderLpExposure;

    // matchIds that need settlement
    uint256[] public pendingSettlements;
    // Matches at indices < pendingSettlementsHead are ALL already settled.
    // Advanced amortized-O(1) on every settle so getReadySettlements(0, N)
    // (the only pattern real callers use) keeps seeing new ready matches
    // instead of re-scanning an ever-growing settled prefix forever.
    uint256 public pendingSettlementsHead;

    // ── EVENTS ─────────────────────────────────────────────
    event OrderPlaced(uint256 indexed orderId, address indexed trader, Direction dir, uint256 amount);
    event OrderMatched(uint256 indexed matchId, uint256 upId, uint256 downId, uint256 amount, uint256 entryPrice);
    event LPMatched(uint256 indexed matchId, uint256 orderId, uint256 amount, uint256 entryPrice);
    event OrderFilled(uint256 indexed orderId, uint256 totalFilled); // emitted once filledAmount == amount
    event MatchSettled(uint256 indexed matchId, bool upWon, uint256 entry, uint256 exit);
    event MatchTied(uint256 indexed matchId, uint256 price);
    event OrderRefunded(uint256 indexed orderId, address trader, uint256 amount); // partial when amount < order.amount
    event Claimed(uint256 indexed orderId, address trader, uint256 payout);

    // ── CONSTRUCTOR / INITIALIZER ──────────────────────────
    /**
     * @notice Direct deployment. Still fully supported (tests and scripts use
     *         it) — the resulting market is configured and locked in one step.
     * @dev    MarketFactory also uses this exactly once, to deploy the
     *         implementation it clones from, passing zeroed per-instance
     *         config. Because _init() runs here, that implementation is left
     *         permanently initialized and so cannot be hijacked by an
     *         arbitrary caller calling initialize() on it directly.
     */
    constructor(
        address _usdc,
        address _resolver,
        address _liquidityPool,
        address _feeDistributor,
        address _referralRegistry,
        address _multisig,
        bytes32 _feedId,
        uint256 _duration
    ) {
        usdc = IERC20(_usdc);
        resolver = _resolver;
        liquidityPool = _liquidityPool;
        feeDistributor = _feeDistributor;
        referralRegistry = _referralRegistry;
        factory = msg.sender;
        // Direct deployment configures itself; there is no factory to ask, and
        // a fee of zero matches what this path has always produced.
        _init(_feedId, _duration, _multisig, 0);
    }

    /**
     * @notice Configure a freshly-cloned market. Callable once, by the factory
     *         that deployed the implementation.
     * @dev    `factory` is an immutable read from the implementation's code,
     *         so every clone agrees on who is allowed to call this. The clone
     *         is created and initialized in the same transaction
     *         (MarketFactory.createMarket), so there is no window in which an
     *         uninitialized clone is reachable by users.
     */
    function initialize(bytes32 _feedId, uint256 _duration, address _multisig, uint256 _feeBps) external {
        require(msg.sender == factory, "only factory");
        _init(_feedId, _duration, _multisig, _feeBps);
    }

    function _init(bytes32 _feedId, uint256 _duration, address _multisig, uint256 _feeBps) internal {
        require(!_initialized, "already initialized");
        _initialized = true;
        feedId = _feedId;
        duration = _duration;
        multisig = _multisig;
        feeBps = _feeBps;
        // Ids start at 1 — 0 is the "no match" sentinel in Order.matchId and
        // the "not queued" sentinel in _queueIndex.
        nextOrderId = 1;
        nextMatchId = 1;
    }

    // ── PLACE BET ──────────────────────────────────────────
    /**
     * @notice Place a bet, carrying the Pyth update that prices it.
     *
     * @dev Sprint 5.6 — the bare `placeBet(dir, amount, referrer,
     *      expectedPrice, slippageBps)` overload is GONE, deliberately. It let
     *      the caller settle on whatever price the keeper had last pushed,
     *      which is a strike up to ENTRY_MAX_PRICE_AGE old. Anyone watching
     *      Hermes in real time could see a move land, then enter against a
     *      strike they already knew was wrong, in the direction the price had
     *      already gone. The counterparty pays for that: another user on a
     *      peer match, the pool on an LP match — and the pool can never
     *      decline, which makes it the structural victim.
     *
     *      `expectedPrice`/`slippageBps` are no defence, because the caller
     *      supplies both: a sniper passes the stale price as `expectedPrice`
     *      with zero slippage and the check passes trivially. That pair
     *      protects an honest user from the price moving between rendering
     *      and execution; it says nothing about staleness.
     *
     *      RedStone is a PULL oracle: the caller brings a freshly signed
     *      price and the contract verifies it. Reading a keeper-pushed value
     *      instead was using a pull oracle in push mode and reintroducing
     *      exactly the staleness the pull design exists to remove.
     *
     *      Two things are required together; either alone is insufficient:
     *        1. this being the only entry point, so no stale path remains;
     *        2. a tight ENTRY_MAX_PRICE_AGE, enforced by our own
     *           validateTimestamp override rather than RedStone's much looser
     *           3-minute default.
     *
     *      Residual window is one block plus gateway latency, not 45 seconds.
     *
     *      The price rides as a signed payload appended to this call's
     *      calldata - there is no parameter for it, and no fee, so this
     *      function is no longer payable. Callers must append the payload;
     *      a call without one cannot produce a price and reverts.
     */
    function placeBet(Direction dir, uint256 amount, address referrer, uint256 expectedPrice, uint256 slippageBps)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 orderId)
    {
        return _placeBet(dir, amount, referrer, expectedPrice, slippageBps);
    }

    function _placeBet(Direction dir, uint256 amount, address referrer, uint256 expectedPrice, uint256 slippageBps)
        internal
        returns (uint256 orderId)
    {
        require(amount >= MIN_BET(), "below min");
        require(amount <= MAX_BET(), "above max");
        require(referrer != msg.sender, "self referral");
        require(expectedPrice > 0, "expectedPrice zero");

        uint256 actualPrice = _getCurrentPrice();

        uint256 diff = actualPrice > expectedPrice ? actualPrice - expectedPrice : expectedPrice - actualPrice;
        uint256 spread = (diff * 10_000) / expectedPrice;
        require(spread <= slippageBps, "price slippage exceeded");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        if (referrer != address(0) && referralRegistry != address(0)) {
            try IReferralRegistry(referralRegistry).register(msg.sender, referrer) {} catch {}
        }

        orderId = nextOrderId++;
        orders[orderId] = Order({
            trader: msg.sender,
            direction: dir,
            amount: amount,
            filledAmount: 0,
            referrer: referrer,
            status: OrderStatus.PENDING,
            placedAt: block.timestamp,
            matchId: 0,
            pendingSettlements: 0,
            payout: 0,
            unmatchedRefunded: false
        });
        traderOrders[msg.sender].push(orderId);

        emit OrderPlaced(orderId, msg.sender, dir, amount);

        _tryMatch(orderId, dir, actualPrice);
    }

    // ── MATCHING LOGIC ─────────────────────────────────────
    /// @notice Multi-fill matching: PvP queue first, then LP, then re-queue
    ///         any remaining portion (down to MIN_BET; dust is refunded).
    function _tryMatch(uint256 orderId, Direction dir, uint256 currentPrice) internal {
        Order storage o = orders[orderId];
        uint256[] storage oppositeQueue = dir == Direction.UP ? pendingDownQueue : pendingUpQueue;

        uint256 scanned = 0;
        uint256 i = 0;

        // Layer 1 — bounded PvP scan with multi-fill.
        while (i < oppositeQueue.length && scanned < MAX_MATCH_SCAN && o.filledAmount < o.amount) {
            uint256 candidateId = oppositeQueue[i];
            Order storage candidate = orders[candidateId];
            scanned++;

            // Lazy eviction of dead/expired orders.
            if (
                candidate.status != OrderStatus.PENDING || candidate.unmatchedRefunded
                    || block.timestamp > candidate.placedAt + MATCH_TIMEOUT
            ) {
                _removeAt(oppositeQueue, i);
                continue;
            }

            uint256 myRemaining = o.amount - o.filledAmount;
            uint256 candidateRemaining = candidate.amount - candidate.filledAmount;
            if (candidateRemaining == 0) {
                _removeAt(oppositeQueue, i);
                continue;
            }
            if (candidateRemaining < MIN_MATCH_AMOUNT()) {
                _refundUnmatchedTail(candidateId, candidate);
                continue;
            }
            if (myRemaining < MIN_MATCH_AMOUNT()) break;

            uint256 matchAmount = myRemaining < candidateRemaining ? myRemaining : candidateRemaining;

            _createMatch(orderId, candidateId, dir, matchAmount, currentPrice, false);

            // Update both orders.
            _registerFill(o, matchAmount);
            _registerFill(candidate, matchAmount);

            // Candidate fully filled → remove from queue.
            if (candidate.filledAmount == candidate.amount) {
                candidate.status = OrderStatus.MATCHED;
                emit OrderFilled(candidateId, candidate.filledAmount);
                _removeAt(oppositeQueue, i);
                // i stays — last element was swapped here.
            } else {
                i++;
            }
        }

        // Layer 2 — LP fallback for whatever remains, bounded by this
        // trader's remaining MAX_TRADER_LP_EXPOSURE allowance. Extracted to
        // its own function: keeping these locals out of _tryMatch's frame
        // avoids "stack too deep" (via_ir is off project-wide; see foundry.toml).
        if (liquidityPool != address(0) && o.filledAmount < o.amount) {
            _tryLpMatch(orderId, o, dir, currentPrice);
        }

        // Layer 3 — finalize.
        if (o.filledAmount == o.amount) {
            o.status = OrderStatus.MATCHED;
            emit OrderFilled(orderId, o.filledAmount);
        } else if (o.filledAmount > 0 && (o.amount - o.filledAmount) < MIN_BET()) {
            // Sub-MIN_BET dust on a partially-filled order: refund the dust now.
            uint256 dust = o.amount - o.filledAmount;
            o.unmatchedRefunded = true;
            usdc.safeTransfer(o.trader, dust);
            o.status = OrderStatus.MATCHED;
            emit OrderRefunded(orderId, o.trader, dust);
            emit OrderFilled(orderId, o.filledAmount);
        } else {
            // Queue the unmatched portion (>= MIN_BET).
            if (dir == Direction.UP) {
                pendingUpQueue.push(orderId);
                _queueIndex[orderId] = pendingUpQueue.length;
            } else {
                pendingDownQueue.push(orderId);
                _queueIndex[orderId] = pendingDownQueue.length;
            }
        }
    }

    /// @dev Layer 2 of _tryMatch: LP fallback bounded by MAX_TRADER_LP_EXPOSURE.
    function _tryLpMatch(uint256 orderId, Order storage o, Direction dir, uint256 currentPrice) internal {
        uint256 remaining = o.amount - o.filledAmount;
        uint256 traderUsed = traderLpExposure[o.trader];
        uint256 cap = MAX_TRADER_LP_EXPOSURE();
        uint256 traderRoom = cap > traderUsed ? cap - traderUsed : 0;
        uint256 lpRequest = remaining < traderRoom ? remaining : traderRoom;
        if (lpRequest < MIN_MATCH_AMOUNT()) return;

        uint256 reservedId = nextMatchId; // hint for LP bookkeeping; final id chosen in _createMatch
        uint256 lpMatched = ILiquidityPool(liquidityPool).tryMatch(orderId, lpRequest, dir == Direction.UP, reservedId);
        require(lpMatched <= lpRequest, "lp overmatched");

        if (lpMatched > 0) {
            // A vault exposure cap can return a small partial amount. Returning
            // it immediately is cheaper and safer than creating a dust match.
            if (lpMatched < MIN_MATCH_AMOUNT()) {
                usdc.safeTransfer(liquidityPool, lpMatched);
                ILiquidityPool(liquidityPool).onMatchRefunded(reservedId);
                return;
            }
            traderLpExposure[o.trader] = traderUsed + lpMatched;
            _createMatch(orderId, 0, dir, lpMatched, currentPrice, true);
            _registerFill(o, lpMatched);
        }
    }

    /// @dev Bookkeeping after a single match is created against the given order.
    function _registerFill(Order storage o, uint256 matchAmount) internal {
        o.filledAmount += matchAmount;
        o.pendingSettlements += 1;
        if (o.matchId == 0) {
            o.matchId = nextMatchId - 1; // _createMatch already incremented
        }
    }

    function _createMatch(
        uint256 orderId,
        uint256 oppositeId,
        Direction dir,
        uint256 amount,
        uint256 entryPrice,
        bool isLpMatch
    ) internal {
        uint256 matchId = nextMatchId++;

        uint256 upId = dir == Direction.UP ? orderId : oppositeId;
        uint256 downId = dir == Direction.UP ? oppositeId : orderId;

        matches[matchId] = Match({
            upOrderId: upId,
            downOrderId: downId,
            amount: amount,
            entryPrice: entryPrice,
            settleAt: block.timestamp + duration,
            exitPrice: 0,
            settled: false,
            upWon: false,
            lpMatch: isLpMatch
        });

        if (isLpMatch) {
            emit LPMatched(matchId, orderId, amount, entryPrice);
        } else {
            emit OrderMatched(matchId, upId, downId, amount, entryPrice);
        }

        pendingSettlements.push(matchId);
    }

    // ── SETTLE ─────────────────────────────────────────────
    function settleMatch(uint256 matchId, uint256 exitPrice) external nonReentrant {
        require(msg.sender == resolver, "only resolver");
        Match storage m = matches[matchId];
        require(m.amount > 0, "match not found");
        require(!m.settled, "already settled");
        require(block.timestamp >= m.settleAt, "too early");
        // Audit fix (S1, 2026-07-05): a keeper resuming after a long outage
        // must not settle on whatever price happens to be current at resume
        // time — that price has nothing to do with the intended settlement
        // moment. Past SETTLE_GRACE, the only valid path is the symmetric
        // emergencyRefundMatch (same window emergencyRefundMatch itself uses).
        require(block.timestamp < m.settleAt + SETTLE_GRACE, "settlement window expired");

        m.settled = true;
        m.exitPrice = exitPrice;
        _advancePendingSettlementsHead();

        // Flat is neither UP nor DOWN. A tie refunds both stakes and charges
        // no fee, avoiding a permanent DOWN edge on inactive pools.
        if (exitPrice == m.entryPrice) {
            _refundTiedMatch(matchId, m);
            emit MatchTied(matchId, exitPrice);
            return;
        }
        m.upWon = exitPrice > m.entryPrice;

        if (!m.lpMatch) {
            _settleOrder(m.upOrderId, m.upWon, m);
            _settleOrder(m.downOrderId, !m.upWon, m);
        } else {
            bool userIsUp = m.upOrderId != 0;
            uint256 userOrderId = userIsUp ? m.upOrderId : m.downOrderId;
            bool userWon = userIsUp ? m.upWon : !m.upWon;

            // Release this match's own share of the trader's LP exposure cap.
            // Markets on this chain have no close time and live forever, so a
            // cap that only ever grows (its own doc comment assumes markets
            // are recreated every few minutes, resetting it) would otherwise
            // become a lifetime ban from the LP the moment a trader's closed
            // positions add up to it - long after the capital those
            // positions used is back in the vault and free again.
            traderLpExposure[orders[userOrderId].trader] -= m.amount;

            _settleOrder(userOrderId, userWon, m);

            if (!userWon) {
                // LP won: send both stakes back to the pool.
                usdc.safeTransfer(liquidityPool, m.amount * 2);
            }
            ILiquidityPool(liquidityPool).onMatchSettled(matchId, m.upWon);
        }

        emit MatchSettled(matchId, m.upWon, m.entryPrice, exitPrice);
    }

    function _refundTiedMatch(uint256 matchId, Match storage m) internal {
        if (!m.lpMatch) {
            Order storage up = orders[m.upOrderId];
            Order storage dn = orders[m.downOrderId];
            _decrementSettlement(up);
            _decrementSettlement(dn);
            usdc.safeTransfer(up.trader, m.amount);
            usdc.safeTransfer(dn.trader, m.amount);
            emit OrderRefunded(m.upOrderId, up.trader, m.amount);
            emit OrderRefunded(m.downOrderId, dn.trader, m.amount);
        } else {
            uint256 userOrderId = m.upOrderId != 0 ? m.upOrderId : m.downOrderId;
            Order storage o = orders[userOrderId];
            traderLpExposure[o.trader] -= m.amount; // see settleMatch's LP branch
            _decrementSettlement(o);
            usdc.safeTransfer(o.trader, m.amount);
            usdc.safeTransfer(liquidityPool, m.amount);
            emit OrderRefunded(userOrderId, o.trader, m.amount);
            ILiquidityPool(liquidityPool).onMatchRefunded(matchId);
        }
    }

    /// @dev Accumulate per-match payout into the order. Only flip status to
    ///      SETTLED when nothing is pending AND the order is closed
    ///      (fully filled OR its unmatched portion was refunded).
    function _settleOrder(uint256 orderId, bool won, Match storage m) internal {
        Order storage o = orders[orderId];
        require(o.pendingSettlements > 0, "no pending settlements");
        o.pendingSettlements -= 1;

        if (won) {
            uint256 totalPool = m.amount * 2;
            uint256 fee = (totalPool * feeBps) / 10_000;
            uint256 net = totalPool - fee;

            if (m.lpMatch) {
                uint256 lpTakerFee = (totalPool * LP_TAKER_FEE_BPS) / 10_000;
                net -= lpTakerFee;
                if (lpTakerFee > 0) usdc.safeTransfer(liquidityPool, lpTakerFee);
            }

            o.payout += net;

            if (fee > 0 && feeDistributor != address(0)) {
                usdc.safeTransfer(feeDistributor, fee);
                // The REGISTRY'S referrer, not this order's own `referrer`
                // field. The registry is sticky (first referrer wins,
                // forever) precisely so a trader cannot redirect it later -
                // but paying o.referrer here meant that protection never
                // reached the money: a trader with an already-registered
                // referrer could still pass a different address on any one
                // placeBet call and redirect THAT bet's referral share to it,
                // including to themselves. o.referrer is kept on the struct
                // for the register() call at placement time (harmless there,
                // since register() itself already ignores a second address);
                // it is simply no longer what payout reads.
                address ref = referralRegistry != address(0)
                    ? IReferralRegistry(referralRegistry).referrerOf(o.trader)
                    : address(0);
                IFeeDistributor(feeDistributor).distributeFee(fee, ref);
            }
        }

        if (o.pendingSettlements == 0 && (o.filledAmount == o.amount || o.unmatchedRefunded)) {
            o.status = OrderStatus.SETTLED;
        }
    }

    // ── CLAIM ──────────────────────────────────────────────
    function claim(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.trader == msg.sender, "not your order");
        require(o.pendingSettlements == 0, "settlements pending");
        require(o.status != OrderStatus.CLAIMED, "already claimed");
        require(
            o.status == OrderStatus.SETTLED || 
                // graceful: allow claim if all settled but status not yet promoted
                (o.filledAmount > 0 && (o.filledAmount == o.amount || o.unmatchedRefunded)),
            "not settled"
        );
        require(o.payout > 0, "nothing to claim");

        uint256 p = o.payout;
        o.payout = 0;
        o.status = OrderStatus.CLAIMED;
        usdc.safeTransfer(msg.sender, p);

        emit Claimed(orderId, msg.sender, p);
    }

    // ── EMERGENCY REFUND (matched-but-unsettled) ───────────
    /// @notice Refund a matched-but-unsettled match after SETTLE_GRACE.
    function emergencyRefundMatch(uint256 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.amount > 0, "match not found");
        require(!m.settled, "already settled");
        require(block.timestamp > m.settleAt + SETTLE_GRACE, "grace not over");

        m.settled = true;
        _advancePendingSettlementsHead();

        if (!m.lpMatch) {
            Order storage up = orders[m.upOrderId];
            Order storage dn = orders[m.downOrderId];
            _forceRefundOrder(up);
            _forceRefundOrder(dn);
            usdc.safeTransfer(up.trader, m.amount);
            usdc.safeTransfer(dn.trader, m.amount);
            emit OrderRefunded(m.upOrderId, up.trader, m.amount);
            emit OrderRefunded(m.downOrderId, dn.trader, m.amount);
            _refundUnmatchedTail(m.upOrderId, up);
            _refundUnmatchedTail(m.downOrderId, dn);
        } else {
            uint256 userOrderId = m.upOrderId != 0 ? m.upOrderId : m.downOrderId;
            Order storage o = orders[userOrderId];
            traderLpExposure[o.trader] -= m.amount; // see settleMatch's LP branch
            _forceRefundOrder(o);
            usdc.safeTransfer(o.trader, m.amount);
            usdc.safeTransfer(liquidityPool, m.amount);
            emit OrderRefunded(userOrderId, o.trader, m.amount);
            ILiquidityPool(liquidityPool).onMatchRefunded(matchId);
            _refundUnmatchedTail(userOrderId, o);
        }
    }

    /// @dev When emergency-refunding a match, force the affected order into
    ///      REFUNDED. Other matches of the same order (if any) can still
    ///      emergencyRefundMatch their own funds independently.
    function _forceRefundOrder(Order storage o) internal {
        if (o.pendingSettlements > 0) o.pendingSettlements -= 1;
        o.status = OrderStatus.REFUNDED;
    }

    /// @dev If the order also has an unmatched tail still in the queue, refund
    ///      it now so funds aren't stranded. Idempotent on `unmatchedRefunded`.
    function _refundUnmatchedTail(uint256 orderId, Order storage o) internal {
        if (o.unmatchedRefunded) return;
        uint256 tail = o.amount - o.filledAmount;
        if (tail == 0) return;
        o.unmatchedRefunded = true;
        _removeFromQueueByOrderId(orderId, o.direction);
        usdc.safeTransfer(o.trader, tail);
        emit OrderRefunded(orderId, o.trader, tail);
    }

    /// @dev Counter decrement + status promotion shared by normal settlement.
    function _decrementSettlement(Order storage o) internal {
        if (o.pendingSettlements > 0) o.pendingSettlements -= 1;
        if (o.status == OrderStatus.PENDING || o.status == OrderStatus.MATCHED) {
            if (o.pendingSettlements == 0 && (o.filledAmount == o.amount || o.unmatchedRefunded || o.filledAmount == 0))
            {
                o.status = o.filledAmount == 0 ? OrderStatus.REFUNDED : OrderStatus.SETTLED;
            }
        }
    }

    // ── REFUND EXPIRED (unmatched portion) ─────────────────
    /// @notice Refund the *unmatched* portion of an order after MATCH_TIMEOUT.
    ///         For a fully-unmatched order (filledAmount == 0) this is the
    ///         entire stake and the order becomes REFUNDED.
    ///         For a partially-filled order, only (amount - filledAmount) is
    ///         returned; the matched portion continues to settle normally.
    function refundExpired(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        // Check idempotency BEFORE status so a second call surfaces the
        // specific reason instead of a generic "wrong status".
        require(!o.unmatchedRefunded, "already refunded");
        require(o.status == OrderStatus.PENDING || o.status == OrderStatus.MATCHED, "wrong status");
        require(block.timestamp > o.placedAt + MATCH_TIMEOUT, "not expired");

        uint256 unmatched = o.amount - o.filledAmount;
        require(unmatched > 0, "nothing to refund");

        o.unmatchedRefunded = true;
        _removeFromQueueByOrderId(orderId, o.direction);

        if (o.filledAmount == 0) {
            o.status = OrderStatus.REFUNDED;
        } else if (o.pendingSettlements == 0) {
            // All matches already settled by now → promote to SETTLED.
            o.status = OrderStatus.SETTLED;
        }

        usdc.safeTransfer(o.trader, unmatched);
        emit OrderRefunded(orderId, o.trader, unmatched);
    }

    /// @dev Skip pendingSettlementsHead past any consecutive already-settled
    ///      matches at the front. Matches settle roughly in creation order
    ///      (settleAt is non-decreasing with matchId since duration is fixed
    ///      per market), so the front of the array is where settled matches
    ///      accumulate; this keeps getReadySettlements(0, N) cheap forever
    ///      instead of re-scanning a growing dead prefix.
    function _advancePendingSettlementsHead() internal {
        uint256 head = pendingSettlementsHead;
        uint256 len = pendingSettlements.length;
        while (head < len && matches[pendingSettlements[head]].settled) {
            head++;
        }
        pendingSettlementsHead = head;
    }

    // ── HELPERS ────────────────────────────────────────────
    function _removeAt(uint256[] storage queue, uint256 index) internal {
        uint256 lastIdx = queue.length - 1;
        uint256 removed = queue[index];
        if (index != lastIdx) {
            uint256 moved = queue[lastIdx];
            queue[index] = moved;
            _queueIndex[moved] = index + 1;
        }
        queue.pop();
        _queueIndex[removed] = 0;
    }

    function _removeFromQueueByOrderId(uint256 orderId, Direction dir) internal {
        uint256 idx1 = _queueIndex[orderId];
        if (idx1 == 0) return;
        uint256[] storage q = dir == Direction.UP ? pendingUpQueue : pendingDownQueue;
        _removeAt(q, idx1 - 1);
    }

    // ── VIEWS ──────────────────────────────────────────────
    function getPendingDepth() external view returns (uint256 up, uint256 down) {
        return (pendingUpQueue.length, pendingDownQueue.length);
    }

    function getTraderOrders(address trader) external view returns (uint256[] memory) {
        return traderOrders[trader];
    }

    /// @notice Returns matchIds that are ready for settlement, capped by `limit`.
    ///         Use `limit = 0` for "all ready" (legacy behaviour).
    /// @dev `offset` is relative to `pendingSettlementsHead`, not the absolute
    ///      array index: the already-settled prefix is skipped automatically
    ///      so callers that always pass offset=0 (every real caller does)
    ///      keep seeing newly-ready matches instead of an ever-empty window.
    function getReadySettlements(uint256 offset, uint256 limit) external view returns (uint256[] memory ready) {
        uint256 total = pendingSettlements.length;
        uint256 start = pendingSettlementsHead + offset;
        if (start >= total) return new uint256[](0);

        uint256 end = limit == 0 || start + limit > total ? total : start + limit;

        // Two-pass to size the array.
        uint256 count = 0;
        for (uint256 i = start; i < end; i++) {
            Match storage m = matches[pendingSettlements[i]];
            if (!m.settled && block.timestamp >= m.settleAt) count++;
        }
        ready = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = start; i < end; i++) {
            Match storage m = matches[pendingSettlements[i]];
            if (!m.settled && block.timestamp >= m.settleAt) {
                ready[idx++] = pendingSettlements[i];
            }
        }
    }

    /// @notice Legacy view — same as getReadySettlements(0, 0). Retained for
    ///         existing callers; prefer getReadySettlements with pagination.
    function getPendingSettlements() external view returns (uint256[] memory ready) {
        uint256 total = pendingSettlements.length;
        uint256 head = pendingSettlementsHead;
        uint256 count = 0;
        for (uint256 i = head; i < total; i++) {
            Match storage m = matches[pendingSettlements[i]];
            if (!m.settled && block.timestamp >= m.settleAt) count++;
        }
        ready = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = head; i < total; i++) {
            Match storage m = matches[pendingSettlements[i]];
            if (!m.settled && block.timestamp >= m.settleAt) {
                ready[idx++] = pendingSettlements[i];
            }
        }
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function getMatch(uint256 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    // ── INTERNAL PYTH PRICE ────────────────────────────────
    /**
     * The strike, taken from the signed payload on this call's own calldata.
     *
     * RedStone publishes at 8 decimals and everything here works in 1e18, so
     * the scaling is load-bearing: without it every strike is ten billion times
     * too small. Freshness is enforced by the validateTimestamp override above,
     * which getOracleNumericValueFromTxMsg calls on the way through.
     */
    uint256 private constant REDSTONE_DECIMALS_TO_WAD = 1e10; // 1e18 / 1e8

    function _getCurrentPrice() internal view virtual returns (uint256) {
        uint256 price = getOracleNumericValueFromTxMsg(feedId) * REDSTONE_DECIMALS_TO_WAD;
        require(price > 0, "non-positive price");
        return price;
    }

    // ── ADMIN ──────────────────────────────────────────────
    // The fee timelock used to live here and was unreachable by construction;
    // it is now MarketFactory.proposeNewFee / applyNewFee. See feeBps above.

    function pause() external {
        require(msg.sender == multisig, "only multisig");
        _pause();
    }

    function unpause() external {
        require(msg.sender == multisig, "only multisig");
        _unpause();
    }

    /// @notice Emergency pause callable by MarketFactory (feed deauthorized).
    function pauseByFactory() external {
        require(msg.sender == factory, "only factory");
        _pause();
    }
}
