// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./GenesisNFT.sol";

/**
 * @title LiquidityPool
 * @notice Shared LP vault (ERC4626) for all OrderbookMarket instances.
 *
 * Architecture:
 *  - Underlying asset = USDC. Vault shares = soulbound (non-transferable).
 *  - Net P&L (LP wins/losses) flows through totalAssets() automatically:
 *      LP win  → market transfers 2*amount to vault → share price grows.
 *      LP loss → market keeps LP stake → vault balance shrinks → share price drops.
 *  - On top of share growth, 1% of each LP-won match is streamed as direct
 *    claimable fees, with Genesis providers receiving a 1.5x boost.
 *
 * Multi-market:
 *  - One vault serves many OrderbookMarket instances (one per feed × duration).
 *  - MarketFactory authorizes new markets via authorizeMarket().
 *  - Per-match state keyed by (market, matchId) to avoid id collisions.
 *  - Each market has its own exposure cap (5% of totalAssets) + global 10% cap.
 *
 * Genesis:
 *  - First 20 unique depositors receive GenesisNFT.
 *  - Genesis LPs get fee-stream weight × 1.5 forever.
 *  - No share-boost (would dilute later depositors); boost is fee-only.
 */
contract LiquidityPool is ERC4626, ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;

    // ── CONSTANTS ──────────────────────────────────────────
    uint256 public constant MIN_DEPOSIT                 = 50e6;  // 50 USDC
    uint256 public constant GENESIS_MAX                 = 20;
    uint256 public constant GENESIS_BOOST_BPS           = 15_000; // 1.5x
    uint256 public constant GLOBAL_MAX_EXPOSURE_BPS     = 1_000;  // 10% of totalAssets()
    uint256 public constant PER_MARKET_MAX_EXPOSURE_BPS = 500;    // 5% of totalAssets()
    uint256 public constant FEE_BPS_ON_LP_WIN           = 100;    // 1% of LP-won amount
    uint256 private constant FEE_INDEX_PRECISION        = 1e30;

    // ── IMMUTABLES ─────────────────────────────────────────
    GenesisNFT public immutable genesisNFT;

    // ── MARKET FACTORY ─────────────────────────────────────
    address public marketFactory;             // set once after deploy
    mapping(address => bool) public isAuthorizedMarket;

    // ── GENESIS ────────────────────────────────────────────
    mapping(address => bool) public isGenesis;
    mapping(address => bool) public hasBeenLP;  // tracks first-time depositors
    uint256 public genesisCount;

    // ── EXPOSURE ───────────────────────────────────────────
    uint256 public totalExposure;
    mapping(address => uint256) public marketExposure;  // market → locked USDC

    // ── MATCHES (composite key) ────────────────────────────
    struct ActiveMatch {
        uint256 amount;
        bool    lpIsDown;
        bool    settled;
    }
    mapping(address => mapping(uint256 => ActiveMatch)) public activeMatches;

    // ── FEE STREAM (index-based, O(1)) ─────────────────────
    uint256 public totalFeeWeight;       // sum of feeWeight across LPs
    uint256 public cumFeePerWeight;      // FEE_INDEX_PRECISION-scaled
    uint256 public totalPendingFees;     // sum of pendingFees[]
    mapping(address => uint256) public feeIndexSnapshot;
    mapping(address => uint256) public pendingFees;

    // ── EVENTS ─────────────────────────────────────────────
    event MarketFactorySet (address indexed factory);
    event MarketAuthorized (address indexed market);
    event MarketDeauthorized(address indexed market);
    event GenesisMinted    (address indexed lp, uint256 tokenId);
    event MatchTaken       (address indexed market, uint256 indexed matchId, uint256 orderId, uint256 amount);
    event MatchResult      (address indexed market, uint256 indexed matchId, bool lpWon, uint256 amount);
    event FeeAccrued       (address indexed market, uint256 amount);
    event FeesClaimed      (address indexed lp, uint256 amount);

    // ── MODIFIERS ──────────────────────────────────────────
    modifier onlyAuthorizedMarket() {
        require(isAuthorizedMarket[msg.sender], "not authorized market");
        _;
    }

    modifier onlyFactoryOrOwner() {
        require(msg.sender == marketFactory || msg.sender == owner(), "only factory or owner");
        _;
    }

    // ── CONSTRUCTOR ────────────────────────────────────────
    constructor(IERC20 _usdc, address _genesisNFT)
        ERC4626(_usdc)
        ERC20("MemePred LP Share", "mpLP")
        Ownable(msg.sender)
    {
        genesisNFT = GenesisNFT(_genesisNFT);
    }

    // ── ERC4626 OVERRIDES ──────────────────────────────────
    /// @dev Mitigate inflation attack by adding virtual shares/assets.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @dev totalAssets excludes pending fees so the fee stream is isolated
    ///      from share-price growth.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - totalPendingFees;
    }

    /// @dev Shares are soulbound. Allow mint (from=0) and burn (to=0) only.
    function _update(address from, address to, uint256 value) internal override {
        require(from == address(0) || to == address(0), "soulbound");

        // Accrue fees up to current index BEFORE changing weights / balances.
        if (from != address(0)) _accrueFees(from);
        if (to   != address(0)) _accrueFees(to);

        // Update fee weight tracking on mint/burn.
        if (from == address(0)) {
            totalFeeWeight += _weightOf(to, value);
        } else if (to == address(0)) {
            uint256 w = _weightOf(from, value);
            totalFeeWeight = totalFeeWeight > w ? totalFeeWeight - w : 0;
        }

        super._update(from, to, value);
    }

    /// @dev Withdraws are constrained by locked exposure across all markets.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        uint256 ownerAssets = previewRedeem(balanceOf(owner_));
        uint256 ta          = totalAssets();
        uint256 free        = ta > totalExposure ? ta - totalExposure : 0;
        return ownerAssets < free ? ownerAssets : free;
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return previewWithdraw(maxWithdraw(owner_));
    }

    /// @dev Apply MIN_DEPOSIT and Genesis bookkeeping on first deposit.
    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        require(assets >= MIN_DEPOSIT, "below min deposit");

        bool firstTime = !hasBeenLP[receiver];
        if (firstTime) {
            hasBeenLP[receiver] = true;
            if (genesisCount < GENESIS_MAX) {
                isGenesis[receiver] = true;
                genesisCount += 1;
            }
        }

        shares = super.deposit(assets, receiver);

        if (firstTime && isGenesis[receiver]) {
            genesisNFT.mint(receiver, genesisCount);
            emit GenesisMinted(receiver, genesisCount);
        }
    }

    /// @dev mint(shares, receiver) — also subject to MIN_DEPOSIT and Genesis.
    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 assets)
    {
        assets = previewMint(shares);
        require(assets >= MIN_DEPOSIT, "below min deposit");

        bool firstTime = !hasBeenLP[receiver];
        if (firstTime) {
            hasBeenLP[receiver] = true;
            if (genesisCount < GENESIS_MAX) {
                isGenesis[receiver] = true;
                genesisCount += 1;
            }
        }

        assets = super.mint(shares, receiver);

        if (firstTime && isGenesis[receiver]) {
            genesisNFT.mint(receiver, genesisCount);
            emit GenesisMinted(receiver, genesisCount);
        }
    }

    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256 assets)
    {
        return super.redeem(shares, receiver, owner_);
    }

    // ── MARKET AUTHORIZATION ───────────────────────────────
    function setMarketFactory(address _factory) external onlyOwner {
        require(marketFactory == address(0), "factory already set");
        require(_factory != address(0), "zero factory");
        marketFactory = _factory;
        emit MarketFactorySet(_factory);
    }

    function authorizeMarket(address market) external onlyFactoryOrOwner {
        require(market != address(0), "zero market");
        isAuthorizedMarket[market] = true;
        emit MarketAuthorized(market);
    }

    /// @notice Emergency pause — blocks deposits/mints and new LP matches.
    ///         Existing matches can still settle; LPs can still withdraw fees and shares.
    function pause()   external onlyOwner { _pause();   }
    function unpause() external onlyOwner { _unpause(); }

    /// @dev Emergency only — owner can revoke a misbehaving market.
    function deauthorizeMarket(address market) external onlyOwner {
        isAuthorizedMarket[market] = false;
        emit MarketDeauthorized(market);
    }

    // ── MATCHING (called by OrderbookMarket) ───────────────
    function tryMatch(
        uint256 orderId,
        uint256 amount,
        bool    userIsUp,
        uint256 matchId
    ) external onlyAuthorizedMarket nonReentrant whenNotPaused returns (bool matched) {
        address market = msg.sender;

        uint256 ta = totalAssets();
        if (ta == 0) return false;

        uint256 globalCap   = ta * GLOBAL_MAX_EXPOSURE_BPS     / 10_000;
        uint256 marketCap   = ta * PER_MARKET_MAX_EXPOSURE_BPS / 10_000;
        uint256 globalAvail = globalCap > totalExposure         ? globalCap - totalExposure         : 0;
        uint256 marketAvail = marketCap > marketExposure[market]? marketCap - marketExposure[market]: 0;
        uint256 maxMatch    = globalAvail < marketAvail ? globalAvail : marketAvail;

        if (maxMatch == 0) return false;

        uint256 matchAmount = amount <= maxMatch ? amount : maxMatch;

        totalExposure              += matchAmount;
        marketExposure[market]     += matchAmount;
        activeMatches[market][matchId] = ActiveMatch({
            amount:    matchAmount,
            lpIsDown:  userIsUp,
            settled:   false
        });

        IERC20(asset()).safeTransfer(market, matchAmount);

        emit MatchTaken(market, matchId, orderId, matchAmount);
        return true;
    }

    function onMatchSettled(uint256 matchId, bool upWon)
        external
        onlyAuthorizedMarket
        nonReentrant
    {
        address market = msg.sender;
        ActiveMatch storage am = activeMatches[market][matchId];
        require(am.amount > 0,    "match not found");
        require(!am.settled,      "already settled");
        am.settled = true;

        bool lpWon = am.lpIsDown ? !upWon : upWon;

        // Unlock exposure regardless of outcome.
        totalExposure          -= am.amount;
        marketExposure[market] -= am.amount;

        if (lpWon) {
            // Market has already transferred 2*amount back to this contract.
            // Carve out 1% fee for direct LP claim; remainder benefits all shares.
            uint256 fee = (am.amount * FEE_BPS_ON_LP_WIN) / 10_000;
            _accrueFee(fee);
            emit FeeAccrued(market, fee);
        }
        // If LP lost: market kept LP's stake. balance already reflects loss.

        emit MatchResult(market, matchId, lpWon, am.amount);
    }

    // ── FEE STREAM ─────────────────────────────────────────
    function _weightOf(address lp, uint256 shareAmount) internal view returns (uint256) {
        return isGenesis[lp]
            ? (shareAmount * GENESIS_BOOST_BPS) / 10_000
            : shareAmount;
    }

    function _currentWeight(address lp) internal view returns (uint256) {
        return _weightOf(lp, balanceOf(lp));
    }

    function _accrueFee(uint256 amount) internal {
        if (amount == 0 || totalFeeWeight == 0) return;
        cumFeePerWeight  += (amount * FEE_INDEX_PRECISION) / totalFeeWeight;
        totalPendingFees += amount;
    }

    function _accrueFees(address lp) internal {
        uint256 weight = _currentWeight(lp);
        uint256 delta  = cumFeePerWeight - feeIndexSnapshot[lp];
        if (weight > 0 && delta > 0) {
            pendingFees[lp] += (weight * delta) / FEE_INDEX_PRECISION;
        }
        feeIndexSnapshot[lp] = cumFeePerWeight;
    }

    function claimFees() external nonReentrant returns (uint256 amount) {
        _accrueFees(msg.sender);
        amount = pendingFees[msg.sender];
        require(amount > 0, "nothing to claim");

        pendingFees[msg.sender] = 0;
        totalPendingFees -= amount;
        IERC20(asset()).safeTransfer(msg.sender, amount);

        emit FeesClaimed(msg.sender, amount);
    }

    function earnedFees(address lp) external view returns (uint256) {
        uint256 weight = _currentWeight(lp);
        uint256 delta  = cumFeePerWeight - feeIndexSnapshot[lp];
        return pendingFees[lp] + (weight * delta) / FEE_INDEX_PRECISION;
    }

    // ── VIEWS ──────────────────────────────────────────────
    function availableForMatching() external view returns (uint256) {
        uint256 ta = totalAssets();
        uint256 cap = ta * GLOBAL_MAX_EXPOSURE_BPS / 10_000;
        return cap > totalExposure ? cap - totalExposure : 0;
    }

    function getPoolStats() external view returns (
        uint256 totalAssetsOut,
        uint256 available,
        uint256 providerExposure,
        uint256 genesisLeft
    ) {
        uint256 ta  = totalAssets();
        uint256 cap = ta * GLOBAL_MAX_EXPOSURE_BPS / 10_000;
        return (
            ta,
            cap > totalExposure ? cap - totalExposure : 0,
            totalExposure,
            GENESIS_MAX > genesisCount ? GENESIS_MAX - genesisCount : 0
        );
    }
}
