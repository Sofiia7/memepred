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

    uint256 public constant TWAP_WINDOW = 5 minutes;
    uint256 public constant MAX_PRICE_AGE = 60; // секунд
    uint256 public constant MAX_SPREAD_BPS = 200; // 2% — если больше → отмена рынка

    event PriceRecorded(bytes32 indexed feedId, uint256 price, uint256 ts);
    event MarketResolved(address indexed market, bool upWon, uint256 entry, uint256 exit);
    event MarketRefunded(address indexed market, string reason);

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

        // TWAP exit price
        uint256 exitTwap = _getTWAP(feedId);

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

        uint256 exitTwap = _getTWAP(feedId);

        // Anomaly check: TWAP vs spot.
        IPyth.Price memory spot = pyth.getPriceNoOlderThan(feedId, MAX_PRICE_AGE);
        uint256 spotPrice = _normalizePrice(spot);
        if (_spread(exitTwap, spotPrice) > MAX_SPREAD_BPS) {
            emit MarketRefunded(market, "oracle spread too high");
            return 0;
        }

        uint256[] memory ready = m.getReadySettlements(0, maxCount);
        for (uint256 i = 0; i < ready.length; i++) {
            m.settleMatch(ready[i], exitTwap);
        }
        settled = ready.length;

        if (settled > 0) {
            emit MarketResolved(market, true, 0, exitTwap);
        }
    }

    // ── TWAP ───────────────────────────────────────────────
    function _getTWAP(bytes32 feedId) internal view returns (uint256) {
        PricePoint[] storage history = priceHistory[feedId];
        uint256 head   = historyHead[feedId];
        uint256 cutoff = block.timestamp > TWAP_WINDOW ? block.timestamp - TWAP_WINDOW : 0;
        uint256 sum = 0;
        uint256 count = 0;

        for (uint256 i = history.length; i > head; i--) {
            if (history[i-1].ts < cutoff) break;
            sum += history[i-1].price;
            count++;
        }

        require(count > 0, "no price data");
        return sum / count;
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
        if (block.timestamp < 10 minutes) return; // prevent underflow
        uint256 cutoff = block.timestamp - 10 minutes;
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
