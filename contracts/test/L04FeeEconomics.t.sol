// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/PoolMarketFactory.sol";
import "../src/PoolOracleResolver.sol";
import "../src/RhcFeeDistributor.sol";
import "../src/LiquidityPool.sol";
import "../src/PoolLiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "../src/ReferralRegistry.sol";
import "./mocks/MockUniswapV3Pool.sol";
import "./mocks/MockUniswapV3Factory.sol";
import "./mocks/MockWETH.sol";

/**
 * Audit L04 (2026-09-28) economic measurement, on the final code (post
 * A01-A08/L01 fixes) rather than the audit's own historical illustration.
 *
 * Most of these are measurement, not correctness tests - their assertions
 * just pin the measured number so it shows up as a diff if the fee/gas model
 * changes later. Read the numbers via `-vv`; see
 * docs/rhc/audit-2026-09-28-L04-economics.md for the write-up built from
 * them. test_Fix_LPWin_PaysTheSameProtocolFeeAUserWinWould is the one real
 * regression test in the file, for the fix itself.
 */
contract L04FeeEconomicsTest is Test {
    PoolMarketFactory factory;
    PoolOracleResolver resolver;
    RhcFeeDistributor feeDistributor;
    LiquidityPool lp;
    MockWETH weth;
    MockUniswapV3Factory v3Factory;
    MockUniswapV3Pool pool;
    PoolOrderbookMarket market;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address multisig = makeAddr("multisig");
    address treasury = makeAddr("treasury");
    address memecoin = makeAddr("memecoin");

    uint32 constant T0 = 1_787_000_000;
    uint256 constant DURATION = 900; // 15 min, exit window 180s
    uint256 constant STAKE = 0.005 ether; // current MIN_BET

    function setUp() public {
        vm.warp(T0);
        weth = new MockWETH();
        v3Factory = new MockUniswapV3Factory();
        resolver = new PoolOracleResolver(address(weth));
        GenesisNFT genesisNFT = new GenesisNFT("ipfs://test/");
        lp = new PoolLiquidityPool(IERC20(address(weth)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(lp));
        feeDistributor = new RhcFeeDistributor(address(weth), treasury, address(lp), multisig);
        ReferralRegistry referralRegistry = new ReferralRegistry();

        factory = new PoolMarketFactory(
            address(weth),
            address(v3Factory),
            address(resolver),
            address(feeDistributor),
            address(referralRegistry),
            multisig,
            address(lp)
        );
        lp.setMarketFactory(address(factory));
        feeDistributor.setMarketFactory(address(factory));
        referralRegistry.setMarketFactory(address(factory));

        pool = new MockUniswapV3Pool(memecoin, address(weth), 10000);
        pool.pushTick(T0 - 7200, 0); // price 1.0
        pool.setLiquidity(10 ether);
        pool.setCardinality(300, 300);
        v3Factory.register(memecoin, address(weth), 10000, address(pool));

        // factory.feeBps defaults to FEE_MAX (100 bps = 1%) at construction -
        // the same value the live testnet carries today (applyNewFee, 11.09).
        market = PoolOrderbookMarket(factory.createMarket(address(pool), DURATION));
        // createMarket authorizes the market on FeeDistributor/ReferralRegistry
        // automatically but deliberately NOT on the LiquidityPool - LP capital
        // authorization is a separate, manual step. Without it here, even a
        // pure PvP placeBet reverts: _tryMatch's LP layer runs unconditionally
        // whenever liquidityPool != address(0), and LiquidityPool.tryMatch
        // reverts rather than returning 0 for an unauthorized caller. Noted as
        // a possible separate finding - not this measurement's concern.
        lp.authorizeMarket(address(market));

        weth.mint(alice, 10 ether);
        weth.mint(bob, 10 ether);
        vm.prank(alice);
        weth.approve(address(market), type(uint256).max);
        vm.prank(bob);
        weth.approve(address(market), type(uint256).max);

        // LP funded well above MAX_TRADER_LP_EXPOSURE headroom needs.
        weth.mint(address(this), 5 ether);
        weth.approve(address(lp), type(uint256).max);
        lp.deposit(2 ether, address(this));
    }

    function _bet(address who, OrderbookMarket.Direction dir) internal returns (uint256) {
        vm.prank(who);
        return market.placeBet(dir, STAKE, address(0), 1e18, 100);
    }

    // ── PvP ──────────────────────────────────────────────────
    function test_Economics_PvP_Win() public {
        uint256 up = _bet(alice, OrderbookMarket.Direction.UP);
        _bet(bob, OrderbookMarket.Direction.DOWN);
        vm.warp(block.timestamp + DURATION + 1);

        uint256 treasuryBefore = weth.balanceOf(treasury);
        uint256 gasBefore = gasleft();
        vm.prank(address(resolver));
        market.settleMatch(1, 2e18); // up wins
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("PvP settleMatch gas", gasUsed);
        emit log_named_uint("PvP treasury revenue (wei)", weth.balanceOf(treasury) - treasuryBefore);
        assertEq(uint256(market.getOrder(up).status), uint256(OrderbookMarket.OrderStatus.SETTLED));
    }

    // ── LP, user wins ────────────────────────────────────────
    function test_Economics_LP_UserWins() public {
        uint256 up = _bet(alice, OrderbookMarket.Direction.UP); // no PvP counterparty -> LP takes it

        uint256 treasuryBefore = weth.balanceOf(treasury);
        uint256 gasBefore = gasleft();
        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(address(resolver));
        market.settleMatch(1, 2e18); // up wins
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("LP-user-win settleMatch gas", gasUsed);
        emit log_named_uint("LP-user-win treasury revenue (wei)", weth.balanceOf(treasury) - treasuryBefore);
        assertGt(market.getOrder(up).payout, 0);
    }

    /// The L04 fix, checked for exact amounts rather than just logged.
    function test_Fix_LPWin_PaysTheSameProtocolFeeAUserWinWould() public {
        _bet(alice, OrderbookMarket.Direction.UP); // LP takes the DOWN side
        uint256 lpBefore = weth.balanceOf(address(lp));
        uint256 treasuryBefore = weth.balanceOf(treasury);

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(address(resolver));
        market.settleMatch(1, 0.5e18); // down wins - the LP wins

        uint256 totalPool = STAKE * 2;
        uint256 expectedFee = (totalPool * market.feeBps()) / 10_000; // feeBps == 100 (1%)
        assertEq(expectedFee, 100_000_000_000_000, "sanity: 1% of 0.01 ETH");
        assertEq(
            weth.balanceOf(treasury) - treasuryBefore, expectedFee, "treasury must get the same cut a user win pays"
        );
        assertEq(
            weth.balanceOf(address(lp)) - lpBefore,
            totalPool - expectedFee,
            "LP gets the pot net of protocol fee, not the full pot"
        );
    }

    // ── LP, LP wins (user loses) ─────────────────────────────
    function test_Economics_LP_UserLoses() public {
        _bet(alice, OrderbookMarket.Direction.UP); // LP takes the DOWN side

        uint256 treasuryBefore = weth.balanceOf(treasury);
        uint256 gasBefore = gasleft();
        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(address(resolver));
        market.settleMatch(1, 0.5e18); // down wins - user loses to the LP
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("LP-user-loss settleMatch gas", gasUsed);
        emit log_named_uint("LP-user-loss treasury revenue (wei)", weth.balanceOf(treasury) - treasuryBefore);
    }

    // ── Tie ──────────────────────────────────────────────────
    function test_Economics_Tie() public {
        _bet(alice, OrderbookMarket.Direction.UP);
        _bet(bob, OrderbookMarket.Direction.DOWN);

        uint256 treasuryBefore = weth.balanceOf(treasury);
        uint256 gasBefore = gasleft();
        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(address(resolver));
        market.settleMatch(1, 1e18); // exact tie
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("Tie settleMatch gas", gasUsed);
        emit log_named_uint("Tie treasury revenue (wei)", weth.balanceOf(treasury) - treasuryBefore);
    }

    // ── Emergency refund ─────────────────────────────────────
    function test_Economics_EmergencyRefund() public {
        _bet(alice, OrderbookMarket.Direction.UP);
        _bet(bob, OrderbookMarket.Direction.DOWN);
        vm.warp(block.timestamp + DURATION + market.SETTLE_GRACE() + 1);

        uint256 treasuryBefore = weth.balanceOf(treasury);
        uint256 gasBefore = gasleft();
        market.emergencyRefundMatch(1);
        uint256 gasUsed = gasBefore - gasleft();

        emit log_named_uint("Emergency refund gas", gasUsed);
        emit log_named_uint("Emergency refund treasury revenue (wei)", weth.balanceOf(treasury) - treasuryBefore);
    }
}
