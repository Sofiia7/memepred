// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PvPMarket.sol";
import "./mocks/MockUSDC.sol";

contract PvPMarketTest is Test {
    PvPMarket  market;
    MockUSDC   usdc;

    address resolver      = makeAddr("resolver");
    address feeDistrib    = makeAddr("feeDistrib");
    address multisig      = makeAddr("multisig");
    address alice         = makeAddr("alice");
    address bob           = makeAddr("bob");
    address referrer      = makeAddr("referrer");

    uint256 constant ENTRY_PRICE = 9142; // $0.000009142 * 1e6

    function setUp() public {
        usdc   = new MockUSDC();
        market = new PvPMarket();

        // Initialize (replaces constructor for clone pattern)
        market.initialize(
            address(usdc), resolver, feeDistrib, multisig,
            15 minutes, bytes32("PEPE/USD"), ENTRY_PRICE
        );

        // Выдать USDC
        usdc.mint(alice, 1000e6);
        usdc.mint(bob,   1000e6);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(market), type(uint256).max);
    }

    // ── INITIALIZE ────────────────────────────────────────
    function test_Initialize_Once() public {
        PvPMarket m2 = new PvPMarket();
        m2.initialize(address(usdc), resolver, feeDistrib, multisig, 5 minutes, bytes32("TEST"), 100);
        vm.expectRevert("already initialized");
        m2.initialize(address(usdc), resolver, feeDistrib, multisig, 5 minutes, bytes32("TEST"), 100);
    }

    // ── PLACE BET ──────────────────────────────────────────
    function test_PlaceBet_UP_Success() public {
        vm.prank(alice);
        market.placeBet(IMarket.Direction.UP, 50e6, referrer);

        assertEq(market.totalUpPool(), 50e6);
        assertEq(usdc.balanceOf(address(market)), 50e6);
    }

    function test_PlaceBet_DOWN_Success() public {
        vm.prank(alice);
        market.placeBet(IMarket.Direction.DOWN, 25e6, address(0));

        assertEq(market.totalDownPool(), 25e6);
    }

    function test_PlaceBet_Reverts_BelowMin() public {
        vm.prank(alice);
        vm.expectRevert("below min bet");
        market.placeBet(IMarket.Direction.UP, 0.5e6, address(0));
    }

    function test_PlaceBet_Reverts_AboveMax() public {
        vm.prank(alice);
        vm.expectRevert("above max bet");
        market.placeBet(IMarket.Direction.UP, 101e6, address(0));
    }

    function test_PlaceBet_Reverts_AfterClose() public {
        vm.warp(block.timestamp + 16 minutes);
        vm.prank(alice);
        vm.expectRevert("market closed");
        market.placeBet(IMarket.Direction.UP, 10e6, address(0));
    }

    function test_PlaceBet_Reverts_DoubleBet() public {
        vm.startPrank(alice);
        market.placeBet(IMarket.Direction.UP, 10e6, address(0));
        vm.expectRevert("already bet UP");
        market.placeBet(IMarket.Direction.UP, 10e6, address(0));
        vm.stopPrank();
    }

    function test_PlaceBet_Reverts_SelfReferral() public {
        vm.prank(alice);
        vm.expectRevert("self referral");
        market.placeBet(IMarket.Direction.UP, 10e6, alice);
    }

    // ── SETTLE & CLAIM ─────────────────────────────────────
    function test_Settle_And_Claim_UpWon() public {
        // Alice: UP $60, Bob: DOWN $40
        vm.prank(alice); market.placeBet(IMarket.Direction.UP,   60e6, address(0));
        vm.prank(bob);   market.placeBet(IMarket.Direction.DOWN, 40e6, address(0));

        vm.warp(block.timestamp + 16 minutes);
        vm.prank(resolver); market.settle(true);

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice); market.claim();
        uint256 aliceAfter = usdc.balanceOf(alice);

        // Alice должна получить весь пул ($100) пропорционально её доле
        // FEE = 0%, Alice доля = 60/60 = 100% выигрышного пула
        // Её выплата = 60/60 * 100 = 100 USDC
        assertEq(aliceAfter - aliceBefore, 100e6);
    }

    function test_Settle_And_Claim_DownWon() public {
        vm.prank(alice); market.placeBet(IMarket.Direction.UP,   30e6, address(0));
        vm.prank(bob);   market.placeBet(IMarket.Direction.DOWN, 70e6, address(0));

        vm.warp(block.timestamp + 16 minutes);
        vm.prank(resolver); market.settle(false);

        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob); market.claim();
        uint256 bobAfter = usdc.balanceOf(bob);

        // Bob ставил 70 DOWN, выиграл. Payout = 70/70 * 100 = 100 USDC
        assertEq(bobAfter - bobBefore, 100e6);
    }

    function test_Settle_Reverts_LowLiquidity() public {
        // Только Alice ставит (нет противника) — пул одной стороны = 0 < MIN_POOL_SIDE
        vm.prank(alice); market.placeBet(IMarket.Direction.UP, 10e6, address(0));
        vm.warp(block.timestamp + 16 minutes);
        vm.prank(resolver); market.settle(true);

        // Рынок должен стать REFUNDED
        assertEq(uint(market.status()), uint(IMarket.Status.REFUNDED));
    }

    function test_Settle_Refunds_BelowMinPoolSide() public {
        // Both sides have bets, but one is below MIN_POOL_SIDE (10 USDC)
        vm.prank(alice); market.placeBet(IMarket.Direction.UP,   50e6, address(0));
        vm.prank(bob);   market.placeBet(IMarket.Direction.DOWN, 5e6,  address(0));

        vm.warp(block.timestamp + 16 minutes);
        vm.prank(resolver); market.settle(true);

        assertEq(uint(market.status()), uint(IMarket.Status.REFUNDED));
    }

    function test_Claim_Reverts_AlreadyClaimed() public {
        vm.prank(alice); market.placeBet(IMarket.Direction.UP,   60e6, address(0));
        vm.prank(bob);   market.placeBet(IMarket.Direction.DOWN, 40e6, address(0));
        vm.warp(block.timestamp + 16 minutes);
        vm.prank(resolver); market.settle(true);
        vm.prank(alice); market.claim();
        vm.prank(alice);
        vm.expectRevert("already claimed");
        market.claim();
    }

    function test_Claim_Reverts_IfLost() public {
        vm.prank(alice); market.placeBet(IMarket.Direction.UP,   60e6, address(0));
        vm.prank(bob);   market.placeBet(IMarket.Direction.DOWN, 40e6, address(0));
        vm.warp(block.timestamp + 16 minutes);
        vm.prank(resolver); market.settle(true);

        vm.prank(bob);
        vm.expectRevert("no winning bet");
        market.claim();
    }

    // ── EMERGENCY REFUND ───────────────────────────────────
    function test_EmergencyRefund_AfterGracePeriod() public {
        vm.prank(alice); market.placeBet(IMarket.Direction.UP, 50e6, address(0));
        // Пропустить grace period без резолюции
        vm.warp(block.timestamp + 15 minutes + 1 hours + 1);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice); market.emergencyRefund();
        assertEq(usdc.balanceOf(alice) - before, 50e6);
    }

    function test_EmergencyRefund_Reverts_BeforeGrace() public {
        vm.prank(alice); market.placeBet(IMarket.Direction.UP, 50e6, address(0));
        vm.warp(block.timestamp + 16 minutes); // After close but before grace
        vm.prank(alice);
        vm.expectRevert("grace period not over");
        market.emergencyRefund();
    }

    // ── ADMIN ──────────────────────────────────────────────
    function test_Pause_OnlyMultisig() public {
        vm.prank(multisig);
        market.pause();

        vm.prank(alice);
        vm.expectRevert();
        market.placeBet(IMarket.Direction.UP, 10e6, address(0));
    }

    function test_Pause_Reverts_NonMultisig() public {
        vm.prank(alice);
        vm.expectRevert("only multisig");
        market.pause();
    }

    // ── VIEWS ──────────────────────────────────────────────
    function test_GetOdds_Empty() public view {
        (uint256 upOdds, uint256 downOdds) = market.getOdds();
        assertEq(upOdds, 2e18);
        assertEq(downOdds, 2e18);
    }

    function test_GetOdds_WithBets() public {
        vm.prank(alice); market.placeBet(IMarket.Direction.UP,   60e6, address(0));
        vm.prank(bob);   market.placeBet(IMarket.Direction.DOWN, 40e6, address(0));

        (uint256 upOdds, uint256 downOdds) = market.getOdds();
        // UP odds: 100/60 = 1.666x, DOWN odds: 100/40 = 2.5x
        assertApproxEqRel(upOdds, 1666666666666666666, 0.01e18);
        assertApproxEqRel(downOdds, 2500000000000000000, 0.01e18);
    }

    function test_TimeLeft() public view {
        uint256 tl = market.timeLeft();
        assertEq(tl, 15 minutes);
    }

    function test_TimeLeft_AfterClose() public {
        vm.warp(block.timestamp + 20 minutes);
        assertEq(market.timeLeft(), 0);
    }

    // ── FUZZ ───────────────────────────────────────────────
    function testFuzz_PlaceBet_AmountRange(uint256 amount) public {
        amount = bound(amount, 1e6, 100e6);
        vm.prank(alice);
        market.placeBet(IMarket.Direction.UP, amount, address(0));
        assertEq(market.totalUpPool(), amount);
    }

    function testFuzz_Settle_Payout(uint256 upAmount, uint256 downAmount) public {
        upAmount   = bound(upAmount,   10e6, 100e6);
        downAmount = bound(downAmount, 10e6, 100e6);

        usdc.mint(alice, upAmount);
        usdc.mint(bob,   downAmount);
        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(market), type(uint256).max);

        vm.prank(alice); market.placeBet(IMarket.Direction.UP,   upAmount,   address(0));
        vm.prank(bob);   market.placeBet(IMarket.Direction.DOWN, downAmount, address(0));

        vm.warp(block.timestamp + 16 minutes);
        vm.prank(resolver); market.settle(true);

        uint256 beforeBal = usdc.balanceOf(alice);
        vm.prank(alice); market.claim();
        uint256 payout = usdc.balanceOf(alice) - beforeBal;

        // Alice должна получить >= её ставки (она выиграла)
        assertGe(payout, upAmount);
        // И <= общего пула (нельзя получить больше чем есть)
        assertLe(payout, upAmount + downAmount);
    }
}
