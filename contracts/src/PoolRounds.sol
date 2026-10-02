// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IUniswapV3.sol";
import "./PoolRoundMath.sol";
import "./PoolRoundOracle.sol";

/// The two calls PoolRounds makes on ReferralRegistry, which already has both
/// (`referrerOf` is its public mapping). Named apart from OrderbookMarket's
/// IReferralRegistry so both can sit in one compilation unit.
interface IPoolRoundReferrals {
    function referrerOf(address referee) external view returns (address);
    function register(address referee, address referrer) external;
}

interface IWrappedEther {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/**
 * @title  PoolRounds (interface v3)
 * @notice Matched rounds on Uniswap v3 pools, candidate v2 of docs/rhc/POSITIVE-EV.md
 *         (third edition). Deployed on Robinhood Chain testnet; internally
 *         reviewed and tested, without an external security audit.
 *
 * @dev    One contract for every pool and duration. A round is the pair
 *         (pool, duration T) and a window index k; it takes bets during
 *         [k*T, (k+1)*T) and exists in storage from its first bet on. There is
 *         no createMarket and nothing to roll over, so no keeper step can undo a
 *         pause (the failure described in DECISIONS.md: pauseMarketsForFeed was
 *         undone by the next createMarket tick).
 *
 *         Bets are visible: side and stake are public at once. The side cap
 *         `maxSideRatio` is fixed at deployment (1 in the design: accepted =
 *         min(UP, DOWN), the excess comes back without a fee, and every accepted
 *         unit of the winning side pays 1.96x whatever the book).
 *
 *         Life of round k, with T = duration:
 *
 *           openAt      = k * T                   bet(): stake and side in
 *           closeAt     = openAt + T              the book is final; an unplayed round can be claimed
 *           strikeStart = closeAt + strikePause   nothing happens during the pause
 *           strikeEnd   = strikeStart + strikeWindow
 *                                                 fixStrike(): mean tick of [strikeStart, strikeEnd]
 *           settleAt    = strikeEnd + T           settle(): exit window and guards as the resolver
 *
 *         A round is ACTIVATED when both sides are present, the accepted bank
 *         is at least the round's minBank and the retained 1% fee covers twice
 *         the round's cost allowance; otherwise every stake is returned in full.
 *         Players collect with claim(); settle() has no loop over players.
 *
 *         Depth rule (re-audit V3-1, V3-2): the accepted bank of a round may not
 *         exceed the pool's WETH depth / depthPerBank. bet() checks it against the
 *         depth now; fixStrike() and settle() check it against the depth the pool
 *         actually carried during each price window (harmonic-mean liquidity from
 *         observe()), and a round whose window was thinner than that is refunded
 *         (REASON_THIN) instead of being decided by a price that was cheap to move.
 *
 *         Nothing here can move a player's money except claim() to that player:
 *         there is no rescue and no sweep of dust, and the pause stops only new
 *         bets.
 */
contract PoolRounds is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Side {
        NONE,
        UP,
        DOWN
    }

    enum Outcome {
        NONE, // not settled (or not activated: see roundView().activated)
        UP,
        DOWN,
        TIE,
        REFUND // oracle could not price the round; activated, so the 1% void fee applies
    }

    enum TicketStatus {
        NONE,
        PLACED,
        CLAIMED
    }

    /// Deployment parameters; everything but minBank and costAllowance is immutable.
    struct Params {
        address weth;
        address v3Factory;
        address referralRegistry; // zero disables referrals; otherwise it must have code
        address treasury;
        uint256 maxSideRatio; // 1..4
        uint256 strikePause; // 60..900 s between closeAt and strikeStart
        uint256 strikeWindow; // 60..600 s averaged for the strike
        uint256 depthPerBank; // K, 100..1 000 000: bank <= pool WETH depth / K
        uint256 minStake;
        uint256 maxStake;
        uint256 minBank;
        uint256 costAllowance;
    }

    /// 2 storage slots; the second is written once, at the first bet.
    struct Round {
        uint96 rawUp; // everything staked UP
        uint96 rawDown; // everything staked DOWN
        int24 entryTick; // strike, valid once strikeFixed or settled
        int24 exitTick; // valid once settled with a price
        uint8 outcome; // Outcome
        bool strikeFixed;
        uint96 minBank; // snapshot at the first bet; nonzero marks the round as opened
        uint64 costAllowance; // snapshot at the first bet, wei
    }

    /// 1 storage slot.
    struct Ticket {
        uint96 stake;
        uint8 side; // Side
        uint8 status; // TicketStatus
    }

    struct PoolConfig {
        bool listed; // takes new bets; delisting keeps wethIsToken0 so open rounds still settle
        bool wethIsToken0;
    }

    struct Times {
        uint256 openAt;
        uint256 closeAt;
        uint256 strikeStart;
        uint256 strikeEnd;
        uint256 settleAt;
    }

    struct RoundView {
        address pool;
        uint256 duration;
        uint256 index;
        Times times;
        uint256 committed; // rawUp + rawDown
        uint256 rawUp;
        uint256 rawDown;
        uint256 acceptedUp;
        uint256 acceptedDown;
        uint256 bank;
        uint256 minBank;
        uint256 costAllowance;
        bool bookClosed; // block.timestamp >= closeAt
        bool activated; // only meaningful once bookClosed
        bool strikeFixed;
        Outcome outcome;
        int24 entryTick;
        int24 exitTick;
    }

    // ── Fixed rules: visible before anyone bets, not owner-tunable ──
    uint256 public constant NORMAL_FEE_BPS = PoolRoundMath.NORMAL_FEE_BPS;
    uint256 public constant VOID_FEE_BPS = PoolRoundMath.VOID_FEE_BPS;
    uint256 public constant REFERRAL_BPS = PoolRoundMath.REFERRAL_BPS;
    uint256 public constant COVER = PoolRoundMath.COVER;
    /// Past settleAt + this, anyone can turn an unpriced activated round into REFUND.
    uint256 public constant SETTLE_GRACE = 24 hours;
    /// Gas given to the registry's referrerOf() at claim; ReferralRegistry needs about 5 000.
    uint256 internal constant REFERRER_LOOKUP_GAS = 100_000;

