// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PoolRounds.sol";
import "../src/TestWETH.sol";
import "./PoolRoundMockPool.sol";
import "./mocks/MockUniswapV3Factory.sol";

contract PoolRoundsNativeEthTest is Test {
    PoolRounds rounds;
    TestWETH weth;
    PoolRoundMockPool pool;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.chainId(46630);
        vm.warp(1_790_000_000);
        weth = new TestWETH();
        MockUniswapV3Factory factory = new MockUniswapV3Factory();
        address token = makeAddr("meme");
        pool = new PoolRoundMockPool(address(weth), token, 3000);
        pool.pushTick(uint32(block.timestamp - 7200), 0);
        pool.setLiquidity(1000 ether);
        pool.setCardinality(900, 900);
        factory.register(address(weth), token, 3000, address(pool));
        rounds = new PoolRounds(PoolRounds.Params({
            weth: address(weth), v3Factory: address(factory), referralRegistry: address(0),
            treasury: address(this), maxSideRatio: 1, strikePause: 300,
            strikeWindow: 300, depthPerBank: 2500, minStake: 0.005 ether,
            maxStake: 0.04 ether, minBank: 0.02 ether, costAllowance: 69_692e9
        }));
        rounds.setDuration(300, true);
        rounds.listPool(address(pool));
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
    }

    function test_EthInEthOut_WhenRoundDoesNotMatch() public {
        uint256 openAt = (block.timestamp / 300 + 1) * 300;
        vm.warp(openAt);
        uint256 id = rounds.roundIdOf(address(pool), 300, openAt / 300);
        uint256 beforeEth = alice.balance;
        vm.prank(alice);
        rounds.betWithEth{value: 0.01 ether}(id, PoolRounds.Side.UP, address(0));
        assertEq(weth.balanceOf(address(rounds)), 0.01 ether);
        assertEq(weth.balanceOf(alice), 0);
        vm.warp(openAt + 300);
        vm.prank(alice);
        assertEq(rounds.claimAsEth(id), 0.01 ether);
        assertEq(alice.balance, beforeEth);
        assertEq(weth.balanceOf(address(rounds)), 0);
    }

    function test_MixedEthAndWethBets_AndEthTiePayout() public {
        uint256 openAt = (block.timestamp / 300 + 1) * 300;
        vm.warp(openAt);
        uint256 id = rounds.roundIdOf(address(pool), 300, openAt / 300);
        vm.prank(alice);
        rounds.betWithEth{value: 0.02 ether}(id, PoolRounds.Side.UP, address(0));
        vm.prank(bob);
        weth.deposit{value: 0.02 ether}();
        vm.prank(bob);
        weth.approve(address(rounds), 0.02 ether);
        vm.prank(bob);
        rounds.bet(id, 0.02 ether, PoolRounds.Side.DOWN, address(0));
        PoolRounds.Times memory tm = rounds.roundTimes(id);
        vm.warp(tm.settleAt);
        rounds.settle(id);
        uint256 beforeEth = alice.balance;
        vm.prank(alice);
        assertEq(rounds.claimAsEth(id), 0.0198 ether);
        assertEq(alice.balance - beforeEth, 0.0198 ether);
    }

    function test_BadEthStakeRevertsWithoutTakingEth() public {
        uint256 openAt = (block.timestamp / 300 + 1) * 300;
        vm.warp(openAt);
        uint256 id = rounds.roundIdOf(address(pool), 300, openAt / 300);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.StakeOutOfBounds.selector, 0.001 ether));
        rounds.betWithEth{value: 0.001 ether}(id, PoolRounds.Side.UP, address(0));
        assertEq(weth.balanceOf(address(rounds)), 0);
    }
}
