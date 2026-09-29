// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Measurement for docs/rhc/ECONOMICS.md: gas of every settlement outcome through the
// full resolver path, on the deployed wiring (RhcFeeDistributor, PoolLiquidityPool,
// ReferralRegistry). Kept under docs/, not contracts/test/, because it measures rather
// than tests; run it from a scratch project, see README.md next to this file.
//
// Read vm.lastCallGas().gasTotalUsed, not gasTotalUsed minus gasRefunded: under
// --isolate the total already includes the 21 000 intrinsic gas and is net of the
// refund (RefundSemantics.t.sol). The first version of ECONOMICS.md subtracted the
// refund a second time; the "lastCallGas.refunded" line is printed for reference only.

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/PoolMarketFactory.sol";
import "../src/PoolOracleResolver.sol";
import "../src/RhcFeeDistributor.sol";
import "../src/PoolLiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "../src/ReferralRegistry.sol";
import "./mocks/MockUniswapV3Pool.sol";
import "./mocks/MockUniswapV3Factory.sol";
import "./mocks/MockWETH.sol";

contract EconGasTest is Test {
    PoolMarketFactory factory;
    PoolOracleResolver resolver;
    RhcFeeDistributor dist;
    PoolLiquidityPool lp;
    ReferralRegistry reg;
    MockWETH weth;
    MockUniswapV3Factory v3;
    MockUniswapV3Pool poolPvp; // market without vault access (like FROGGO)
    MockUniswapV3Pool poolLp; // market with vault access (like MOONCAT)
    PoolOrderbookMarket mPvp; // 300 s
    PoolOrderbookMarket mLp; // 60 s

    address treasury = makeAddr("treasury");
    address multisig = makeAddr("multisig");
    uint32 constant T0 = 1_790_000_000;
    uint256 constant STAKE = 0.01 ether; // the live e2e stake

    function setUp() public {
        vm.warp(T0);
        weth = new MockWETH();
        v3 = new MockUniswapV3Factory();
        resolver = new PoolOracleResolver(address(weth));
        GenesisNFT g = new GenesisNFT("ipfs://x/");
        lp = new PoolLiquidityPool(IERC20(address(weth)), address(g));
        g.setLiquidityPool(address(lp));
        dist = new RhcFeeDistributor(address(weth), treasury, address(lp), multisig);
        reg = new ReferralRegistry();
        factory = new PoolMarketFactory(
            address(weth), address(v3), address(resolver), address(dist), address(reg), multisig, address(lp)
        );
        lp.setMarketFactory(address(factory));
        dist.setMarketFactory(address(factory));
        reg.setMarketFactory(address(factory));

        poolPvp = _pool(makeAddr("froggo"));
        poolLp = _pool(makeAddr("mooncat"));
        mPvp = PoolOrderbookMarket(factory.createMarket(address(poolPvp), 300));
        mLp = PoolOrderbookMarket(factory.createMarket(address(poolLp), 60));
        lp.authorizeMarket(address(mLp));

        weth.mint(address(this), 10 ether);
        weth.approve(address(lp), type(uint256).max);
        lp.deposit(2 ether, address(this));
        weth.mint(treasury, 1); // the live treasury already held WETH
    }

    function _pool(address token) internal returns (MockUniswapV3Pool p) {
        p = new MockUniswapV3Pool(token, address(weth), 10000);
        p.pushTick(T0 - 7200, 0);
        p.setLiquidity(40 ether);
        p.setCardinality(300, 300);
        v3.register(token, address(weth), 10000, address(p));
    }

    function _trader(string memory name) internal returns (address a) {
        a = makeAddr(name);
        weth.mint(a, 1 ether);
        vm.startPrank(a);
        weth.approve(address(mPvp), type(uint256).max);
        weth.approve(address(mLp), type(uint256).max);
        vm.stopPrank();
    }

    function _bet(PoolOrderbookMarket m, address who, OrderbookMarket.Direction d, uint256 amt, address ref)
        internal
        returns (uint256)
    {
        uint256 px = resolver.spotPriceWad(m.feedId());
        vm.prank(who);
        return m.placeBet(d, amt, ref, px, 100);
    }

    /// Bring a pool to `n` segments with the tick left at `tick`, the last write 70 s ago.
    function _history(MockUniswapV3Pool p, uint256 n, int24 tick) internal {
        uint256 have = 1;
        uint32 t = uint32(block.timestamp) - 3600;
        while (have < n) {
            p.pushTick(t, tick);
            t += 60;
            have++;
        }
        vm.warp(block.timestamp + 70);
    }

    function _settle(PoolOrderbookMarket m, string memory label) internal returns (uint256 used) {
        uint256 g0 = gasleft();
        uint256 n = resolver.resolveOrderbookMarketBatchFrom(address(m), 0, 25);
        used = g0 - gasleft();
        Vm.Gas memory lg = vm.lastCallGas();
        emit log_named_uint(string.concat(label, " resolved"), n);
        emit log_named_uint(string.concat(label, " gasleft-delta"), used);
        emit log_named_uint(string.concat(label, " lastCallGas.total"), lg.gasTotalUsed);
        emit log_named_int(string.concat(label, " lastCallGas.refunded"), lg.gasRefunded);
    }

    // ── PvP on the 300 s market, 4 segments at settlement like FROGGO on 29.09 ──
    function _pvp(int24 exitTick, bool withRef, string memory label) internal {
        _history(poolPvp, 3, -400);
        address a = _trader("a");
        address b = _trader("b");
        address r = makeAddr("referrer");
        _bet(mPvp, a, OrderbookMarket.Direction.UP, STAKE, address(0));
        _bet(mPvp, b, OrderbookMarket.Direction.DOWN, STAKE, withRef ? r : address(0));
        assertFalse(mPvp.getMatch(1).lpMatch, "must be PvP");
        vm.warp(block.timestamp + 9);
        poolPvp.pushTick(uint32(block.timestamp), exitTick);
        vm.warp(block.timestamp + 300);
        _settle(mPvp, label);
    }

    function test_PvP_DownWins() public {
        _pvp(-600, false, "PvP win");
    }

    function test_PvP_DownWins_WinnerHasReferrer() public {
        _pvp(-600, true, "PvP win+ref");
    }

    function test_PvP_Tie() public {
        _pvp(-400, false, "PvP tie");
    }

    function test_PvP_SpreadRefund() public {
        _history(poolPvp, 3, -400);
        address a = _trader("a");
        address b = _trader("b");
        _bet(mPvp, a, OrderbookMarket.Direction.UP, STAKE, address(0));
        _bet(mPvp, b, OrderbookMarket.Direction.DOWN, STAKE, address(0));
        // 300 s market: window 60 s, anchor 20 s. Jump in the last 15 s.
        vm.warp(block.timestamp + 285);
        poolPvp.pushTick(uint32(block.timestamp), 0);
        vm.warp(block.timestamp + 20);
        _settle(mPvp, "PvP refund");
        assertTrue(mPvp.getMatch(1).settled);
    }

    function test_PvP_Batch5() public {
        _history(poolPvp, 3, -400);
        for (uint256 i = 0; i < 5; i++) {
            address a = _trader(string.concat("a", vm.toString(i)));
            address b = _trader(string.concat("b", vm.toString(i)));
            _bet(mPvp, a, OrderbookMarket.Direction.UP, STAKE, address(0));
            _bet(mPvp, b, OrderbookMarket.Direction.DOWN, STAKE, address(0));
        }
        vm.warp(block.timestamp + 9);
        poolPvp.pushTick(uint32(block.timestamp), -600);
        vm.warp(block.timestamp + 300);
        _settle(mPvp, "PvP batch5");
    }

    // ── Vault matches on the 60 s market, 6 segments at settlement like MOONCAT ──
    function _vault(int24 exitTick, string memory label) internal {
        _history(poolLp, 5, 0);
        address a = _trader("a");
        _bet(mLp, a, OrderbookMarket.Direction.UP, STAKE, address(0));
        assertTrue(mLp.getMatch(1).lpMatch, "must be a vault match");
        vm.warp(block.timestamp + 5);
        poolLp.pushTick(uint32(block.timestamp), exitTick);
        vm.warp(block.timestamp + 60);
        _settle(mLp, label);
    }

    function test_Vault_UserWins() public {
        _vault(200, "Vault user wins");
    }

    function test_Vault_UserLoses() public {
        _vault(-200, "Vault user loses");
    }

    function test_Vault_Tie() public {
        _vault(0, "Vault tie");
    }

    function test_Vault_SpreadRefund() public {
        _history(poolLp, 7, 0);
        address a = _trader("a");
        _bet(mLp, a, OrderbookMarket.Direction.UP, STAKE, address(0));
        // 60 s market: window 30 s, anchor 10 s. +4% eight seconds before settleAt.
        vm.warp(block.timestamp + 52);
        poolLp.pushTick(uint32(block.timestamp), 400);
        vm.warp(block.timestamp + 10);
        _settle(mLp, "Vault refund");
        assertTrue(mLp.getMatch(1).settled);
    }

    // ── Referral credits in steady state ──
    // Warm-up on a second PvP market so the measured pool keeps 4 records: after it the
    // referrer `r` already holds a balance, totalReferralOwed is non-zero and the distributor
    // keeps WETH. Then one measured match on mPvp, same shape as test_PvP_DownWins.
    function _warmReferral(address winner, address ref) internal {
        MockUniswapV3Pool warm = _pool(makeAddr("warmtoken"));
        PoolOrderbookMarket mWarm = PoolOrderbookMarket(factory.createMarket(address(warm), 300));
        address loser = _trader("warmloser");
        vm.prank(winner);
        weth.approve(address(mWarm), type(uint256).max);
        vm.prank(loser);
        weth.approve(address(mWarm), type(uint256).max);
        warm.pushTick(uint32(block.timestamp) - 3000, -400);
        vm.warp(block.timestamp + 70);
        _bet(mWarm, loser, OrderbookMarket.Direction.UP, STAKE, address(0));
        _bet(mWarm, winner, OrderbookMarket.Direction.DOWN, STAKE, ref);
        vm.warp(block.timestamp + 9);
        warm.pushTick(uint32(block.timestamp), -600);
        vm.warp(block.timestamp + 300);
        resolver.resolveOrderbookMarketBatchFrom(address(mWarm), 0, 25);
        assertGt(dist.referralBalance(ref), 0, "warm-up credited the referrer");
    }

    function _measuredPvp(address winner, address refOnBet, string memory label) internal {
        _history(poolPvp, 3, -400);
        address a = _trader("a");
        _bet(mPvp, a, OrderbookMarket.Direction.UP, STAKE, address(0));
        _bet(mPvp, winner, OrderbookMarket.Direction.DOWN, STAKE, refOnBet);
        vm.warp(block.timestamp + 9);
        poolPvp.pushTick(uint32(block.timestamp), -600);
        vm.warp(block.timestamp + 300);
        _settle(mPvp, label);
    }

    function test_Referral_Repeat_SameReferrer() public {
        address b = _trader("b");
        address r = makeAddr("referrer");
        _warmReferral(b, r);
        _measuredPvp(b, address(0), "PvP win, repeat credit");
    }

    function test_Referral_NewReferrer_SteadyState() public {
        address b = _trader("b");
        _warmReferral(b, makeAddr("referrer"));
        address d = _trader("d");
        _measuredPvp(d, makeAddr("referrer2"), "PvP win, first credit of a new referrer");
    }

    function test_Referral_NoReferrer_SteadyState() public {
        address b = _trader("b");
        _warmReferral(b, makeAddr("referrer"));
        address e = _trader("e");
        _measuredPvp(e, address(0), "PvP win, no referrer, distributor holds balance");
    }

    // ── Paths the keeper pays for outside settlement ──
    function test_RefundExpired_And_Cancel() public {
        _history(poolPvp, 3, -400);
        address a = _trader("a");
        address b = _trader("b");
        uint256 oa = _bet(mPvp, a, OrderbookMarket.Direction.UP, STAKE, address(0));
        uint256 ob = _bet(mPvp, b, OrderbookMarket.Direction.UP, STAKE, address(0));
        vm.warp(block.timestamp + 301);
        uint256 g0 = gasleft();
        mPvp.refundExpired(oa);
        emit log_named_uint("refundExpired gasleft-delta", g0 - gasleft());
        vm.prank(b);
        g0 = gasleft();
        mPvp.cancelOrder(ob);
        emit log_named_uint("cancelOrder gasleft-delta", g0 - gasleft());
    }

    function test_EmergencyRefund_PvP_and_Vault() public {
        _history(poolPvp, 3, -400);
        _history(poolLp, 5, 0);
        address a = _trader("a");
        address b = _trader("b");
        address c = _trader("c");
        _bet(mPvp, a, OrderbookMarket.Direction.UP, STAKE, address(0));
        _bet(mPvp, b, OrderbookMarket.Direction.DOWN, STAKE, address(0));
        _bet(mLp, c, OrderbookMarket.Direction.UP, STAKE, address(0));
        vm.warp(block.timestamp + 300 + 24 hours + 1);
        uint256 g0 = gasleft();
        mPvp.emergencyRefundMatch(1);
        emit log_named_uint("emergencyRefund PvP gasleft-delta", g0 - gasleft());
        g0 = gasleft();
        mLp.emergencyRefundMatch(1);
        emit log_named_uint("emergencyRefund vault gasleft-delta", g0 - gasleft());
    }

    // ── The vault's expected value per match, from the payouts themselves ──
    function test_VaultEdge_OneWinOneLoss() public {
        _history(poolLp, 5, 0);
        uint256 before = lp.totalAssets() + lp.totalPendingFees();
        address a = _trader("a");
        _bet(mLp, a, OrderbookMarket.Direction.UP, STAKE, address(0));
        vm.warp(block.timestamp + 5);
        poolLp.pushTick(uint32(block.timestamp), 200); // user wins
        vm.warp(block.timestamp + 60);
        resolver.resolveOrderbookMarketBatchFrom(address(mLp), 0, 25);
        uint256 mid = lp.totalAssets() + lp.totalPendingFees();
        vm.warp(block.timestamp + 70);
        _bet(mLp, a, OrderbookMarket.Direction.UP, STAKE, address(0));
        vm.warp(block.timestamp + 5);
        poolLp.pushTick(uint32(block.timestamp), 0); // user loses
        vm.warp(block.timestamp + 60);
        resolver.resolveOrderbookMarketBatchFrom(address(mLp), 0, 25);
        uint256 afterBoth = lp.totalAssets() + lp.totalPendingFees();
        emit log_named_int("vault after user win (wei)", int256(mid) - int256(before));
        emit log_named_int("vault after user win + user loss (wei)", int256(afterBoth) - int256(before));
        emit log_named_uint("treasury got (wei)", weth.balanceOf(treasury) - 1);
        assertEq(afterBoth, before, "one win and one loss of the same size leave the vault exactly flat");
    }
}
