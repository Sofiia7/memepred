// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PoolRounds.sol";
import "../src/ReferralRegistry.sol";
import "./PoolRoundMockPool.sol";
import "./mocks/MockUniswapV3Factory.sol";
import "./mocks/MockWETH.sol";

/**
 * Drives PoolRounds through random sequences over many overlapping rounds of
 * one pool (60 s and 300 s): bets, clock and price moves, oracle failures,
 * strike fixing, settlement, claims and repeated claims, pause, policy
 * changes, fee and referral withdrawals.
 *
 * The handler owns the contract so it can pause and change the policy; it
 * never calls anything a player or keeper could not call except those two.
 * Each action looks for a ticket or round in the right phase, starting from
 * the fuzzed index, so that settlements and claims actually happen.
 */
contract PoolRoundsHandler is Test {
    PoolRounds public rounds;
    MockWETH public weth;
    PoolRoundMockPool public pool;
    ReferralRegistry public registry;

    struct Ghost {
        uint256 roundId;
        address player;
        uint256 stake;
        PoolRounds.Side side;
        bool claimed;
        uint256 paid;
    }

    Ghost[] public tickets;
    uint256[] public roundIds;
    mapping(uint256 => bool) internal seen;
    address[] internal actors;
    address[2] public referrers = [address(0xAAA1), address(0xAAA2)];

    uint256 public deposits;
    uint256 public paidOut;
    uint256 public feesWithdrawn;
    uint256 public referralsClaimed;
    uint256 public doubleClaims;
    uint256 public betsWhilePaused;
    // coverage counters: a run where nothing gets decided proves little
    uint256 public strikesFixed;
    uint256 public decided;
    uint256 public claims;

    uint256 internal constant MAX_TICKETS = 80;

    constructor(uint256 ratio) {
        vm.warp(1_790_000_000);
        weth = new MockWETH();
        MockUniswapV3Factory v3 = new MockUniswapV3Factory();
        registry = new ReferralRegistry();
        rounds = new PoolRounds(
            PoolRounds.Params({
                weth: address(weth),
                v3Factory: address(v3),
                referralRegistry: address(registry),
                treasury: address(0xFEE),
                maxSideRatio: ratio,
                strikePause: 300,
                strikeWindow: 300,
                depthPerBank: 2500,
                minStake: 1,
                maxStake: 1 ether,
                minBank: 0.02 ether,
                costAllowance: 20_142e9
            })
        );
        registry.setMarketFactory(address(rounds));
        registry.authorizeMarket(address(rounds));
        rounds.setDuration(60, true);
        rounds.setDuration(300, true);
        address token = address(0x70CE);
        pool = new PoolRoundMockPool(token, address(weth), 3000);
        pool.pushTick(uint32(block.timestamp - 7200), 0);
        pool.setCardinality(900, 900);
        pool.setLiquidity(1e9 ether);
        v3.register(token, address(weth), 3000, address(pool));
        rounds.listPool(address(pool));
        for (uint256 i = 0; i < 8; i++) {
            actors.push(address(uint160(0xA000 + i)));
        }
    }

    // ── actions ──────────────────────────────────────────────

    function bet(uint256 actorSeed, uint256 stakeSeed, bool up, bool short) external {
        if (tickets.length >= MAX_TICKETS) return;
        uint256 d = short ? 60 : 300;
        uint256 id = rounds.currentRoundId(address(pool), d);
        address a = actors[actorSeed % actors.length];
        (,, PoolRounds.TicketStatus st) = rounds.ticketOf(id, a);
        if (st != PoolRounds.TicketStatus.NONE) return;
        uint256 stake = bound(stakeSeed, 0.001 ether, 0.2 ether);
        PoolRounds.Side side = up ? PoolRounds.Side.UP : PoolRounds.Side.DOWN;
        address ref = actorSeed % 3 == 0 ? referrers[(actorSeed / 3) % 2] : address(0);
        weth.mint(a, stake);
        vm.prank(a);
        weth.approve(address(rounds), stake);
        vm.prank(a);
        try rounds.bet(id, stake, side, ref) {
            if (rounds.paused()) betsWhilePaused++;
            deposits += stake;
            tickets.push(Ghost(id, a, stake, side, false, 0));
            if (!seen[id]) {
                seen[id] = true;
                roundIds.push(id);
            }
        } catch {}
    }

    function warp(uint256 secs, int256 tickSeed) external {
        vm.warp(block.timestamp + bound(secs, 1, 200));
        pool.pushTick(uint32(block.timestamp), int24(bound(tickSeed, -250, 250)));
    }

    function oracle(uint8 mode) external {
        mode = mode % 8; // mostly healthy
        pool.setForceOld(mode == 1);
        pool.setForceOtherRevert(mode == 2 ? 1 : 0);
        // Liquidity leaves rarely and only changes when it really changes: every
        // change is a new segment of the stand-in's liquidity history.
        uint128 want = mode == 3 && uint256(keccak256(abi.encode(block.timestamp))) % 2 == 0 ? 0 : 1e9 ether;
        if (pool.liquidity() != want) pool.setLiquidity(want);
    }

    function fixStrike(uint256 idx) external {
        uint256 n = roundIds.length;
        for (uint256 k = 0; k < n; k++) {
            uint256 id = roundIds[(idx % n + k) % n];
            PoolRounds.RoundView memory v = rounds.roundView(id);
            if (!v.activated || v.strikeFixed || v.outcome != PoolRounds.Outcome.NONE) continue;
            if (block.timestamp < v.times.strikeEnd) continue;
            try rounds.fixStrike(id) {
                strikesFixed++;
            } catch {}
            return;
        }
    }

    function settle(uint256 idx) external {
        uint256 n = roundIds.length;
        for (uint256 k = 0; k < n; k++) {
            uint256 id = roundIds[(idx % n + k) % n];
            PoolRounds.RoundView memory v = rounds.roundView(id);
            if (!v.activated || v.outcome != PoolRounds.Outcome.NONE) continue;
            if (block.timestamp < v.times.settleAt) continue;
            try rounds.settle(id) {
                decided++;
            } catch {}
            return;
        }
    }

    function claim(uint256 idx) external {
        uint256 n = tickets.length;
        for (uint256 k = 0; k < n; k++) {
            Ghost storage g = tickets[(idx % n + k) % n];
            if (g.claimed) continue;
            try rounds.previewClaim(g.roundId, g.player) {}
            catch {
                continue;
            }
            uint256 before = weth.balanceOf(g.player);
            vm.prank(g.player);
            rounds.claim(g.roundId); // previewClaim said yes, so claim must pay
            g.claimed = true;
            claims++;
            g.paid = weth.balanceOf(g.player) - before;
            paidOut += g.paid;
            return;
        }
    }

    /// A second claim of a ticket: must never pay.
    function claimAgain(uint256 idx) external {
        uint256 n = tickets.length;
        for (uint256 k = 0; k < n; k++) {
            Ghost storage g = tickets[(idx % n + k) % n];
            if (!g.claimed) continue;
            vm.prank(g.player);
            try rounds.claim(g.roundId) {
                doubleClaims++;
            } catch {}
            return;
        }
    }

    /// Unpauses at once, pauses one time in four: a pause that lasts half the run
    /// would starve every other action of bets.
    function togglePause(uint8 seed) external {
        if (rounds.paused()) rounds.unpause();
        else if (seed % 4 == 0) rounds.pause();
    }

    function setPolicy(uint256 mb, uint256 ca) external {
        // Narrower than the contract's bounds so that rounds still activate.
        rounds.setMinBank(bound(mb, rounds.MIN_BANK_FLOOR(), 0.05 ether));
        rounds.setCostAllowance(bound(ca, rounds.COST_ALLOWANCE_FLOOR(), 1e14));
    }

    function withdrawFees() external {
        try rounds.withdrawFees() returns (uint256 a) {
            feesWithdrawn += a;
        } catch {}
    }

    function claimReferral(uint256 i) external {
        address r = referrers[i % 2];
        vm.prank(r);
        try rounds.claimReferral() returns (uint256 a) {
            referralsClaimed += a;
        } catch {}
    }

    // ── views for the invariants ──────────────────────────────

    function ticketCount() external view returns (uint256) {
        return tickets.length;
    }

    function roundCount() external view returns (uint256) {
        return roundIds.length;
    }

    function ticketAt(uint256 i) external view returns (Ghost memory) {
        return tickets[i];
    }
}