    uint8 public constant REASON_PRICED = 0;
    uint8 public constant REASON_HISTORY = 1; // the observation ring no longer reaches a window
    uint8 public constant REASON_SPREAD = 2; // exit window vs its own tail beyond 2%
    uint8 public constant REASON_GRACE = 3; // SETTLE_GRACE lapsed before anyone priced it
    uint8 public constant REASON_THIN = 4; // a price window carried less than bank x depthPerBank of WETH depth

    // ── Pool gate, from PoolMarketFactory ──
    /// PoolMarketFactory.MIN_POOL_WETH_DEPTH: moving the price costs more than a capped bet wins.
    uint256 public constant MIN_POOL_WETH_DEPTH = 2 ether;
    /// Seconds of ring beyond the longest window, for the keeper to be late.
    /// PoolMarketFactory's MIN_CARDINALITY = 300 is its longest window (180 s) plus
    /// 120 s. Here 600 s (re-audit V3-7): the keeper then has 599 s to fix the
    /// strike and 839 s to settle a 300 s round even if the pool writes an
    /// observation every second (see keeperDeadlines).
    uint256 public constant CARDINALITY_SLACK = 600;

    // ── Owner and deployment bounds ──
    uint256 public constant MIN_BANK_FLOOR = 0.001 ether;
    uint256 public constant MIN_BANK_CEIL = 10 ether;
    /// 1 000 000 gas at 0.02 gwei (the chain floor on 2026-09-29) and at 10 gwei (re-audit V3-7).
    uint256 public constant COST_ALLOWANCE_FLOOR = 2e13;
    uint256 public constant COST_ALLOWANCE_CEIL = 1e16;
    uint256 public constant MIN_DURATION = 60;
    uint256 public constant MAX_DURATION = 3600;
    uint256 public constant MIN_STRIKE_PAUSE = 60;
    uint256 public constant MAX_STRIKE_PAUSE = 900;
    uint256 public constant MIN_STRIKE_WINDOW = 60;
    uint256 public constant MAX_STRIKE_WINDOW = 600;
    uint256 public constant MIN_DEPTH_PER_BANK = 100;
    uint256 public constant MAX_DEPTH_PER_BANK = 1_000_000;

    IERC20 public immutable weth;
    IUniswapV3Factory public immutable v3Factory;
    /// Zero disables referrals: every referral share then goes to the treasury.
    IPoolRoundReferrals public immutable referralRegistry;
    uint256 public immutable maxSideRatio;
    uint256 public immutable strikePause;
    uint256 public immutable strikeWindow;
    uint256 public immutable minStake;
    uint256 public immutable maxStake;
    /// Ring capacity a pool must have to be listed: max(strikeWindow, 300 s exit cap) + CARDINALITY_SLACK.
    uint256 public immutable minCardinality;
    /// K: a round's accepted bank may not exceed the pool's WETH depth / K.
    uint256 public immutable depthPerBank;

    address public treasury;
    /// May pause new bets; only the owner may unpause.
    address public pauser;
    /// Current values, copied into a round at its first bet.
    uint256 public minBank;
    uint256 public costAllowance;

    /// Project fees not yet sent to the treasury.
    uint256 public feesAccrued;
    mapping(address => uint256) public referralOwed;

    mapping(address => PoolConfig) public pools;
    mapping(uint256 => bool) public durationEnabled;

    mapping(uint256 => Round) internal _rounds;
    mapping(uint256 => mapping(address => Ticket)) internal _tickets;

    // ── Events ──
    event RoundOpened(
        uint256 indexed roundId,
        address indexed pool,
        uint256 duration,
        uint256 index,
        uint256 closeAt,
        uint256 minBank,
        uint256 costAllowance
    );
    event Bet(uint256 indexed roundId, address indexed player, Side side, uint256 stake);
    event StrikeFixed(uint256 indexed roundId, int24 entryTick, uint256 entryPrice);
    event RoundSettled(
        uint256 indexed roundId,
        Outcome outcome,
        uint8 reason,
        uint256 entryPrice,
        uint256 exitPrice,
        uint256 bank,
        uint256 grossFee,
        uint256 referralPot
    );
    event Claimed(
        uint256 indexed roundId, address indexed player, uint256 payout, address indexed referrer, uint256 referralShare
    );
    event FeesWithdrawn(address indexed treasury, uint256 amount);
    event ReferralClaimed(address indexed referrer, uint256 amount);
    event PoolListed(address indexed pool, bool wethIsToken0);
    event PoolDelisted(address indexed pool);
    /// delistIfBelowGate() found the pool below the gate (followed by PoolDelisted).
    event PoolBelowGate(address indexed pool, uint256 depth, uint256 cardinality);
    event DurationSet(uint256 duration, bool enabled);
    event MinBankSet(uint256 oldValue, uint256 newValue);
    event CostAllowanceSet(uint256 oldValue, uint256 newValue);
    event TreasurySet(address indexed treasury);
    event PauserSet(address indexed pauser);

