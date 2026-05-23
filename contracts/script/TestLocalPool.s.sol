// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/OrderbookMarket.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "../test/mocks/MockUSDC.sol";
import "../test/mocks/MockPyth.sol";

contract MockResolver {
    address public pyth;
    constructor(address _pyth) {
        pyth = _pyth;
    }
}

contract TestLocalPool is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        MockUSDC usdc = new MockUSDC();
        MockPyth pyth = new MockPyth();
        MockResolver resolver = new MockResolver(address(pyth));
        pyth.setPrice(bytes32("PEPE/USD"), 1000, 0);

        GenesisNFT genesisNFT = new GenesisNFT("ipfs://genesis/");
        LiquidityPool pool = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        OrderbookMarket market = new OrderbookMarket(
            address(usdc),
            address(resolver),
            address(pool),
            deployer,    // fee distrib (mock)
            address(0),  // referralRegistry — dev script, not exercised
            deployer,    // multisig
            bytes32("PEPE/USD"),
            15 minutes
        );
        // Authorize this market directly (owner path, no factory in dev script).
        pool.authorizeMarket(address(market));

        console.log("LiquidityPool: ", address(pool));
        console.log("OrderbookMarket: ", address(market));

        usdc.mint(deployer, 10000e6);
        usdc.approve(address(pool), type(uint256).max);

        console.log("Depositing 5000 USDC into Pool...");
        uint256 shares = pool.deposit(5000e6, deployer);
        console.log("Shares minted: ", shares);
        console.log("Is Genesis LP: ", pool.isGenesis(deployer));
        console.log("totalAssets:   ", pool.totalAssets());

        usdc.approve(address(market), type(uint256).max);
        console.log("Placing bet against LP...");
        uint256 orderId = market.placeBet(
            OrderbookMarket.Direction.UP,
            100e6,
            address(0),
            1000 * 1e18,
            100
        );

        OrderbookMarket.Order memory o = market.getOrder(orderId);
        console.log("Order matched? ", uint(o.status) == uint(OrderbookMarket.OrderStatus.MATCHED));

        vm.stopBroadcast();
    }
}
