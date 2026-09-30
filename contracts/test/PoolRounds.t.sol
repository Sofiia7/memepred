// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoolRoundTestBase.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * Unit tests of PoolRounds (interface v3): (a) the reference numbers of
 * positive-ev.mts selfTest() to the wei, at cap 1 (the design) and cap 4, then
 * the lifecycle, the oracle paths, the pool gate and (c) the bad paths. Every
 * money figure asserted here is the reference's, not re-derived.
 */
/// Registry whose referrerOf never returns: burns all the gas it is given.
contract GasBurningReferrals {
    function referrerOf(address) external pure returns (address) {
        while (true) {}
        return address(0);
    }

    function register(address, address) external {}
}

/// Registry whose referrerOf answers with 20 bytes instead of a 32-byte word.
contract ShortAnswerReferrals {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(12, 20)
        }
    }
}

/// Registry whose referrerOf answers with a word that is not an address.
contract NotAnAddressReferrals {
    function referrerOf(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function register(address, address) external {}
}

contract PoolRoundsTest is PoolRoundTestBase {
    address alice = _player(1);
    address bob = _player(2);
    address carol = _player(3);
    address refA = makeAddr("refA");
    address refB = makeAddr("refB");

    // ── helpers ──────────────────────────────────────────────

    /// Balanced 0.05 / 0.05 book, referrers refA / refB, clock at closeAt.
    function _balancedRound() internal returns (uint256 id) {
        id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), refA);
        _bet(id, bob, 0.05 ether, _down(), refB);
        _warpClose(id);
    }

    function _outcome(uint256 id) internal view returns (PoolRounds.Outcome) {
        return rounds.roundView(id).outcome;
    }

    // ════════════════════════════════════════════════════════════
    //  (a) positive-ev.mts selfTest(), policy(0.398): cost allowance 398e12, min bank 0.02
    // ════════════════════════════════════════════════════════════

    function test_Reference_Balanced_UpWins() public {
        uint256 id = _balancedRound();
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);

        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.UP));
        assertEq(rounds.feesAccrued(), 0.0018 ether, "treasury part booked at settle");
        assertEq(_claim(id, alice), 0.098 ether, "u.payouts[0] = 0.098");
        assertEq(_claim(id, bob), 0, "loser");
        assertEq(rounds.referralOwed(refA), 0.0002 ether, "10% of the 2% fee to the winner's referrer");
        assertEq(rounds.referralOwed(refB), 0);
        assertEq(rounds.feesAccrued(), 0.0018 ether, "u.treasury = 0.0018");
        assertEq(rounds.feesAccrued() - COST_0398, 0.001402 ether, "u.contribution = 0.001402");
        assertEq(weth.balanceOf(address(rounds)), 0.002 ether, "only the fee is left: no dust here");
    }

    function test_Reference_Balanced_DownWins_SameContribution() public {
        uint256 id = _balancedRound();
        _exitTick(pool, id, -100);
        _warpSettle(id);
        rounds.settle(id);

        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.DOWN));
        assertEq(_claim(id, alice), 0);
        assertEq(_claim(id, bob), 0.098 ether);
        assertEq(rounds.referralOwed(refB), 0.0002 ether);
        assertEq(rounds.feesAccrued() - COST_0398, 0.001402 ether, "u.contribution == d.contribution");
    }

    function test_Reference_Tie() public {
        uint256 id = _balancedRound();
        _warpSettle(id); // no price change: entry and exit quotes are equal
        rounds.settle(id);

        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.TIE));
        assertEq(_claim(id, alice), 0.0495 ether, "r.payouts[0] = 0.0495");
        assertEq(_claim(id, bob), 0.0495 ether);
        assertEq(rounds.referralOwed(refA) + rounds.referralOwed(refB), 0.0001 ether);
        assertEq(rounds.feesAccrued() - COST_0398, 0.000502 ether, "r.contribution = 0.000502");
        assertEq(weth.balanceOf(address(rounds)), 0.001 ether, "a tie leaves only the 1% fee inside");
    }

    function test_Reference_OracleRefund() public {
        uint256 id = _balancedRound();
        _warpSettle(id);
        pool.setForceOld(true);
        rounds.settle(id);

        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND));
        assertEq(_claim(id, alice), 0.0495 ether);
        assertEq(_claim(id, bob), 0.0495 ether);
        assertEq(rounds.feesAccrued() - COST_0398, 0.000502 ether);
        assertEq(weth.balanceOf(address(rounds)), 0.001 ether, "a refund leaves only the 1% fee inside");
    }

    /// Cap 1:1, the design: 0.40 UP and 0.10 DOWN, 0.10 and 0.10 accepted.
    function test_Reference_Cap1_Skew040vs010() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.4 ether, _up(), address(0));
        _bet(id, bob, 0.1 ether, _down(), address(0));
        _exitTick(pool, id, -100);
        _warpSettle(id);
        rounds.settle(id);
        assertEq(rounds.feesAccrued() - COST_0398, 0.003202 ether, "s1.contribution = 0.003202");

        PoolRounds.RoundView memory v = rounds.roundView(id);
        assertEq(v.bank, 0.2 ether, "s1.bank = 0.2");
        assertEq(v.acceptedUp, 0.1 ether);
        assertEq(v.acceptedDown, 0.1 ether);
        assertEq(_claim(id, alice), 0.3 ether, "s1.payouts[0] = 0.3: the excess back, no fee on it");
        assertEq(_claim(id, bob), 0.196 ether, "s1.payouts[1] = 0.196 = 1.96 x 0.1");
    }

    /// Cap 4 (the earlier proposal), the same code: 0.40 UP and 0.02 DOWN.
    function test_Reference_Cap4_Skew040vs002() public {
        PoolRounds r4 = _deploy(address(0), 4);
        PoolRoundMockPool p4 = _newPoolOn(r4, false);
        uint256 id = _nextRoundOn(r4, address(p4), T);
        _betOn(r4, id, alice, 0.4 ether, _up(), address(0));
        _betOn(r4, id, bob, 0.02 ether, _down(), address(0));
        _exitTickOn(r4, p4, id, -100);
        vm.warp(r4.roundTimes(id).settleAt);
        r4.settle(id);

        PoolRounds.RoundView memory v = r4.roundView(id);
        assertEq(v.bank, 0.1 ether, "s.bank = 0.1: 0.08 UP + 0.02 DOWN accepted");
        assertEq(v.acceptedUp, 0.08 ether);
        assertEq(_claimOn(r4, id, alice), 0.32 ether, "s.payouts[0] = 0.32");
        assertEq(_claimOn(r4, id, bob), 0.098 ether, "s.payouts[1] = 0.098");
    }

    /// Cap 1: every winner gets exactly 1.96x its accepted part, whatever the book.
    function test_Cap1_WinnerGets196xOfItsAcceptedPart() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.3 ether, _up(), address(0));
        _bet(id, carol, 0.1 ether, _up(), address(0));
        _bet(id, bob, 0.1 ether, _down(), address(0));
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);
        // UP accepts 0.1 of 0.4: alice's accepted part is 0.075, carol's 0.025.
        assertEq(_claim(id, alice), 0.225 ether + 0.147 ether, "0.225 unmatched + 1.96 x 0.075");
        assertEq(_claim(id, carol), 0.075 ether + 0.049 ether, "0.075 unmatched + 1.96 x 0.025");
        assertEq(_claim(id, bob), 0);
    }

    function test_Reference_UnderfundedBook_IsNotActivated() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.005 ether, _up(), address(0));
        _bet(id, bob, 0.005 ether, _down(), address(0));
        _warpClose(id);

        assertFalse(rounds.roundView(id).activated, "bank 0.01 < min bank 0.02");
        assertEq(_claim(id, alice), 0.005 ether, "refundable at closeAt, nothing to wait for");
        assertEq(_claim(id, bob), 0.005 ether);
        _warpSettle(id);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotActivated.selector, id));
        rounds.settle(id);
        assertEq(rounds.feesAccrued(), 0, "no fee on a round that was not played");
        assertEq(weth.balanceOf(address(rounds)), 0);
    }

    function test_Reference_OneSidedBook_RefundsEverything() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 1 ether, _up(), address(0));
        _warpClose(id);
        assertEq(_claim(id, alice), 1 ether, "one.payouts[0] = 1");
    }

    // ════════════════════════════════════════════════════════════
    //  Lifecycle
    // ════════════════════════════════════════════════════════════

    function test_Times_PauseThenStrikeWindowThenDuration() public view {
        uint256 id = rounds.roundIdOf(address(pool), T, 7);
        PoolRounds.Times memory tm = rounds.roundTimes(id);
        assertEq(tm.openAt, 7 * T);
        assertEq(tm.closeAt, 8 * T);
        assertEq(tm.strikeStart, 8 * T + PAUSE);
        assertEq(tm.strikeEnd, 8 * T + PAUSE + WINDOW);
        assertEq(tm.settleAt, 8 * T + PAUSE + WINDOW + T);
        assertEq(rounds.maxSideRatio(), 1);
        assertEq(rounds.strikePause(), 300);
        assertEq(rounds.strikeWindow(), 300);
        assertEq(rounds.minStake(), 1);
        assertEq(rounds.maxStake(), 100 ether);
        assertEq(rounds.minCardinality(), 900, "max(300 s strike window, 300 s exit cap) + 600 s");
        assertEq(rounds.depthPerBank(), 2500);
        assertEq(rounds.gateDepth(), 50 ether, "2500 x min bank 0.02");
    }

    function test_Strike_IsTheMeanOfTheWindowAfterThePause() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
        PoolRounds.Times memory tm = _times(id);
        // Price during the pause must NOT enter the strike.
        pool.pushTick(uint32(tm.closeAt), 5000);
        pool.pushTick(uint32(tm.strikeStart), 0);
        pool.pushTick(uint32(tm.strikeStart + 150), 60);
        pool.pushTick(uint32(tm.strikeEnd), 7000);
        vm.warp(tm.strikeEnd);
        rounds.fixStrike(id);
        assertEq(rounds.roundView(id).entryTick, 30, "(0 x 150 s + 60 x 150 s) / 300 s");
        assertTrue(rounds.roundView(id).strikeFixed);
    }

    function test_FixStrikeThenSettle_EqualsSettleAlone() public {
        uint256 a = _balancedRound();
        _exitTick(pool, a, 100);
        vm.warp(_times(a).strikeEnd);
        rounds.fixStrike(a);
        _warpSettle(a);
        rounds.settle(a);

        PoolRoundMockPool pool2 = _newPool(false);
        uint256 b = _nextRound(pool2, T);
        _bet(b, carol, 0.05 ether, _up(), address(0));
        _bet(b, _player(4), 0.05 ether, _down(), address(0));
        _exitTick(pool2, b, 100);
        _warpSettle(b);
        rounds.settle(b);

        assertEq(uint8(_outcome(a)), uint8(_outcome(b)));
        assertEq(rounds.roundView(a).entryTick, rounds.roundView(b).entryTick);
        assertEq(rounds.roundView(a).exitTick, rounds.roundView(b).exitTick);
    }

    function test_Orientation_WethAsToken0_TickDownIsPriceUp() public {
        PoolRoundMockPool inverted = _newPool(true);
        uint256 id = _nextRound(inverted, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
        _exitTick(inverted, id, -100); // the token got more expensive in WETH
        _warpSettle(id);
        rounds.settle(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.UP));
    }

    /// Timeline from the start of a 900 s window (also a 300 s boundary):
    /// +0 bets in k and in the 900 s round, +300 k+1 takes bets while k waits
    /// for its strike, +1200 k settles, +1500 k+1 settles, +2400 the long round.
    function test_Rounds_OfOnePool_CollectAndSettleInParallel() public {
        uint256 long = _nextRound(pool, 900);
        uint256 k = block.timestamp / T;
        uint256 id1 = rounds.roundIdOf(address(pool), T, k);
        uint256 id2 = rounds.roundIdOf(address(pool), T, k + 1);
        _bet(id1, alice, 0.05 ether, _up(), address(0));
        _bet(id1, bob, 0.05 ether, _down(), address(0));
        _bet(long, alice, 0.05 ether, _down(), address(0));
        _bet(long, bob, 0.05 ether, _up(), address(0));

        _warpClose(id1);
        _bet(id2, carol, 0.05 ether, _up(), address(0));
        _bet(id2, alice, 0.05 ether, _down(), address(0));
        assertEq(rounds.roundView(id2).committed, 0.1 ether, "round k+1 took bets while round k waited");

        _warpSettle(id1);
        rounds.settle(id1);
        assertEq(uint8(_outcome(id1)), uint8(PoolRounds.Outcome.TIE));
        _warpSettle(id2);
        rounds.settle(id2);
        _warpSettle(long);
        rounds.settle(long);
        assertTrue(uint8(_outcome(id2)) != 0 && uint8(_outcome(long)) != 0, "each round settled on its own clock");
        assertEq(_claim(id1, alice), 0.0495 ether);
        assertEq(_claim(long, bob), 0.0495 ether);
    }

    function test_PreviewClaim_EqualsClaim() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.37 ether, _up(), refA);
        _bet(id, bob, 0.11 ether, _down(), refB);
        _bet(id, carol, 0.213 ether, _down(), address(0));
        _exitTick(pool, id, -1);
        _warpSettle(id);
        rounds.settle(id);
        address[3] memory ps = [alice, bob, carol];
        for (uint256 i = 0; i < 3; i++) {
            (uint256 payout,) = rounds.previewClaim(id, ps[i]);
            assertEq(_claim(id, ps[i]), payout);
        }
    }

    function testFuzz_RoundId_RoundTrips(address p, uint32 d, uint64 k) public view {
        uint256 id = rounds.roundIdOf(p, d, k);
        (address p2, uint256 d2, uint256 k2) = rounds.decodeRoundId(id);
        assertEq(p2, p);
        assertEq(d2, d);
        assertEq(k2, k);
    }

    function test_Bet_EmitsTheV3Event() public {
        uint256 id = _nextRound(pool, T);
        _fund(rounds, alice, 1 ether);
        vm.expectEmit(true, true, false, true, address(rounds));
        emit PoolRounds.Bet(id, alice, PoolRounds.Side.DOWN, 0.03 ether);
        vm.prank(alice);
        rounds.bet(id, 0.03 ether, _down(), address(0));
        (uint256 stake, PoolRounds.Side side, PoolRounds.TicketStatus st) = rounds.ticketOf(id, alice);
        assertEq(stake, 0.03 ether);
        assertEq(uint8(side), 2);
        assertEq(uint8(st), uint8(PoolRounds.TicketStatus.PLACED));
    }

    // ════════════════════════════════════════════════════════════
    //  Referrals and treasury
    // ════════════════════════════════════════════════════════════

    function test_Referral_RecordedThroughBet() public {
        _balancedRound();
        assertEq(registry.referrerOf(alice), refA);
        assertEq(registry.referrerOf(bob), refB);
    }

    function test_Referral_WithoutReferrerGoesToTreasury() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);
        _claim(id, alice);
        assertEq(rounds.feesAccrued(), 0.002 ether, "the whole 2% when nobody has a referrer");
    }

    function test_Referral_ClaimAndWithdraw() public {
        uint256 id = _balancedRound();
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);
        _claim(id, alice);

        vm.prank(refA);
        rounds.claimReferral();
        assertEq(weth.balanceOf(refA), 0.0002 ether);
        vm.prank(refA);
        vm.expectRevert(PoolRounds.NothingToWithdraw.selector);
        rounds.claimReferral();

        vm.prank(carol); // anyone
        rounds.withdrawFees();
        assertEq(weth.balanceOf(treasury), 0.0018 ether);
        vm.expectRevert(PoolRounds.NothingToWithdraw.selector);
        rounds.withdrawFees();
    }

    function test_Referral_BrokenRegistryNeverBlocksBetOrClaim() public {
        PoolRounds r2 = _deploy(address(new RevertingReferrals()), RATIO);
        PoolRoundMockPool p2 = _newPoolOn(r2, false);
        uint256 id = _nextRoundOn(r2, address(p2), T);
        _betOn(r2, id, alice, 0.05 ether, _up(), refA);
        _betOn(r2, id, bob, 0.05 ether, _down(), refB);
        _exitTickOn(r2, p2, id, 100);
        vm.warp(r2.roundTimes(id).settleAt);
        r2.settle(id);
        vm.prank(alice);
        assertEq(r2.claim(id), 0.098 ether);
        assertEq(r2.feesAccrued(), 0.002 ether, "unknown referrer: the share goes to the treasury");
    }

    /// Re-audit V3-4: a registry that burns gas or answers with something that
    /// is not an address cannot hold a claim; the share goes to the treasury.
    function test_Referral_HostileRegistryAnswers_ClaimStillPays() public {
        address[3] memory registries = [
            address(new GasBurningReferrals()),
            address(new NotAnAddressReferrals()),
            address(new ShortAnswerReferrals())
        ];
        for (uint256 i = 0; i < 3; i++) {
            PoolRounds r2 = _deploy(registries[i], RATIO);
            PoolRoundMockPool p2 = _newPoolOn(r2, false);
            uint256 id = _nextRoundOn(r2, address(p2), T);
            _betOn(r2, id, alice, 0.05 ether, _up(), refA);
            _betOn(r2, id, bob, 0.05 ether, _down(), refB);
            _exitTickOn(r2, p2, id, 100);
            vm.warp(r2.roundTimes(id).settleAt);
            r2.settle(id);
            vm.prank(alice);
            assertEq(r2.claim{gas: 1_000_000}(id), 0.098 ether);
            assertEq(r2.feesAccrued(), 0.002 ether, "the share went to the treasury");
        }
    }

    // ════════════════════════════════════════════════════════════
    //  Oracle paths
    // ════════════════════════════════════════════════════════════

    function test_Oracle_UnreadablePool_WaitsThenAnyoneRefundsAfterGrace() public {
        uint256 id = _balancedRound();
        _warpSettle(id);
        pool.setForceOtherRevert(1);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PriceUnavailableNow.selector, id));
        rounds.settle(id);
        assertEq(uint8(_outcome(id)), 0, "a read that may pass later changes nothing");

        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotSettled.selector, id));
        vm.prank(alice);
        rounds.claim(id);

        vm.warp(_times(id).settleAt + rounds.SETTLE_GRACE());
        vm.prank(carol); // any address, not the keeper
        rounds.settle(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND));
        assertEq(_claim(id, alice), 0.0495 ether);
        assertEq(_claim(id, bob), 0.0495 ether);
    }

    function test_Oracle_BareRevert_IsNotARefund() public {
        uint256 id = _balancedRound();
        _warpSettle(id);
        pool.setForceOtherRevert(2);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PriceUnavailableNow.selector, id));
        rounds.settle(id);
    }

    /// Re-audit V3-2: what counts is the liquidity the pool had during the price
    /// windows, not at the moment of the call. Pulled after the exit window, it
    /// blocks nothing (before v3 this was a 24 h lock followed by a refund).
    function test_Oracle_LiquidityPulledAfterTheWindows_DoesNotBlock() public {
        uint256 id = _balancedRound();
        _exitTick(pool, id, 100);
        _warpSettle(id);
        pool.setLiquidity(0);
        rounds.settle(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.UP));
        assertEq(_claim(id, alice), 0.098 ether);
    }

    function test_Oracle_HistoryGone_RefundsAtOnce() public {
        uint256 id = _balancedRound();
        _warpSettle(id);
        pool.setForceOld(true);
        vm.recordLogs();
        rounds.settle(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (, uint8 reason,,,,,) =
            abi.decode(logs[logs.length - 1].data, (uint8, uint8, uint256, uint256, uint256, uint256, uint256));
        assertEq(reason, rounds.REASON_HISTORY());
    }

    function test_Oracle_SpreadGuard_Refunds() public {
        uint256 id = _balancedRound();
        uint256 settleAt = _times(id).settleAt;
        // A late push inside the anchor tail: exit mean 166, anchor mean 500 ticks.
        pool.pushTick(uint32(settleAt - 10), 1000);
        _warpSettle(id);
        rounds.settle(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND));
        assertEq(_claim(id, alice), 0.0495 ether, "refund with the 1% void fee, not a win");
    }

    function test_FixStrike_LostStrikeWindow_RefundsAtOnce() public {
        uint256 id = _balancedRound();
        vm.warp(_times(id).strikeEnd);
        pool.setForceOld(true);
        rounds.fixStrike(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND));
        assertEq(_claim(id, alice), 0.0495 ether, "claimable at once, no need to wait for settleAt");
        _warpSettle(id);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.AlreadySettled.selector, id));
        rounds.settle(id);
    }

    function test_Settle_ReadsNothingBeforeItIsDue() public {
        uint256 id = _balancedRound();
        vm.warp(_times(id).settleAt - 1);
        pool.setForceOld(true); // would be a refund if settle looked at the pool
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotDue.selector, id));
        rounds.settle(id);
        vm.warp(_times(id).strikeEnd - 1);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotDue.selector, id));
        rounds.fixStrike(id);
    }

    function test_Settle_Twice_And_FixStrike_Twice_Revert() public {
        uint256 id = _balancedRound();
        vm.warp(_times(id).strikeEnd);
        rounds.fixStrike(id);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.StrikeAlreadyFixed.selector, id));
        rounds.fixStrike(id);
        _warpSettle(id);
        rounds.settle(id);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.AlreadySettled.selector, id));
        rounds.settle(id);
    }

    // ════════════════════════════════════════════════════════════
    //  Pool gate (audit M2)
    // ════════════════════════════════════════════════════════════

    function test_ListPool_RefusesCounterfeitAndNonWethPools() public {
        address token = makeAddr("fake-token");
        PoolRoundMockPool fake = new PoolRoundMockPool(token, address(weth), FEE_TIER);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotCanonicalPool.selector, address(fake)));
        rounds.listPool(address(fake));

        PoolRoundMockPool noWeth = new PoolRoundMockPool(token, makeAddr("other"), FEE_TIER);
        v3.register(token, makeAddr("other"), FEE_TIER, address(noWeth));
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotWethPool.selector, address(noWeth)));
        rounds.listPool(address(noWeth));
    }

    function test_ListPool_RefusesAThinPool() public {
        PoolRoundMockPool p = _unlistedPool(rounds, false);
        p.setLiquidity(50 ether - 1);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PoolTooThin.selector, 50 ether - 1));
        rounds.listPool(address(p));
        p.setLiquidity(50 ether);
        rounds.listPool(address(p));
        assertEq(rounds.wethDepth(address(p)), 50 ether, "at tick 0 the WETH depth equals L");
        assertEq(rounds.maxBankOf(address(p)), 0.02 ether, "50 / 2500: exactly the minimum bank");
    }

    function test_ListPool_RefusesASmallRing() public {
        PoolRoundMockPool p = _unlistedPool(rounds, false);
        p.setCardinality(300, 300); // enough for PoolMarketFactory, not for a 300 s strike window
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.CardinalityTooLow.selector, 300, 900));
        rounds.listPool(address(p));
        p.setCardinality(899, 899);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.CardinalityTooLow.selector, 899, 900));
        rounds.listPool(address(p));
        p.setCardinality(900, 900);
        rounds.listPool(address(p));
    }

    // ════════════════════════════════════════════════════════════
    //  Depth rule (re-audit V3-1, V3-2, V3-3)
    // ════════════════════════════════════════════════════════════

    /// Depth 100 WETH, K 2500: the accepted bank may reach 0.04. A bet that
    /// grows it past that is refused; a bet that only adds to the larger side
    /// does not grow the bank and is taken.
    function test_DepthRule_BetGrowingTheBankPastDepthOverK_Reverts() public {
        PoolRoundMockPool p = _unlistedPool(rounds, false);
        p.setLiquidity(100 ether);
        rounds.listPool(address(p));
        assertEq(rounds.maxBankOf(address(p)), 0.04 ether);
        uint256 id = _nextRound(p, T);
        _bet(id, alice, 0.02 ether, _up(), address(0));
        _bet(id, bob, 0.02 ether, _down(), address(0)); // bank 0.04: exactly the limit
        _bet(id, carol, 0.001 ether, _down(), address(0)); // larger side only: bank stays 0.04
        address dave = _player(4);
        _fund(rounds, dave, 1 ether);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.BankTooLargeForPool.selector, 0.042 ether, 0.04 ether));
        rounds.bet(id, 0.001 ether, _up(), address(0));
        assertEq(rounds.roundView(id).bank, 0.04 ether);
    }

    /// The pool carried less than bank x K during the strike window: the strike
    /// was cheap to move, so the round is refunded at fixStrike (REASON_THIN).
    function test_DepthRule_ThinStrikeWindow_Refunds() public {
        uint256 id = _balancedRound(); // bank 0.1 needs 250 WETH in each window
        pool.pushLiquidity(uint32(_times(id).strikeStart), 200 ether);
        vm.warp(_times(id).strikeEnd);
        vm.recordLogs();
        rounds.fixStrike(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (, uint8 reason,,,,,) =
            abi.decode(logs[logs.length - 1].data, (uint8, uint8, uint256, uint256, uint256, uint256, uint256));
        assertEq(reason, rounds.REASON_THIN());
        assertEq(_claim(id, alice), 0.0495 ether, "refund with the 1% void fee, at once");
    }

    /// The same for the exit window, checked at settle.
    function test_DepthRule_ThinExitWindow_Refunds() public {
        uint256 id = _balancedRound();
        _exitTick(pool, id, 100);
        vm.warp(_times(id).strikeEnd);
        rounds.fixStrike(id); // the strike window was deep enough
        pool.pushLiquidity(uint32(_times(id).settleAt - 30), 0); // half the exit window with no liquidity
        _warpSettle(id);
        rounds.settle(id);
        assertEq(
            uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND), "no winner from a window the pool did not carry"
        );
    }

    /// Without fixStrike, settle reads the strike window itself and applies the
    /// same rule to it.
    function test_DepthRule_ThinStrikeWindow_RefundsAtSettleToo() public {
        uint256 id = _balancedRound();
        _exitTick(pool, id, 100);
        pool.pushLiquidity(uint32(_times(id).strikeStart), 100 ether);
        pool.pushLiquidity(uint32(_times(id).strikeEnd), POOL_LIQUIDITY);
        _warpSettle(id);
        rounds.settle(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND), "the strike window carried 100, not 250");
    }

    /// Just-in-time liquidity at bet time does not buy a cheap window: the bet
    /// passes against the inflated depth, but the windows are measured on their
    /// own, and a pool that went thin again refunds the round.
    function test_DepthRule_JitLiquidityAtBetTime_DoesNotBuyACheapWindow() public {
        PoolRoundMockPool p = _unlistedPool(rounds, false);
        p.setLiquidity(60 ether);
        rounds.listPool(address(p));
        uint256 id = _nextRound(p, T);
        _fund(rounds, alice, 1 ether);
        vm.prank(alice);
        rounds.bet(id, 0.05 ether, _up(), address(0));
        _fund(rounds, bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.BankTooLargeForPool.selector, 0.1 ether, 0.024 ether));
        rounds.bet(id, 0.05 ether, _down(), address(0));
        p.setLiquidity(1000 ether); // mint just before the bet...
        vm.prank(bob);
        rounds.bet(id, 0.05 ether, _down(), address(0));
        p.setLiquidity(60 ether); // ...burn right after
        _exitTick(p, id, 100);
        vm.warp(_times(id).strikeEnd);
        rounds.fixStrike(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND), "the strike window carried 60, not 250");
    }

    /// Re-audit V3-3: the gate is re-checked on every bet, and anyone can delist a
    /// pool that fell below it. Rounds already open run to the end.
    function test_Gate_RecheckedOnEveryBet_AndAnyoneDelistsBelowGate() public {
        uint256 id = _balancedRound();
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PoolAboveGate.selector, address(pool), POOL_LIQUIDITY));
        vm.prank(carol);
        rounds.delistIfBelowGate(address(pool));

        uint256 next = rounds.roundIdOf(address(pool), T, block.timestamp / T); // taking bets now
        pool.setLiquidity(40 ether);
        _fund(rounds, carol, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PoolTooThin.selector, 40 ether));
        vm.prank(carol);
        rounds.bet(next, 0.05 ether, _up(), address(0));

        vm.prank(carol); // anyone
        rounds.delistIfBelowGate(address(pool));
        (bool listed,) = rounds.pools(address(pool));
        assertFalse(listed);

        pool.setLiquidity(POOL_LIQUIDITY); // back before the windows of the open round
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);
        assertEq(_claim(id, alice), 0.098 ether, "the open round ran to the end");
    }

    /// Re-audit V3-3: a pool with no liquidity takes no bets.
    function test_Gate_NoLiquidity_NoBets() public {
        uint256 id = _nextRound(pool, T);
        pool.setLiquidity(0);
        _fund(rounds, alice, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PoolTooThin.selector, 0));
        vm.prank(alice);
        rounds.bet(id, 0.05 ether, _up(), address(0));
    }

    /// Re-audit V3-5: the keeper's deadlines follow a formula, not a constant.
    function test_KeeperDeadlines_Formula() public view {
        uint256[3] memory ds = [uint256(60), 300, 900];
        uint256[3] memory exitW = [uint256(30), 60, 180];
        for (uint256 i = 0; i < 3; i++) {
            uint256 id = rounds.roundIdOf(address(pool), ds[i], 1000);
            PoolRounds.Times memory tm = rounds.roundTimes(id);
            (uint256 fixBy, uint256 settleBy) = rounds.keeperDeadlines(id);
            assertEq(rounds.exitWindowOf(ds[i]), exitW[i]);
            assertEq(fixBy, tm.strikeStart + 900 - 1);
            assertEq(settleBy, tm.settleAt - exitW[i] + 900 - 1);
        }
        uint256 id300 = rounds.roundIdOf(address(pool), 300, 1000);
        (uint256 f, uint256 st) = rounds.keeperDeadlines(id300);
        assertEq(f - rounds.roundTimes(id300).strikeEnd, 599);
        assertEq(st - rounds.roundTimes(id300).settleAt, 839);
    }

    function test_ListPool_RefusesARingWithoutHistory() public {
        PoolRoundMockPool p = _unlistedPool(rounds, false);
        p.setForceOld(true); // the slots exist, the history in them does not reach 300 s
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PoolCannotServeWindow.selector, 300));
        rounds.listPool(address(p));
        assertFalse(rounds.canServeWindow(address(p), 300));
    }

    // ════════════════════════════════════════════════════════════
    //  (c) Bad paths
    // ════════════════════════════════════════════════════════════

    function test_Bet_OutsideItsWindow_Reverts() public {
        uint256 id = _nextRound(pool, T);
        (,, uint256 k) = rounds.decodeRoundId(id);
        _fund(rounds, alice, 1 ether);

        vm.warp(_times(id).closeAt); // first second after the window
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotCollecting.selector, id));
        vm.prank(alice);
        rounds.bet(id, 0.05 ether, _up(), address(0));

        uint256 future = rounds.roundIdOf(address(pool), T, k + 5);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotCollecting.selector, future));
        vm.prank(alice);
        rounds.bet(future, 0.05 ether, _up(), address(0));

        vm.warp(_times(id).closeAt - 1); // last second inside
        vm.prank(alice);
        rounds.bet(id, 0.05 ether, _up(), address(0));
    }

    function test_Bet_Validation() public {
        uint256 id = _nextRound(pool, T);
        _fund(rounds, alice, 1 ether);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.StakeOutOfBounds.selector, 0));
        rounds.bet(id, 0, _up(), address(0));
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.StakeOutOfBounds.selector, 101 ether));
        rounds.bet(id, 101 ether, _up(), address(0));
        vm.expectRevert(PoolRounds.InvalidSide.selector);
        rounds.bet(id, 0.05 ether, PoolRounds.Side.NONE, address(0));
        vm.expectRevert(PoolRounds.SelfReferral.selector);
        rounds.bet(id, 0.05 ether, _up(), alice);
        vm.expectRevert(PoolRounds.SelfReferral.selector); // audit L3
        rounds.bet(id, 0.05 ether, _up(), address(rounds));
        rounds.bet(id, 0.05 ether, _up(), address(0));
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.AlreadyBet.selector, id, alice));
        rounds.bet(id, 0.05 ether, _down(), address(0));
        vm.stopPrank();
        // a side value outside the enum does not decode at all
        (bool ok,) =
            address(rounds).call(abi.encodeWithSelector(PoolRounds.bet.selector, id, 0.05 ether, uint8(3), address(0)));
        assertFalse(ok);
    }

    function test_Claim_BadStates_Revert() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NoTicket.selector, id, carol));
        vm.prank(carol);
        rounds.claim(id);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotSettled.selector, id));
        vm.prank(alice);
        rounds.claim(id); // still taking bets

        _exitTick(pool, id, 100);
        _warpClose(id);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotSettled.selector, id));
        vm.prank(alice);
        rounds.claim(id); // activated, not settled

        _warpSettle(id);
        rounds.settle(id);
        _claim(id, alice);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.AlreadyClaimed.selector, id, alice));
        vm.prank(alice);
        rounds.claim(id);
        _claim(id, bob); // a loser can close the ticket with 0
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.AlreadyClaimed.selector, id, bob));
        vm.prank(bob);
        rounds.claim(id);
    }

    function test_OneSideOnly_RefundedAtClose_KeeperNeverNeeded() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, carol, 0.03 ether, _up(), address(0));
        _warpClose(id);
        assertFalse(rounds.roundView(id).activated);
        assertEq(_claim(id, alice), 0.05 ether);
        assertEq(_claim(id, carol), 0.03 ether);
        vm.warp(_times(id).strikeEnd);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotActivated.selector, id));
        rounds.fixStrike(id);
        assertEq(weth.balanceOf(address(rounds)), 0);
    }

    // ════════════════════════════════════════════════════════════
    //  Pause, snapshots, owner
    // ════════════════════════════════════════════════════════════

    function test_Pause_StopsOnlyNewBets_EveryExitKeepsWorking() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), refA);
        _bet(id, bob, 0.05 ether, _down(), refB);
        vm.prank(pauserAddr);
        rounds.pause();

        _fund(rounds, carol, 1 ether);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(carol);
        rounds.bet(id, 0.05 ether, _up(), address(0));

        _exitTick(pool, id, 100);
        vm.warp(_times(id).strikeEnd);
        rounds.fixStrike(id);
        _warpSettle(id);
        rounds.settle(id);
        assertEq(_claim(id, alice), 0.098 ether);
        vm.prank(refA);
        rounds.claimReferral();
        rounds.withdrawFees();
        assertTrue(rounds.paused(), "nothing on the way out cleared the pause");

        // A fresh round is created by bet(), which checks the flag:
        // no keeper action can reopen betting.
        uint256 next = _nextRound(pool, T);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(carol);
        rounds.bet(next, 0.05 ether, _up(), address(0));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, pauserAddr));
        vm.prank(pauserAddr);
        rounds.unpause();
        rounds.unpause();
        vm.prank(carol);
        rounds.bet(next, 0.05 ether, _up(), address(0));
    }

    function test_Pause_OnlyOwnerOrPauser() public {
        vm.expectRevert(PoolRounds.NotPauser.selector);
        vm.prank(carol);
        rounds.pause();
    }

    function test_Pause_DoesNotBlockRefundOfUnplayedRound() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        rounds.pause();
        _warpClose(id);
        assertEq(_claim(id, alice), 0.05 ether);
    }

    function test_Snapshot_MinBankAndCostAllowance_NeverChangeARoundAlreadyOpen() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        rounds.setMinBank(1 ether);
        rounds.setCostAllowance(1e16);
        _bet(id, bob, 0.05 ether, _down(), address(0));
        _warpClose(id);
        PoolRounds.RoundView memory v = rounds.roundView(id);
        assertEq(v.minBank, MIN_BANK);
        assertEq(v.costAllowance, COST_0398);
        assertTrue(v.activated, "the values in force at the first bet decide");

        uint256 later = _nextRound(pool, T);
        _bet(later, alice, 0.05 ether, _up(), address(0));
        _bet(later, bob, 0.05 ether, _down(), address(0));
        _warpClose(later);
        assertFalse(rounds.roundView(later).activated, "a round opened after the change uses the new values");
        assertEq(_claim(later, alice), 0.05 ether);
    }

    function test_Owner_BoundsAndAccess() public {
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 0.0009 ether));
        rounds.setMinBank(0.0009 ether);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 11 ether));
        rounds.setMinBank(11 ether);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 1e12 - 1));
        rounds.setCostAllowance(1e12 - 1);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 1e16 + 1));
        rounds.setCostAllowance(1e16 + 1);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 59));
        rounds.setDuration(59, true);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 3601));
        rounds.setDuration(3601, true);
        vm.expectRevert(PoolRounds.ZeroAddress.selector);
        rounds.setTreasury(address(0));

        vm.startPrank(carol);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol));
        rounds.setMinBank(0.02 ether);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol));
        rounds.setCostAllowance(1e13);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol));
        rounds.listPool(address(pool));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol));
        rounds.setTreasury(carol);
        vm.stopPrank();
    }

    function test_Constructor_Bounds() public {
        PoolRounds.Params memory p = _params(address(registry), 0);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 0));
        new PoolRounds(p);
        p.maxSideRatio = 5;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 5));
        new PoolRounds(p);
        p.maxSideRatio = 1;
        p.strikePause = 59;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 59));
        new PoolRounds(p);
        p.strikePause = 901;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 901));
        new PoolRounds(p);
        p.strikePause = 300;
        p.strikeWindow = 59;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 59));
        new PoolRounds(p);
        p.strikeWindow = 601;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 601));
        new PoolRounds(p);
        p.strikeWindow = 600;
        assertEq(new PoolRounds(p).minCardinality(), 1200, "a 600 s strike window needs 1200 slots");
        p.depthPerBank = 99;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 99));
        new PoolRounds(p);
        p.depthPerBank = 1_000_001;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 1_000_001));
        new PoolRounds(p);
        p.depthPerBank = K;
        p.maxStake = uint256(type(uint96).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, uint256(type(uint96).max) + 1));
        new PoolRounds(p);
    }

    /// Audit M1: a registry address without code is refused at deployment.
    function test_Constructor_RefusesARegistryWithoutCode() public {
        address noCode = makeAddr("registry-without-code");
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NoCode.selector, noCode));
        new PoolRounds(_params(noCode, RATIO));
        new PoolRounds(_params(address(0), RATIO)); // zero still means "no referrals"
    }

    function test_Delist_StopsNewBets_OpenRoundStillSettles() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
        rounds.delistPool(address(pool));
        _fund(rounds, carol, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PoolNotListed.selector, address(pool)));
        vm.prank(carol);
        rounds.bet(id, 0.05 ether, _up(), address(0));

        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);
        assertEq(_claim(id, alice), 0.098 ether);
    }

    function test_DisabledDuration_RefusesBets() public {
        rounds.setDuration(T, false);
        uint256 id = _nextRound(pool, T);
        _fund(rounds, alice, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.DurationNotEnabled.selector, T));
        vm.prank(alice);
        rounds.bet(id, 0.05 ether, _up(), address(0));
    }

    function test_IsMarket_AnswersForItselfOnly() public view {
        assertTrue(rounds.isMarket(address(rounds)));
        assertFalse(rounds.isMarket(alice));
    }
}
