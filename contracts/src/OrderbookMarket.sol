// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IPyth.sol";

interface ILiquidityPool {
    function tryMatch(uint256 orderId, uint256 amount, bool userIsUp, uint256 matchId) external returns (bool);
    function onMatchSettled(uint256 matchId, bool upWon) external;
}

interface IOracleResolver {
    function pyth() external view returns (address);
}

interface IFeeDistributor {
    function distributeFee(uint256 totalFee, address referrer) external;
}

interface IReferralRegistry {
    function register(address referee, address referrer) external;
}

/**
 * @title OrderbookMarket
 * @notice Rolling market with async matching.
 *
 * Bet lifecycle:
 *   placeBet() → PENDING → match() → MATCHED → settle() → SETTLED → claim()
 *
 * Each match has its own entryPrice — price is fixed
 * at match time, not at market creation.
 * This allows matching bets at any time.
 */
contract OrderbookMarket is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── TYPES ──────────────────────────────────────────────
    enum Direction   { UP, DOWN }
    enum OrderStatus { PENDING, MATCHED, SETTLED, CLAIMED, REFUNDED }

    struct Order {
        address     trader;
        Direction   direction;
        uint256     amount;
        address     referrer;
        OrderStatus status;
        uint256     placedAt;
        uint256     matchId;    // 0 if not matched
        uint256     payout;     // filled on settlement
    }

    struct Match {
        uint256 upOrderId;
        uint256 downOrderId;
        uint256 amount;       // min(upOrder.amount, downOrder.amount)
        uint256 entryPrice;   // price at match time
        uint256 settleAt;     // matchedAt + duration
        uint256 exitPrice;    // filled on resolution
        bool    settled;
        bool    upWon;
        bool    lpMatch;      // true if matched with LP pool
    }

    // ── CONSTANTS ──────────────────────────────────────────
    uint256 public constant MIN_BET       = 1e6;       // 1 USDC
    uint256 public constant MAX_BET       = 100e6;     // 100 USDC, remove after audit
    uint256 public constant MATCH_TIMEOUT = 5 minutes; // max wait → refund

    // ── TIMELOCK / FEE STATE ───────────────────────────────
    uint256 public feeBps = 0;
    uint256 public pendingFeeBps;
    uint256 public feeChangeAvailableAt;
    uint256 public constant FEE_TIMELOCK = 48 hours;
    uint256 public constant FEE_MAX = 100; // max 1%

    // ── IMMUTABLES ─────────────────────────────────────────
    IERC20  public immutable usdc;
    address public immutable resolver;
    address public immutable liquidityPool;
    address public immutable feeDistributor;
    address public immutable referralRegistry;
    address public immutable multisig;
    bytes32 public immutable pythFeedId;
    uint256 public immutable duration;

    // ── STATE ──────────────────────────────────────────────
    uint256 public nextOrderId = 1;
    uint256 public nextMatchId = 1;

    mapping(uint256 => Order) public orders;
    mapping(uint256 => Match) public matches;

    // Pending queues
    uint256[] public pendingUpQueue;
    uint256[] public pendingDownQueue;

    // trader → their orderIds
    mapping(address => uint256[]) public traderOrders;

    // matchIds that need settlement (for keeper/resolver)
    uint256[] public pendingSettlements;

    // ── EVENTS ─────────────────────────────────────────────
    event OrderPlaced  (uint256 indexed orderId, address indexed trader, Direction dir, uint256 amount);
    event OrderMatched (uint256 indexed matchId, uint256 upId, uint256 downId, uint256 entryPrice);
    event LPMatched    (uint256 indexed matchId, uint256 orderId, uint256 entryPrice);
    event MatchSettled (uint256 indexed matchId, bool upWon, uint256 entry, uint256 exit);
    event OrderRefunded(uint256 indexed orderId, address trader, uint256 amount);
    event Claimed      (uint256 indexed orderId, address trader, uint256 payout);
    event FeeChangeProposed(uint256 newFeeBps, uint256 availableAt);
    event FeeChanged   (uint256 newFeeBps);

    // ── CONSTRUCTOR ────────────────────────────────────────
    constructor(
        address _usdc,
        address _resolver,
        address _liquidityPool,
        address _feeDistributor,
        address _referralRegistry,
        address _multisig,
        bytes32 _pythFeedId,
        uint256 _duration
    ) {
        usdc             = IERC20(_usdc);
        resolver         = _resolver;
        liquidityPool    = _liquidityPool;
        feeDistributor   = _feeDistributor;
        referralRegistry = _referralRegistry;
        multisig         = _multisig;
        pythFeedId       = _pythFeedId;
        duration         = _duration;
    }

    // ── PLACE BET ──────────────────────────────────────────
    /**
     * @notice Place a bet.
     *         Immediately tries PvP match → LP match → queue.
     */
    function placeBet(
        Direction dir,
        uint256   amount,
        address   referrer,
        uint256   expectedPrice,  // passed from frontend via Pyth
        uint256   slippageBps     // allowed deviation, e.g. 50 = 0.5%
    ) external nonReentrant whenNotPaused returns (uint256 orderId) {
        require(amount >= MIN_BET,        "below min");
        require(amount <= MAX_BET,        "above max");
        require(referrer != msg.sender,   "self referral");

        uint256 actualPrice = _getCurrentPrice();

        uint256 diff = actualPrice > expectedPrice
            ? actualPrice - expectedPrice
            : expectedPrice - actualPrice;

        uint256 spread = diff * 10_000 / expectedPrice;
        require(spread <= slippageBps, "price slippage exceeded");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Register referral on first touch — best-effort, must not block the bet.
        if (referrer != address(0) && referralRegistry != address(0)) {
            try IReferralRegistry(referralRegistry).register(msg.sender, referrer) {} catch {}
        }

        orderId = nextOrderId++;
        orders[orderId] = Order({
            trader:    msg.sender,
            direction: dir,
            amount:    amount,
            referrer:  referrer,
            status:    OrderStatus.PENDING,
            placedAt:  block.timestamp,
            matchId:   0,
            payout:    0
        });
        traderOrders[msg.sender].push(orderId);

        emit OrderPlaced(orderId, msg.sender, dir, amount);

        // Try match immediately
        _tryMatch(orderId, dir, amount, actualPrice);
    }

    // ── MATCHING LOGIC ─────────────────────────────────────
    /**
     * @notice Match attempt: first orderbook, then LP.
     */
    function _tryMatch(
        uint256   orderId,
        Direction dir,
        uint256   amount,
        uint256   currentPrice
    ) internal {
        // Layer 1: find PvP opponent in queue
        uint256[] storage oppositeQueue = dir == Direction.UP
            ? pendingDownQueue
            : pendingUpQueue;

        for (uint256 i = 0; i < oppositeQueue.length; i++) {
            uint256 candidateId = oppositeQueue[i];
            Order storage candidate = orders[candidateId];

            // Skip stale or already matched
            if (candidate.status != OrderStatus.PENDING) continue;
            if (block.timestamp - candidate.placedAt > MATCH_TIMEOUT) continue;

            // Match! Take minimum amount
            uint256 matchAmount = amount < candidate.amount ? amount : candidate.amount;
            _createMatch(orderId, candidateId, dir, matchAmount, currentPrice, false);

            // Remove from queue
            _removeFromQueue(oppositeQueue, i);
            return;
        }

        // Layer 2: try LP pool
        if (liquidityPool != address(0)) {
            uint256 matchId = nextMatchId; // will be used by _createMatch
            bool lpMatched = ILiquidityPool(liquidityPool).tryMatch(
                orderId, amount, dir == Direction.UP, matchId
            );
            if (lpMatched) {
                _createMatch(orderId, 0, dir, amount, currentPrice, true);
                return;
            }
        }

        // Layer 3: add to pending queue
        if (dir == Direction.UP) {
            pendingUpQueue.push(orderId);
        } else {
            pendingDownQueue.push(orderId);
        }
    }

    function _createMatch(
        uint256   orderId,
        uint256   oppositeId,
        Direction dir,
        uint256   amount,
        uint256   entryPrice,
        bool      isLpMatch
    ) internal {
        uint256 matchId = nextMatchId++;

        uint256 upId   = dir == Direction.UP ? orderId   : oppositeId;
        uint256 downId = dir == Direction.UP ? oppositeId : orderId;

        matches[matchId] = Match({
            upOrderId:   upId,
            downOrderId: downId,
            amount:      amount,
            entryPrice:  entryPrice,
            settleAt:    block.timestamp + duration,
            exitPrice:   0,
            settled:     false,
            upWon:       false,
            lpMatch:     isLpMatch
        });

        orders[orderId].status  = OrderStatus.MATCHED;
        orders[orderId].matchId = matchId;

        if (!isLpMatch) {
            orders[oppositeId].status  = OrderStatus.MATCHED;
            orders[oppositeId].matchId = matchId;
            emit OrderMatched(matchId, upId, downId, entryPrice);
        } else {
            emit LPMatched(matchId, orderId, entryPrice);
        }

        // Track for settlement
        pendingSettlements.push(matchId);
    }

    // ── SETTLE ─────────────────────────────────────────────
    /**
     * @notice Called by OracleResolver after duration expires.
     */
    function settleMatch(
        uint256 matchId,
        uint256 exitPrice
    ) external {
        require(msg.sender == resolver, "only resolver");
        Match storage m = matches[matchId];
        require(!m.settled,                  "already settled");
        require(block.timestamp >= m.settleAt, "too early");

        m.settled   = true;
        m.exitPrice = exitPrice;
        m.upWon     = exitPrice > m.entryPrice;

        // Update order statuses
        if (!m.lpMatch) {
            // PvP: settle both orders
            _settleOrder(m.upOrderId,   m.upWon,  m);
            _settleOrder(m.downOrderId, !m.upWon, m);
        } else {
            // LP match: find the user's order (non-zero id) and settle it
            bool userIsUp = m.upOrderId != 0;
            uint256 userOrderId = userIsUp ? m.upOrderId : m.downOrderId;
            bool userWon = userIsUp ? m.upWon : !m.upWon;

            _settleOrder(userOrderId, userWon, m);

            if (!userWon) {
                // LP won: transfer both stakes (user's + LP's) to pool
                usdc.safeTransfer(liquidityPool, m.amount * 2);
            }
            // If user won: market keeps funds for user to claim via claim()

            // Notify LP pool of result (updates accounting)
            ILiquidityPool(liquidityPool).onMatchSettled(matchId, m.upWon);
        }

        emit MatchSettled(matchId, m.upWon, m.entryPrice, exitPrice);
    }

    function _settleOrder(
        uint256 orderId,
        bool    won,
        Match storage m
    ) internal {
        Order storage o = orders[orderId];
        o.status = OrderStatus.SETTLED;

        if (won) {
            uint256 totalPool = m.amount * 2;
            uint256 fee       = (totalPool * feeBps) / 10_000;
            o.payout = totalPool - fee;
            
            if (fee > 0 && feeDistributor != address(0)) {
                usdc.safeTransfer(feeDistributor, fee);
                IFeeDistributor(feeDistributor).distributeFee(fee, o.referrer);
            }
        }
    }

    // ── CLAIM ──────────────────────────────────────────────
    function claim(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.trader == msg.sender,          "not your order");
        require(o.status == OrderStatus.SETTLED, "not settled");
        require(o.payout > 0,                    "nothing to claim");

        o.status = OrderStatus.CLAIMED;
        usdc.safeTransfer(msg.sender, o.payout);

        emit Claimed(orderId, msg.sender, o.payout);
    }

    // ── REFUND EXPIRED ─────────────────────────────────────
    /**
     * @notice Refund bets that didn't match within MATCH_TIMEOUT.
     *         Called by keeper or by the user themselves.
     */
    function refundExpired(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.PENDING,                   "not pending");
        require(block.timestamp > o.placedAt + MATCH_TIMEOUT,     "not expired");

        o.status = OrderStatus.REFUNDED;
        usdc.safeTransfer(o.trader, o.amount);

        emit OrderRefunded(orderId, o.trader, o.amount);
    }

    // ── HELPERS ────────────────────────────────────────────
    function _removeFromQueue(uint256[] storage queue, uint256 index) internal {
        queue[index] = queue[queue.length - 1];
        queue.pop();
    }

    // ── VIEWS ──────────────────────────────────────────────
    function getPendingDepth() external view returns (uint256 up, uint256 down) {
        return (pendingUpQueue.length, pendingDownQueue.length);
    }

    function getTraderOrders(address trader) external view returns (uint256[] memory) {
        return traderOrders[trader];
    }

    /**
     * @notice Returns matchIds that are ready for settlement.
     *         Used by keeper/resolver to know which matches to settle.
     */
    function getPendingSettlements() external view returns (uint256[] memory ready) {
        uint256 count = 0;
        for (uint256 i = 0; i < pendingSettlements.length; i++) {
            Match storage m = matches[pendingSettlements[i]];
            if (!m.settled && block.timestamp >= m.settleAt) {
                count++;
            }
        }

        ready = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < pendingSettlements.length; i++) {
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
    function _getCurrentPrice() internal view returns (uint256) {
        address pythAddress = IOracleResolver(resolver).pyth();
        // 60 seconds max age
        IPyth.Price memory p = IPyth(pythAddress).getPriceNoOlderThan(pythFeedId, 60);

        int32 expo = p.expo;
        uint256 price = uint256(int256(p.price));
        if (expo < 0) {
            uint256 divisor = 10 ** uint32(-expo);
            return price * 1e18 / divisor;
        } else {
            return price * 1e18 * (10 ** uint32(expo));
        }
    }

    // ── ADMIN ──────────────────────────────────────────────
    function proposeNewFee(uint256 newFeeBps) external {
        require(msg.sender == multisig, "only multisig");
        require(newFeeBps <= FEE_MAX, "fee too high");
        pendingFeeBps = newFeeBps;
        feeChangeAvailableAt = block.timestamp + FEE_TIMELOCK;
        emit FeeChangeProposed(newFeeBps, feeChangeAvailableAt);
    }

    function applyNewFee() external {
        require(msg.sender == multisig, "only multisig");
        require(feeChangeAvailableAt != 0, "no proposal");
        require(block.timestamp >= feeChangeAvailableAt, "timelock");
        feeBps = pendingFeeBps;
        feeChangeAvailableAt = 0;
        emit FeeChanged(feeBps);
    }

    function pause()   external { require(msg.sender == multisig, "only multisig"); _pause();   }
    function unpause() external { require(msg.sender == multisig, "only multisig"); _unpause(); }
}
