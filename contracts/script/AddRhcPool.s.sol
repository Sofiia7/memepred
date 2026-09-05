// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../test/mocks/MockToken.sol";
import "../test/mocks/MockUniswapV3Pool.sol";
import "../test/mocks/MockUniswapV3Factory.sol";

/**
 * @title  AddRhcPool
 * @notice Adds one more stand-in pool to an existing testnet deployment.
 *
 * @dev    Two jobs, and they fit in one deployment.
 *
 *         **A token with a name.** The first stand-ins used MockWETH on both
 *         sides, so every log line and every row of the pool feed read
 *         "WETH / WETH". This one is called what it is.
 *
 *         **A pool that can be killed on purpose.** SETTLE_GRACE is a
 *         twenty-four hour constant, and emergencyRefundMatch is the only path
 *         by which money comes back out of a match the keeper cannot settle -
 *         the one refund path never exercised on any chain. Reaching it needs a
 *         match that stays unsettleable for a day, and the soak will never
 *         produce one because the keeper settles everything. So it gets its own
 *         pool: bets are placed, they match, the pool's liquidity is set to
 *         zero, and the resolver then refuses to price them exactly as it would
 *         for a token whose pool was drained under an open position.
 *
 *         Its own pool, because doing it to the soak's would stop the soak.
 *
 *         Reuses the deployment's existing WETH and factory - both are
 *         immutable on PoolMarketFactory, so a new WETH would mean a new stack.
 */
contract AddRhcPool is Script {
    uint24 constant FEE = 10000;

    function run() external {
        require(block.chainid != 4663, "stand-ins are for testnets");
        uint256 key = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(key);

        address weth = vm.envAddress("RHC_WETH_ADDRESS");
        MockUniswapV3Factory v3Factory = MockUniswapV3Factory(vm.envAddress("RHC_V3_FACTORY_ADDRESS"));
        string memory symbol = vm.envOr("RHC_NEW_TOKEN_SYMBOL", string("PEPE"));

        vm.startBroadcast(key);

        MockToken token = new MockToken(symbol, symbol, 18);
        (address token0, address token1) = address(token) < weth ? (address(token), weth) : (weth, address(token));

        MockUniswapV3Pool pool = new MockUniswapV3Pool(token0, token1, FEE);
        v3Factory.register(token0, token1, FEE, address(pool));

        // Passes every gate on sight: two hours of flat history at tick 0, 40
        // ETH of depth, a full observation ring. poolWatcher picks it up from
        // the PoolCreated event the registration emits and creates its markets
        // unaided - which is also a second run of the thing stage 2 is about.
        pool.pushTick(uint32(block.timestamp) - 7200, 0);
        pool.setLiquidity(40 ether);
        pool.setCardinality(300, 300);

        token.mint(deployer, 1_000_000 ether);

        vm.stopBroadcast();

        console.log("chainId:", block.chainid);
        console.log("\n--- Copy to .env ---");
        console.log("RHC_GRACE_POOL=%s", address(pool));
        console.log("RHC_GRACE_TOKEN=%s", address(token));
        console.log("\nsymbol %s, depth 40 ETH, cardinality 300, 2h of history", symbol);
        console.log("Kill it with MockUniswapV3Pool(pool).setLiquidity(0) once a match exists.");
    }
}
