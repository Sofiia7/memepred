// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoolRoundTestBase.sol";

/// Calls observe() from a contract, the way PoolRounds does, and reports the gas.
contract ObserveProbe {
    function gasOfDepthRead(IUniswapV3Pool pool) external view returns (uint256 used) {
        uint256 before = gasleft();
        pool.slot0();
        pool.liquidity();
        used = before - gasleft();
    }

    function gasOf(IUniswapV3Pool pool, uint32[] calldata secondsAgos) external view returns (uint256 used) {
        uint256 before = gasleft();
        pool.observe(secondsAgos);
        used = before - gasleft();
    }
}

/**
 * Gas of the full round lifecycle (interface v3), for docs/rhc/ROUNDS-CONTRACT.md.
 *
 * Run it with --isolate (see docs/rhc/measurements/rounds/README.md): every call
 * from this test then executes as its own transaction with cold storage, the
 * 21 000 base gas included and refunds applied, and vm.lastCallGas().gasTotalUsed
 * is what a receipt's L2 gasUsed would show (docs/rhc/measurements/economics/
 * RefundSemantics.t.sol established those semantics). Without --isolate the same
 * test runs and passes, but the numbers are warm-slot numbers and not the ones
 * to quote.
 *
 * Every cycle deploys a fresh PoolRounds (cap 1, pause 300 s, strike window
 * 300 s) and pool, so the n = 2, 10 and 50 cycles start from identical state and
 * differ only in the number of players.
 *
 * Two parts cannot be measured here and are added as labelled ESTIMATES:
 *   - the real pool's observe() is a binary search over a populated ring; the
 *     mock walks a short list. Measured on chain: 41 500 gas of execution for
 *     three points (PoolSettlementGasBench.t.sol). Scaled per point for 2 and 5.
 *   - the L1 data fee (Arbitrum-style chain). Not reproducible in forge at all;
 *     13 021 gas per transaction is the largest value measured on RHC testnet
 *     receipts (docs/rhc/ECONOMICS.md), used for every keeper transaction.
 */
