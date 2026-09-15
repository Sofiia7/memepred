// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./FeeDistributor.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title RhcFeeDistributor
 * @notice RHC fee split with a settlement reserve as the first obligation.
 *
 * @dev The Base distributor is intentionally left untouched. At RHC's 0.005
 * WETH minimum, giving 40% of a 1% fee to a referrer leaves the treasury below
 * the measured cost of settlement. This implementation keeps a modest 10%
 * attribution reward and directs the remaining 90% to the operational reserve
 * (treasury). LP P&L and the LP taker fee remain separate economics; NFT fee
 * farming is not part of the RHC launch path.
 */
contract RhcFeeDistributor is FeeDistributor {
    using SafeERC20 for IERC20;
    uint256 public constant RHC_REF_BPS = 1000;
    uint256 public constant RHC_TREASURY_BPS = 9000;

    constructor(address _weth, address _treasury, address _liquidityPool, address _nftRewardsPool)
        FeeDistributor(_weth, _treasury, _liquidityPool, _nftRewardsPool)
    {}

    function distributeFee(uint256 totalFee, address referrer) public virtual override nonReentrant {
        require(isAuthorizedMarket[msg.sender], "not authorized market");
        require(totalFee > 0, "zero fee");

        uint256 toRef = referrer == address(0) ? 0 : (totalFee * RHC_REF_BPS) / 10_000;
        if (toRef > 0) {
            referralBalance[referrer] += toRef;
            totalReferralOwed += toRef;
            emit ReferralCredited(referrer, toRef);
        }

        // If there is no referrer the whole fee becomes reserve. Rounding dust
        // also stays there, so every received wei is accounted for.
        uint256 toTreasury = totalFee - toRef;
        if (toTreasury > 0) usdc.safeTransfer(treasury, toTreasury);
        emit FeeReceived(msg.sender, totalFee, referrer);
    }
}
