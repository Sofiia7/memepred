// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./OrderbookMarket.sol";
import "./interfaces/IUniswapV3.sol";
import "./lib/TickMath.sol";

/**
 * @title  PoolOracleResolver
 * @notice Settles OrderbookMarket matches priced from a token's own Uniswap v3
 *         pool, for Robinhood Chain.
 *
 * @dev    A neighbour of OracleResolver, not a replacement. OracleResolver
 *         keeps serving Base through RedStone and is not touched: the two run
 *         on different chains against different deployments, and the rule for
 *         this branch is that nothing existing gets rewritten in place.
 *
 *         The entrypoints, roles and events match OracleResolver exactly, so
 *         the keeper, the indexer and the watchdog do not learn a second
 *         vocabulary. What changes is where a price comes from.
 *
 *         **Why a pool and not a feed.** RedStone carries PEPE, DOGE, BRETT,
 *         WIF, BONK, SHIB and FLOKI. A token that graduated on a Robinhood
 *         Chain launchpad an hour ago will never be on that list - 496 pools a
 *         day are created here (measured, docs/rhc/measurements) and no oracle
 *         provider will ever cover them. The pool itself is the only thing that
 *         knows what the token is worth, and v3 pools carry their own TWAP
 *         oracle, so reading it costs the keeper nothing.
 *
 *         **What that deletes.** priceHistory, historyHead, recordPrice,
 *         _cleanHistory and HISTORY_RETENTION are all gone: the pool stores the
 *         history, so we do not. That removes a state array, a keeper cycle and
 *         the entire class of failure where settlement stops because nobody
 *         pushed a price. It also removes the RedStone payload, and with it the
 *         requirement that every call be hand-assembled calldata rather than an
 *         ordinary writeContract.
 *
 *         **What that costs.** The pool's observation ring is finite, so a
 *         match can age out of it. observe() reverting 'OLD' is a supported
 *         outcome: it becomes MatchUnpriceable, exactly as an outage longer
 *         than HISTORY_RETENTION does on Base, and then SETTLE_GRACE and
 *         emergencyRefundMatch take over. PoolMarketFactory's cardinality gate
 *         is what keeps that rare.
 */