    // ── Errors ──
    error ZeroAddress();
    error NoCode(address account);
    error OutOfBounds(uint256 value);
    error NotWethPool(address pool);
    error NotCanonicalPool(address pool);
    error PoolTooThin(uint256 depth);
    error CardinalityTooLow(uint256 have, uint256 need);
    error PoolCannotServeWindow(uint256 window);
    error PoolAboveGate(address pool, uint256 depth);
    error BankTooLargeForPool(uint256 bank, uint256 maxBank);
    error PoolNotListed(address pool);
    error DurationNotEnabled(uint256 duration);
    error NotCollecting(uint256 roundId);
    error StakeOutOfBounds(uint256 stake);
    error InvalidSide();
    error SelfReferral();
    error AlreadyBet(uint256 roundId, address player);
    error NotDue(uint256 roundId);
    error NotActivated(uint256 roundId);
    error AlreadySettled(uint256 roundId);
    error StrikeAlreadyFixed(uint256 roundId);
    error PriceUnavailableNow(uint256 roundId);
    error NoTicket(uint256 roundId, address player);
    error AlreadyClaimed(uint256 roundId, address player);
    error NotSettled(uint256 roundId);
    error NothingToWithdraw();
    error NotPauser();

    constructor(Params memory p) Ownable(msg.sender) {
        if (p.weth == address(0) || p.v3Factory == address(0) || p.treasury == address(0)) revert ZeroAddress();
        // Audit M1: a registry address without code would make every claim with a
        // referral share revert outside try/catch (the extcodesize check), for good.
        if (p.referralRegistry != address(0) && p.referralRegistry.code.length == 0) {
            revert NoCode(p.referralRegistry);
        }
        if (p.maxSideRatio < PoolRoundMath.MIN_SIDE_RATIO || p.maxSideRatio > PoolRoundMath.MAX_SIDE_RATIO) {
            revert OutOfBounds(p.maxSideRatio);
        }
        if (p.strikePause < MIN_STRIKE_PAUSE || p.strikePause > MAX_STRIKE_PAUSE) revert OutOfBounds(p.strikePause);
        if (p.strikeWindow < MIN_STRIKE_WINDOW || p.strikeWindow > MAX_STRIKE_WINDOW) {
            revert OutOfBounds(p.strikeWindow);
        }
        if (p.minStake == 0 || p.maxStake < p.minStake || p.maxStake > type(uint96).max) {
            revert OutOfBounds(p.maxStake);
        }
        if (p.depthPerBank < MIN_DEPTH_PER_BANK || p.depthPerBank > MAX_DEPTH_PER_BANK) {
            revert OutOfBounds(p.depthPerBank);
        }
        weth = IERC20(p.weth);
        v3Factory = IUniswapV3Factory(p.v3Factory);
        referralRegistry = IPoolRoundReferrals(p.referralRegistry);
        treasury = p.treasury;
        maxSideRatio = p.maxSideRatio;
        strikePause = p.strikePause;
        strikeWindow = p.strikeWindow;
        minStake = p.minStake;
        maxStake = p.maxStake;
        depthPerBank = p.depthPerBank;
        uint256 longest =
            p.strikeWindow > PoolRoundOracle.TWAP_WINDOW_CAP ? p.strikeWindow : PoolRoundOracle.TWAP_WINDOW_CAP;
        minCardinality = longest + CARDINALITY_SLACK;
        _setMinBank(p.minBank);
        _setCostAllowance(p.costAllowance);
        emit TreasurySet(p.treasury);
    }

    // ════════════════════════════════════════════════════════════════
    //  Round identity and clock
    // ════════════════════════════════════════════════════════════════

    /// @notice roundId = pool (160 bits) | duration (32 bits) | index (64 bits).
    function roundIdOf(address pool, uint256 duration, uint256 index) public pure returns (uint256) {
        if (duration > type(uint32).max) revert OutOfBounds(duration);
        if (index > type(uint64).max) revert OutOfBounds(index);
        return (uint256(uint160(pool)) << 96) | (duration << 64) | index;
    }

    function decodeRoundId(uint256 roundId) public pure returns (address pool, uint256 duration, uint256 index) {
        // Truncation IS the decoding: each field is cut out of its own bit range.
        // forge-lint: disable-next-line(unsafe-typecast)
        pool = address(uint160(roundId >> 96));
        // forge-lint: disable-next-line(unsafe-typecast)
        duration = uint32(roundId >> 64);
        // forge-lint: disable-next-line(unsafe-typecast)
        index = uint64(roundId);
    }

    /// @notice The round of `pool` and `duration` that takes bets right now.
    function currentRoundId(address pool, uint256 duration) external view returns (uint256) {
        if (duration == 0) revert OutOfBounds(duration);
        return roundIdOf(pool, duration, block.timestamp / duration);
    }

    /**
     * @notice openAt, closeAt, strikeStart, strikeEnd, settleAt of a round.
     *         The keeper's deadlines follow from them (keeperDeadlines):
     *           fixStrikeBy = strikeStart + minCardinality - 1
     *           settleBy    = settleAt - exitWindow(T) + minCardinality - 1
     *         where exitWindow(T) = T / 5 clamped to [30, 300] s.
     */
    function roundTimes(uint256 roundId) public view returns (Times memory t) {
        (, uint256 duration, uint256 index) = decodeRoundId(roundId);
        return _times(duration, index);
    }

    /**
     * @notice The last second at which fixStrike() and settle() are still sure
     *         to read their window, even on a pool that writes an observation
     *         every second (re-audit V3-5). A listed ring has at least
     *         minCardinality slots and Uniswap writes at most one observation a
     *         second, so it holds at least minCardinality - 1 seconds. On a quiet
     *         pool the windows stay readable longer; past these seconds a busy
     *         pool can lose them, and a lost window is REFUND.
     *         With the defaults (strike window 300 s, T = 300 s, minCardinality
     *         900): strikeEnd + 599 and settleAt + 839.
     */
    function keeperDeadlines(uint256 roundId) external view returns (uint256 fixStrikeBy, uint256 settleBy) {
        (, uint256 duration, uint256 index) = decodeRoundId(roundId);
        Times memory tm = _times(duration, index);
        fixStrikeBy = tm.strikeStart + minCardinality - 1;
        settleBy = tm.settleAt - PoolRoundOracle.exitWindowFor(duration) + minCardinality - 1;
    }

