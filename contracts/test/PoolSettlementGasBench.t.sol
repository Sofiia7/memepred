// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/PoolOrderbookMarket.sol";
import "../src/PoolOracleResolver.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "./mocks/MockUniswapV3Pool.sol";
import "./mocks/MockMarketRegistry.sol";
import "./mocks/MockWETH.sol";

/**
 * Settlement gas on the Robinhood Chain path, which is the number MIN_BET is
 * derived from.
 *
 * SettlementGasBench measures the same thing on the Base path, and until this
 * file existed that was the best available proxy - it shares the market's
 * storage writes, which dominate, but it verifies RedStone signatures per match
 * where this reads a pool observation instead. Now that both halves exist the
 * proxy is not needed, and the difference between the two files is the honest
 * cost of changing oracles.
 *
 * The mock pool integrates ticks over time rather than returning a constant, so
 * the observe() work here is real work. What it cannot reproduce is the real
 * pool's binary search over a populated observation ring, which on chain
 * measured about 41,500 gas of execution against a live pool - so treat the
 * per-match figure here as a floor and add that.
 */
contract PoolSettlementGasBenchTest is Test {
    PoolOracleResolver resolver;
    MockWETH weth;

    address keeper = makeAddr("keeper");
    address memecoin = makeAddr("memecoin");
    address multisig = makeAddr("multisig");

    uint256 constant DURATION = 900; // exit window 180s
    uint256 constant BET = 0.02 ether;
    uint32 constant T0 = 1_787_000_000;

    function setUp() public {
        vm.warp(T0);
        weth = new MockWETH();
        resolver = new PoolOracleResolver(address(weth));
        resolver.addKeeper(keeper);
    }

    function test_BatchSettlementGasScaling() public {
        uint256[4] memory sizes = [uint256(1), 10, 20, 50];
        uint256[4] memory gas;

        for (uint256 i = 0; i < sizes.length; i++) {
            gas[i] = _measureBatch(sizes[i]);
            emit log_named_uint(string.concat("matches=", vm.toString(sizes[i]), " total gas"), gas[i]);
            emit log_named_uint("  gas per match", gas[i] / sizes[i]);
        }

        uint256 marginal = (gas[3] - gas[0]) / (sizes[3] - sizes[0]);
        emit log_named_uint("marginal gas per additional match", marginal);
        emit log_named_uint("fixed overhead per batch tx", gas[0] > marginal ? gas[0] - marginal : 0);

        // Break-even from TZ §8: the protocol takes at most 1% of a bank that
        // is twice one stake, so a stake has to clear 50x the settlement gas.
        // At MIN_BET and the p90 gas price this must hold with room to spare.
        emit log_named_uint("implied MIN_BET at 0.612 gwei (wei)", marginal * 50 * 612_000_000 / 1e9);

        assertLt(gas[3] / sizes[3], gas[0], "batching must beat one-at-a-time");
    }

    /**
     * How much of the per-match figure is the mock understating?
     *
     * The mock's observe() walks a two-segment array; a real pool binary
     * searches a populated ring, which measured 62,700 via eth_estimateGas on a
     * live RBLX pool - 41,500 of execution once the 21,200 of intrinsic and
     * calldata is taken off. Measuring the mock's own observe here turns that
     * into an adjustment instead of a guess.
     */
    function test_MockObserveUnderstatesTheRealPool() public {
        MockUniswapV3Pool pool = new MockUniswapV3Pool(memecoin, address(weth), 10000);
        pool.pushTick(T0 - 7200, 0);
        pool.pushTick(T0 - 600, 5);
        pool.setCardinality(300, 300);

        uint32[] memory secondsAgos = new uint32[](3);
        secondsAgos[0] = 181;
        secondsAgos[1] = 2;
        secondsAgos[2] = 1;

        uint256 before = gasleft();
        pool.observe(secondsAgos);
        uint256 mockObserve = before - gasleft();

        emit log_named_uint("mock observe (3 points)", mockObserve);
        emit log_named_uint("live pool observe execution, measured on chain", 41500);
        emit log_named_uint("understatement to add per match", 41500 > mockObserve ? 41500 - mockObserve : 0);
    }

    function _measureBatch(uint256 n) internal returns (uint256 gasUsed) {
        MockUniswapV3Pool pool = new MockUniswapV3Pool(memecoin, address(weth), 10000);
        pool.pushTick(T0 - 7200, 0);
        pool.setCardinality(300, 300);

        GenesisNFT genesisNFT = new GenesisNFT("ipfs://test/");
        LiquidityPool lp = new LiquidityPool(IERC20(address(weth)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(lp));

        PoolOrderbookMarket market = new PoolOrderbookMarket(
            address(weth),
            address(resolver),
            address(lp),
            makeAddr("feeDistrib"),
            address(0),
            multisig,
            bytes32(uint256(uint160(address(pool)))),
            DURATION
        );
        MockMarketRegistry registry = new MockMarketRegistry();
        registry.register(address(market));
        lp.setMarketFactory(address(registry));
        lp.authorizeMarket(address(market));

        // A fresh trader per side per match: reusing them would hit the
        // per-trader LP exposure cap long before fifty matches.
        for (uint256 i = 0; i < n; i++) {
            address up = address(uint160(uint256(keccak256(abi.encode("up", n, i)))));
            address down = address(uint160(uint256(keccak256(abi.encode("down", n, i)))));
            _bet(market, up, OrderbookMarket.Direction.UP);
            _bet(market, down, OrderbookMarket.Direction.DOWN);
        }

        uint256 settleAt = block.timestamp + DURATION;
        vm.warp(settleAt + 1);

        vm.prank(keeper);
        uint256 before = gasleft();
        uint256 settled = resolver.resolveOrderbookMarketBatch(address(market), n);
        gasUsed = before - gasleft();
        assertEq(settled, n, "every match must have settled");
    }

    function _bet(PoolOrderbookMarket market, address who, OrderbookMarket.Direction dir) internal {
        weth.mint(who, 1 ether);
        vm.startPrank(who);
        weth.approve(address(market), type(uint256).max);
        market.placeBet(dir, BET, address(0), 1e18, 100);
        vm.stopPrank();
    }
}