contract PoolRoundsGasTest is PoolRoundTestBase {
    uint256 internal constant REAL_OBSERVE_3PT = 41_500; // measured on chain, execution only
    uint256 internal constant L1_PER_TX_EST = 13_021; // largest gasUsedForL1 of the RHC e2e receipts
    uint256 internal constant LIFECYCLE_BUDGET = 1_000_000; // POSITIVE-EV.md design budget
    uint256 internal constant STAKE = 0.01 ether;

    mapping(bytes32 => uint256) internal g; // measurement name => gas

    ObserveProbe internal probe;
    address internal referrer;

    function _last() internal view returns (uint256) {
        return vm.lastCallGas().gasTotalUsed;
    }

    function _log(uint256 n, string memory what, uint256 v) internal {
        emit log_named_uint(string.concat("n=", vm.toString(n), " ", what), v);
    }

    function _k(uint256 n, string memory what) internal pure returns (bytes32) {
        return keccak256(abi.encode(n, what));
    }

    /// Fresh contract, registry, pool, treasury and referrer per cycle, so the
    /// n = 2, 10 and 50 cycles start from the same state.
    function _fresh(uint256 n) internal {
        treasury = address(uint160(uint256(keccak256(abi.encode("gas-treasury", n)))));
        referrer = address(uint160(uint256(keccak256(abi.encode("gas-referrer", n)))));
        registry = new ReferralRegistry();
        rounds = _deploy(address(registry), 1);
        registry.setMarketFactory(address(rounds));
        registry.authorizeMarket(address(rounds));
        rounds.setMinBank(0.02 ether);
        rounds.setCostAllowance(20_142e9); // 1M gas x 0.020142 gwei, today's floor
        pool = _newPool(false);
    }

    function _p(uint256 n, uint256 i) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("gas-player", n, i)))));
    }

    /// Every fourth player has a referrer, so that in a round UP wins (even
    /// players) there is a winner whose referrer is credited for the first
    /// time (0), a winner without referrer (2) and one credited again (4).
    function _ref(uint256 i) internal view returns (address) {
        return i % 4 == 0 ? referrer : address(0);
    }

    function _side(uint256 i) internal pure returns (PoolRounds.Side) {
        return i % 2 == 0 ? PoolRounds.Side.UP : PoolRounds.Side.DOWN;
    }

    /// n bets (half UP, half DOWN, equal stakes) into the next window. Records the
    /// first bet of the round, a later one without referrer, a later one that
    /// records a referral link, and the average of all later ones.
    function _betAll(uint256 n, string memory tag) internal returns (uint256 id) {
        for (uint256 i = 0; i < n; i++) {
            _fund(rounds, _p(n, i), 10 * STAKE);
        }
        id = _nextRound(pool, T);
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            vm.prank(_p(n, i));
            rounds.bet(id, STAKE, _side(i), _ref(i));
            uint256 used = _last();
            if (i == 0) g[_k(n, string.concat(tag, " bet, first of the round"))] = used;
            if (i == 1) g[_k(n, string.concat(tag, " bet, later, no referrer"))] = used;
            if (i == 4) g[_k(n, string.concat(tag, " bet, later, with referrer"))] = used;
            if (i > 0) sum += used;
        }
        g[_k(n, string.concat(tag, " bet, average of later bets"))] = sum / (n - 1);
    }

    function _claimAll(uint256 n, uint256 id) internal {
        for (uint256 i = 0; i < n; i++) {
            vm.prank(_p(n, i));
            rounds.claim(id);
            uint256 used = _last();
            if (i == 0) g[_k(n, "A claim, winner, referrer credited first time")] = used;
            if (i == 1) g[_k(n, "A claim, loser")] = used;
            if (i == 2) g[_k(n, "A claim, winner, no referrer (share to treasury)")] = used;
            if (i == 4) g[_k(n, "A claim, winner, referrer credited again")] = used;
        }
    }

    function _cycle(uint256 n) internal {
        _fresh(n);

        // ── A: priced round, strike fixed separately (the keeper's path) ──
        uint256 a = _betAll(n, "A");
        _exitTick(pool, a, 100); // UP wins
        vm.warp(_times(a).strikeEnd);
        rounds.fixStrike(a);
        g[_k(n, "fixStrike")] = _last();
        _warpSettle(a);
        rounds.settle(a);
        g[_k(n, "settle, strike fixed (3-point read)")] = _last();
        _claimAll(n, a);
        rounds.withdrawFees();
        g[_k(n, "withdrawFees")] = _last();
        vm.prank(referrer);
        rounds.claimReferral();
        g[_k(n, "claimReferral")] = _last();

        // ── B: priced round, settle reads the strike window too (5-point read) ──
        uint256 b = _betAll(n, "B");
        // no price change after round A's move: entry and exit equal, a tie, 1% void fee
        _warpSettle(b);
        rounds.settle(b);
        g[_k(n, "settle, strike read at settle (5-point read)")] = _last();
        vm.prank(_p(n, 0));
        rounds.claim(b);
        g[_k(n, "B claim, tie")] = _last();
        assertEq(uint8(rounds.roundView(b).outcome), uint8(PoolRounds.Outcome.TIE));

        // ── C: the pool lost the window: REFUND at settle ──
        uint256 c = _betAll(n, "C");
        _warpSettle(c);
        pool.setForceOtherRevert(1);
        (bool ok,) = address(rounds).call(abi.encodeCall(PoolRounds.settle, (c)));
        assertFalse(ok, "an unreadable pool must not decide the round");
        g[_k(n, "settle attempt, pool unreadable (reverts, retry later)")] = _last();
        pool.setForceOtherRevert(0);
        pool.setForceOld(true);
        rounds.settle(c);
        g[_k(n, "settle -> REFUND, history gone")] = _last();
        pool.setForceOld(false);
        vm.prank(_p(n, 0));
        rounds.claim(c);
        g[_k(n, "C claim, oracle refund")] = _last();

        // ── D: nobody priced it within SETTLE_GRACE ──
        uint256 d = _betAll(n, "D");
        vm.warp(_times(d).settleAt + rounds.SETTLE_GRACE());
        rounds.settle(d);
        g[_k(n, "settle -> REFUND, grace lapsed")] = _last();

        // ── E: not activated: a minimum bank no book here reaches, set before its first bet ──
        rounds.setMinBank(10 ether);
        uint256 e = _betAll(n, "E");
        _warpClose(e);
        assertFalse(rounds.roundView(e).activated);
        vm.prank(_p(n, 0));
        rounds.claim(e);
        g[_k(n, "E claim, round not activated: full refund")] = _last();

        // ── observe() of the mock, from a contract, at this pool's size ──
        probe = new ObserveProbe();
        uint32[] memory two = new uint32[](2);
        two[0] = 301;
        two[1] = 1;
        uint32[] memory three = new uint32[](3);
        three[0] = 61;
        three[1] = 21;
        three[2] = 1;
        uint32[] memory five = new uint32[](5);
        five[0] = 900;
        five[1] = 600;
        five[2] = 61;
        five[3] = 21;
        five[4] = 1;
        g[_k(n, "mock observe 2 points")] = probe.gasOf(pool, two);
        g[_k(n, "mock observe 3 points")] = probe.gasOf(pool, three);
        g[_k(n, "mock observe 5 points")] = probe.gasOf(pool, five);
        g[_k(n, "mock slot0 + liquidity (the depth read of a bet)")] = probe.gasOfDepthRead(pool);
    }

    string[] internal names;

    function _names() internal {
        if (names.length > 0) return;
        names.push("A bet, first of the round");
        names.push("A bet, later, no referrer");
        names.push("A bet, later, with referrer");
        names.push("A bet, average of later bets");
        names.push("B bet, first of the round");
        names.push("B bet, later, no referrer");
        names.push("B bet, later, with referrer");
        names.push("B bet, average of later bets");
        names.push("fixStrike");
        names.push("settle, strike fixed (3-point read)");
        names.push("settle, strike read at settle (5-point read)");
        names.push("settle attempt, pool unreadable (reverts, retry later)");
        names.push("settle -> REFUND, history gone");
        names.push("settle -> REFUND, grace lapsed");
        names.push("A claim, winner, referrer credited first time");
        names.push("A claim, winner, referrer credited again");
        names.push("A claim, winner, no referrer (share to treasury)");
        names.push("A claim, loser");
        names.push("B claim, tie");
        names.push("C claim, oracle refund");
        names.push("E claim, round not activated: full refund");
        names.push("withdrawFees");
        names.push("claimReferral");
        names.push("mock observe 2 points");
        names.push("mock observe 3 points");
        names.push("mock observe 5 points");
        names.push("mock slot0 + liquidity (the depth read of a bet)");
    }

    function test_Gas_FullLifecycle_2_10_50() public {
        _names();
        uint256[3] memory ns = [uint256(2), 10, 50];
        for (uint256 j = 0; j < 3; j++) {
            _cycle(ns[j]);
        }
        for (uint256 j = 0; j < 3; j++) {
            for (uint256 k = 0; k < names.length; k++) {
                _log(ns[j], names[k], g[_k(ns[j], names[k])]);
            }
        }

        // What a round costs the project does not depend on how many played.
        string[5] memory keeper = [
            "fixStrike",
            "settle, strike fixed (3-point read)",
            "settle, strike read at settle (5-point read)",
            "settle -> REFUND, history gone",
            "settle -> REFUND, grace lapsed"
        ];
        for (uint256 k = 0; k < keeper.length; k++) {
            assertEq(g[_k(2, keeper[k])], g[_k(10, keeper[k])], keeper[k]);
            assertEq(g[_k(2, keeper[k])], g[_k(50, keeper[k])], keeper[k]);
        }

        // Budget: measured L2 gas + real-pool observe adjustment (estimate) + L1 (estimate).
        uint256 n = 50;
        // A real observe() called from a contract: the cold account access (2 600)
        // plus the measured execution, scaled per point. Minus what the mock cost.
        uint256 adj2 = _adj(2600 + REAL_OBSERVE_3PT * 2 / 3, g[_k(n, "mock observe 2 points")]);
        uint256 adj3 = _adj(2600 + REAL_OBSERVE_3PT, g[_k(n, "mock observe 3 points")]);
        uint256 adj5 = _adj(2600 + REAL_OBSERVE_3PT * 5 / 3, g[_k(n, "mock observe 5 points")]);
        uint256 fix = g[_k(n, "fixStrike")] + adj2 + L1_PER_TX_EST;
        uint256 set3 = g[_k(n, "settle, strike fixed (3-point read)")] + adj3 + L1_PER_TX_EST;
        uint256 set5 = g[_k(n, "settle, strike read at settle (5-point read)")] + adj5 + L1_PER_TX_EST;
        uint256 retry = g[_k(n, "settle attempt, pool unreadable (reverts, retry later)")] + adj5 + L1_PER_TX_EST;
        emit log_named_uint("EST real-pool observe adjustment, 2 points", adj2);
        emit log_named_uint("EST real-pool observe adjustment, 3 points", adj3);
        emit log_named_uint("EST real-pool observe adjustment, 5 points", adj5);
        emit log_named_uint("EST keeper path A: fixStrike + settle, with L1 and real observe", fix + set3);
        emit log_named_uint("EST keeper path B: settle alone, with L1 and real observe", set5);
        emit log_named_uint("EST one failed settle attempt, with L1 and real observe", retry);
        uint256 worst = fix + set3 > set5 ? fix + set3 : set5;
        uint256 retries = (LIFECYCLE_BUDGET - worst) / retry;
        emit log_named_uint("EST failed attempts that still fit in the 1 000 000 budget after the worst path", retries);
        assertLe(worst, LIFECYCLE_BUDGET, "a round's keeper work fits the lifecycle budget");
    }

    function _adj(uint256 realEst, uint256 mock) internal pure returns (uint256) {
        return realEst > mock ? realEst - mock : 0;
    }
}