    /// @notice Exit window of a round of `duration` seconds: duration / 5 clamped to [30, 300].
    function exitWindowOf(uint256 duration) external pure returns (uint256) {
        return PoolRoundOracle.exitWindowFor(duration);
    }

    function _times(uint256 duration, uint256 index) internal view returns (Times memory t) {
        t.openAt = index * duration;
        t.closeAt = t.openAt + duration;
        t.strikeStart = t.closeAt + strikePause;
        t.strikeEnd = t.strikeStart + strikeWindow;
        t.settleAt = t.strikeEnd + duration;
    }

    // ════════════════════════════════════════════════════════════════
    //  Player: bet, claim
    // ════════════════════════════════════════════════════════════════

    /**
     * @notice Stake `stake` WETH on `side` (1 = UP, 2 = DOWN) in round `roundId`.
     * @param  referrer optional; recorded in the referral registry if this contract
     *         is authorized there, silently skipped otherwise (as in
     *         OrderbookMarket.placeBet), and never a reason to refuse the bet. It may
     *         not be the player or this contract (audit L3: a share credited to
     *         this contract could never be withdrawn).
     * @dev    One bet per player per round. The round's minBank and cost
     *         allowance are copied at its first bet and never change after.
     *         The pool is re-checked against the listing depth gate on every bet
     *         (re-audit V3-3), and a bet that grows the accepted bank past the
     *         pool's current depth / depthPerBank is refused (V3-1). A bet that
     *         only adds to the larger side does not grow the bank and is not
     *         limited: its excess comes back without a fee.
     */
    function bet(uint256 roundId, uint256 stake, Side side, address referrer) external nonReentrant whenNotPaused {
        _bet(roundId, stake, side, referrer, false);
    }

    /// @notice Place a bet using native ETH. It is wrapped into the pool's WETH
    ///         inside this transaction, so the player needs no separate wrap or approval.
    function betWithEth(uint256 roundId, Side side, address referrer) external payable nonReentrant whenNotPaused {
        _bet(roundId, msg.value, side, referrer, true);
    }

    function _bet(uint256 roundId, uint256 stake, Side side, address referrer, bool nativeEth) internal {
        (address pool, uint256 duration, uint256 index) = decodeRoundId(roundId);
        PoolConfig memory cfg = pools[pool];
        if (!cfg.listed) revert PoolNotListed(pool);
        if (!durationEnabled[duration]) revert DurationNotEnabled(duration);
        uint256 openAt = index * duration;
        if (block.timestamp < openAt || block.timestamp >= openAt + duration) revert NotCollecting(roundId);
        if (stake < minStake || stake > maxStake) revert StakeOutOfBounds(stake);
        if (side != Side.UP && side != Side.DOWN) revert InvalidSide();
        if (referrer == msg.sender || referrer == address(this)) revert SelfReferral();

        Ticket storage t = _tickets[roundId][msg.sender];
        if (t.status != uint8(TicketStatus.NONE)) revert AlreadyBet(roundId, msg.sender);

        Round storage r = _rounds[roundId];
        if (r.minBank == 0) {
            uint256 mb = minBank;
            uint256 ca = costAllowance;
            // safe: MIN_BANK_CEIL (10 ether) < 2^96 and COST_ALLOWANCE_CEIL (1e16) < 2^64,
            // enforced by _setMinBank and _setCostAllowance.
            // forge-lint: disable-next-line(unsafe-typecast)
            r.minBank = uint96(mb);
            // forge-lint: disable-next-line(unsafe-typecast)
            r.costAllowance = uint64(ca);
            emit RoundOpened(roundId, pool, duration, index, openAt + duration, mb, ca);
        }
        _addStake(r, IUniswapV3Pool(pool), cfg.wethIsToken0, stake, side);

        // forge-lint: disable-next-line(unsafe-typecast)
        t.stake = uint96(stake);
        t.side = uint8(side);
        t.status = uint8(TicketStatus.PLACED);

        if (nativeEth) IWrappedEther(address(weth)).deposit{value: stake}();
        else weth.safeTransferFrom(msg.sender, address(this), stake);

        if (referrer != address(0) && address(referralRegistry) != address(0)) {
            try referralRegistry.register(msg.sender, referrer) {} catch {}
        }
        emit Bet(roundId, msg.sender, side, stake);
    }

    /// @dev Adds the stake to its side and applies the depth gate and the depth rule.
    function _addStake(Round storage r, IUniswapV3Pool p, bool wethIsToken0, uint256 stake, Side side) internal {
        uint256 depth = PoolRoundOracle.wethDepth(p, wethIsToken0);
        if (depth < gateDepth()) revert PoolTooThin(depth);
        uint256 bankBefore = _bankOf(r.rawUp, r.rawDown);
        // safe: stake <= maxStake <= type(uint96).max (constructor); the sums are checked.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (side == Side.UP) r.rawUp += uint96(stake);
        // forge-lint: disable-next-line(unsafe-typecast)
        else r.rawDown += uint96(stake);
        uint256 bankAfter = _bankOf(r.rawUp, r.rawDown);
        if (bankAfter > bankBefore && bankAfter * depthPerBank > depth) {
            revert BankTooLargeForPool(bankAfter, depth / depthPerBank);
        }
    }

    function _bankOf(uint256 rawUp, uint256 rawDown) internal view returns (uint256) {
        (uint256 up, uint256 down) = PoolRoundMath.accepted(rawUp, rawDown, maxSideRatio);
        return up + down;
    }

    /**
     * @notice Collect what your bet is owed.
     * @dev    Not activated round: the whole stake, from closeAt on.
     *         Activated round: after settlement, the unmatched part plus the
     *         award (PoolRoundMath.ticketClaim). The ticket's referral share is
     *         credited to its referrer, or to the treasury if it has none; a
     *         registry that reverts is treated as "no referrer" so that it can
     *         never hold a claim hostage. Not pausable.
     */
    function claim(uint256 roundId) external nonReentrant returns (uint256 payout) {
        return _claim(roundId, false);
    }

