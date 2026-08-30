// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/LiquidityPool.sol";
import "../src/GenesisNFT.sol";
import "../src/OrderbookMarket.sol";
import "./mocks/MockUSDC.sol";
import "./mocks/MockMarketRegistry.sol";
import "./helpers/RedstoneTest.sol";
import "./helpers/RedstoneHarness.sol";

/**
 * Same-block interleaving against shared pool capital.
 *
 * Everything the pool guards is shared across every market: one global 10%
 * exposure cap, one 5% per-market cap, one USDC balance. The existing suite
 * exercises those caps one call at a time, which is the easy case - the EVM
 * serialises transactions, so a cap read-modify-written inside a single call
 * cannot be torn.
 *
 * What is NOT self-evident is the interleaving: several markets matching
 * against the same pool within one block, a withdraw landing between two
 * matches, a deposit raising the cap mid-flight. Each of those calls is atomic
 * on its own and the composition still has to hold. Foundry keeps every call in
 * a test at the same block number and timestamp unless told otherwise, which is
 * exactly the model wanted here.
 *
 * Four invariants, asserted after every step:
 *   totalExposure          <= 10% of totalAssets
 *   marketExposure[m]      <= 5%  of totalAssets
 *   USDC held by the pool  >= totalPendingFees  (the pool stays backed)
 *   totalExposure          == 0 once everything has settled
 */
