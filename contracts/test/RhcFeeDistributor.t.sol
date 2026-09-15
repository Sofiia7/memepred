// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/RhcFeeDistributor.sol";
import "./mocks/MockWETH.sol";
import "./mocks/MockMarketRegistry.sol";

contract RhcFeeDistributorTest is Test {
    MockWETH weth;
    RhcFeeDistributor distributor;
    MockMarketRegistry registry;

    address treasury = makeAddr("treasury");
    address market = makeAddr("market");
    address referrer = makeAddr("referrer");

    function setUp() public {
        weth = new MockWETH();
        distributor = new RhcFeeDistributor(address(weth), treasury, treasury, treasury);
        registry = new MockMarketRegistry();
        registry.register(market);
        distributor.setMarketFactory(address(registry));
        distributor.authorizeMarket(market);
    }

    function test_RhcKeepsNinetyPercentForSettlementReserve() public {
        uint256 fee = 0.01 ether;
        weth.mint(address(distributor), fee);

        vm.prank(market);
        distributor.distributeFee(fee, referrer);

        assertEq(weth.balanceOf(treasury), 0.009 ether);
        assertEq(distributor.referralBalance(referrer), 0.001 ether);
        assertEq(distributor.totalReferralOwed(), 0.001 ether);
    }

    function test_RhcSendsAnUnattributedFeeFullyToReserve() public {
        uint256 fee = 0.01 ether;
        weth.mint(address(distributor), fee);

        vm.prank(market);
        distributor.distributeFee(fee, address(0));

        assertEq(weth.balanceOf(treasury), fee);
        assertEq(distributor.totalReferralOwed(), 0);
    }
}
