// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OracleResolver.sol";
import "./mocks/MockPyth.sol";
import "./mocks/MockUSDC.sol";
import "../src/PvPMarket.sol";

contract OracleResolverTest is Test {
    OracleResolver resolver;
    MockPyth       mockPyth;
    MockUSDC       usdc;

    address keeper   = makeAddr("keeper");
    address multisig = makeAddr("multisig");
    address feeDist  = makeAddr("feeDist");
    address alice    = makeAddr("alice");
    address bob      = makeAddr("bob");

    bytes32 constant FEED_ID = bytes32("PEPE/USD");

    function setUp() public {
        mockPyth = new MockPyth();
        usdc     = new MockUSDC();
        resolver = new OracleResolver(address(mockPyth));
        resolver.addKeeper(keeper);

        // Set initial price
        mockPyth.setPrice(FEED_ID, 9142, -8); // $0.00009142
    }

    function test_RecordPrice() public {
        bytes[] memory data = new bytes[](0);
        vm.prank(keeper);
        resolver.recordPrice(FEED_ID, data);
    }

    function test_RecordPrice_OnlyKeeper() public {
        bytes[] memory data = new bytes[](0);
        vm.prank(alice);
        vm.expectRevert();
        resolver.recordPrice(FEED_ID, data);
    }

    function test_AddRemoveKeeper() public {
        address newKeeper = makeAddr("newKeeper");
        resolver.addKeeper(newKeeper);

        bytes[] memory data = new bytes[](0);
        vm.prank(newKeeper);
        resolver.recordPrice(FEED_ID, data);

        resolver.removeKeeper(newKeeper);
        vm.prank(newKeeper);
        vm.expectRevert();
        resolver.recordPrice(FEED_ID, data);
    }

    function test_ResolveMarket() public {
        // Create a market
        PvPMarket market = new PvPMarket();
        market.initialize(
            address(usdc), address(resolver), feeDist, multisig,
            5 minutes, FEED_ID, 9142 * 1e10 // normalized entry price
        );

        // Place bets
        usdc.mint(alice, 1000e6);
        usdc.mint(bob,   1000e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(market), type(uint256).max);
        vm.prank(alice); market.placeBet(IMarket.Direction.UP,   50e6, address(0));
        vm.prank(bob);   market.placeBet(IMarket.Direction.DOWN, 50e6, address(0));

        // Record price history for TWAP
        bytes[] memory data = new bytes[](0);
        vm.prank(keeper);
        resolver.recordPrice(FEED_ID, data);

        // Warp past close
        vm.warp(block.timestamp + 6 minutes);

        // Set exit price higher
        mockPyth.setPrice(FEED_ID, 10000, -8); // $0.00010000 (higher)

        vm.prank(keeper);
        resolver.recordPrice(FEED_ID, data);

        // Resolve
        vm.prank(keeper);
        resolver.resolveMarket(address(market), data);

        assertEq(uint(market.status()), uint(IMarket.Status.RESOLVED));
        assertTrue(market.upWon());
    }
}
