// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/demo/ContinuousDemoPool.sol";
import "../src/PoolRounds.sol";
import "../src/TestWETH.sol";
import "./mocks/MockUniswapV3Factory.sol";

contract ContinuousDemoPoolTest is Test {
    ContinuousDemoPool pool;

    function setUp() public {
        vm.chainId(46630);
        vm.warp(1_791_120_000);
        pool = new ContinuousDemoPool(address(1), address(2), keccak256("FROGGO"));
    }

    function test_RefusesMainnet() public {
        vm.chainId(4663);
        vm.expectRevert("Testnet demo only");
        new ContinuousDemoPool(address(1), address(2), bytes32(0));
    }

    function test_CumulativeMatchesEverySecondAcrossCycleBoundary() public view {
        uint32 start = 5103;
        int56 total;
        for (uint32 t = start; t < start + 80; ++t) {
            total += int56(pool.tickAt(t));
        }
        assertEq(pool.cumulativeAt(start + 80) - pool.cumulativeAt(start), total);
    }

    function testFuzz_CumulativeMatchesPiecewiseSchedule(uint32 t, uint16 window) public view {
        t = uint32(bound(t, 0, 4_000_000_000));
        window = uint16(bound(window, 1, 600));
        int56 total;
        uint32 cursor = t;
        uint32 end = t + window;
        while (cursor < end) {
            uint32 next = uint32((uint256(cursor) / 20 + 1) * 20);
            if (next > end) next = end;
            total += int56(pool.tickAt(cursor)) * int56(uint56(next - cursor));
            cursor = next;
        }
        assertEq(pool.cumulativeAt(end) - pool.cumulativeAt(t), total);
    }

    function test_SpotMovesWithoutTransactionsAndCannotJumpPastGuard() public view {
        bool moved;
        for (uint32 t; t < 5120; t += 20) {
            int256 delta = int256(pool.tickAt(t + 20)) - int256(pool.tickAt(t));
            if (delta != 0) moved = true;
            assertLe(uint256(delta < 0 ? -delta : delta), 28);
        }
        assertTrue(moved);
    }

    function test_OracleGasDoesNotGrowAfterYearsOfUpdates() public {
        uint32[] memory ago = new uint32[](3);
        ago[0] = 600;
        ago[1] = 60;
        vm.cool(address(pool));
        uint256 before = gasleft();
        pool.observe(ago);
        uint256 initial = before - gasleft();
        vm.warp(block.timestamp + 3650 days);
        vm.cool(address(pool));
        before = gasleft();
        pool.observe(ago);
        uint256 later = before - gasleft();
        assertLe(later, initial + 10_000);
        assertLt(later, 80_000);
    }

    function test_RoundPaysNativeEthAndOldTicketsSurviveDelisting() public {
        TestWETH weth = new TestWETH();
        address coin = address(123);
        (address a, address b) = address(weth) < coin ? (address(weth), coin) : (coin, address(weth));
        ContinuousDemoPool oracle = new ContinuousDemoPool(a, b, keccak256("PEPE"));
        MockUniswapV3Factory factory = new MockUniswapV3Factory();
        factory.register(a, b, oracle.fee(), address(oracle));
        PoolRounds rounds = new PoolRounds(
            PoolRounds.Params({
                weth: address(weth),
                v3Factory: address(factory),
                referralRegistry: address(0),
                treasury: address(this),
                maxSideRatio: 1,
                strikePause: 300,
                strikeWindow: 60,
                depthPerBank: 2500,
                minStake: 0.005 ether,
                maxStake: 0.04 ether,
                minBank: 0.01 ether,
                costAllowance: 45_000e9
            })
        );
        rounds.setDuration(300, true);
        rounds.listPool(address(oracle));
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        uint256 id = rounds.roundIdOf(address(oracle), 300, block.timestamp / 300);
        vm.prank(alice);
        rounds.betWithEth{value: 0.005 ether}(id, PoolRounds.Side.UP, address(0));
        vm.prank(bob);
        rounds.betWithEth{value: 0.005 ether}(id, PoolRounds.Side.DOWN, address(0));
        rounds.delistPool(address(oracle));
        PoolRounds.Times memory tm = rounds.roundTimes(id);
        vm.warp(tm.strikeEnd);
        rounds.fixStrike(id);
        vm.warp(tm.settleAt);
        rounds.settle(id);
        (uint256 up,) = rounds.previewClaim(id, alice);
        (uint256 down,) = rounds.previewClaim(id, bob);
        vm.prank(alice);
        assertEq(rounds.claimAsEth(id), up);
        vm.prank(bob);
        assertEq(rounds.claimAsEth(id), down);
        assertEq(alice.balance, 0.995 ether + up);
        assertEq(bob.balance, 0.995 ether + down);
        assertTrue(up + down == 0.0098 ether || up + down == 0.0099 ether);
    }
}
