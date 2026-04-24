// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./GenesisNFT.sol";

/**
 * @title LiquidityPool
 * @notice Genesis LP pool — fallback when orderbook is empty.
 *
 * Providers deposit USDC. Pool auto-matches unmatched bets.
 * LPs take Direction risk in exchange for boosted fee share.
 *
 * Protection: max 10% of deposit per single bet (LP_MAX_EXPOSURE).
 * If bet > available → LP matches partially, remainder goes to queue.
 *
 * Genesis providers (first 20): receive GenesisNFT
 * and boosted fee share forever (80% vs 50%).
 */
contract LiquidityPool is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ── TYPES ──────────────────────────────────────────────
    struct Provider {
        uint256 deposit;      // current USDC deposit
        uint256 exposure;     // current risk (sum of unresolved matches)
        uint256 totalEarned;  // total fees earned
        bool    isGenesis;    // Genesis provider?
        uint256 joinedAt;
    }

    struct ActiveMatch {
        uint256 orderId;
        uint256 amount;
        bool    lpIsDown;    // LP took DOWN position (user is UP)
        bool    settled;
    }

    // ── CONSTANTS ──────────────────────────────────────────
    uint256 public constant LP_MAX_EXPOSURE   = 1000; // 10% of deposit (BPS)
    uint256 public constant MIN_DEPOSIT       = 50e6; // 50 USDC minimum
    uint256 public constant GENESIS_MAX       = 20;   // first 20 providers
    uint256 public constant GENESIS_FEE_SHARE = 8000; // 80% of fees
    uint256 public constant NORMAL_FEE_SHARE  = 5000; // 50% of fees

    // ── IMMUTABLES ─────────────────────────────────────────
    IERC20     public immutable usdc;
    GenesisNFT public immutable genesisNFT;

    // ── STATE ──────────────────────────────────────────────
    address public market; // OrderbookMarket — set after deployment

    mapping(address => Provider)     public providers;
    mapping(uint256 => ActiveMatch)  public activeMatches; // matchId → match

    address[] public providerList;
    uint256   public genesisCount;
    uint256   public totalDeposited;

    // Accumulated fees for LP (pull pattern)
    mapping(address => uint256) public pendingFees;

    // ── EVENTS ─────────────────────────────────────────────
    event Deposited    (address indexed lp, uint256 amount, bool isGenesis);
    event Withdrawn    (address indexed lp, uint256 amount);
    event MatchTaken   (uint256 indexed matchId, uint256 orderId, uint256 amount);
    event MatchResult  (uint256 indexed matchId, bool lpWon, uint256 amount);
    event FeesClaimed  (address indexed lp, uint256 amount);

    // ── CONSTRUCTOR ────────────────────────────────────────
    constructor(address _usdc, address _genesisNFT) Ownable(msg.sender) {
        usdc       = IERC20(_usdc);
        genesisNFT = GenesisNFT(_genesisNFT);
    }

    // ── SET MARKET (called once after OrderbookMarket deploys) ──
    function setMarket(address _market) external onlyOwner {
        require(market == address(0), "market already set");
        market = _market;
    }

    modifier onlyMarket() {
        require(msg.sender == market, "only market");
        _;
    }

    // ── DEPOSIT ────────────────────────────────────────────
    /**
     * @notice Become a liquidity provider.
     *         First 20 get GenesisNFT and boosted fees forever.
     */
    function deposit(uint256 amount) external nonReentrant {
        require(amount >= MIN_DEPOSIT, "below min deposit");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        bool isNew = providers[msg.sender].deposit == 0;

        if (isNew) {
            providerList.push(msg.sender);
            providers[msg.sender].joinedAt = block.timestamp;
        }

        providers[msg.sender].deposit += amount;
        totalDeposited += amount;

        // Genesis status — first 20 unique providers
        if (isNew && genesisCount < GENESIS_MAX) {
            providers[msg.sender].isGenesis = true;
            genesisCount++;
            genesisNFT.mint(msg.sender, genesisCount); // tokenId = sequential number
        }

        emit Deposited(msg.sender, amount, providers[msg.sender].isGenesis);
    }

    // ── WITHDRAW ───────────────────────────────────────────
    /**
     * @notice Withdraw deposit. Cannot withdraw exposed portion.
     */
    function withdraw(uint256 amount) external nonReentrant {
        Provider storage p = providers[msg.sender];
        uint256 available  = p.deposit > p.exposure ? p.deposit - p.exposure : 0;
        require(amount <= available, "amount locked in active matches");

        p.deposit      -= amount;
        totalDeposited -= amount;
        usdc.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // ── TRY MATCH (called from OrderbookMarket) ────────────
    /**
     * @notice Attempt to match a bet with the LP pool.
     * @param orderId   The order ID from OrderbookMarket
     * @param amount    Bet amount in USDC
     * @param userIsUp  true if user bet UP
     * @param matchId   The match ID assigned by OrderbookMarket
     * @return matched  true if pool took the bet
     */
    function tryMatch(
        uint256 orderId,
        uint256 amount,
        bool    userIsUp,
        uint256 matchId
    ) external onlyMarket returns (bool matched) {
        // Calculate available pool liquidity
        uint256 available = _availableLiquidity();
        if (available == 0) return false;

        // LP matches no more than available
        uint256 matchAmount = amount <= available ? amount : available;

        // Freeze liquidity proportionally across providers
        _lockExposure(matchAmount);

        // Transfer LP stake to market so market holds both sides' funds
        usdc.safeTransfer(market, matchAmount);

        // Record active match
        activeMatches[matchId] = ActiveMatch({
            orderId:  orderId,
            amount:   matchAmount,
            lpIsDown: userIsUp, // if user UP → LP takes DOWN
            settled:  false
        });

        emit MatchTaken(matchId, orderId, matchAmount);
        return true;
    }

    // ── ON SETTLE (called from OrderbookMarket) ────────────
    /**
     * @notice Callback after LP match resolution.
     *         If LP lost → deduct from deposits.
     *         If LP won → add to deposits + distribute fees.
     */
    function onMatchSettled(uint256 matchId, bool upWon) external onlyMarket {
        ActiveMatch storage am = activeMatches[matchId];
        require(!am.settled, "already settled");
        am.settled = true;

        bool lpWon = am.lpIsDown ? !upWon : upWon;

        if (lpWon) {
            // LP won: market already transferred winnings to pool before this callback
            // Net gain: +amount to pool accounting (LP got back its stake + user's stake)
            totalDeposited += am.amount;
            // Distribute fees to providers
            _distributeFees(am.amount / 100); // 1% of winnings as fee
        } else {
            // LP lost: market keeps LP's stake to pay the user
            // Pool accounting: -amount (LP's escrowed stake is gone)
            totalDeposited = totalDeposited > am.amount ? totalDeposited - am.amount : 0;
        }

        _unlockExposure(am.amount);
        emit MatchResult(matchId, lpWon, am.amount);
    }

    // ── CLAIM FEES ─────────────────────────────────────────
    function claimFees() external nonReentrant {
        uint256 amount = pendingFees[msg.sender];
        require(amount > 0, "no fees");
        pendingFees[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit FeesClaimed(msg.sender, amount);
    }

    // ── INTERNAL ───────────────────────────────────────────
    function _availableLiquidity() internal view returns (uint256) {
        if (totalDeposited == 0) return 0;

        uint256 total = 0;
        for (uint256 i = 0; i < providerList.length; i++) {
            Provider storage p = providers[providerList[i]];
            uint256 maxExp = p.deposit * LP_MAX_EXPOSURE / 10_000;
            if (p.exposure < maxExp) {
                total += maxExp - p.exposure;
            }
        }
        return total;
    }

    function _lockExposure(uint256 amount) internal {
        if (totalDeposited == 0) return;
        for (uint256 i = 0; i < providerList.length; i++) {
            Provider storage p = providers[providerList[i]];
            uint256 share = amount * p.deposit / totalDeposited;
            p.exposure += share;
        }
    }

    function _unlockExposure(uint256 amount) internal {
        if (totalDeposited == 0) return;
        for (uint256 i = 0; i < providerList.length; i++) {
            Provider storage p = providers[providerList[i]];
            uint256 share = amount * p.deposit / totalDeposited;
            p.exposure = p.exposure > share ? p.exposure - share : 0;
        }
    }

    function _distributeFees(uint256 totalFee) internal {
        if (totalDeposited == 0 || totalFee == 0) return;
        for (uint256 i = 0; i < providerList.length; i++) {
            address lp  = providerList[i];
            Provider storage p = providers[lp];
            uint256 share     = totalFee * p.deposit / totalDeposited;
            // Genesis gets 80%, others 50%
            uint256 lpFee = p.isGenesis
                ? share * GENESIS_FEE_SHARE / 10_000
                : share * NORMAL_FEE_SHARE  / 10_000;
            pendingFees[lp] += lpFee;
            p.totalEarned   += lpFee;
        }
    }

    // ── VIEWS ──────────────────────────────────────────────
    function getPoolStats() external view returns (
        uint256 total,
        uint256 available,
        uint256 providerCount,
        uint256 genesisLeft
    ) {
        return (
            totalDeposited,
            _availableLiquidity(),
            providerList.length,
            GENESIS_MAX > genesisCount ? GENESIS_MAX - genesisCount : 0
        );
    }

    function getProvider(address lp) external view returns (Provider memory) {
        return providers[lp];
    }

    function getProviderCount() external view returns (uint256) {
        return providerList.length;
    }
}