    /// @notice Collect a payout as native ETH. The WETH configured for this
    ///         deployment must support withdraw(uint256) and be fully backed.
    function claimAsEth(uint256 roundId) external nonReentrant returns (uint256 payout) {
        return _claim(roundId, true);
    }

    function _claim(uint256 roundId, bool nativeEth) internal returns (uint256 payout) {
        Ticket storage t = _tickets[roundId][msg.sender];
        _requirePlaced(roundId, msg.sender, t.status);

        uint256 referralShare;
        (payout, referralShare) = _owed(roundId, _rounds[roundId], t);
        t.status = uint8(TicketStatus.CLAIMED);

        address referrer;
        if (referralShare > 0) {
            referrer = _referrerOf(msg.sender);
            if (referrer != address(0)) referralOwed[referrer] += referralShare;
            else feesAccrued += referralShare;
        }
        if (payout > 0) {
            if (nativeEth) {
                IWrappedEther(address(weth)).withdraw(payout);
                (bool sent,) = payable(msg.sender).call{value: payout}("");
                require(sent, "ETH payout failed");
            } else weth.safeTransfer(msg.sender, payout);
        }
        emit Claimed(roundId, msg.sender, payout, referrer, referralShare);
    }

    receive() external payable {
        require(msg.sender == address(weth), "Only WETH may send ETH");
    }

    function _requirePlaced(uint256 roundId, address player, uint8 status) internal pure {
        if (status == uint8(TicketStatus.PLACED)) return;
        if (status == uint8(TicketStatus.NONE)) revert NoTicket(roundId, player);
        revert AlreadyClaimed(roundId, player);
    }

    /**
     * @dev The player's referrer, or zero. A low-level staticcall with a gas cap
     *      and only the first 32 bytes of the answer copied (re-audit V3-4): a
     *      registry that reverts, answers with fewer than 32 bytes, answers with
     *      something that is not an address, or burns gas cannot hold a claim
     *      hostage; the share then goes to the treasury. Audit L3, second half:
     *      a registry shared with other markets can hold this contract as
     *      someone's referrer; a share credited to it could never be withdrawn,
     *      so it goes to the treasury too.
     */
    function _referrerOf(address player) internal view returns (address) {
        address registry = address(referralRegistry);
        if (registry == address(0)) return address(0);
        bytes memory data = abi.encodeCall(IPoolRoundReferrals.referrerOf, (player));
        bool ok;
        uint256 size;
        uint256 word;
        assembly ("memory-safe") {
            mstore(0, 0) // a short answer must not pick up whatever the scratch word held
            ok := staticcall(REFERRER_LOOKUP_GAS, registry, add(data, 32), mload(data), 0, 32)
            size := returndatasize()
            word := mload(0)
        }
        if (!ok || size < 32 || word > type(uint160).max) return address(0);
        address ref = address(uint160(word));
        return ref == address(this) ? address(0) : ref;
    }

    /// @dev What a PLACED ticket is owed; reverts while the answer is not final.
    function _owed(uint256 roundId, Round storage r, Ticket storage t)
        internal
        view
        returns (uint256 payout, uint256 referralShare)
    {
        (, uint256 duration, uint256 index) = decodeRoundId(roundId);
        if (block.timestamp < _times(duration, index).closeAt) revert NotSettled(roundId);

        uint256 stake = t.stake;
        uint256 rawUp = r.rawUp;
        uint256 rawDown = r.rawDown;
        if (!PoolRoundMath.isActive(rawUp, rawDown, maxSideRatio, r.minBank, r.costAllowance)) return (stake, 0);

        Outcome o = Outcome(r.outcome);
        if (o == Outcome.NONE) revert NotSettled(roundId);

        (uint256 up, uint256 down) = PoolRoundMath.accepted(rawUp, rawDown, maxSideRatio);
        bool isUp = t.side == uint8(Side.UP);
        return PoolRoundMath.ticketClaim(
            stake,
            isUp ? rawUp : rawDown,
            isUp ? up : down,
            up + down,
            o == Outcome.TIE || o == Outcome.REFUND,
            isUp ? o == Outcome.UP : o == Outcome.DOWN
        );
    }

    // ════════════════════════════════════════════════════════════════
    //  Anyone: strike, settlement
    // ════════════════════════════════════════════════════════════════

