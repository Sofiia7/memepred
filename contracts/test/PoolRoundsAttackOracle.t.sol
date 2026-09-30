// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoolRoundTestBase.sol";

/**
 * Кольцо наблюдений Uniswap v3, воспроизведённое там, где существующий
 * MockUniswapV3Pool этого не делает: конечная кардинальность, вытеснение
 * старых записей, 'OLD' для точки старше самой старой записи, экстраполяция
 * текущим тиком после последней записи и интерполяция между записями (тик
 * между записями постоянен). poke() = любая транзакция, которая пишет
 * наблюдение (своп со сменой тика, mint/burn в диапазоне).
 */
contract RingPool is IUniswapV3Pool {
    struct Obs {
        uint32 ts;
        int56 cum;
        uint160 spl; // secondsPerLiquidityCumulativeX128, as in the Uniswap Oracle
        bool init;
    }

    Obs[] internal ring;
    uint16 internal idx;
    uint16 internal card;
    int24 public currentTick;
    address public override token0;
    address public override token1;
    uint24 public override fee;
    uint128 internal liq = 1e18;
    uint256 public writes;

    constructor(address t0, address t1, uint24 f, uint16 cardinality_, uint32 firstTs, int24 tick0) {
        token0 = t0;
        token1 = t1;
        fee = f;
        card = cardinality_;
        currentTick = tick0;
        for (uint256 i = 0; i < cardinality_; i++) {
            ring.push(Obs(0, 0, 0, false));
        }
        ring[0] = Obs(firstTs, 0, 0, true);
    }

    function _splDelta(uint32 dt) internal view returns (uint160) {
        return uint160((uint256(dt) << 128) / (liq > 0 ? liq : 1));
    }

    function poke() public {
        Obs storage last = ring[idx];
        uint32 nowTs = uint32(block.timestamp);
        if (last.ts == nowTs) return;
        uint32 dt = nowTs - last.ts;
        int56 cum = last.cum + int56(currentTick) * int56(uint56(dt));
        uint160 spl = last.spl + _splDelta(dt); // no wrap at test values
        idx = uint16((uint256(idx) + 1) % card);
        ring[idx] = Obs(nowTs, cum, spl, true);
        writes++;
    }

    function swapTo(int24 tick) external {
        poke();
        currentTick = tick;
    }

    /// A change of in-range liquidity writes an observation first, as a mint or
    /// burn in range does on Uniswap, so the past keeps the old liquidity.
    function setLiquidity(uint128 l) external {
        poke();
        liq = l;
    }

    function oldestTs() external view returns (uint32) {
        Obs memory oldest = ring[(uint256(idx) + 1) % card];
        if (!oldest.init) oldest = ring[0];
        return oldest.ts;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        override
        returns (int56[] memory c, uint160[] memory s)
    {
        c = new int56[](secondsAgos.length);
        s = new uint160[](secondsAgos.length);
        uint32 nowTs = uint32(block.timestamp);
        Obs memory last = ring[idx];
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            uint32 target = nowTs - secondsAgos[i];
            if (target >= last.ts) {
                c[i] = last.cum + int56(currentTick) * int56(uint56(target - last.ts));
                s[i] = last.spl + _splDelta(target - last.ts);
                continue;
            }
            Obs memory oldest = ring[(uint256(idx) + 1) % card];
            if (!oldest.init) oldest = ring[0];
            require(oldest.ts <= target, "OLD");
            (int56 cb, uint160 sb) = _between(target);
            c[i] = cb;
            s[i] = sb;
        }
    }

    function _between(uint32 target) internal view returns (int56, uint160) {
        Obs memory before;
        Obs memory after_;
        bool haveA;
        for (uint256 j = 0; j < card; j++) {
            Obs memory o = ring[j];
            if (!o.init) continue;
            if (o.ts <= target && o.ts >= before.ts) before = o;
            if (o.ts > target && (!haveA || o.ts < after_.ts)) {
                after_ = o;
                haveA = true;
            }
        }
        if (before.ts == target || !haveA) return (before.cum, before.spl);
        uint32 span = after_.ts - before.ts;
        uint32 part = target - before.ts;
        int56 tickBetween = (after_.cum - before.cum) / int56(uint56(span));
        uint160 spl = before.spl + uint160(uint256(after_.spl - before.spl) * part / span);
        return (before.cum + tickBetween * int56(uint56(part)), spl);
    }

    function slot0() external view override returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (TickMath.getSqrtRatioAtTick(currentTick), currentTick, idx, card, card, 0, true);
    }

    function liquidity() external view override returns (uint128) {
        return liq;
    }

    function increaseObservationCardinalityNext(uint16) external override {}
}

    /**
     * Аудит PoolRounds (docs/rhc/ROUNDS-AUDIT.md), часть 4: оракул, страйк, кольцо.
     * Приведено к интерфейсу v3 и к гейту пулов: пул с кольцом меньше minCardinality
     * (900 при окне страйка 300 с, после повторного аудита V3-7) или глубиной меньше
     * gateDepth (50 WETH) не листится, поэтому все кольца здесь проходят гейт, и атака
     * L1 проверяется против пула, который реально можно допустить.
     */
    contract PoolRoundsAttackOracleTest is PoolRoundTestBase {
        address alice = _player(1);
        address bob = _player(2);

        uint256 internal ringNonce;

        function _ringPoolUnlisted(uint16 cardinality, int24 tick0) internal returns (RingPool p) {
            address token = address(uint160(uint256(keccak256(abi.encode("ring-token", ringNonce++)))));
            p = new RingPool(token, address(weth), FEE_TIER, cardinality, uint32(block.timestamp - 7200), tick0);
            p.setLiquidity(POOL_LIQUIDITY);
            v3.register(token, address(weth), FEE_TIER, address(p));
        }

        function _ringPool(uint16 cardinality, int24 tick0) internal returns (RingPool p) {
            p = _ringPoolUnlisted(cardinality, tick0);
            rounds.listPool(address(p));
        }

        function _round(address p) internal returns (uint256 id) {
            id = _nextRound(PoolRoundMockPool(p), T);
            _bet(id, alice, 0.05 ether, _up(), address(0));
            _bet(id, bob, 0.05 ether, _down(), address(0));
        }

        /// Пишет наблюдение в каждую секунду отрезка [from, to] включительно.
        function _pokeEverySecond(RingPool p, uint256 from, uint256 to) internal {
            for (uint256 t = from; t <= to; t++) {
                vm.warp(t);
                p.poke();
            }
        }

        function _outcome(uint256 id) internal view returns (PoolRounds.Outcome) {
            return rounds.roundView(id).outcome;
        }

        // ════════════════════════════════════════════════════════════
        //  1. M2 закрыт: listPool с гейтами глубины и кольца
        // ════════════════════════════════════════════════════════════

        /// Раньше пул с кольцом 1 и 1 wei ликвидности листился. Теперь нет: ни
        /// кольцо 1, ни 300 (порог PoolMarketFactory), ни 420 (прежний порог v3),
        /// ни 1 wei глубины. Кольцо 900 и глубина с запасом допускаются.
        function test_M2_ListPool_RefusesSmallRingAndThinPool() public {
            uint16[3] memory small = [uint16(1), 300, 420];
            for (uint256 i = 0; i < 3; i++) {
                RingPool r = _ringPoolUnlisted(small[i], 0);
                vm.expectRevert(abi.encodeWithSelector(PoolRounds.CardinalityTooLow.selector, small[i], 900));
                rounds.listPool(address(r));
            }
            RingPool thin = _ringPoolUnlisted(900, 0);
            thin.setLiquidity(1);
            vm.expectRevert(abi.encodeWithSelector(PoolRounds.PoolTooThin.selector, 1));
            rounds.listPool(address(thin));

            thin.setLiquidity(POOL_LIQUIDITY);
            rounds.listPool(address(thin));
            (bool listed,) = rounds.pools(address(thin));
            assertTrue(listed);
        }

        // ════════════════════════════════════════════════════════════
        //  2. L1: принудительный REFUND стиранием окна из кольца
        // ════════════════════════════════════════════════════════════

        /// Наблюдение пишется не чаще раза в секунду, поэтому кольцо из 900 записей
        /// при записи каждую секунду помнит последние 899 с. Окно страйка 300 с,
        /// значит атакующий, пишущий каждую секунду, не может его стереть раньше
        /// strikeEnd + 600: fixStrike до keeperDeadlines().fixStrikeBy = strikeEnd + 599
        /// всегда успевает. Кипер, опоздавший дольше, отдаёт раунд в REFUND.
        function test_L1_TimelyFixStrike_SurvivesAnObservationEverySecond() public {
            RingPool pa = _ringPool(900, 0);
            uint256 a = _round(address(pa));
            PoolRounds.Times memory ta = _times(a);
            (uint256 fixBy,) = rounds.keeperDeadlines(a);
            assertEq(fixBy, ta.strikeEnd + 599);
            _pokeEverySecond(pa, ta.closeAt, fixBy);
            rounds.fixStrike(a);
            assertTrue(rounds.roundView(a).strikeFixed, "fixStrike 599 s late still reads the whole window");
            _pokeEverySecond(pa, fixBy + 1, ta.settleAt);
            rounds.settle(a);
            assertEq(uint8(_outcome(a)), uint8(PoolRounds.Outcome.TIE), "priced, no refund");

            RingPool pb = _ringPool(900, 0);
            uint256 b = _round(address(pb));
            PoolRounds.Times memory tb = _times(b);
            _pokeEverySecond(pb, tb.closeAt, tb.strikeEnd + 600);
            rounds.fixStrike(b);
            assertEq(uint8(_outcome(b)), uint8(PoolRounds.Outcome.REFUND), "a keeper late past the deadline loses it");
        }

        /// Без fixStrike settle читает окно страйка сам, а от settleAt до strikeStart
        /// 600 с. Кольцо 900 при записи каждую секунду помнит 899 с, поэтому settle,
        /// опоздавший больше чем на 299 с, окно страйка уже потерял: fixStrike для
        /// кипера обязателен, а не оптимизация.
        function test_L1_WithoutFixStrike_ABusyRingLosesTheStrikeWindow() public {
            RingPool p = _ringPool(900, 0);
            uint256 id = _round(address(p));
            PoolRounds.Times memory tm = _times(id);
            vm.recordLogs();
            _pokeEverySecond(p, tm.closeAt, tm.settleAt + 300);
            rounds.settle(id);
            assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND));
            (,,,,,, uint8 reason) = _lastSettled();
            assertEq(reason, rounds.REASON_HISTORY());
        }

        /// Окно выхода (60 с при T = 300) при кольце 900 и записи каждую секунду
        /// стирается, только если settle опоздал больше keeperDeadlines().settleBy =
        /// settleAt + 839.
        function test_L1_ExitWindow_SurvivesUntilTheDeadline() public {
            RingPool pa = _ringPool(900, 0);
            uint256 a = _round(address(pa));
            PoolRounds.Times memory ta = _times(a);
            (, uint256 settleBy) = rounds.keeperDeadlines(a);
            assertEq(settleBy, ta.settleAt + 839);
            vm.warp(ta.strikeEnd);
            rounds.fixStrike(a);
            _pokeEverySecond(pa, ta.strikeEnd + 1, settleBy);
            rounds.settle(a);
            assertEq(uint8(_outcome(a)), uint8(PoolRounds.Outcome.TIE), "839 s late: still priced");

            RingPool pb = _ringPool(900, 0);
            uint256 b = _round(address(pb));
            PoolRounds.Times memory tb = _times(b);
            vm.warp(tb.strikeEnd);
            rounds.fixStrike(b);
            _pokeEverySecond(pb, tb.strikeEnd + 1, tb.settleAt + 840);
            rounds.settle(b);
            assertEq(uint8(_outcome(b)), uint8(PoolRounds.Outcome.REFUND), "840 s late: the exit window is gone");
            assertEq(_claim(b, alice), 0.0495 ether, "each side back minus the 1% void fee");
            assertEq(_claim(b, bob), 0.0495 ether);
        }

        // ════════════════════════════════════════════════════════════
        //  3. Тонкий пул: наблюдения редки, интерполяция берёт старый тик
        // ════════════════════════════════════════════════════════════

        /// На пуле без свопов в окне выхода observe даёт тик последней записи:
        /// цена «замерзает» на последнем свопе. Раунд всё равно считается (не
        /// зависает): либо ценой замороженного тика, либо REFUND, если окно потеряно.
        function test_ThinPool_NoSwapsInWindow_StillDecides() public {
            RingPool p = _ringPool(900, 500);
            uint256 id = _round(address(p));
            PoolRounds.Times memory tm = _times(id);
            vm.warp(tm.strikeStart);
            p.swapTo(1000); // один своп в начале окна страйка, дальше тишина
            vm.warp(tm.settleAt);
            rounds.settle(id);
            PoolRounds.Outcome o = _outcome(id);
            assertTrue(o != PoolRounds.Outcome.NONE, "a silent pool never leaves the round unsettled");
        }

        /// Re-audit V3-2 на кольце: единственный LP снимает ликвидность до окна
        /// страйка. Кольцо окно помнит, но глубина окна (средняя по
        /// secondsPerLiquidity) ноль: раунд сразу возвращается (REASON_THIN), без
        /// суток блокировки. Снявший после окон ничего не блокирует.
        function test_V3_2_LiquidityPulledBeforeTheWindow_RefundsAtOnce_AfterDoesNothing() public {
            RingPool pa = _ringPool(900, 0);
            uint256 a = _round(address(pa));
            vm.warp(_times(a).closeAt + 10);
            pa.setLiquidity(0);
            vm.warp(_times(a).strikeEnd);
            vm.recordLogs();
            rounds.fixStrike(a);
            assertEq(uint8(_outcome(a)), uint8(PoolRounds.Outcome.REFUND));
            (,,,,,, uint8 reason) = _lastSettled();
            assertEq(reason, rounds.REASON_THIN());
            assertEq(_claim(a, alice), 0.0495 ether, "claimable at once");

            RingPool pb = _ringPool(900, 0);
            uint256 b = _round(address(pb));
            vm.warp(_times(b).strikeEnd);
            rounds.fixStrike(b);
            vm.warp(_times(b).settleAt + 1);
            pb.setLiquidity(0); // pulled after both windows
            rounds.settle(b);
            assertEq(uint8(_outcome(b)), uint8(PoolRounds.Outcome.TIE), "priced from windows that had liquidity");
        }

        // Достаёт поля последнего RoundSettled из логов.
        function _lastSettled()
            internal
            view
            returns (PoolRounds.Outcome, uint256, uint256, uint256, uint256, uint256, uint8)
        {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i = logs.length; i > 0; i--) {
                Vm.Log memory l = logs[i - 1];
                if (
                    l.topics[0]
                        == keccak256("RoundSettled(uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256)")
                ) {
                    (uint8 outcome, uint8 reason,,,,,) =
                        abi.decode(l.data, (uint8, uint8, uint256, uint256, uint256, uint256, uint256));
                    return (PoolRounds.Outcome(outcome), 0, 0, 0, 0, 0, reason);
                }
            }
            revert("no RoundSettled");
        }
    }
