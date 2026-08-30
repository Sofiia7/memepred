// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/OrderbookMarket.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "../test/mocks/MockUSDC.sol";

contract TestLocalPool is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        MockUSDC usdc = new MockUSDC();
        // Just an address allowed to settle: the oracle is no longer reached
        // through the resolver.
        address resolver = vm.addr(0xBEEF);

        GenesisNFT genesisNFT = new GenesisNFT("ipfs://genesis/");
        LiquidityPool pool = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        OrderbookMarket market = new OrderbookMarket(
            address(usdc),
            address(resolver),
            address(pool),
            deployer, // fee distrib (mock)
            address(0), // referralRegistry — dev script, not exercised
            deployer, // multisig
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
        // The strike rides on the calldata as a signed RedStone payload, so the
        // bet cannot go through a normal typed call - forge has no way to
        // append bytes to one. Fetch a live payload first and pass it in:
        //
        //   REDSTONE_PAYLOAD=$(node scripts/print-redstone-payload.mjs PEPE)         //     forge script script/TestLocalPool.s.sol --broadcast
        bytes memory payload = vm.envBytes("REDSTONE_PAYLOAD");
        require(payload.length > 0, "REDSTONE_PAYLOAD not set - see comment above");

        (bool ok, bytes memory ret) = address(market)
            .call(
                bytes.concat(
                    abi.encodeWithSelector(
                        OrderbookMarket.placeBet.selector,
                        OrderbookMarket.Direction.UP,
                        uint256(100e6),
                        address(0),
                        uint256(1000 * 1e18),
                        uint256(100)
                    ),
                    payload
                )
            );
        require(ok, "placeBet reverted - is the payload fresh? the entry window is 20s");
        uint256 orderId = abi.decode(ret, (uint256));

        OrderbookMarket.Order memory o = market.getOrder(orderId);
        console.log("Order matched? ", uint256(o.status) == uint256(OrderbookMarket.OrderStatus.MATCHED));

        vm.stopBroadcast();
    }
}
