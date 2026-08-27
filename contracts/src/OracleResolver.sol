// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IPyth.sol";
import "./OrderbookMarket.sol";

/**
 * @title OracleResolver
 * @notice Читает Pyth, считает TWAP, вызывает settle() на рынках.
 *         Поддерживает PvPMarket (legacy) и OrderbookMarket (новый).
 *         Вызывается keeper-ом каждые N минут.
 */
contract OracleResolver is AccessControl {

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    IPyth public immutable pyth;

    // TWAP: feedId → array {price, timestamp}.
    // historyHead[feedId] marks the first still-relevant index; cleanup just
    // advances the head (amortized O(1)) instead of shifting the array.
    struct PricePoint { uint256 price; uint256 ts; }
    mapping(bytes32 => PricePoint[]) public priceHistory;
    mapping(bytes32 => uint256) public historyHead;

    // Exit TWAP window is scaled to the market's own duration instead of a
    // flat constant (Sprint 5.5 audit fix): for a 5-minute market, a flat
    // 5-minute window covers the ENTIRE match, so "exit price" ends up
    // being "average price over the whole bet" — heavily diluted by stale
    // early-period ticks — instead of a short, representative end-of-period
    // close. Longer markets (1h/4h/24h) still cap at TWAP_WINDOW_CAP so the
    // window never grows unreasonably large.
    uint256 public constant TWAP_WINDOW_CAP = 5 minutes;
    uint256 public constant MIN_TWAP_WINDOW = 30 seconds;
    uint256 public constant MAX_PRICE_AGE = 60; // секунд
    uint256 public constant MAX_SPREAD_BPS = 200; // 2% — если больше → отмена рынка

    /**
     * How long price points are kept.
     *
     * The exit price is now averaged over the window ending at each match's own
     * settleAt (see _getTWAPAt), so history has to outlive a late keeper or
     * there is nothing to settle against. It used to be pruned at 10 minutes,
     * which is shorter than a routine container restart — with anchored pricing
     * that would have made every match after a short outage unsettleable.
     *
     * Two hours is the compromise: it absorbs ordinary operational blips while
     * keeping the array bounded (~240 points per feed at the 30s push cadence).
     * Past it a match cannot be priced honestly at all, and the right outcome is
     * the permissionless emergencyRefundMatch, not a made-up winner.
     */
    uint256 public constant HISTORY_RETENTION = 2 hours;

    /// Caps the backward scan in _getTWAPAt so a long history can't make
    /// settlement cost unbounded gas.
    uint256 private constant MAX_SCAN = 512;

    event PriceRecorded(bytes32 indexed feedId, uint256 price, uint256 ts);
    event MarketResolved(address indexed market, bool upWon, uint256 entry, uint256 exit);
    event MarketRefunded(address indexed market, string reason);
    /// A match came due but no recorded price covers its settleAt window.
    event MatchUnpriceable(address indexed market, uint256 indexed matchId, uint256 settleAt);

    constructor(address _pyth) {
        pyth = IPyth(_pyth);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ── RECORD PRICE ───────────────────────────────────────
    /**
     * @notice Записать текущую цену в историю (вызывать каждые 30 сек keeper-ом).
     * @param feedId           Pyth feed ID
     * @param priceUpdateData  Bytes от Pyth Hermes API
     */
    function recordPrice(
        bytes32 feedId,
        bytes[] calldata priceUpdateData
    ) external onlyRole(KEEPER_ROLE) {
        uint256 updateFee = pyth.getUpdateFee(priceUpdateData);
        pyth.updatePriceFeeds{value: updateFee}(priceUpdateData);

        IPyth.Price memory p = pyth.getPriceNoOlderThan(feedId, MAX_PRICE_AGE);
        uint256 price = _normalizePrice(p);

        priceHistory[feedId].push(PricePoint({price: price, ts: block.timestamp}));
        // Чистить старые точки (старше 10 минут)
        _cleanHistory(feedId);

        emit PriceRecorded(feedId, price, block.timestamp);
    }

    // ── RESOLVE ORDERBOOK MATCH ────────────────────────────
    /**
     * @notice Settle a single match on an OrderbookMarket.
     * @param market           Address of OrderbookMarket
     * @param matchId          Match ID to settle
     * @param priceUpdateData  Fresh Pyth Hermes data
     */
    function resolveOrderbookMatch(
        address market,
        uint256 matchId,
        bytes[] calldata priceUpdateData
    ) external onlyRole(KEEPER_ROLE) {
        OrderbookMarket m = OrderbookMarket(market);
        bytes32 feedId = m.pythFeedId();

        // Get fresh price
        uint256 updateFee = pyth.getUpdateFee(priceUpdateData);
        pyth.updatePriceFeeds{value: updateFee}(priceUpdateData);

        // TWAP exit price, windowed to this market's own duration.
        uint256 exitTwap = _getTWAP(feedId, _twapWindowFor(m.duration()));

        // Anomaly check
        IPyth.Price memory spot = pyth.getPriceNoOlderThan(feedId, MAX_PRICE_AGE);
        uint256 spotPrice = _normalizePrice(spot);
        if (_spread(exitTwap, spotPrice) > MAX_SPREAD_BPS) {
            emit MarketRefunded(market, "oracle spread too high");
            return;
        }

        m.settleMatch(matchId, exitTwap);
        emit MarketResolved(market, exitTwap > m.getMatch(matchId).entryPrice, m.getMatch(matchId).entryPrice, exitTwap);
    }

    /**
     * @notice Batch-settle all pending matches on an OrderbookMarket.
     *         Kept as a thin wrapper around the bounded batch for back-compat;
     *         prefer resolveOrderbookMarketBatch to pin per-tx gas.
     * @param market           Address of OrderbookMarket
     * @param priceUpdateData  Fresh Pyth Hermes data
     */
    function resolveOrderbookMarket(
        address market,
        bytes[] calldata priceUpdateData
    ) external onlyRole(KEEPER_ROLE) {
        _resolveBatch(market, priceUpdateData, 0); // 0 = all ready
    }

    /**
     * @notice Bounded batch-settle. Caller picks `maxCount` to keep gas under a
     *         reliable cap (≈ 1.5M for ~25 settlements at current contract size).
     *         Returns the number of matches actually settled in this call so
     *         keepers can loop until all ready matches are flushed.
     */
    function resolveOrderbookMarketBatch(
        address market,
        bytes[] calldata priceUpdateData,
        uint256 maxCount
    ) external onlyRole(KEEPER_ROLE) returns (uint256 settled) {
        return _resolveBatch(market, priceUpdateData, maxCount);
    }

    function _resolveBatch(
        address market,
        bytes[] calldata priceUpdateData,
        uint256 maxCount
    ) internal returns (uint256 settled) {
        OrderbookMarket m = OrderbookMarket(market);
        bytes32 feedId    = m.pythFeedId();

        uint256 updateFee = pyth.getUpdateFee(priceUpdateData);
        pyth.updatePriceFeeds{value: updateFee}(priceUpdateData);

        uint256 window = _twapWindowFor(m.duration());
        uint256[] memory ready = m.getReadySettlements(0, maxCount);

        // Each match is priced at its OWN settleAt. A single batch-wide exit
        // price was wrong twice: matches in one market have different settleAt
        // values, and the price was read at keeper time rather than at the
        // moment the bet was actually due.
        for (uint256 i = 0; i < ready.length; i++) {
            uint256 settleAt = m.getMatch(ready[i]).settleAt;
            (uint256 exitTwap, uint256 spotAtAnchor, bool ok) =
                _getTWAPAt(feedId, window, settleAt);

            if (!ok) {
                // No recorded price anywhere near this match's deadline —
                // usually a keeper outage longer than HISTORY_RETENTION. Skip
                // it rather than inventing a winner; once SETTLE_GRACE lapses
                // anyone can call emergencyRefundMatch and both sides get their
                // stake back.
                emit MatchUnpriceable(market, ready[i], settleAt);
                continue;
            }

            // Two anomaly checks, because they catch different things.
            //
            // (a) Internal consistency: the average over the window versus the
            //     last tick at or before settleAt. Meaningful at any age.
            if (_spread(exitTwap, spotAtAnchor) > MAX_SPREAD_BPS) {
                emit MarketRefunded(market, "oracle spread too high");
                continue;
            }
            // (b) History versus live reality: the original guard, which is what
            //     catches stale or poisoned history. Only applied when we are
            //     settling promptly — for a match that came due hours ago the
            //     recorded price and the current spot legitimately differ, and
            //     comparing them would block every overdue settlement. Kept
            //     tight (MAX_PRICE_AGE) so a memecoin's ordinary 2% drift over a
            //     few minutes doesn't trip it on the happy path.
            if (block.timestamp <= settleAt + MAX_PRICE_AGE) {
                IPyth.Price memory spot = pyth.getPriceNoOlderThan(feedId, MAX_PRICE_AGE);
                if (_spread(exitTwap, _normalizePrice(spot)) > MAX_SPREAD_BPS) {
                    emit MarketRefunded(market, "oracle spread too high");
                    continue;
                }
            }

            m.settleMatch(ready[i], exitTwap);
            settled++;
            emit MarketResolved(market, exitTwap > m.getMatch(ready[i]).entryPrice,
                                m.getMatch(ready[i]).entryPrice, exitTwap);
        }
    }

    // ── TWAP ───────────────────────────────────────────────
    /// @dev Scales the exit TWAP window to a market's own duration so short
    ///      markets don't average over their entire lifetime. Floored at
    ///      MIN_TWAP_WINDOW, capped at TWAP_WINDOW_CAP.
    function _twapWindowFor(uint256 duration) internal pure returns (uint256) {
        uint256 scaled = duration / 5;
        if (scaled > TWAP_WINDOW_CAP)  return TWAP_WINDOW_CAP;
        if (scaled < MIN_TWAP_WINDOW)  return MIN_TWAP_WINDOW;
        return scaled;
    }

    function _getTWAP(bytes32 feedId, uint256 window) internal view returns (uint256) {
        (uint256 twap, , bool ok) = _getTWAPAt(feedId, window, block.timestamp);
        require(ok, "no price data");
        return twap;
    }

    /**
     * @dev TWAP over the window ENDING AT `anchor`, plus the last price at or
     *      before `anchor`.
     *
     *      The window used to end at block.timestamp, i.e. whenever the keeper
     *      happened to run. Nothing tied the exit price to the moment the match
     *      was actually due, so a keeper that came back six hours late settled
     *      every overdue match against the price six hours later: a user who was
     *      right at their settleAt could lose their whole stake because the coin
     *      moved afterwards. The 2% spread guard could not catch it either — it
     *      compared the current TWAP against the current spot, which of course
     *      agreed.
     *
     *      Returns ok=false rather than reverting when the window holds no data,
     *      so one unpriceable match cannot block a whole batch.
     */
    function _getTWAPAt(bytes32 feedId, uint256 window, uint256 anchor)
        internal view returns (uint256 twap, uint256 spotAtAnchor, bool ok)
    {
        PricePoint[] storage history = priceHistory[feedId];
        uint256 head   = historyHead[feedId];
        uint256 cutoff = anchor > window ? anchor - window : 0;

        uint256 sum   = 0;
        uint256 count = 0;
        uint256 scanned = 0;

        for (uint256 i = history.length; i > head; i--) {
            if (scanned++ >= MAX_SCAN) break;
            PricePoint storage p = history[i-1];
            if (p.ts > anchor) continue;          // not yet due at settleAt
            if (p.ts < cutoff) break;             // older than the window
            if (count == 0) spotAtAnchor = p.price; // newest point <= anchor
            sum += p.price;
            count++;
        }

        if (count == 0) return (0, 0, false);
        return (sum / count, spotAtAnchor, true);
    }

    function _spread(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0 || b == 0) return 10_000;
        uint256 diff = a > b ? a - b : b - a;
        return (diff * 10_000) / ((a + b) / 2);
    }

    function _normalizePrice(IPyth.Price memory p) internal pure returns (uint256) {
        // Pyth возвращает price * 10^expo, нормализуем к 1e18
        int32 expo = p.expo;
        uint256 price = uint256(int256(p.price));
        if (expo < 0) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 divisor = 10 ** uint32(-expo);
            return price * 1e18 / divisor;
        } else {
            // forge-lint: disable-next-line(unsafe-typecast)
            return price * 1e18 * (10 ** uint32(expo));
        }
    }

    function _cleanHistory(bytes32 feedId) internal {
        if (block.timestamp < HISTORY_RETENTION) return; // prevent underflow
        uint256 cutoff = block.timestamp - HISTORY_RETENTION;
        PricePoint[] storage history = priceHistory[feedId];
        uint256 i = historyHead[feedId];
        // Advance head past stale entries; do NOT shift the array.
        while (i < history.length && history[i].ts < cutoff) i++;
        historyHead[feedId] = i;
    }

    // Keeper может пополнять ETH для оплаты Pyth updates
    receive() external payable {}

    function addKeeper(address keeper) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(KEEPER_ROLE, keeper);
    }

    function removeKeeper(address keeper) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(KEEPER_ROLE, keeper);
    }

    /// @notice Withdraw stuck ETH (leftover from Pyth fee top-ups).
    function withdrawETH(address payable to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "eth withdraw failed");
    }
}