    /**
     * @notice Record the strike: the pool's mean tick over [strikeStart, strikeEnd].
     *         Callable by anyone from strikeEnd on.
     * @dev    Call it right after strikeEnd, and at the latest by
     *         keeperDeadlines(roundId).fixStrikeBy: until then the strike window
     *         is readable even if the pool writes an observation every second
     *         (a listed ring holds at least minCardinality - 1 seconds, one
     *         observation per second at most). settle() can read the window
     *         itself, but only while the ring still reaches back strikeWindow + T
     *         seconds from settleAt. A window the ring has already lost is final,
     *         so that turns the round into REFUND at once (1% void fee), the rule
     *         the resolver applies to an exit window. So does a strike window in
     *         which the pool carried less than bank x depthPerBank of WETH depth
     *         (REASON_THIN): the price in it was cheap to move. The pool's liquidity
     *         right now does not matter, only the liquidity it had in the window.
     */
    function fixStrike(uint256 roundId) external {
        Round storage r = _rounds[roundId];
        (address pool, uint256 duration, uint256 index) = decodeRoundId(roundId);
        Times memory tm = _times(duration, index);
        if (block.timestamp < tm.strikeEnd) revert NotDue(roundId);
        if (!_activated(r)) revert NotActivated(roundId);
        if (r.outcome != uint8(Outcome.NONE)) revert AlreadySettled(roundId);
        if (r.strikeFixed) revert StrikeAlreadyFixed(roundId);
        if (block.timestamp >= tm.settleAt + SETTLE_GRACE) {
            _finalize(roundId, r, Outcome.REFUND, REASON_GRACE, 0, 0);
            return;
        }

        uint256[] memory ts = new uint256[](2);
        ts[0] = tm.strikeStart;
        ts[1] = tm.strikeEnd;
        (PoolRoundOracle.Status s, int56[] memory c, uint160[] memory spl) =
            PoolRoundOracle.cumulativesAt(IUniswapV3Pool(pool), ts);
        if (s == PoolRoundOracle.Status.HISTORY_GONE) {
            _finalize(roundId, r, Outcome.REFUND, REASON_HISTORY, 0, 0);
            return;
        }
        if (s != PoolRoundOracle.Status.OK) revert PriceUnavailableNow(roundId);

        bool wethIsToken0 = pools[pool].wethIsToken0;
        int24 entryTick = PoolRoundOracle.meanTick(c[0], c[1], strikeWindow);
        uint256 entryWad = PoolRoundOracle.quoteWad(wethIsToken0, entryTick);
        uint256 depth = PoolRoundOracle.windowDepth(spl[0], spl[1], strikeWindow, entryTick, wethIsToken0);
        if (depth < _bankOf(r.rawUp, r.rawDown) * depthPerBank) {
            _finalize(roundId, r, Outcome.REFUND, REASON_THIN, entryWad, 0);
            return;
        }
        r.entryTick = entryTick;
        r.strikeFixed = true;
        emit StrikeFixed(roundId, entryTick, entryWad);
    }

    /**
     * @notice Decide an activated round: UP, DOWN, TIE or REFUND. Callable by
     *         anyone from settleAt on. No loop over players.
     * @dev    Order of checks follows PoolOracleResolver._settleOne: not due is
     *         "wait" and comes first; past SETTLE_GRACE is REFUND without reading
     *         the pool at all, so a pool that reverts in any way can delay a
     *         round by at most SETTLE_GRACE; an unreadable pool reverts (nothing
     *         changes, try later); a lost window is REFUND; a price window that
     *         carried less than bank x depthPerBank of WETH depth is REFUND
     *         (REASON_THIN, re-audit V3-1 and V3-2: this replaces the old check of
     *         the pool's liquidity at the moment of the call, so liquidity pulled
     *         after the windows no longer blocks anything); an exit window that
     *         disagrees with its own tail by more than 2% is REFUND.
     *         Exit above entry is UP, below is DOWN, equal WAD quotes are TIE -
     *         the comparison the reference model makes (pool-toxicity.mts cmp).
     *         There is no spread guard on the strike window (audit L2): any guard
     *         would add refunds the reference model does not have.
     */
    function settle(uint256 roundId) external {
        Round storage r = _rounds[roundId];
        (address pool, uint256 duration, uint256 index) = decodeRoundId(roundId);
        Times memory tm = _times(duration, index);
        if (block.timestamp < tm.settleAt) revert NotDue(roundId);
        if (!_activated(r)) revert NotActivated(roundId);
        if (r.outcome != uint8(Outcome.NONE)) revert AlreadySettled(roundId);
        if (block.timestamp >= tm.settleAt + SETTLE_GRACE) {
            _finalize(roundId, r, Outcome.REFUND, REASON_GRACE, 0, 0);
            return;
        }

        bool wethIsToken0 = pools[pool].wethIsToken0;
        Read memory rd = _readRound(IUniswapV3Pool(pool), wethIsToken0, r.strikeFixed, r.entryTick, duration, tm);
        if (rd.status == PoolRoundOracle.Status.HISTORY_GONE) {
            _finalize(roundId, r, Outcome.REFUND, REASON_HISTORY, 0, 0);
            return;
        }
        if (rd.status != PoolRoundOracle.Status.OK) revert PriceUnavailableNow(roundId);

        uint256 entryWad = PoolRoundOracle.quoteWad(wethIsToken0, rd.entryTick);
        uint256 exitWad = PoolRoundOracle.quoteWad(wethIsToken0, rd.exitTick);
        r.entryTick = rd.entryTick;
        r.exitTick = rd.exitTick;

        uint256 required = _bankOf(r.rawUp, r.rawDown) * depthPerBank;
        if (rd.exitDepth < required || rd.strikeDepth < required) {
            _finalize(roundId, r, Outcome.REFUND, REASON_THIN, entryWad, exitWad);
            return;
        }
        if (
            PoolRoundOracle.spreadBps(exitWad, PoolRoundOracle.quoteWad(wethIsToken0, rd.anchorTick))
                > PoolRoundOracle.MAX_SPREAD_BPS
        ) {
            _finalize(roundId, r, Outcome.REFUND, REASON_SPREAD, entryWad, exitWad);
            return;
        }
        Outcome o = exitWad > entryWad ? Outcome.UP : exitWad < entryWad ? Outcome.DOWN : Outcome.TIE;
        _finalize(roundId, r, o, REASON_PRICED, entryWad, exitWad);
    }

    /// What settle() reads from the pool in one observe().
    struct Read {
        PoolRoundOracle.Status status;
        int24 entryTick;
        int24 exitTick;
        int24 anchorTick;
        uint256 exitDepth; // WETH depth carried during the exit window
        uint256 strikeDepth; // during the strike window; unlimited when the strike was fixed (checked then)
    }