contract PoolOracleResolver is AccessControl {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    /// WETH on this chain: every market prices its token against it.
    address public immutable weth;

    // ── Windows and guards, copied from OracleResolver ─────
    // Deliberately identical values with identical meanings. A market on this
    // chain should behave the way a market on Base behaves; the oracle changed,
    // the product did not.

    /// @dev Scales the exit TWAP window to a market's own duration so short
    ///      markets don't average over their entire lifetime. Floored at
    ///      MIN_TWAP_WINDOW, capped at TWAP_WINDOW_CAP.
    uint256 public constant TWAP_WINDOW_CAP = 5 minutes;
    uint256 public constant MIN_TWAP_WINDOW = 30 seconds;

    /**
     * The window the entry strike is averaged over.
     *
     * Not the spot tick: a pool holding a few ETH moves several percent on one
     * swap, so a spot strike is something the counterparty can place for you.
     * Sixty seconds is short enough to be the price you think you are getting
     * and long enough that moving it costs more than the bet is worth.
     */
    uint32 public constant ENTRY_TWAP_WINDOW = 60 seconds;

    /**
     * How promptly a settlement has to happen for the live-price check to run.
     * Same reasoning as OracleResolver: for a match that came due hours ago the
     * anchored price and the current spot legitimately differ, and comparing
     * them would block every overdue settlement.
     */
    uint256 public constant MAX_PRICE_AGE = 3 minutes;

    uint256 public constant MAX_SPREAD_BPS = 200; // 2%, past that the match is refunded

    event MarketResolved(address indexed market, bool upWon, uint256 entry, uint256 exit);
    event MarketRefunded(address indexed market, string reason);
    /// A match came due but the pool cannot price its settleAt window.
    event MatchUnpriceable(address indexed market, uint256 indexed matchId, uint256 settleAt);

    error ZeroAddress();
    /// A pool reported a mean tick outside Uniswap's own tick range.
    error TickOutOfPoolRange(int56 meanTick);

    constructor(address _weth) {
        if (_weth == address(0)) revert ZeroAddress();
        weth = _weth;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ── FEED ID ────────────────────────────────────────────
    /**
     * @notice The pool a market's feedId refers to.
     * @dev    feedId stays bytes32 in all 68 places it appears rather than
     *         becoming an address. The markets, the indexer, the subgraph and
     *         the events all keep their signatures; only the interpretation
     *         changes, and it changes in exactly one function.
     */
    function poolOf(bytes32 feedId) public pure returns (IUniswapV3Pool) {
        return IUniswapV3Pool(address(uint160(uint256(feedId))));
    }

    // ── ENTRY PRICE ────────────────────────────────────────
    /**
     * @notice Current strike for a market, as a WAD price of the token in WETH.
     * @dev    PoolOrderbookMarket._getCurrentPrice() calls this rather than
     *         doing the arithmetic itself, which keeps TickMath out of the
     *         market's bytecode - it inherits a RedStone consumer it cannot
     *         drop and has ~6.7kB of EIP-170 headroom to spend. It also leaves
     *         one implementation of tick-to-price instead of two, which is the
     *         mistake _settleOne exists to document.
     *
     *         Reverts rather than returning zero: this is the entry path, and a
     *         bet placed at a strike nobody could compute is worse than a bet
     *         that did not happen.
     */
    function spotPriceWad(bytes32 feedId) external view returns (uint256) {
        IUniswapV3Pool pool = poolOf(feedId);
        (bool ok, int24 tick) = _meanTick(pool, ENTRY_TWAP_WINDOW, 0);
        require(ok, "pool cannot price entry");
        require(pool.liquidity() > 0, "pool has no liquidity");
        return _quoteWad(pool.token0(), tick);
    }

    // ── RESOLVE ORDERBOOK MATCH ────────────────────────────
    /// @notice Settle a single match on an OrderbookMarket.
    function resolveOrderbookMatch(address market, uint256 matchId) external onlyRole(KEEPER_ROLE) {
        OrderbookMarket m = OrderbookMarket(market);
        PoolView memory pv = _poolView(m.feedId());
        _settleOne(m, pv, _twapWindowFor(m.duration()), matchId);
    }

    /// @notice Batch-settle all pending matches. Thin wrapper on the bounded
    ///         batch, kept for parity with OracleResolver.
    function resolveOrderbookMarket(address market) external onlyRole(KEEPER_ROLE) {
        _resolveBatch(market, 0, 0);
    }

    /// @notice Bounded batch-settle; returns how many matches actually settled.
    function resolveOrderbookMarketBatch(address market, uint256 maxCount)
        external
        onlyRole(KEEPER_ROLE)
        returns (uint256 settled)
    {
        return _resolveBatch(market, 0, maxCount);
    }

    /// @notice Settle a window starting `offset` past the queue head, so one
    ///         stuck match at the head cannot hide everything behind it.
    function resolveOrderbookMarketBatchFrom(address market, uint256 offset, uint256 maxCount)
        external
        onlyRole(KEEPER_ROLE)
        returns (uint256 settled)
    {
        return _resolveBatch(market, offset, maxCount);
    }

    /**
     * Pool facts that are the same for every match in a batch. Read once here
     * rather than per match: token0 and liquidity are two external calls, and
     * fifty matches on one market would otherwise pay for a hundred of them.
     */
    struct PoolView {
        IUniswapV3Pool pool;
        address token0;
        bool hasLiquidity;
    }

    function _poolView(bytes32 feedId) internal view returns (PoolView memory pv) {
        pv.pool = poolOf(feedId);
        pv.token0 = pv.pool.token0();
        pv.hasLiquidity = pv.pool.liquidity() > 0;
    }

    function _resolveBatch(address market, uint256 offset, uint256 maxCount) internal returns (uint256 settled) {
        OrderbookMarket m = OrderbookMarket(market);
        PoolView memory pv = _poolView(m.feedId());

        uint256 window = _twapWindowFor(m.duration());
        uint256[] memory ready = m.getReadySettlements(offset, maxCount);

        for (uint256 i = 0; i < ready.length; i++) {
            if (_settleOne(m, pv, window, ready[i])) settled++;
        }
    }

    /**
     * @dev Settle one match, priced at its OWN settleAt. Returns false when the
     *      match was skipped rather than settled.
     *
     *      Anchoring at settleAt rather than at block.timestamp is the same
     *      rule OracleResolver enforces and for the same reason: a keeper that
     *      comes back late must not settle every overdue match against the
     *      price at the time it happened to wake up. On a pool that anchoring
     *      is free, because observe() takes the offsets we ask for.
     */
    function _settleOne(OrderbookMarket m, PoolView memory pv, uint256 window, uint256 matchId)
        internal
        returns (bool)
    {
        address market = address(m);
        uint256 settleAt = m.getMatch(matchId).settleAt;

        if (!pv.hasLiquidity) {
            // The pool died under the position. Nothing here can be priced
            // honestly, and a drained pool quotes whatever the last swap left
            // behind, so refuse rather than settle against it.
            emit MatchUnpriceable(market, matchId, settleAt);
            return false;
        }

        (uint256 exitTwap, uint256 spotAtAnchor, bool ok) = _twapWadAt(pv, window, settleAt);
        if (!ok) {
            // The observation ring no longer reaches back to this match's
            // deadline. Same outcome as a keeper outage on Base: skip it, and
            // once SETTLE_GRACE lapses anyone can call emergencyRefundMatch.
            emit MatchUnpriceable(market, matchId, settleAt);
            return false;
        }

        // Two anomaly checks, because they catch different things.
        //
        // (a) Internal consistency: the average over the window versus the last
        //     tick at or before settleAt. Meaningful at any age.
        if (_spread(exitTwap, spotAtAnchor) > MAX_SPREAD_BPS) {
            emit MarketRefunded(market, "oracle spread too high");
            return false;
        }
        // (b) Anchored price versus live reality, which catches a pool that has
        //     been shoved since. Only when we are settling promptly - past
        //     MAX_PRICE_AGE the two legitimately differ and comparing them
        //     would block every overdue settlement.
        if (block.timestamp <= settleAt + MAX_PRICE_AGE) {
            (, int24 liveTick,,,,,) = pv.pool.slot0();
            if (_spread(exitTwap, _quoteWad(pv.token0, liveTick)) > MAX_SPREAD_BPS) {
                emit MarketRefunded(market, "oracle spread too high");
                return false;
            }
        }

        m.settleMatch(matchId, exitTwap);
        emit MarketResolved(market, exitTwap > m.getMatch(matchId).entryPrice, m.getMatch(matchId).entryPrice, exitTwap);
        return true;
    }

    // ── TWAP ───────────────────────────────────────────────
    /// @dev Identical to OracleResolver._twapWindowFor, deliberately. Copied
    ///      rather than shared because the two contracts must be free to
    ///      diverge without one chain's tuning silently moving the other's.
    function _twapWindowFor(uint256 duration) internal pure returns (uint256) {
        uint256 scaled = duration / 5;
        if (scaled > TWAP_WINDOW_CAP) return TWAP_WINDOW_CAP;
        if (scaled < MIN_TWAP_WINDOW) return MIN_TWAP_WINDOW;
        return scaled;
    }

    /**
     * @dev TWAP over the window ENDING AT `anchor`, plus the price at `anchor`,
     *      both as WAD quotes of the token in WETH.
     *
     *      Returns ok=false rather than reverting when the pool cannot reach
     *      back that far, so one unpriceable match cannot block a whole batch -
     *      the same contract OracleResolver._getTWAPAt offers.
     */
    function _twapWadAt(PoolView memory pv, uint256 window, uint256 anchor)
        internal
        view
        returns (uint256 twap, uint256 spotAtAnchor, bool ok)
    {
        if (anchor > block.timestamp) return (0, 0, false);
        uint256 age = block.timestamp - anchor;
        // uint32 is what observe takes; an age past that means a match older
        // than 136 years, which is not a case worth encoding for.
        if (age + window > type(uint32).max) return (0, 0, false);

        // Three points, one call: the start of the window, one second before
        // the anchor, and the anchor itself. That yields the window average and
        // the anchor's own one-second tick without a second observe().
        uint32[] memory secondsAgos = new uint32[](3);
        // safe: `age + window` is bounds-checked against uint32 above, and the
        // other two are strictly smaller.
        // forge-lint: disable-next-line(unsafe-typecast)
        secondsAgos[0] = uint32(age + window);
        // forge-lint: disable-next-line(unsafe-typecast)
        secondsAgos[1] = uint32(age + 1);
        // forge-lint: disable-next-line(unsafe-typecast)
        secondsAgos[2] = uint32(age);

        int56[] memory cumulatives;
        try pv.pool.observe(secondsAgos) returns (int56[] memory c, uint160[] memory) {
            cumulatives = c;
        } catch {
            // 'OLD': the ring does not reach the start of the window.
            return (0, 0, false);
        }

        int24 meanTick = _meanFrom(cumulatives[2] - cumulatives[0], window);
        int24 anchorTick = _meanFrom(cumulatives[2] - cumulatives[1], 1);

        return (_quoteWad(pv.token0, meanTick), _quoteWad(pv.token0, anchorTick), true);
    }

    /// @dev Mean tick over `window`, ending `secondsAgo` back. ok=false when
    ///      the pool's ring is too short, which the caller turns into
    ///      MatchUnpriceable rather than a revert.
    function _meanTick(IUniswapV3Pool pool, uint32 window, uint32 secondsAgo)
        internal
        view
        returns (bool ok, int24 meanTick)
    {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo + window;
        secondsAgos[1] = secondsAgo;

        try pool.observe(secondsAgos) returns (int56[] memory c, uint160[] memory) {
            return (true, _meanFrom(c[1] - c[0], window));
        } catch {
            return (false, 0);
        }
    }

    /**
     * @dev Cumulative tick delta over `window` seconds, as a mean tick.
     *
     *      The floor adjustment is Uniswap's, and it is not cosmetic: Solidity
     *      truncates toward zero, so without it a negative mean rounds the
     *      wrong way and every price below 1 WETH comes out a tick high.
     *
     *      The range check is ours, and it is the reason this is not just a
     *      cast. int56 -> int24 wraps silently, and a wrapped tick is not
     *      always out of range - it can land back inside it and quote a price
     *      that is wrong by orders of magnitude without anything reverting.
     *      A well-behaved pool cannot produce a mean outside the tick range, so
     *      reaching this revert means the pool is not one, which is exactly
     *      when we want to stop rather than guess.
     */
    function _meanFrom(int56 delta, uint256 window) internal pure returns (int24) {
        // safe: window is bounded by TWAP_WINDOW_CAP (300) at every call site.
        // forge-lint: disable-next-line(unsafe-typecast)
        int56 w = int56(uint56(window));
        int56 mean = delta / w;
        if (delta < 0 && delta % w != 0) mean--;

        if (mean < TickMath.MIN_TICK || mean > TickMath.MAX_TICK) revert TickOutOfPoolRange(mean);
        // safe: bounds-checked against the tick range on the line above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return int24(mean);
    }

    // ── PRICE ──────────────────────────────────────────────
    /**
     * @dev One unit (1e18) of the pool's non-WETH token, quoted in WETH.
     *
     *      This is Uniswap's OracleLibrary.getQuoteAtTick specialised to a
     *      WETH quote and a 1e18 base. The branch on uint128 is theirs too: for
     *      a large enough sqrt ratio the square overflows Q192, so the same
     *      quantity has to be computed in Q128 instead. Both branches use
     *      OpenZeppelin's audited 512-bit mulDiv rather than a vendored copy of
     *      Uniswap's FullMath - it is already a dependency here, and one fewer
     *      hand-transcribed library is one fewer thing to be quietly wrong.
     */
    function _quoteWad(address token0, int24 tick) internal view returns (uint256) {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
        // token0 == weth means the token we are pricing is token1, so the quote
        // is the reciprocal of the pool's token1/token0 ratio.
        bool baseIsToken0 = token0 != weth;

        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            return baseIsToken0 ? Math.mulDiv(ratioX192, 1e18, 1 << 192) : Math.mulDiv(1 << 192, 1e18, ratioX192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
        return baseIsToken0 ? Math.mulDiv(ratioX128, 1e18, 1 << 128) : Math.mulDiv(1 << 128, 1e18, ratioX128);
    }

    function _spread(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0 || b == 0) return 10_000;
        uint256 diff = a > b ? a - b : b - a;
        return (diff * 10_000) / ((a + b) / 2);
    }

    // ── ADMIN ──────────────────────────────────────────────
    function addKeeper(address keeper) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(KEEPER_ROLE, keeper);
    }

    function removeKeeper(address keeper) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(KEEPER_ROLE, keeper);
    }

    /// @notice Rescue ETH forced in by a selfdestruct. Nothing here needs a
    ///         balance: reading a pool's oracle is free.
    function withdrawETH(address payable to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "eth withdraw failed");
    }
}
