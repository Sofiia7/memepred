// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev MarketFactory, narrowed to the one question its collaborators ask it.
 *
 * LiquidityPool, FeeDistributor and ReferralRegistry all gate authorizeMarket
 * on it: an address that the factory did not create must not be able to move
 * pool capital, credit itself fees, or pin referral links on people. Shared
 * from one file rather than declared three times, because three copies of an
 * interface in one compilation unit is a name clash waiting for the second
 * contract to import the first.
 */
interface IMarketRegistry {
    function isMarket(address market) external view returns (bool);
}