    /// @dev Exit window, its anchor tail and (unless fixed) the strike window, in one observe().
    function _readRound(
        IUniswapV3Pool p,
        bool wethIsToken0,
        bool strikeFixed,
        int24 fixedEntry,
        uint256 duration,
        Times memory tm
    ) internal view returns (Read memory rd) {
        uint256 w = PoolRoundOracle.exitWindowFor(duration);
        uint256 a = PoolRoundOracle.anchorWindowFor(w);
        uint256[] memory ts = new uint256[](strikeFixed ? 3 : 5);
        ts[0] = tm.settleAt - w;
        ts[1] = tm.settleAt - a;
        ts[2] = tm.settleAt;
        if (!strikeFixed) {
            ts[3] = tm.strikeStart;
            ts[4] = tm.strikeEnd;
        }
        int56[] memory c;
        uint160[] memory spl;
        (rd.status, c, spl) = PoolRoundOracle.cumulativesAt(p, ts);
        if (rd.status != PoolRoundOracle.Status.OK) return rd;
        rd.exitTick = PoolRoundOracle.meanTick(c[0], c[2], w);
        rd.anchorTick = PoolRoundOracle.meanTick(c[1], c[2], a);
        rd.exitDepth = PoolRoundOracle.windowDepth(spl[0], spl[2], w, rd.exitTick, wethIsToken0);
        if (strikeFixed) {
            rd.entryTick = fixedEntry;
            rd.strikeDepth = type(uint256).max;
        } else {
            rd.entryTick = PoolRoundOracle.meanTick(c[3], c[4], strikeWindow);
            rd.strikeDepth = PoolRoundOracle.windowDepth(spl[3], spl[4], strikeWindow, rd.entryTick, wethIsToken0);
        }
    }

    /// @dev Records the outcome and books the project's part of the fee. The
    ///      referral pot is NOT booked here: it is split per ticket at claim.
    function _finalize(uint256 roundId, Round storage r, Outcome o, uint8 reason, uint256 entryWad, uint256 exitWad)
        internal
    {
        r.outcome = uint8(o);
        (uint256 up, uint256 down) = PoolRoundMath.accepted(r.rawUp, r.rawDown, maxSideRatio);
        uint256 bank = up + down;
        bool isVoid = o == Outcome.TIE || o == Outcome.REFUND;
        (uint256 gross, uint256 pot) =
            PoolRoundMath.fees(bank, isVoid ? PoolRoundMath.VOID_FEE_BPS : PoolRoundMath.NORMAL_FEE_BPS);
        feesAccrued += gross - pot;
        emit RoundSettled(roundId, o, reason, entryWad, exitWad, bank, gross, pot);
    }

    function _activated(Round storage r) internal view returns (bool) {
        return PoolRoundMath.isActive(r.rawUp, r.rawDown, maxSideRatio, r.minBank, r.costAllowance);
    }

    // ════════════════════════════════════════════════════════════════
    //  Treasury and referrers
    // ════════════════════════════════════════════════════════════════

    /// @notice Send accrued project fees to the treasury. Anyone may call.
    function withdrawFees() external nonReentrant returns (uint256 amount) {
        amount = feesAccrued;
        if (amount == 0) revert NothingToWithdraw();
        feesAccrued = 0;
        address to = treasury;
        weth.safeTransfer(to, amount);
        emit FeesWithdrawn(to, amount);
    }

