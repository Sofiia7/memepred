// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoolRoundTestBase.sol";

/**
 * (b) Fuzzing one round end to end against the reference model, at cap 1 (the
 * design) and cap 4: random book (1-20 bets), random referrers, random gas
 * policy and outcome. For every run:
 *
 *   - activation and every payout equal the reference, to the wei;
 *   - money: deposits = payouts + fee + referrals + dust, with dust >= 0 and
 *     bounded (the reference's own dust plus < 1 wei per ticket from splitting
 *     the referral pot per ticket);
 *   - an activated round books at least COVER x its cost allowance for the
 *     project, whatever the outcome, so the result stays >= the allowance
 *     while the real spend is within it;
 *   - ties, refunds and unplayed rounds leave nothing inside beyond fee and dust;
 *   - at cap 1 every winner's award is 1.96x its accepted part, up to rounding;
 *   - a second claim of the same ticket reverts.
 */
contract PoolRoundsFuzzTest is PoolRoundTestBase {
    uint256[4] internal GAS_WEI = [uint256(20_142e9), 69_692e9, 398e12, 1_039e12];

    struct Book {
        uint256 n;
        address[] players;
        uint256[] stakes;
        bool[] up;
        address[] refs;
    }

    function _rng(uint256 seed, uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i)));
    }

    function _book(uint256 seed, uint256 n, bool wide) internal pure returns (Book memory b) {
        b.n = n;
        b.players = new address[](n);
        b.stakes = new uint256[](n);
        b.up = new bool[](n);
        b.refs = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 r = _rng(seed, i);
            b.players[i] = address(uint160(uint256(keccak256(abi.encode("fz", seed, i)))));
            // positive-ev.mts selfTest() stakes: k x 0.005 ETH plus a few wei of noise;
            // `wide` spreads them over [1 wei, 100 ETH] to reach the mulDiv paths.
            b.stakes[i] = wide ? 1 + (r >> 8) % 100 ether : (1 + r % 8) * 0.005 ether + (r >> 16) % 17;
            b.up[i] = (r >> 32) % 2 == 0;
            b.refs[i] = (r >> 48) % 3 == 0 ? address(uint160(0xEEEE0000 + (r >> 56) % 3)) : address(0);
        }
    }

    function testFuzz_Round_MatchesReferenceAndConservesMoney(
        uint256 seed,
        uint8 nRaw,
        uint8 outcomeSel,
        uint8 gasSel,
        bool cap4
    ) public {
        _run(_book(seed, 1 + uint256(nRaw) % 20, false), outcomeSel % 4, GAS_WEI[gasSel % 4], cap4 ? 4 : 1);
    }

    function testFuzz_WideStakes_MatchReference(uint256 seed, uint8 nRaw, uint8 outcomeSel, bool cap4) public {
        _run(_book(seed, 2 + uint256(nRaw) % 10, true), outcomeSel % 4, GAS_WEI[0], cap4 ? 4 : 1);
    }

    /// outcome: 0 up, 1 down, 2 tie, 3 oracle refund
    function _run(Book memory b, uint256 outcome, uint256 costAllowance, uint256 ratio) internal {
        if (ratio != RATIO) _useRatio(ratio);
        rounds.setCostAllowance(costAllowance);
        uint256 id = _nextRound(pool, T);
        uint256 deposits;
        for (uint256 i = 0; i < b.n; i++) {
            _bet(id, b.players[i], b.stakes[i], b.up[i] ? _up() : _down(), b.refs[i]);
            deposits += b.stakes[i];
        }
        if (outcome == 0) _exitTick(pool, id, 100);
        if (outcome == 1) _exitTick(pool, id, -100);

        PoolRoundRefModel.Result memory ref = _reference(b, outcome, ratio, costAllowance);

        _warpSettle(id);
        assertEq(rounds.roundView(id).activated, ref.active, "activation = reference clear()");
        if (ref.active) {
            if (outcome == 3) pool.setForceOld(true);
            rounds.settle(id);
            pool.setForceOld(false);
            assertEq(uint8(rounds.roundView(id).outcome), uint8(outcome + 1));
            assertGe(
                rounds.feesAccrued(), PoolRoundMath.COVER * costAllowance, "retained fee covers the allowance twice"
            );
        }

        uint256 paid = _claimAll(b, id, ref, ratio, outcome);

        uint256 fees = rounds.feesAccrued();
        uint256 refs = rounds.referralOwed(address(0xEEEE0000)) + rounds.referralOwed(address(0xEEEE0001))
            + rounds.referralOwed(address(0xEEEE0002));
        uint256 balance = weth.balanceOf(address(rounds));
        assertGe(balance, fees + refs, "dust is never negative");
        uint256 dust = balance - fees - refs;
        assertEq(deposits, paid + fees + refs + dust, "deposits = payouts + fee + referrals + dust");

        if (!ref.active) {
            assertEq(balance, 0, "an unplayed round keeps nothing");
            return;
        }
        assertEq(
            fees + refs + (dust - ref.dust), ref.grossFee, "gross fee = treasury + referrals + referral-split rounding"
        );
        assertGe(dust, ref.dust);
        assertLt(dust - ref.dust, b.n + 1, "referral split rounds away < 1 wei per ticket");
        assertLt(ref.dust, 2 * b.n, "reference: claim rounding is bounded");
        assertGe(fees, ref.treasury, "project part >= the reference's (which assumes every fee has a referrer)");
        assertGe(fees - costAllowance, costAllowance, "result after a fully spent allowance >= allowance");
    }

    function _reference(Book memory b, uint256 outcome, uint256 ratio, uint256 costAllowance)
        internal
        pure
        returns (PoolRoundRefModel.Result memory)
    {
        PoolRoundRefModel.Ticket[] memory book = new PoolRoundRefModel.Ticket[](b.n);
        for (uint256 i = 0; i < b.n; i++) {
            book[i] = PoolRoundRefModel.Ticket(b.up[i], b.stakes[i]);
        }
        return PoolRoundRefModel.settle(book, uint8(outcome + 1), ratio, MIN_BANK, costAllowance);
    }

    function _claimAll(Book memory b, uint256 id, PoolRoundRefModel.Result memory ref, uint256 ratio, uint256 outcome)
        internal
        returns (uint256 paid)
    {
        PoolRounds.RoundView memory v = rounds.roundView(id);
        for (uint256 i = 0; i < b.n; i++) {
            uint256 got = _claim(id, b.players[i]);
            assertEq(got, ref.payouts[i], "payout = reference, to the wei");
            paid += got;
            if (ref.active && ratio == 1 && outcome < 2 && (outcome == 0) == b.up[i]) {
                // 1.96x the accepted part: award = stake * prize / sideRaw, accepted = stake * m / sideRaw
                uint256 sideRaw = b.up[i] ? v.rawUp : v.rawDown;
                uint256 unmatched = b.stakes[i] * (sideRaw - v.acceptedUp) / sideRaw;
                uint256 acceptedPart = b.stakes[i] * v.acceptedUp / sideRaw;
                assertApproxEqAbs(got - unmatched, acceptedPart * 196 / 100, 3, "cap 1: 1.96x of the accepted part");
            }
            vm.expectRevert(abi.encodeWithSelector(PoolRounds.AlreadyClaimed.selector, id, b.players[i]));
            vm.prank(b.players[i]);
            rounds.claim(id);
        }
    }
}