abstract contract PoolRoundsInvariantBase is Test {
    PoolRoundsHandler internal h;
    PoolRounds internal rounds;
    MockWETH internal weth;

    function _ratio() internal pure virtual returns (uint256);

    function setUp() public {
        h = new PoolRoundsHandler(_ratio());
        rounds = h.rounds();
        weth = h.weth();
        bytes4[] memory sel = new bytes4[](15);
        sel[0] = h.bet.selector;
        sel[1] = h.bet.selector; // weights: bets and time are what every other action needs
        sel[2] = h.bet.selector;
        sel[3] = h.warp.selector;
        sel[4] = h.warp.selector;
        sel[5] = h.oracle.selector;
        sel[6] = h.fixStrike.selector;
        sel[7] = h.settle.selector;
        sel[8] = h.settle.selector;
        sel[9] = h.claim.selector;
        sel[10] = h.claimAgain.selector;
        sel[11] = h.togglePause.selector;
        sel[12] = h.withdrawFees.selector;
        sel[13] = h.claimReferral.selector;
        sel[14] = h.setPolicy.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        targetContract(address(h));
    }

    /// Coverage summary of the run, printed with -vv; asserts nothing.
    function invariant_zz_CoverageSummary() public view {
        uint256[5] memory byOutcome;
        uint256 n = h.roundCount();
        for (uint256 i = 0; i < n; i++) {
            PoolRounds.RoundView memory v = rounds.roundView(h.roundIds(i));
            byOutcome[uint8(v.outcome)]++;
        }
        console.log("rounds", n, "tickets", h.ticketCount());
        console.log("claims", h.claims(), "strikes fixed", h.strikesFixed());
        console.log("settle/fixStrike decisions", h.decided());
        console.log("UP", byOutcome[1], "DOWN", byOutcome[2]);
        console.log("TIE", byOutcome[3], "REFUND", byOutcome[4]);
    }

    /// Every wei in the contract is explained by deposits minus what left through claim, withdrawFees and claimReferral.
    function invariant_BalanceIsDepositsMinusOutflows() public view {
        assertEq(weth.balanceOf(address(rounds)), h.deposits() - h.paidOut() - h.feesWithdrawn() - h.referralsClaimed());
    }

    /**
     * The contract can always pay everything it may owe: accrued fees, referral
     * balances, and for every ticket its exact claim when known, otherwise its
     * stake (an upper bound for an unsettled round as a whole, because payouts
     * plus the gross fee never exceed the stakes).
     */
    function invariant_Solvent() public view {
        uint256 owed = rounds.feesAccrued() + rounds.referralOwed(h.referrers(0)) + rounds.referralOwed(h.referrers(1));
        uint256 n = h.ticketCount();
        for (uint256 i = 0; i < n; i++) {
            PoolRoundsHandler.Ghost memory g = h.ticketAt(i);
            if (g.claimed) continue;
            try rounds.previewClaim(g.roundId, g.player) returns (uint256 payout, uint256 referralShare) {
                owed += payout + referralShare;
            } catch {
                owed += g.stake;
            }
        }
        assertGe(weth.balanceOf(address(rounds)), owed);
    }

    function invariant_NoTicketIsPaidTwice_AndPauseHoldsBets() public view {
        assertEq(h.doubleClaims(), 0);
        assertEq(h.betsWhilePaused(), 0);
    }

    /**
     * Every decided round booked for the project at least twice its own cost
     * allowance (snapshot at its first bet), whatever the outcome.
     */
    function invariant_DecidedRoundsCoverTheirBudget() public view {
        uint256 n = h.roundCount();
        for (uint256 i = 0; i < n; i++) {
            PoolRounds.RoundView memory v = rounds.roundView(h.roundIds(i));
            if (v.outcome == PoolRounds.Outcome.NONE) continue;
            bool isVoid = v.outcome == PoolRounds.Outcome.TIE || v.outcome == PoolRounds.Outcome.REFUND;
            uint256 gross = v.bank * (isVoid ? 100 : 200) / 10_000;
            uint256 retained = gross - gross * 1000 / 10_000;
            assertGe(retained, 2 * v.costAllowance);
            assertGe(v.bank, v.minBank);
        }
    }

    /**
     * A decided round whose tickets have all been claimed keeps only its gross
     * fee and dust (< 3 wei per ticket); an unplayed one keeps nothing. Ties and
     * refunds included. At cap 1 the accepted sides are equal.
     */
    function invariant_FinishedRoundsLeaveOnlyFeeAndDust() public view {
        uint256 nr = h.roundCount();
        uint256 nt = h.ticketCount();
        for (uint256 i = 0; i < nr; i++) {
            uint256 id = h.roundIds(i);
            PoolRounds.RoundView memory v = rounds.roundView(id);
            if (_ratio() == 1) assertEq(v.acceptedUp, v.acceptedDown, "cap 1: equal accepted sides");
            if (!v.bookClosed) continue;
            if (v.activated && v.outcome == PoolRounds.Outcome.NONE) continue;
            uint256 paid;
            uint256 count;
            bool open;
            for (uint256 j = 0; j < nt; j++) {
                PoolRoundsHandler.Ghost memory g = h.ticketAt(j);
                if (g.roundId != id) continue;
                if (!g.claimed) open = true;
                paid += g.paid;
                count++;
            }
            if (open) continue;
            uint256 left = v.committed - paid;
            if (!v.activated) {
                assertEq(left, 0, "unplayed round: every stake went back");
                continue;
            }
            bool isVoid = v.outcome == PoolRounds.Outcome.TIE || v.outcome == PoolRounds.Outcome.REFUND;
            uint256 gross = v.bank * (isVoid ? 100 : 200) / 10_000;
            assertGe(left, gross, "the fee is inside or was paid to treasury and referrers");
            assertLt(left - gross, 3 * count, "dust is bounded");
        }
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 200
/// forge-config: default.invariant.fail-on-revert = true
contract PoolRoundsInvariantCap1Test is PoolRoundsInvariantBase {
    function _ratio() internal pure override returns (uint256) {
        return 1;
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 200
/// forge-config: default.invariant.fail-on-revert = true
contract PoolRoundsInvariantCap4Test is PoolRoundsInvariantBase {
    function _ratio() internal pure override returns (uint256) {
        return 4;
    }
}