contract ConcurrencyRacesTest is RedstoneTest {
    LiquidityPool pool;
    GenesisNFT genesisNFT;
    MockUSDC usdc;

    OrderbookMarket[3] markets;

    address feeDistrib = makeAddr("feeDistrib");
    address multisig = makeAddr("multisig");
    address resolver;

    uint256 constant LP_CAPITAL = 100_000e6; // 100k USDC
    uint256 constant GLOBAL_CAP = LP_CAPITAL / 10; // 10%
    uint256 constant MARKET_CAP = LP_CAPITAL / 20; // 5%

    function setUp() public {
        resolver = makeAddr("resolver");
        _setPrice(bytes32("PEPE/USD"), 1000e8);

        usdc = new MockUSDC();
        genesisNFT = new GenesisNFT("ipfs://test/");
        pool = new LiquidityPool(IERC20(address(usdc)), address(genesisNFT));
        genesisNFT.setLiquidityPool(address(pool));

        MockMarketRegistry registry = new MockMarketRegistry();

        for (uint256 i = 0; i < 3; i++) {
            markets[i] = new OrderbookMarketHarness(
                address(usdc),
                resolver,
                address(pool),
                feeDistrib,
                address(0),
                multisig,
                bytes32("PEPE/USD"),
                15 minutes
            );
            registry.register(address(markets[i]));
        }

        pool.setMarketFactory(address(registry));
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(address(registry));
            pool.authorizeMarket(address(markets[i]));
        }

        _addLP("whale", LP_CAPITAL);
    }

    function _addLP(string memory name, uint256 amount) internal returns (address lp) {
        lp = makeAddr(name);
        usdc.mint(lp, amount);
        vm.prank(lp);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(lp);
        pool.deposit(amount, lp);
    }

    /// Called by a market: takes LP stake for a match.
    function _match(uint256 m, uint256 matchId, uint256 amount) internal returns (uint256) {
        vm.prank(address(markets[m]));
        return pool.tryMatch(matchId, amount, true, matchId);
    }

    /// Market hands the LP stake back and reports the outcome.
    function _settle(uint256 m, uint256 matchId, uint256 stake, bool upWon) internal {
        // A real market returns the LP's stake (plus the user's, on an LP win)
        // before reporting. Mint-and-transfer stands in for that flow.
        usdc.mint(address(markets[m]), upWon ? 0 : stake * 2);
        vm.prank(address(markets[m]));
        usdc.transfer(address(pool), upWon ? 0 : stake * 2);
        vm.prank(address(markets[m]));
        pool.onMatchSettled(matchId, upWon);
    }

    /**
     * Measured against ECONOMIC assets - what the pool holds plus what is out
     * on open matches - not against totalAssets(). totalAssets() is the pool's
     * USDC balance plus open exposure, because a match physically moves the
     * LP's stake to the market and the stake is not lost while it is out
     * there. totalAssets() now returns exactly that, so the caps are computed
     * against a denominator that does not move when a match opens. It used to
     * return the bare balance, and an invariant written against it reported a
     * breach the moment two matches were open - a property of the accounting
     * rather than a violation of the cap. See
     * test_SharePrice_HoldsWhileAMatchIsOpen.
     */
    function _assertInvariants() internal view {
        uint256 economic = pool.totalAssets();
        assertLe(pool.totalExposure(), (economic * 1_000) / 10_000 + 1, "global exposure cap breached");
        for (uint256 i = 0; i < 3; i++) {
            assertLe(
                pool.marketExposure(address(markets[i])),
                (economic * 500) / 10_000 + 1,
                "per-market exposure cap breached"
            );
        }
        assertTrue(pool.isFullyBacked(), "pool stopped being fully backed");
    }

    // ── the cap holds across markets, not just within one ──────────────

    /**
     * Three markets, each entitled to 5%, all matching in the same block. Their
     * individual caps sum to 15%; the global cap is 10%. The third must be
     * truncated to what is left rather than getting its own full slice.
     */
    function test_Race_ThreeMarketsSameBlock_ShareOneGlobalCap() public {
        uint256 a = _match(0, 1, MARKET_CAP);
        uint256 b = _match(1, 2, MARKET_CAP);
        uint256 c = _match(2, 3, MARKET_CAP);

        // Two markets get their full 5% each and the third gets nothing,
        // because two 5% slices are the whole 10% global cap.
        //
        // This used to read 5,000 / 4,500 / 0. The second slice was smaller
        // because the first match had moved 5,000 USDC out of the pool and
        // totalAssets() counted only what was left, so the denominator shrank
        // with every match in the block and the cap converged from below.
        // totalAssets() now counts an open stake as the asset it is, so the
        // cap means what it says: at most 10% of the pool's economic value is
        // at risk at once. The old margin was an accident of the accounting,
        // not a designed safety buffer.
        assertEq(a, MARKET_CAP, "first market gets its full slice");
        assertEq(b, MARKET_CAP, "so does the second");
        assertEq(c, 0, "third gets nothing, the cap is spent");

        // Exactly the nominal 10% of capital, never above it.
        assertEq(pool.totalExposure(), GLOBAL_CAP, "cap is reached, not breached");
        _assertInvariants();
    }

    /**
     * The truncation case specifically: a market asking for more than the
     * remaining global headroom gets the remainder, not a revert and not the
     * full amount. A revert here would be a denial of service on the last
     * bettor of a busy block; the full amount would be an over-committed pool.
     */
    function test_Race_LastMatchInBlockIsTruncatedNotReverted() public {
        _match(0, 1, MARKET_CAP); // 5% taken
        _match(1, 2, MARKET_CAP / 2); // 2.5% taken, 2.5% of global left

        uint256 headroom = pool.availableForMatching();
        uint256 got = _match(2, 3, MARKET_CAP); // asks for 5%, less remains

        assertEq(got, headroom, "should receive exactly the headroom the pool advertised");
        assertGt(got, 0, "a partial fill, not a refusal");
        assertLt(got, MARKET_CAP, "and not the full ask");
        assertEq(pool.availableForMatching(), 0, "headroom is now spent");
        _assertInvariants();
    }

    /**
     * Twelve matches interleaved across three markets in one block. Nothing
     * here should be able to walk exposure past the cap, and every intermediate
     * state has to satisfy the invariants too - not just the end state.
     */
    function test_Race_ManyInterleavedMatches_NeverBreachCaps() public {
        for (uint256 i = 0; i < 12; i++) {
            _match(i % 3, i + 1, MARKET_CAP / 3);
            _assertInvariants();
        }
        assertLe(pool.totalExposure(), GLOBAL_CAP);
    }

    // ── withdrawals racing matches ─────────────────────────────────────

    /**
     * An LP pulling out between two matches must not be able to strand the
     * pool: the capital backing an open match cannot leave, and the second
     * match must be sized against what is genuinely still there.
     */
    function test_Race_WithdrawBetweenMatches_CannotStrandOpenExposure() public {
        address whale = makeAddr("whale");

        uint256 first = _match(0, 1, MARKET_CAP);
        assertGt(first, 0);

        uint256 maxOut = pool.maxWithdraw(whale);
        vm.prank(whale);
        pool.withdraw(maxOut, whale, whale);

        // The pool cannot be made insolvent by this: the matched stake already
        // left for the market, which holds both sides and pays the winner
        // directly. Nothing further is owed out of the pool's balance.
        assertTrue(pool.isFullyBacked(), "pool stopped being fully backed");

        // What the withdrawal DOES do is concentrate the open match onto
        // whoever is left: exposure is now the whole remaining balance.
        assertEq(pool.totalExposure(), usdc.balanceOf(address(pool)), "remaining LPs now carry the whole match");

        // And the settlement itself must go through.
        _settle(0, 1, first, true);
        assertEq(pool.totalExposure(), 0, "exposure should unwind to zero");
    }

    /**
     * A withdraw shrinks totalAssets, which shrinks the caps. Exposure already
     * locked at the old, larger cap must not be treated as new headroom.
     */
    function test_Race_WithdrawShrinksCap_NoNewHeadroomAppears() public {
        _match(0, 1, MARKET_CAP);
        uint256 availableBefore = pool.availableForMatching();

        address whale = makeAddr("whale");
        // maxWithdraw() is read BEFORE the prank on purpose: an argument
        // expression is evaluated first and would otherwise consume it.
        uint256 half = pool.maxWithdraw(whale) / 2;
        vm.prank(whale);
        pool.withdraw(half, whale, whale);

        assertLe(pool.availableForMatching(), availableBefore, "withdrawing must not create headroom");

        // Note what is deliberately NOT asserted here: the caps. A cap binds at
        // match time, and nothing can retroactively unwind a match that is
        // already open, so a large withdrawal leaves the existing 5,000 match
        // sitting above 5% of what remains. The pool stays solvent - the stake
        // is already with the market, which holds both sides - but the
        // concentration is real and belongs to whoever stayed.
        // Note what is deliberately not asserted: the caps. A cap binds at
        // match time and nothing can retroactively unwind an open match, so a
        // large enough withdrawal leaves existing exposure above the nominal
        // percentage of what remains (test_Race_WithdrawBetweenMatches shows
        // the extreme: 100% of the residual balance). The pool stays solvent -
        // the stake is already with the market, which holds both sides - but
        // the concentration lands on whoever stayed.
        assertTrue(pool.isFullyBacked(), "pool stopped being fully backed");
    }

    // ── deposits racing matches ────────────────────────────────────────

    /**
     * A deposit landing mid-block raises totalAssets and therefore the caps.
     * That is intended - new capital genuinely can back new exposure - but the
     * increase must be bounded by the new totalAssets and nothing already
     * locked may be double-counted as available.
     */
    function test_Race_DepositBetweenMatches_RaisesCapButStaysBounded() public {
        _match(0, 1, MARKET_CAP);
        _match(1, 2, MARKET_CAP);
        assertEq(pool.availableForMatching(), 0, "global cap should be spent");

        _addLP("latecomer", LP_CAPITAL);

        uint256 ta = pool.totalAssets();
        assertLe(pool.availableForMatching(), (ta * 1_000) / 10_000 - pool.totalExposure() + 1);

        uint256 got = _match(2, 3, MARKET_CAP);
        assertGt(got, 0, "fresh capital should open real headroom");
        _assertInvariants();
    }

    // ── settlement idempotency ─────────────────────────────────────────

    /**
     * The keeper retries. A settle that lands twice for the same match must not
     * unlock the exposure twice, or the pool would report headroom it does not
     * have and over-commit the next bettor.
     */
    function test_Race_DoubleSettleSameMatch_Reverts() public {
        uint256 stake = _match(0, 1, MARKET_CAP);
        _settle(0, 1, stake, true);
        assertEq(pool.totalExposure(), 0);

        vm.prank(address(markets[0]));
        vm.expectRevert("already settled");
        pool.onMatchSettled(1, true);

        assertEq(pool.totalExposure(), 0, "exposure must not go negative or wrap");
    }

    /**
     * The other half of the same problem: the refund path and the settle path
     * both unlock exposure, and a market that managed to call one after the
     * other would unlock it twice.
     */
    function test_Race_RefundAfterSettle_Reverts() public {
        uint256 stake = _match(0, 1, MARKET_CAP);
        _settle(0, 1, stake, true);

        vm.prank(address(markets[0]));
        vm.expectRevert("already settled");
        pool.onMatchRefunded(1);

        assertEq(pool.totalExposure(), 0);
    }

    /**
     * Full round trip under interleaving: matches taken across three markets in
     * one block, then all settled. Exposure has to return to exactly zero - a
     * residue would silently shrink the pool's capacity forever.
     */
    function test_Race_AllMatchesSettle_ExposureReturnsToZero() public {
        uint256[3] memory stakes;
        for (uint256 i = 0; i < 3; i++) {
            stakes[i] = _match(i, i + 1, MARKET_CAP / 2);
        }

        for (uint256 i = 0; i < 3; i++) {
            _settle(i, i + 1, stakes[i], i % 2 == 0);
            _assertInvariants();
        }

        assertEq(pool.totalExposure(), 0, "exposure left over after everything settled");
        for (uint256 i = 0; i < 3; i++) {
            assertEq(pool.marketExposure(address(markets[i])), 0, "per-market exposure left over");
        }
    }

    // ── what the interleaving exposed: open matches were marked at zero ──

    /**
     * tryMatch physically transfers the LP's stake to the market, so the pool's
     * USDC balance drops the instant a match opens. totalAssets() adds
     * totalExposure back, so the share price does not move: the stake is out of
     * the balance but not lost, and a bet paying twice the stake or nothing is
     * worth the stake in expectation.
     *
     * It used to move, by the full stake - a 5% match knocked 5% off the share
     * price of a 100k pool and put it back on settlement. That is what made
     * four of the tests above fail on their first, naive expectations, and the
     * two tests below are what it cost in money.
     */
    function test_SharePrice_HoldsWhileAMatchIsOpen() public {
        uint256 before = pool.convertToAssets(1e18);

        uint256 stake = _match(0, 1, MARKET_CAP);

        assertEq(pool.convertToAssets(1e18), before, "an open match is not a loss");
        assertEq(pool.totalExposure(), stake, "even though the cash has left");

        _settle(0, 1, stake, false); // LP wins
        assertGt(pool.convertToAssets(1e18), before, "the win is what moves it");
    }

    /**
     * The consequence, stated as money, and the regression this guards.
     *
     * While an open match was marked at zero, anyone depositing during one
     * bought shares at a price that already assumed the match was lost. If it
     * was lost they got their deposit back untouched; if it was won they took a
     * cut of a gain they had paid nothing for. Downside zero, upside positive,
     * no lock-up, no exit fee - a free option on the pool's open positions,
     * paid for by the LPs who were already in.
     *
     * Now both legs move. A depositor who arrives during a match shares the
     * loss as well as the win, which is the definition of having bought in at a
     * fair price rather than a discount.
     */
    function test_DepositDuringOpenMatch_IsAFairBetNotAFreeOption() public {
        uint256 stake = _match(0, 1, MARKET_CAP);

        // Snapshot, take the LP-loss branch, measure.
        uint256 snap = vm.snapshotState();

        address a = _addLP("opportunist", LP_CAPITAL);
        _settle(0, 1, stake, true); // upWon == true -> LP lost
        uint256 onLoss = pool.maxWithdraw(a);

        vm.revertToState(snap);

        address b = _addLP("opportunist", LP_CAPITAL);
        _settle(0, 1, stake, false); // LP won
        uint256 onWin = pool.maxWithdraw(b);

        assertLt(onLoss, LP_CAPITAL, "the downside leg now costs the depositor too");
        assertGt(onWin, LP_CAPITAL, "and the upside leg still pays");

        // Symmetric to within the 1% fee carved out of an LP win.
        assertApproxEqRel(LP_CAPITAL - onLoss, onWin - LP_CAPITAL, 0.02e18, "a fair bet, not an option");
        emit log_named_decimal_uint("downside taken, USDC", LP_CAPITAL - onLoss, 6);
        emit log_named_decimal_uint("upside taken,   USDC", onWin - LP_CAPITAL, 6);
    }

    /**
     * The half of the timing problem that survived the first fix, and the test
     * that decides whether it is actually gone.
     *
     * Counting an open match at its stake is honest in expectation and stops
     * being honest once the underlying moves: near settlement the outcome can
     * be all but decided while the mark still says "cost". An LP who can see a
     * bet going against the pool would then withdraw at that unmoved mark and
     * leave the loss with whoever stayed.
     *
     * A withdrawal is now priced against cash only, so the leaver takes their
     * share of the money and leaves their share of the open bets behind. The
     * property that closes the game is this one: when the pool goes on to lose,
     * leaving first pays exactly what staying would have paid. There is nothing
     * to gain by timing it, so there is nothing to time.
     */
    function test_ExitingBeforeALoss_GainsNothingOverStaying() public {
        address stayer = _addLP("stayer", LP_CAPITAL);
        address leaver = makeAddr("whale"); // the setUp LP, same size
        uint256 stake = _match(0, 1, MARKET_CAP);

        uint256 snap = vm.snapshotState();

        // Branch 1: the leaver sees the loss coming and gets out first.
        uint256 out = pool.maxWithdraw(leaver);
        vm.prank(leaver);
        pool.withdraw(out, leaver, leaver);
        _settle(0, 1, stake, true); // upWon -> LP side lost
        uint256 dodged = out + pool.maxWithdraw(leaver);

        vm.revertToState(snap);

        // Branch 2: the same LP sits through it.
        _settle(0, 1, stake, true);
        uint256 stayed = pool.maxWithdraw(leaver);

        assertLe(dodged, stayed, "leaving early must not beat sitting through the loss");
        emit log_named_decimal_uint("dodged, USDC", dodged, 6);
        emit log_named_decimal_uint("stayed, USDC", stayed, 6);

        // And the LP who stayed put is not made to carry it alone.
        assertGt(pool.maxWithdraw(stayer), 0);
    }

    /**
     * The rule has to be stable in the other direction too, or it is just a new
     * edge wearing different clothes: deposits price against totalAssets()
     * (which counts open exposure) while withdrawals price against cash. Going
     * in and straight back out during a match therefore costs money rather than
     * making it, which is what stops the pair of rules from being gameable.
     */
    function test_DepositAndImmediateExitDuringOpenMatch_IsALoss() public {
        _match(0, 1, MARKET_CAP);

        address tourist = _addLP("tourist", LP_CAPITAL);
        uint256 back = pool.maxWithdraw(tourist);

        assertLt(back, LP_CAPITAL, "a round trip through an open match is not free");
    }

    /**
     * The mirror image, and the reason this matters for LPs who behave
     * normally: leaving while a match is open forfeits the win. Two LPs who
     * deposited the same amount on the same day end up with different money
     * purely on the timing of the exit - which is now the intended rule rather
     * than a defect, because it is the same rule that removes the incentive to
     * time an exit at all.
     */
    function test_ExitingDuringOpenMatchForfeitsTheOutcome() public {
        address stayer = _addLP("stayer", LP_CAPITAL);
        uint256 stake = _match(0, 1, MARKET_CAP);

        address leaver = makeAddr("whale"); // the setUp LP, same size as stayer
        uint256 out = pool.maxWithdraw(leaver);
        vm.prank(leaver);
        pool.withdraw(out, leaver, leaver);

        _settle(0, 1, stake, false); // LP won

        uint256 stayerEnd = pool.maxWithdraw(stayer);
        assertGt(stayerEnd, out, "the LP who stayed collects the whole outcome");
        emit log_named_decimal_uint("gap between identical LPs, USDC", stayerEnd - out, 6);
    }

    // ── pause racing a match ───────────────────────────────────────────

    /**
     * Pausing must stop new exposure without trapping what is already open -
     * otherwise the emergency switch becomes the emergency.
     */
    function test_Race_PauseBetweenMatchAndSettle_StillSettles() public {
        uint256 stake = _match(0, 1, MARKET_CAP);

        pool.pause();

        vm.prank(address(markets[1]));
        assertEq(pool.tryMatch(2, MARKET_CAP, true, 2), 0, "a paused pool takes no new exposure");

        _settle(0, 1, stake, true);
        assertEq(pool.totalExposure(), 0, "a paused pool must still be able to settle");
    }

    /**
     * Declining, not reverting - because the caller is placeBet.
     *
     * tryMatch used to carry whenNotPaused, and OrderbookMarket calls it with
     * no try/catch, in the middle of placeBet and before the remainder is
     * queued. So pausing the pool did not merely stop the pool taking the other
     * side: it reverted every bet that was not filled outright by the opposite
     * queue, including plain maker orders on an empty book, which could no
     * longer even be placed. An emergency switch on the pool quietly became an
     * emergency switch on the whole product - the opposite of what the pool's
     * own documentation promises, and of what a pause is for.
     *
     * A pool with nothing to offer already returns 0 and lets the order rest;
     * a paused pool is the same answer for a different reason.
     */
    function test_Race_PausedPool_DeclinesInsteadOfBrickingPlaceBet() public {
        pool.pause();

        vm.prank(address(markets[0]));
        uint256 matched = pool.tryMatch(1, MARKET_CAP, true, 1);

        assertEq(matched, 0, "a paused pool must decline rather than revert");
        assertEq(pool.totalExposure(), 0, "and must take on no exposure doing it");
    }
}