    function claimReferral() external nonReentrant returns (uint256 amount) {
        amount = referralOwed[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        referralOwed[msg.sender] = 0;
        weth.safeTransfer(msg.sender, amount);
        emit ReferralClaimed(msg.sender, amount);
    }

    // ════════════════════════════════════════════════════════════════
    //  Views
    // ════════════════════════════════════════════════════════════════

    function roundView(uint256 roundId) external view returns (RoundView memory v) {
        Round storage r = _rounds[roundId];
        (v.pool, v.duration, v.index) = decodeRoundId(roundId);
        v.times = _times(v.duration, v.index);
        v.rawUp = r.rawUp;
        v.rawDown = r.rawDown;
        v.committed = v.rawUp + v.rawDown;
        (v.acceptedUp, v.acceptedDown) = PoolRoundMath.accepted(v.rawUp, v.rawDown, maxSideRatio);
        v.bank = v.acceptedUp + v.acceptedDown;
        v.minBank = r.minBank;
        v.costAllowance = r.costAllowance;
        v.bookClosed = block.timestamp >= v.times.closeAt;
        v.activated = v.bookClosed && _activated(r);
        v.strikeFixed = r.strikeFixed;
        v.outcome = Outcome(r.outcome);
        v.entryTick = r.entryTick;
        v.exitTick = r.exitTick;
    }

    function ticketOf(uint256 roundId, address player)
        external
        view
        returns (uint256 stake, Side side, TicketStatus status)
    {
        Ticket storage t = _tickets[roundId][player];
        return (t.stake, Side(t.side), TicketStatus(t.status));
    }

    /// @notice What claim() would pay now; reverts exactly when claim() would.
    function previewClaim(uint256 roundId, address player)
        external
        view
        returns (uint256 payout, uint256 referralShare)
    {
        Ticket storage t = _tickets[roundId][player];
        _requirePlaced(roundId, player, t.status);
        return _owed(roundId, _rounds[roundId], t);
    }

    /// @notice WETH depth of a pool as the listing gate measures it (PoolMarketFactory.wethDepth).
    function wethDepth(address pool) public view returns (uint256) {
        return PoolRoundOracle.wethDepth(IUniswapV3Pool(pool), IUniswapV3Pool(pool).token0() == address(weth));
    }

    /**
     * @notice WETH depth a pool must have to be listed and to take bets:
     *         max(MIN_POOL_WETH_DEPTH, depthPerBank x minBank). Below
     *         depthPerBank x minBank no round of the pool could ever activate.
     *         It follows the current minBank, so raising minBank raises it.
     */
    function gateDepth() public view returns (uint256) {
        uint256 d = depthPerBank * minBank;
        return d > MIN_POOL_WETH_DEPTH ? d : MIN_POOL_WETH_DEPTH;
    }

    /// @notice Largest accepted bank a round of `pool` may reach at the pool's depth right now.
    function maxBankOf(address pool) external view returns (uint256) {
        return wethDepth(pool) / depthPerBank;
    }

    /// @notice Whether the pool can price a window ending now, `window` long (PoolMarketFactory.canServeWindow).
    function canServeWindow(address pool, uint256 window) external view returns (bool) {
        return PoolRoundOracle.canServeWindow(IUniswapV3Pool(pool), window);
    }

    /**
     * @notice Lets a NEW ReferralRegistry authorize this contract without any
     *         change to the registry's code: registry.setMarketFactory(this),
     *         then registry.authorizeMarket(this). The registry asks its factory
     *         isMarket(market); this answers yes for itself only.
     */
    function isMarket(address market) external view returns (bool) {
        return market == address(this);
    }

    // ════════════════════════════════════════════════════════════════
    //  Owner
    // ════════════════════════════════════════════════════════════════

    /// @notice Applies to rounds whose first bet comes after this call.
    function setMinBank(uint256 value) external onlyOwner {
        _setMinBank(value);
    }

    /// @notice Lifecycle cost allowance of one round in wei (gas budget x
    ///         conservative gas price). Applies to rounds opened after this call.
    function setCostAllowance(uint256 value) external onlyOwner {
        _setCostAllowance(value);
    }

    function _setMinBank(uint256 value) internal {
        if (value < MIN_BANK_FLOOR || value > MIN_BANK_CEIL) revert OutOfBounds(value);
        emit MinBankSet(minBank, value);
        minBank = value;
    }

    function _setCostAllowance(uint256 value) internal {
        if (value < COST_ALLOWANCE_FLOOR || value > COST_ALLOWANCE_CEIL) revert OutOfBounds(value);
        emit CostAllowanceSet(costAllowance, value);
        costAllowance = value;
    }

    function setTreasury(address value) external onlyOwner {
        if (value == address(0)) revert ZeroAddress();
        treasury = value;
        emit TreasurySet(value);
    }

    function setPauser(address value) external onlyOwner {
        pauser = value;
        emit PauserSet(value);
    }

    /**
     * @notice Admit a pool (audit M2: the gate PoolMarketFactory applies, in code).
     *         It must pair WETH and be the v3 factory's own pool for its tokens and
     *         fee (anyone can deploy a contract that answers observe() with any
     *         price), hold at least gateDepth() of WETH, have a ring of at
     *         least minCardinality slots, and already hold the history for the
     *         longest window a round reads (capacity is not history: Uniswap grows
     *         the ring in one step, so a pool can report the slots with seconds of
     *         prices in them). Checked at listing only, as in the factory.
     */
    function listPool(address pool) external onlyOwner {
        if (pool == address(0)) revert ZeroAddress();
        IUniswapV3Pool p = IUniswapV3Pool(pool);
        address t0 = p.token0();
        address t1 = p.token1();
        bool wethIsToken0 = t0 == address(weth);
        if (!wethIsToken0 && t1 != address(weth)) revert NotWethPool(pool);
        if (v3Factory.getPool(t0, t1, p.fee()) != pool) revert NotCanonicalPool(pool);

        uint256 depth = PoolRoundOracle.wethDepth(p, wethIsToken0);
        if (depth < gateDepth()) revert PoolTooThin(depth);
        (,,, uint16 cardinality,,,) = p.slot0();
        if (cardinality < minCardinality) revert CardinalityTooLow(cardinality, minCardinality);
        uint256 longest = minCardinality - CARDINALITY_SLACK;
        if (!PoolRoundOracle.canServeWindow(p, longest)) revert PoolCannotServeWindow(longest);

        pools[pool] = PoolConfig({listed: true, wethIsToken0: wethIsToken0});
        emit PoolListed(pool, wethIsToken0);
    }

    /// @notice Stops new bets on `pool`. Rounds already open run to the end.
    function delistPool(address pool) external onlyOwner {
        pools[pool].listed = false;
        emit PoolDelisted(pool);
    }

    /**
     * @notice Anyone may delist a pool that has fallen below the listing gate:
     *         WETH depth under gateDepth() (no liquidity included) or a ring under
     *         minCardinality (re-audit V3-3). Like delistPool it stops only new
     *         bets; rounds already open run to the end. Reverts PoolAboveGate if
     *         the pool still passes, so nobody can delist a healthy pool.
     */
    function delistIfBelowGate(address pool) external {
        PoolConfig storage cfg = pools[pool];
        if (!cfg.listed) revert PoolNotListed(pool);
        IUniswapV3Pool p = IUniswapV3Pool(pool);
        uint256 depth = PoolRoundOracle.wethDepth(p, cfg.wethIsToken0);
        (,,, uint16 cardinality,,,) = p.slot0();
        if (depth >= gateDepth() && cardinality >= minCardinality) revert PoolAboveGate(pool, depth);
        cfg.listed = false;
        emit PoolBelowGate(pool, depth, cardinality);
        emit PoolDelisted(pool);
    }

    /// @notice Allow or stop new rounds of `duration` seconds. Open rounds run to the end.
    function setDuration(uint256 duration, bool enabled) external onlyOwner {
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert OutOfBounds(duration);
        durationEnabled[duration] = enabled;
        emit DurationSet(duration, enabled);
    }

    /**
     * @notice Stop new bets. Owner or pauser.
     * @dev    Stops bet() and nothing else: fixStrike, settle, claim,
     *         withdrawFees and claimReferral keep working, so a pause can never
     *         hold a payout. Rounds are opened only by bet(), which checks the
     *         flag, so no keeper action can undo it.
     */
    function pause() external {
        if (msg.sender != owner() && msg.sender != pauser) revert NotPauser();
        _pause();
    }

    /// @notice Owner only: a pauser can trip the stop but never clear it.
    function unpause() external onlyOwner {
        _unpause();
    }
}
