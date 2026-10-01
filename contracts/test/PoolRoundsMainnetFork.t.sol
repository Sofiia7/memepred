// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PoolRounds.sol";

/**
 * @notice Read a canonical Robinhood Chain mainnet v3 pool through the current
 *         PoolRounds implementation. All deployments, token balances, bets and
 *         time travel in this test exist only inside the local fork.
 * @dev The public RPC retains little historical state, so fork latest. Set
 *      RHC_MAINNET_RPC to opt in; offline CI does not claim to run this check.
 */
contract PoolRoundsMainnetForkTest is Test {
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant RMHT_POOL = 0xabe3B1fF5Fc6a9638D0c46f2379B20f7e6173bEe;

    address internal alice = makeAddr("rounds-mainnet-fork-alice");
    address internal bob = makeAddr("rounds-mainnet-fork-bob");
    PoolRounds internal rounds;
    bool internal active;

    function setUp() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        require(block.chainid == 4663, "wrong fork chain");
        active = true;
        rounds = new PoolRounds(
            PoolRounds.Params({
                weth: WETH,
                v3Factory: V3_FACTORY,
                referralRegistry: address(0),
                treasury: makeAddr("rounds-mainnet-fork-treasury"),
                maxSideRatio: 1,
                strikePause: 300,
                strikeWindow: 300,
                depthPerBank: 2500,
                minStake: 0.005 ether,
                maxStake: 0.04 ether,
                minBank: 0.02 ether,
                costAllowance: 69_692e9
            })
        );
        rounds.setDuration(300, true);
    }

    function test_RealPoolRoundReadsAndCollects() public {
        if (!active) vm.skip(true);

        IUniswapV3Pool pool = IUniswapV3Pool(RMHT_POOL);
        assertTrue(pool.token0() == WETH || pool.token1() == WETH, "not WETH paired");
        assertEq(V3_FACTORY, address(rounds.v3Factory()));
        assertEq(IUniswapV3Factory(V3_FACTORY).getPool(pool.token0(), pool.token1(), pool.fee()), RMHT_POOL);

        (,,, uint16 cardinality,,,) = pool.slot0();
        uint256 depth = rounds.wethDepth(RMHT_POOL);
        emit log_named_uint("fork block", block.number);
        emit log_named_uint("WETH depth", depth);
        emit log_named_uint("observation cardinality", cardinality);
        emit log_named_uint("required WETH depth", rounds.gateDepth());
        emit log_named_uint("required cardinality", rounds.minCardinality());

        // The test is a live eligibility probe too: if RMHT falls below the
        // gate, the failed assertion documents the changed pool state.
        assertGe(depth, rounds.gateDepth(), "real pool fell below depth gate");
        assertGe(cardinality, rounds.minCardinality(), "real pool fell below observation gate");
        assertTrue(rounds.canServeWindow(RMHT_POOL, 300), "real pool lacks 300s history");
        rounds.listPool(RMHT_POOL);

        deal(WETH, alice, 0.01 ether);
        deal(WETH, bob, 0.01 ether);
        vm.prank(alice);
        IERC20(WETH).approve(address(rounds), 0.01 ether);
        vm.prank(bob);
        IERC20(WETH).approve(address(rounds), 0.01 ether);

        uint256 roundId = rounds.currentRoundId(RMHT_POOL, 300);
        vm.prank(alice);
        rounds.bet(roundId, 0.01 ether, PoolRounds.Side.UP, address(0));
        vm.prank(bob);
        rounds.bet(roundId, 0.01 ether, PoolRounds.Side.DOWN, address(0));

        PoolRounds.Times memory times = rounds.roundTimes(roundId);
        vm.warp(times.strikeEnd);
        rounds.fixStrike(roundId);
        vm.warp(times.settleAt);
        rounds.settle(roundId);

        PoolRounds.RoundView memory result = rounds.roundView(roundId);
        assertTrue(result.activated, "round not active");
        assertTrue(result.strikeFixed, "real pool strike not read");
        assertEq(uint8(result.outcome), uint8(PoolRounds.Outcome.TIE), "static fork should tie");
        assertEq(result.entryTick, result.exitTick, "forked pool should keep its tick");
        emit log_named_int("real pool strike tick", result.entryTick);
        emit log_named_int("real pool exit tick", result.exitTick);
        vm.prank(alice);
        assertEq(rounds.claim(roundId), 0.0099 ether, "Alice tie refund");
        vm.prank(bob);
        assertEq(rounds.claim(roundId), 0.0099 ether, "Bob tie refund");
        emit log_named_uint("fork-only tie payout to each player", 0.0099 ether);
    }
}
