// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../test/mocks/MockWETH.sol";
import "../test/mocks/MockUniswapV3Pool.sol";
import "../test/mocks/MockUniswapV3Factory.sol";

/**
 * @title  DeployRhcFixtures
 * @notice The pieces of the world that Robinhood Chain's testnet does not have.
 *
 * @dev    Checked on 46630: neither the WETH at
 *         0x0bd7d308f8e1639fab988df18a8011f41eacad73 nor the Uniswap v3 factory
 *         at 0x1f7d7550b1b028f7571e69a784071f0205fd2efa has any code. So a soak
 *         there cannot run against real pools, and something has to stand in.
 *
 *         These are the same mocks the unit tests use, which is the point: the
 *         pool integrates the tick over time and reverts 'OLD' past its
 *         observation ring exactly as Oracle.sol does, so the soak exercises
 *         the real settlement path rather than a happy one. What it does not
 *         exercise is Uniswap's own arithmetic - that is covered separately by
 *         224 (tick, sqrtPriceX96) vectors read off live mainnet pools.
 *
 *         It also buys something a real pool would not: the price is settable,
 *         so the soak can drive a market up, down, sideways and off a cliff on
 *         purpose instead of waiting for a memecoin to do it.
 *
 *         Never run this against 4663. The guard below refuses.
 */
contract DeployRhcFixtures is Script {
    uint24 constant FEE = 10000;

    function run() external {
        require(block.chainid != 4663, "fixtures are for testnets; mainnet has the real Uniswap");
        uint256 key = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(key);
        address keeper = vm.envAddress("KEEPER_ADDRESS");

        vm.startBroadcast(key);

        // An 18-decimal ERC20 each. MockWETH is used for both sides because
        // that is all a stand-in token needs to be; the names differ only in
        // what this script calls them.
        MockWETH weth = new MockWETH();
        MockWETH meme = new MockWETH();

        // Uniswap sorts a pool's tokens, and PoolMarketFactory.wethDepth reads
        // which slot WETH landed in to pick the right half of L = sqrt(x*y).
        // Sorting here means the stand-in exercises whichever branch the real
        // addresses would have.
        (address token0, address token1) =
            address(weth) < address(meme) ? (address(weth), address(meme)) : (address(meme), address(weth));

        MockUniswapV3Factory v3Factory = new MockUniswapV3Factory();
        MockUniswapV3Pool pool = new MockUniswapV3Pool(token0, token1, FEE);
        v3Factory.register(token0, token1, FEE, address(pool));

        // A pool that passes every gate on day one: two hours of flat history
        // at tick 0 (price 1.0), 50 ETH of depth, a full observation ring.
        pool.pushTick(uint32(block.timestamp) - 7200, 0);
        pool.setLiquidity(50 ether);
        pool.setCardinality(300, 300);

        // Stake money for the soak. The harness needs WETH on the accounts it
        // trades from, and there is no faucet for a token we just invented.
        weth.mint(deployer, 1000 ether);
        weth.mint(keeper, 100 ether);

        vm.stopBroadcast();

        console.log("chainId:", block.chainid);
        console.log("\n--- Copy to .env ---");
        console.log("RHC_WETH_ADDRESS=%s", address(weth));
        console.log("RHC_V3_FACTORY_ADDRESS=%s", address(v3Factory));
        console.log("RHC_FIXTURE_POOL=%s", address(pool));
        console.log("RHC_FIXTURE_TOKEN=%s", address(meme));
        console.log("\npool token0=%s token1=%s", token0, token1);
        console.log("depth 50 ETH, cardinality 300, 2h of history at tick 0");
    }
}
