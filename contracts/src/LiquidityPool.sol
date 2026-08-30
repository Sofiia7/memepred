// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./GenesisNFT.sol";
import "./interfaces/IMarketRegistry.sol";

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
    using Math for uint256;

    // ── CONSTANTS ──────────────────────────────────────────
    uint256 public constant MIN_DEPOSIT = 50e6; // 50 USDC
    uint256 public constant GENESIS_MAX = 20;
    uint256 public constant GENESIS_BOOST_BPS = 15_000; // 1.5x
    uint256 public constant GLOBAL_MAX_EXPOSURE_BPS = 1_000; // 10% of totalAssets()
    uint256 public constant PER_MARKET_MAX_EXPOSURE_BPS = 500; // 5% of totalAssets()
    uint256 public constant FEE_BPS_ON_LP_WIN = 100; // 1% of LP-won amount
    uint256 private constant FEE_INDEX_PRECISION = 1e30;

    // ── IMMUTABLES ─────────────────────────────────────────
    GenesisNFT public immutable genesisNFT;

    // ── MARKET FACTORY ─────────────────────────────────────
    address public marketFactory; // set once after deploy
    mapping(address => bool) public isAuthorizedMarket;

    // ── GENESIS ────────────────────────────────────────────
    // NOTE: Genesis status is derived from GenesisNFT ownership at any moment
    //       (NFT is the right; transfer the NFT → transfer the boost).
    //       hasBeenLP records first-time depositors so a single Genesis NFT
    //       is minted at most once per LP.
    mapping(address => bool) public hasBeenLP;
    uint256 public genesisCount;

    // Cached per-LP weight (shares × boost). Kept in sync with totalFeeWeight
    // on every event that can change it: mint, burn, NFT transfer.
    mapping(address => uint256) private _lpWeight;

    // ── EXPOSURE ───────────────────────────────────────────
    uint256 public totalExposure;
    mapping(address => uint256) public marketExposure; // market → locked USDC

    // ── MATCHES (composite key) ────────────────────────────
    struct ActiveMatch {
        uint256 amount;
        bool lpIsDown;
        bool settled;
    }
    mapping(address => mapping(uint256 => ActiveMatch)) public activeMatches;

    // ── FEE STREAM (index-based, O(1)) ─────────────────────
    uint256 public totalFeeWeight; // sum of feeWeight across LPs
    uint256 public cumFeePerWeight; // FEE_INDEX_PRECISION-scaled
    uint256 public totalPendingFees; // sum of pendingFees[]
    mapping(address => uint256) public feeIndexSnapshot;
    mapping(address => uint256) public pendingFees;

    // ── EVENTS ─────────────────────────────────────────────
    event MarketFactorySet(address indexed factory);
    event MarketAuthorized(address indexed market);
    event MarketDeauthorized(address indexed market);
    event GenesisMinted(address indexed lp, uint256 tokenId);
    event MatchTaken(address indexed market, uint256 indexed matchId, uint256 orderId, uint256 amount);
    event MatchResult(address indexed market, uint256 indexed matchId, bool lpWon, uint256 amount);
    event FeeAccrued(address indexed market, uint256 amount);
    event FeesClaimed(address indexed lp, uint256 amount);

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
        ERC20("FlipTheMeme LP Share", "ftmLP")
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
        // Open matches are counted at the stake the pool put up. That money has
        // left the balance (tryMatch transfers it to the market) but it is not
        // lost: it is staked on an outcome that returns twice the stake or
        // nothing, which is worth exactly the stake in expectation.
        //
        // Leaving it out marked the share price down by the whole stake for as
        // long as a match was open and snapped it back on settlement. That gap
        // is a discount anyone can buy: a deposit made while a match is live
        // bought in cheap and was holding shares when the price recovered,
        // moving the outcome of a bet onto somebody who arrived after the risk
        // was taken. See
        // test_DepositDuringOpenMatch_DoesNotTakeTheWinFromTheLpsWhoCarriedIt.
        //
        // Clamp on underflow: if the vault took losses big enough that balance
        // dropped below totalPendingFees, share-price falls to 0 instead of
        // reverting every view call. Pending fees become a socialised loss
        // claimed against whatever balance remains.
        uint256 bal = IERC20(asset()).balanceOf(address(this)) + totalExposure;
        return bal > totalPendingFees ? bal - totalPendingFees : 0;
    }

    /**
     * @dev What a withdrawal is priced against: cash on hand, less pending
     *      fees. Open matches are deliberately NOT counted here, even though
     *      totalAssets() counts them.
     *
     * The asymmetry is the whole point, and it closes the second half of the
     * timing problem.
     *
     * Valuing an open match at its stake is honest in expectation, but it stops
     * being honest the moment the underlying price moves: near settlement the
     * outcome can be all but decided while the mark still says "cost". An LP
     * watching a bet go against the pool could withdraw at that unmoved mark
     * and hand the loss to whoever stayed. Marking the position to market would
     * fix it in theory and is the wrong tool in practice - totalAssets() is
     * read by every ERC4626 operation, so it would put an oracle read and a
     * probability model in the path of every deposit, and hand an attacker a
     * price to manipulate.
     *
     * The structural answer needs no oracle: an LP who leaves takes their share
     * of the CASH and leaves their share of the open bets behind. Then leaving
     * is never better than staying - it is exactly equal when the pool loses
     * the bet, and worse when it wins - so there is nothing to time. The
     * forfeited share accrues to the LPs who stayed and carried the risk.
     *
     * Deposits still price against totalAssets(), which includes exposure, so
     * arriving mid-match is neither a discount nor a premium. Depositing and
     * immediately withdrawing is a strict loss, which is what makes the pair of
     * rules stable rather than a new edge in the other direction.
     */
    function _withdrawableAssets() internal view returns (uint256) {
        uint256 cash = IERC20(asset()).balanceOf(address(this));
        return cash > totalPendingFees ? cash - totalPendingFees : 0;
    }

    /// @dev Mirrors OZ's _convertToAssets against the cash-only base. The +1 /
    ///      +10**offset terms are the inherited virtual-share protection and
    ///      have to be kept identical, or the two directions stop agreeing.
    function previewRedeem(uint256 shares) public view override returns (uint256) {
        return shares.mulDiv(_withdrawableAssets() + 1, totalSupply() + 10 ** _decimalsOffset(), Math.Rounding.Floor);
    }

    /// @dev Mirrors OZ's _convertToShares against the cash-only base, rounding
    ///      up so the vault never gives away a wei to rounding.
    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        return assets.mulDiv(totalSupply() + 10 ** _decimalsOffset(), _withdrawableAssets() + 1, Math.Rounding.Ceil);
    }

    /// @notice True iff the vault holds enough USDC to back every accrued
    ///         pending fee. Off-chain monitors should alert when this is false.
    function isFullyBacked() external view returns (bool) {
        return IERC20(asset()).balanceOf(address(this)) >= totalPendingFees;
    }

    /// @dev Shares are soulbound. Allow mint (from=0) and burn (to=0) only.
    function _update(address from, address to, uint256 value) internal override {
        require(from == address(0) || to == address(0), "soulbound");

        // Accrue fees up to current index BEFORE changing balances.
        if (from != address(0)) _accrueFees(from);
        if (to != address(0)) _accrueFees(to);

        super._update(from, to, value);

        // Re-sync cached weight AFTER balances move.
        if (from != address(0)) _syncWeight(from);
        if (to != address(0)) _syncWeight(to);
    }

    /// @dev Withdraws are constrained by locked exposure across all markets.
    ///      Measured from the cash actually on hand, not from totalAssets():
    ///      totalAssets() now counts open exposure as an asset, so subtracting
    ///      totalExposure from it would leave exactly the balance and quietly
    ///      stop holding back anything at all. The reserved amount is identical
    ///      to what this always withheld - balance minus fees minus exposure.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        uint256 ownerAssets = previewRedeem(balanceOf(owner_));
        uint256 cash = IERC20(asset()).balanceOf(address(this));
        uint256 reserved = totalPendingFees + totalExposure;
        uint256 free = cash > reserved ? cash - reserved : 0;
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
        bool getGenesis = firstTime && genesisCount < GENESIS_MAX;
        if (firstTime) {
            hasBeenLP[receiver] = true;
            if (getGenesis) {
                genesisCount += 1;
                // Mint NFT BEFORE super.deposit so _syncWeight inside the mint
                // path picks up Genesis weight correctly.
                genesisNFT.mint(receiver, genesisCount);
                emit GenesisMinted(receiver, genesisCount);
            }
        }

        shares = super.deposit(assets, receiver);
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
        bool getGenesis = firstTime && genesisCount < GENESIS_MAX;
        if (firstTime) {
            hasBeenLP[receiver] = true;
            if (getGenesis) {
                genesisCount += 1;
                genesisNFT.mint(receiver, genesisCount);
                emit GenesisMinted(receiver, genesisCount);
            }
        }

        assets = super.mint(shares, receiver);
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

    /**
     * @notice Grant a market access to pooled funds.
     *
     * @dev The factory registry check is the point. This used to accept any
     *      non-zero address from the factory or the owner, so the owner could
     *      authorize their own EOA, call the match/settle entrypoints as if it
     *      were a market, and walk the pool out - onMatchSettled's LP-lost
     *      branch expects no funds back. Genesis NFT exists to attract
     *      third-party deposits, so the people carrying that risk are not the
     *      operator. The owner keeps deauthorizeMarket; taking capability away
     *      is not the dangerous direction.
     */
    function authorizeMarket(address market) external onlyFactoryOrOwner {
        require(market != address(0), "zero market");
        require(marketFactory != address(0), "factory not set");
        require(IMarketRegistry(marketFactory).isMarket(market), "not a market");
        isAuthorizedMarket[market] = true;
        emit MarketAuthorized(market);
    }

    /// @notice Emergency pause — blocks deposits/mints and new LP matches.
    ///         Existing matches can still settle; LPs can still withdraw fees and shares.
    ///         Note that tryMatch declines rather than reverting while paused;
    ///         see the comment there for why the difference matters.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Emergency only — owner can revoke a misbehaving market.
    function deauthorizeMarket(address market) external onlyOwner {
        isAuthorizedMarket[market] = false;
        emit MarketDeauthorized(market);
    }

    // ── MATCHING (called by OrderbookMarket) ───────────────
    function tryMatch(uint256 orderId, uint256 amount, bool userIsUp, uint256 matchId)
        external
        onlyAuthorizedMarket
        nonReentrant
        returns (uint256 matchedAmount)
    {
        address market = msg.sender;

        // Declined, not reverted. This carried whenNotPaused, and the caller is
        // OrderbookMarket._tryLpMatch - inside placeBet, with no try/catch,
        // before the unmatched remainder is queued. So pausing the pool did not
        // just stop the pool taking the other side of a bet: it reverted every
        // bet the opposite queue did not fill outright, including plain maker
        // orders on an empty book, which could no longer even be placed. An
        // emergency switch on the pool became an emergency switch on trading
        // itself, which is neither what this pause is for nor what the header
        // above promises. A pool with nothing to offer already answers 0 and
        // lets the order rest; a paused pool is the same answer.
        if (paused()) return 0;

        uint256 ta = totalAssets();
        if (ta == 0 || amount == 0) return 0;

        uint256 globalCap = (ta * GLOBAL_MAX_EXPOSURE_BPS) / 10_000;
        uint256 marketCap = (ta * PER_MARKET_MAX_EXPOSURE_BPS) / 10_000;
        uint256 globalAvail = globalCap > totalExposure ? globalCap - totalExposure : 0;
        uint256 marketAvail = marketCap > marketExposure[market] ? marketCap - marketExposure[market] : 0;
        uint256 maxMatch = globalAvail < marketAvail ? globalAvail : marketAvail;

        if (maxMatch == 0) return 0;

        matchedAmount = amount <= maxMatch ? amount : maxMatch;

        totalExposure += matchedAmount;
        marketExposure[market] += matchedAmount;
        activeMatches[market][matchId] = ActiveMatch({amount: matchedAmount, lpIsDown: userIsUp, settled: false});

        IERC20(asset()).safeTransfer(market, matchedAmount);

        emit MatchTaken(market, matchId, orderId, matchedAmount);
    }

    /**
     * @notice Called by an authorized market when a match is emergency-refunded
     *         (matched but never settled within OrderbookMarket.SETTLE_GRACE).
     *         Just unlocks exposure — market has already returned the LP stake.
     *         No P&L change; no fee accrual.
     */
    function onMatchRefunded(uint256 matchId) external onlyAuthorizedMarket nonReentrant {
        address market = msg.sender;
        ActiveMatch storage am = activeMatches[market][matchId];
        require(am.amount > 0, "match not found");
        require(!am.settled, "already settled");
        am.settled = true;

        totalExposure -= am.amount;
        marketExposure[market] -= am.amount;

        emit MatchResult(market, matchId, false, am.amount);
    }

    function onMatchSettled(uint256 matchId, bool upWon) external onlyAuthorizedMarket nonReentrant {
        address market = msg.sender;
        ActiveMatch storage am = activeMatches[market][matchId];
        require(am.amount > 0, "match not found");
        require(!am.settled, "already settled");
        am.settled = true;

        bool lpWon = am.lpIsDown ? !upWon : upWon;

        // Unlock exposure regardless of outcome.
        totalExposure -= am.amount;
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

    // ── GENESIS HOOK (callable only by GenesisNFT) ─────────
    /**
     * @notice Called by GenesisNFT on every transfer (incl. mint/burn) so the
     *         pool can reflect the new Genesis owner in the fee-stream weights.
     *         No-op for self-transfers.
     */
    function onGenesisTransfer(address from, address to) external {
        require(msg.sender == address(genesisNFT), "only genesis nft");
        if (from == to) return;
        // Accrue pending fees with the OLD weight before resyncing.
        if (from != address(0)) _accrueFees(from);
        if (to != address(0)) _accrueFees(to);
        if (from != address(0)) _syncWeight(from);
        if (to != address(0)) _syncWeight(to);
    }

    // ── FEE STREAM ─────────────────────────────────────────
    /// @dev Genesis status is derived from NFT ownership — transfer the NFT,
    ///      transfer the boost.
    function isGenesis(address lp) public view returns (bool) {
        return address(genesisNFT) != address(0) && genesisNFT.balanceOf(lp) > 0;
    }

    function _intendedWeight(address lp) internal view returns (uint256) {
        uint256 sh = balanceOf(lp);
        if (sh == 0) return 0;
        return isGenesis(lp) ? (sh * GENESIS_BOOST_BPS) / 10_000 : sh;
    }

    function _currentWeight(address lp) internal view returns (uint256) {
        return _lpWeight[lp];
    }

    /// @dev Reconcile _lpWeight[lp] and totalFeeWeight with the LP's
    ///      current intent (balance × boost). Must run AFTER fees are accrued.
    function _syncWeight(address lp) internal {
        uint256 oldW = _lpWeight[lp];
        uint256 newW = _intendedWeight(lp);
        if (newW == oldW) return;
        if (newW > oldW) {
            totalFeeWeight += newW - oldW;
        } else {
            uint256 d = oldW - newW;
            totalFeeWeight = totalFeeWeight > d ? totalFeeWeight - d : 0;
        }
        _lpWeight[lp] = newW;
    }

    function _accrueFee(uint256 amount) internal {
        if (amount == 0 || totalFeeWeight == 0) return;
        cumFeePerWeight += (amount * FEE_INDEX_PRECISION) / totalFeeWeight;
        totalPendingFees += amount;
    }

    function _accrueFees(address lp) internal {
        uint256 weight = _currentWeight(lp);
        uint256 delta = cumFeePerWeight - feeIndexSnapshot[lp];
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
        uint256 delta = cumFeePerWeight - feeIndexSnapshot[lp];
        return pendingFees[lp] + (weight * delta) / FEE_INDEX_PRECISION;
    }

    // ── VIEWS ──────────────────────────────────────────────
    function availableForMatching() external view returns (uint256) {
        uint256 ta = totalAssets();
        uint256 cap = ta * GLOBAL_MAX_EXPOSURE_BPS / 10_000;
        return cap > totalExposure ? cap - totalExposure : 0;
    }

    function getPoolStats()
        external
        view
        returns (uint256 totalAssetsOut, uint256 available, uint256 providerExposure, uint256 genesisLeft)
    {
        uint256 ta = totalAssets();
        uint256 cap = ta * GLOBAL_MAX_EXPOSURE_BPS / 10_000;
        return (
            ta,
            cap > totalExposure ? cap - totalExposure : 0,
            totalExposure,
            GENESIS_MAX > genesisCount ? GENESIS_MAX - genesisCount : 0
        );
    }
}
