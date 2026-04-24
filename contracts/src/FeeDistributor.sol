// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FeeDistributor
 * @notice Принимает 0.5% комиссии и распределяет:
 *         40% рефереры · 20% treasury · 20% liquidity mining · 20% NFT rewards
 */
contract FeeDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    address public treasury;
    address public liquidityPool;
    address public nftRewardsPool;

    // BPS из 10000
    uint256 public constant REF_BPS      = 4000; // 40%
    uint256 public constant TREASURY_BPS = 2000; // 20%
    uint256 public constant LP_BPS       = 2000; // 20%
    uint256 public constant NFT_BPS      = 2000; // 20%

    // Реферальные балансы (pull pattern)
    mapping(address => uint256) public referralBalance;

    event FeeReceived(address indexed market, uint256 amount);
    event ReferralCredited(address indexed referrer, uint256 amount);
    event ReferralClaimed(address indexed referrer, uint256 amount);

    constructor(
        address _usdc,
        address _treasury,
        address _liquidityPool,
        address _nftRewardsPool
    ) Ownable(msg.sender) {
        usdc           = IERC20(_usdc);
        treasury       = _treasury;
        liquidityPool  = _liquidityPool;
        nftRewardsPool = _nftRewardsPool;
    }

    /**
     * @notice Получить fee от рынка и распределить.
     * @param totalFee    Общая сумма комиссии
     * @param referrers   Массив адресов рефереров участников
     * @param betAmounts  Массив сумм ставок (для расчёта доли реферала)
     * @param totalPool   Общий пул для расчёта
     */
    function distributeFee(
        uint256 totalFee,
        address[] calldata referrers,
        uint256[] calldata betAmounts,
        uint256 totalPool
    ) external nonReentrant {
        require(referrers.length == betAmounts.length, "length mismatch");

        usdc.safeTransferFrom(msg.sender, address(this), totalFee);

        uint256 totalRefPaid = 0;

        for (uint256 i = 0; i < referrers.length; i++) {
            if (referrers[i] == address(0)) continue;
            // Реферер получает 20% от fee своего реферала
            uint256 refFee = (betAmounts[i] * totalFee / totalPool) * 20 / 100;
            referralBalance[referrers[i]] += refFee;
            totalRefPaid += refFee;
            emit ReferralCredited(referrers[i], refFee);
        }

        // Остаток распределить по протоколу
        uint256 remaining = totalFee - totalRefPaid;
        uint256 toTreasury = remaining * TREASURY_BPS / (TREASURY_BPS + LP_BPS + NFT_BPS);
        uint256 toLP       = remaining * LP_BPS       / (TREASURY_BPS + LP_BPS + NFT_BPS);
        uint256 toNFT      = remaining - toTreasury - toLP;

        if (toTreasury > 0) usdc.safeTransfer(treasury, toTreasury);
        if (toLP > 0)       usdc.safeTransfer(liquidityPool, toLP);
        if (toNFT > 0)      usdc.safeTransfer(nftRewardsPool, toNFT);

        emit FeeReceived(msg.sender, totalFee);
    }

    /**
     * @notice Реферер забирает накопленные USDC.
     */
    function claimReferralRewards() external nonReentrant {
        uint256 amount = referralBalance[msg.sender];
        require(amount > 0, "nothing to claim");
        referralBalance[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit ReferralClaimed(msg.sender, amount);
    }

    // ── ADMIN ──────────────────────────────────────────────
    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
    }

    function setLiquidityPool(address _lp) external onlyOwner {
        liquidityPool = _lp;
    }

    function setNftRewardsPool(address _nft) external onlyOwner {
        nftRewardsPool = _nft;
    }
}
