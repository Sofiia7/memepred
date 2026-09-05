// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/OracleResolver.sol";
import "../src/OrderbookMarket.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "./helpers/RedstonePayloadBuilder.sol";
import "./helpers/RedstoneHarness.sol";
import "./mocks/MockMarketRegistry.sol";
import "./mocks/MockUSDC.sol";

/**
 * Measures what a settlement actually costs, and - the reason this file exists -
 * how much of that cost batching can remove.
 *
 * TZ §8 sets MIN_BET from the break-even `0.01 * bank > gas`, and leans on
 * batching to push it down ("батчами она падает кратно"). That claim is only
 * true if the per-match work is small next to the per-transaction work. This
 * benchmark settles it by measuring the same batch at 1 / 10 / 20 / 50 matches
 * and reporting the marginal cost of one extra match, which is the number
 * MIN_BET is actually a function of.
 *
 * Asserts nothing about absolute gas on purpose: it is a measurement harness,
 * and a threshold here would just break on every unrelated change. It fails
 * only if batching stops working at all.
 *
 * Run: forge test --match-contract SettlementGasBench -vv
 */
contract SettlementGasBenchTest is Test {
    OracleResolverHarness resolver;
    address keeper = makeAddr("keeper");
    bytes32 constant FEED = bytes32("PEPE/USD");
    uint256 constant DURATION = 15 minutes;
    uint256 constant BET = 25e6;

    function setUp() public {
        resolver = new OracleResolverHarness();
        resolver.addKeeper(keeper);
        vm.warp(1_787_000_000);
    }

    function test_BatchSettlementGasScaling() public {
        uint256[4] memory sizes = [uint256(1), 10, 20, 50];
        uint256[4] memory gas;

        for (uint256 i = 0; i < sizes.length; i++) {
            gas[i] = _measureBatch(sizes[i]);
            emit log_named_uint(string.concat("matches=", vm.toString(sizes[i]), " total gas"), gas[i]);
            emit log_named_uint("  gas per match", gas[i] / sizes[i]);
        }

        // Marginal cost of one more match, from the widest pair measured. This
        // is the figure that sets MIN_BET: the fixed part amortises away, this
        // does not.
        uint256 marginal = (gas[3] - gas[0]) / (sizes[3] - sizes[0]);
        emit log_named_uint("marginal gas per additional match", marginal);
        emit log_named_uint("fixed overhead per batch tx", gas[0] > marginal ? gas[0] - marginal : 0);

        assertLt(gas[3] / sizes[3], gas[0], "batching must beat one-at-a-time");
    }

    /// Builds a market carrying `n` ready matches and returns the gas the
    /// single batch call to settle all of them consumed.
    function _measureBatch(uint256 n) internal returns (uint256 gasUsed) {
        MockUSDC usdc = new MockUSDC();
        GenesisNFT genesisNFT = new GenesisNFT("ipfs://test/");
        LiquidityPool pool = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        OrderbookMarket market = new OrderbookMarketHarness(
            address(usdc),
            address(resolver),
            address(pool),
            makeAddr("feeDistrib"),
            address(0),
            makeAddr("multisig"),
            FEED,
            DURATION
        );
        MockMarketRegistry registry = new MockMarketRegistry();
        registry.register(address(market));
        pool.setMarketFactory(address(registry));
        pool.authorizeMarket(address(market));

        // One fresh trader per side per match: reusing traders would trip the
        // per-trader LP exposure cap long before 50 matches.
        for (uint256 i = 0; i < n; i++) {
            address up = address(uint160(uint256(keccak256(abi.encode("up", n, i)))));
            address down = address(uint160(uint256(keccak256(abi.encode("down", n, i)))));
            _fund(usdc, market, up);
            _fund(usdc, market, down);
            _bet(market, up, OrderbookMarket.Direction.UP, BET);
            _bet(market, down, OrderbookMarket.Direction.DOWN, BET);
        }

        // A price point inside the exit TWAP window (duration/5 = 3 min here),
        // then past settleAt so every match is ready.
        vm.warp(block.timestamp + DURATION - 60);
        _record(1e8);
        vm.warp(block.timestamp + 61);

        bytes memory callData = bytes.concat(
            abi.encodeWithSelector(OracleResolver.resolveOrderbookMarketBatch.selector, address(market), n),
            RedstonePayloadBuilder.buildNow(FEED, 1e8, 3)
        );

        vm.prank(keeper);
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = address(resolver).call(callData);
        gasUsed = before - gasleft();
        require(ok, "batch reverted");
        assertEq(abi.decode(ret, (uint256)), n, "every match must have settled");
    }

    function _fund(MockUSDC usdc, OrderbookMarket market, address who) internal {
        usdc.mint(who, 1000e6);
        vm.prank(who);
        usdc.approve(address(market), type(uint256).max);
    }

    function _bet(OrderbookMarket mkt, address who, OrderbookMarket.Direction dir, uint256 amount) internal {
        vm.prank(who);
        (bool ok,) = address(mkt)
            .call(
                bytes.concat(
                    abi.encodeWithSelector(
                        OrderbookMarket.placeBet.selector, dir, amount, address(0), uint256(1e18), uint256(100)
                    ),
                    RedstonePayloadBuilder.buildNow(FEED, 1e8, 3)
                )
            );
        require(ok, "placeBet reverted");
    }

    function _record(uint256 value8dp) internal {
        vm.prank(keeper);
        (bool ok,) = address(resolver)
            .call(
                bytes.concat(
                    abi.encodeWithSelector(OracleResolver.recordPrice.selector, FEED),
                    RedstonePayloadBuilder.buildNow(FEED, value8dp, 3)
                )
            );
        require(ok, "recordPrice reverted");
    }
}
