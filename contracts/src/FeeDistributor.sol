// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FeeDistributor
 * @notice Receives match fees pushed by authorized markets and splits them:
 *           - REF_BPS (40%)      → referrer (pull pattern)
 *           - TREASURY_BPS (20%) → treasury
 *           - LP_BPS (20%)       → liquidityPool fee sink
 *           - NFT_BPS (20%)      → nftRewardsPool
 *
 * Push pattern:
 *   1. Market does `usdc.safeTransfer(feeDistributor, totalFee)`.
 *   2. Market calls `feeDistributor.distributeFee(totalFee, referrer)` in the
 *      same tx so the fee never sits unsplit.
 *
 * If the winning order has no referrer, REF_BPS is redistributed pro-rata to
 * the other three sinks.
 */
contract FeeDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    address public treasury;
    address public liquidityPool;
    address public nftRewardsPool;

    address public marketFactory;
    mapping(address => bool) public isAuthorizedMarket;

    uint256 public constant REF_BPS      = 4000; // 40%
    uint256 public constant TREASURY_BPS = 2000; // 20%
    uint256 public constant LP_BPS       = 2000; // 20%
    uint256 public constant NFT_BPS      = 2000; // 20%

    mapping(address => uint256) public referralBalance;

    event MarketFactorySet (address indexed factory);
    event MarketAuthorized (address indexed market);
    event MarketDeauthorized(address indexed market);
    event FeeReceived      (address indexed market, uint256 totalFee, address indexed referrer);
    event ReferralCredited (address indexed referrer, uint256 amount);
    event ReferralClaimed  (address indexed referrer, uint256 amount);

    modifier onlyFactoryOrOwner() {
        require(msg.sender == marketFactory || msg.sender == owner(), "only factory or owner");
        _;
    }

    constructor(
        address _usdc,
        address _treasury,
        address _liquidityPool,
        address _nftRewardsPool
    ) Ownable(msg.sender) {
        require(_usdc != address(0) && _treasury != address(0)
             && _liquidityPool != address(0) && _nftRewardsPool != address(0), "zero address");
        usdc           = IERC20(_usdc);
        treasury       = _treasury;
        liquidityPool  = _liquidityPool;
        nftRewardsPool = _nftRewardsPool;
    }

    // ── auth ──────────────────────────────────────────────
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

    function deauthorizeMarket(address market) external onlyOwner {
        isAuthorizedMarket[market] = false;
        emit MarketDeauthorized(market);
    }

    // ── distribution ──────────────────────────────────────
    /**
     * @notice Called by an authorized market AFTER pushing `totalFee` USDC to this contract.
     * @param totalFee  fee already transferred to this contract.
     * @param referrer  referrer of the winning bet (zero if none).
     */
    function distributeFee(uint256 totalFee, address referrer) external nonReentrant {
        require(isAuthorizedMarket[msg.sender], "not authorized market");
        require(totalFee > 0, "zero fee");

        uint256 toRef = referrer == address(0) ? 0 : (totalFee * REF_BPS) / 10_000;
        if (toRef > 0) {
            referralBalance[referrer] += toRef;
            emit ReferralCredited(referrer, toRef);
        }

        uint256 remaining  = totalFee - toRef;
        uint256 base       = TREASURY_BPS + LP_BPS + NFT_BPS; // 6000
        uint256 toTreasury = (remaining * TREASURY_BPS) / base;
        uint256 toLP       = (remaining * LP_BPS)       / base;
        uint256 toNFT      = remaining - toTreasury - toLP;

        if (toTreasury > 0) usdc.safeTransfer(treasury,       toTreasury);
        if (toLP       > 0) usdc.safeTransfer(liquidityPool,  toLP);
        if (toNFT      > 0) usdc.safeTransfer(nftRewardsPool, toNFT);

        emit FeeReceived(msg.sender, totalFee, referrer);
    }

    function claimReferralRewards() external nonReentrant returns (uint256 amount) {
        amount = referralBalance[msg.sender];
        require(amount > 0, "nothing to claim");
        referralBalance[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit ReferralClaimed(msg.sender, amount);
    }

    // ── admin ─────────────────────────────────────────────
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "zero");
        treasury = _treasury;
    }
    function setLiquidityPool(address _lp) external onlyOwner {
        require(_lp != address(0), "zero");
        liquidityPool = _lp;
    }
    function setNftRewardsPool(address _nft) external onlyOwner {
        require(_nft != address(0), "zero");
        nftRewardsPool = _nft;
    }
}
