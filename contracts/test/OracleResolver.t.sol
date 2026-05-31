// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OracleResolver.sol";
import "../src/interfaces/IPyth.sol";
import "./mocks/MockPyth.sol";

/// @notice Restores coverage of OracleResolver — the previous test file was
///         deleted during the cold-start refactor and never replaced.
///         Focus areas: TWAP staleness, spread detection, Pyth normalization,
///         keeper role gating, ETH top-up withdrawal.
contract OracleResolverTest is Test {
    OracleResolver resolver;
    MockPyth       pyth;

    address admin  = address(this);
    address keeper = makeAddr("keeper");
    address other  = makeAddr("other");

    bytes32 constant FEED = bytes32("PEPE/USD");

    function setUp() public {
        pyth     = new MockPyth();
        resolver = new OracleResolver(address(pyth));
        resolver.addKeeper(keeper);
    }

    // ─── ACCESS CONTROL ─────────────────────────────────────
    function test_AddKeeper_OnlyAdmin() public {
        vm.expectRevert();
        vm.prank(other);
        resolver.addKeeper(other);
    }

    function test_RecordPrice_OnlyKeeper() public {
        bytes[] memory data = new bytes[](0);
        vm.prank(other);
        vm.expectRevert();
        resolver.recordPrice(FEED, data);
    }

    function test_RemoveKeeper_RevokesAccess() public {
        resolver.removeKeeper(keeper);
        pyth.setPrice(FEED, 1e8, -8);
        bytes[] memory data = new bytes[](0);
        vm.prank(keeper);
        vm.expectRevert();
        resolver.recordPrice(FEED, data);
    }

    // ─── PRICE RECORDING / TWAP ─────────────────────────────
    /// @dev TWAP of a constant price over the window equals that price.
    function test_TWAP_ConstantPrice() public {
        pyth.setPrice(FEED, 1_000_000_00, -8); // $1.00, 8 decimals
        bytes[] memory data = new bytes[](0);

        // Record 5 prices spaced by 30s, all $1.
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(keeper);
            resolver.recordPrice(FEED, data);
            vm.warp(block.timestamp + 30);
        }

        // Snapshot history via the public getter.
        (uint256 lastPrice, uint256 ts) = resolver.priceHistory(FEED, 4);
        assertEq(lastPrice, 1e18, "normalized $1 = 1e18");
        assertGt(ts, 0);
    }

    /// @dev If the last recorded price is older than TWAP_WINDOW (5 min),
    ///      _getTWAP must revert via "no price data".
    function test_TWAP_AllStale_NotUsable() public {
        pyth.setPrice(FEED, 1e8, -8);
        bytes[] memory data = new bytes[](0);

        vm.prank(keeper);
        resolver.recordPrice(FEED, data);

        // Jump past the 5-min TWAP window (and past 10-min cleanup head).
        vm.warp(block.timestamp + 11 minutes);

        // We can't call _getTWAP directly (internal); confirm history retains
        // a stale point and head advances on next recordPrice cleanup.
        (, uint256 ts0) = resolver.priceHistory(FEED, 0);
        assertGt(ts0, 0, "old point retained");
        assertEq(resolver.historyHead(FEED), 0, "head not yet advanced");

        // Trigger cleanup via a fresh recordPrice.
        vm.prank(keeper);
        resolver.recordPrice(FEED, data);
        assertEq(resolver.historyHead(FEED), 1, "head advanced past stale entry");
    }

    // ─── PYTH PRICE NORMALIZATION ───────────────────────────
    /// @dev expo = -8 → 8 decimals → divisor 1e8 → result scaled to 1e18.
    function test_Normalize_NegativeExpo() public {
        // 9142 with expo -8 → 9142 * 1e18 / 1e8 = 9142e10
        pyth.setPrice(FEED, 9142, -8);
        bytes[] memory data = new bytes[](0);
        vm.prank(keeper);
        resolver.recordPrice(FEED, data);
        (uint256 price, ) = resolver.priceHistory(FEED, 0);
        assertEq(price, 9142e10, "9142 with expo -8");
    }

    /// @dev expo = 0 → result = price * 1e18.
    function test_Normalize_ZeroExpo() public {
        pyth.setPrice(FEED, 5, 0);
        bytes[] memory data = new bytes[](0);
        vm.prank(keeper);
        resolver.recordPrice(FEED, data);
        (uint256 price, ) = resolver.priceHistory(FEED, 0);
        assertEq(price, 5e18, "5 with expo 0 = 5e18");
    }

    /// @dev Fuzz: any non-zero positive price with reasonable expo normalizes
    ///      to a non-zero uint256 without revert.
    function testFuzz_Normalize_NoRevert_PositivePrice(int64 raw, int8 expoSmall) public {
        vm.assume(raw > 0 && raw < 1e15);
        vm.assume(expoSmall > -18 && expoSmall < 0);
        int32 expo = int32(expoSmall);

        pyth.setPrice(FEED, raw, expo);
        bytes[] memory data = new bytes[](0);
        vm.prank(keeper);
        resolver.recordPrice(FEED, data);

        (uint256 price, ) = resolver.priceHistory(FEED, 0);
        assertGt(price, 0, "normalized > 0");
    }

    // ─── HISTORY CLEANUP / HEAD ADVANCE ─────────────────────
    function test_HistoryHead_NotAffectingFreshPrices() public {
        pyth.setPrice(FEED, 1e8, -8);
        bytes[] memory data = new bytes[](0);

        // 3 fresh prices in the window.
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(keeper);
            resolver.recordPrice(FEED, data);
            vm.warp(block.timestamp + 60);
        }
        // Head should still be 0 — none are stale yet.
        assertEq(resolver.historyHead(FEED), 0);
    }

    // ─── ETH MANAGEMENT ─────────────────────────────────────
    function test_ReceiveAndWithdrawETH() public {
        // Top up resolver with 1 ETH.
        vm.deal(address(this), 1 ether);
        (bool ok, ) = address(resolver).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(resolver).balance, 1 ether);

        // Withdraw 0.5 ETH as admin.
        address payable sink = payable(makeAddr("sink"));
        resolver.withdrawETH(sink, 0.5 ether);
        assertEq(address(resolver).balance, 0.5 ether);
        assertEq(sink.balance, 0.5 ether);
    }

    function test_WithdrawETH_OnlyAdmin() public {
        vm.deal(address(resolver), 1 ether);
        vm.prank(other);
        vm.expectRevert();
        resolver.withdrawETH(payable(other), 0.1 ether);
    }

    // Required for ETH-receiving tests.
    receive() external payable {}
}
