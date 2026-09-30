// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoolRoundTestBase.sol";

/**
 * Аудит PoolRounds (docs/rhc/ROUNDS-AUDIT.md), часть 3: расчёт, оракул, сроки,
 * независимость раундов, крайние входы против эталона. Приведено к интерфейсу v3
 * (ставка видимая, пауза и окно страйка по 300 с, кап из конструктора).
 */
contract PoolRoundsAttackSettleTest is PoolRoundTestBase {
    address alice = _player(1);
    address bob = _player(2);
    address carol = _player(3);

    function _balanced(PoolRoundMockPool p, uint256 dur) internal returns (uint256 id) {
        uint256 next = (block.timestamp / dur + 1) * dur;
        vm.warp(next);
        id = rounds.roundIdOf(address(p), dur, next / dur);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
    }

    // ════════════════════════════════════════════════════════════
    //  1. Один застрявший раунд не блокирует другой
    // ════════════════════════════════════════════════════════════

    /// Раунд A навсегда непрайсируем (пул отвечает не-OLD ошибкой), раунд B того
    /// же пула считается нормально. settle(A) откатывается, settle(B) проходит:
    /// у каждого раунда свой roundId, цикла и общей очереди нет. Это устраняет
    /// проблему head-of-line из аудита OrderbookMarket (audit-2026-09-28, P1).
    function test_StuckRound_DoesNotBlockAnotherRoundOfTheSamePool() public {
        uint256 a = _balanced(pool, T);
        _exitTick(pool, a, 100);
        uint256 b = _balanced(pool, T); // следующее окно того же пула
        _exitTick(pool, b, 300); // выше входа (вход ~100 от раунда A) -> UP

        _warpSettle(a);
        pool.setForceOtherRevert(1); // непрайсируем прямо сейчас
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PriceUnavailableNow.selector, a));
        rounds.settle(a);

        // B считается несмотря на застрявший A.
        _warpSettle(b);
        pool.setForceOtherRevert(0);
        rounds.settle(b);
        assertEq(uint8(rounds.roundView(b).outcome), uint8(PoolRounds.Outcome.UP));
        assertEq(_claim(b, alice), 0.098 ether);

        // A по-прежнему решается своим путём: после отсрочки - REFUND любым адресом.
        vm.warp(_times(a).settleAt + rounds.SETTLE_GRACE());
        vm.prank(carol);
        rounds.settle(a);
        assertEq(uint8(rounds.roundView(a).outcome), uint8(PoolRounds.Outcome.REFUND));
    }

    /// roundId = pool<<96 | duration<<64 | index. Соседние окна и разные
    /// длительности одного пула - разные слоты хранения, ставка в один не
    /// видна в другом.
    function test_RoundId_NoCollisionBetweenAdjacentWindowsAndDurations() public {
        uint256 k = block.timestamp / T + 3; // a window ahead: the pool's liquidity history starts at setUp
        uint256 id300a = rounds.roundIdOf(address(pool), 300, k);
        uint256 id300b = rounds.roundIdOf(address(pool), 300, k + 1);
        uint256 id900 = rounds.roundIdOf(address(pool), 900, k);
        assertTrue(id300a != id300b && id300a != id900 && id300b != id900);
        vm.warp(300 * k);
        _bet(id300a, alice, 0.05 ether, _up(), address(0));
        assertEq(rounds.roundView(id300a).committed, 0.05 ether);
        assertEq(rounds.roundView(id300b).committed, 0, "next window untouched");
        assertEq(rounds.roundView(id900).committed, 0, "other duration untouched");
    }

    // ════════════════════════════════════════════════════════════
    //  2. Границы времени (последняя/первая секунда каждого окна)
    // ════════════════════════════════════════════════════════════

    /// settle: за секунду до settleAt - NotDue и пул не читается; ровно в
    /// settleAt - считается. fixStrike: за секунду до strikeEnd - NotDue;
    /// ровно в strikeEnd - фиксирует.
    function test_Timing_SettleAndFixStrike_BoundariesAreInclusiveAtDue() public {
        uint256 id = _balanced(pool, T);
        _exitTick(pool, id, 100);

        vm.warp(_times(id).strikeEnd - 1);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotDue.selector, id));
        rounds.fixStrike(id);
        vm.warp(_times(id).strikeEnd);
        rounds.fixStrike(id);
        assertTrue(rounds.roundView(id).strikeFixed);

        vm.warp(_times(id).settleAt - 1);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotDue.selector, id));
        rounds.settle(id);
        vm.warp(_times(id).settleAt);
        rounds.settle(id);
        assertEq(uint8(rounds.roundView(id).outcome), uint8(PoolRounds.Outcome.UP));
    }

    /// Отсрочка: ровно в settleAt + SETTLE_GRACE непрайсируемый раунд уходит в
    /// REFUND без чтения пула; за секунду до - ещё пробует читать (и здесь
    /// откатывается, потому что пул мёртв).
    function test_Timing_GraceBoundaryIsInclusive() public {
        uint256 id = _balanced(pool, T);
        vm.warp(_times(id).settleAt + rounds.SETTLE_GRACE() - 1);
        pool.setForceOtherRevert(1);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PriceUnavailableNow.selector, id));
        rounds.settle(id);
        vm.warp(_times(id).settleAt + rounds.SETTLE_GRACE());
        rounds.settle(id);
        assertEq(uint8(rounds.roundView(id).outcome), uint8(PoolRounds.Outcome.REFUND));
    }

    /// Ставка ровно в openAt (первая секунда окна) принимается; неактивированный
    /// раунд можно забрать ровно в closeAt, секундой раньше - нет.
    function test_Timing_BetAtOpenAt_RefundAtCloseAt() public {
        uint256 k = block.timestamp / T + 1;
        uint256 id = rounds.roundIdOf(address(pool), T, k);
        vm.warp(k * T); // ровно openAt
        _bet(id, alice, 0.05 ether, _up(), address(0));
        assertEq(rounds.roundView(id).committed, 0.05 ether);
        vm.warp(_times(id).closeAt - 1);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotSettled.selector, id));
        vm.prank(alice);
        rounds.claim(id);
        vm.warp(_times(id).closeAt);
        assertEq(_claim(id, alice), 0.05 ether);
    }

    // ════════════════════════════════════════════════════════════
    //  3. Оракул: страйк без гарда, спред только на выходе (L2)
    // ════════════════════════════════════════════════════════════

    /// Окно страйка не имеет гарда спреда: игла внутри [strikeStart, strikeEnd]
    /// сдвигает вход, и это меняет исход. Известное ограничение (L2): гард не
    /// поставлен, потому что добавил бы возвраты, которых нет в модели. Окно
    /// теперь 300 с вместо 60: игла на 20 000 тиков на половину окна двигает
    /// вход так же, но держать её нужно 150 с, а не 30.
    function test_Oracle_StrikeWindowHasNoSpreadGuard_EntryIsMovable() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
        PoolRounds.Times memory tm = _times(id);
        pool.pushTick(uint32(tm.strikeStart), 0);
        pool.pushTick(uint32(tm.strikeStart + 150), 20000); // игла на половину окна страйка
        _exitTick(pool, id, 0); // тик 0 с strikeEnd и на всё окно выхода
        vm.warp(tm.strikeEnd);
        rounds.fixStrike(id);
        // Средний тик входа = (0 x 150 + 20000 x 150)/300 = 10000, а не спот 0.
        assertEq(rounds.roundView(id).entryTick, 10000, "entry moved by an in-window spike, no guard");
        _warpSettle(id);
        rounds.settle(id);
        assertEq(uint8(rounds.roundView(id).outcome), uint8(PoolRounds.Outcome.DOWN), "the spike decided the round");
    }

    /// Та же игла, но 30 с, как хватало при окне 60 с: сдвиг входа в 5 раз меньше.
    function test_Oracle_StrikeWindow300s_ShortSpikeMovesEntryFiveTimesLess() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
        PoolRounds.Times memory tm = _times(id);
        pool.pushTick(uint32(tm.strikeStart), 0);
        pool.pushTick(uint32(tm.strikeEnd - 30), 20000);
        _exitTick(pool, id, 0);
        vm.warp(tm.strikeEnd);
        rounds.fixStrike(id);
        assertEq(rounds.roundView(id).entryTick, 2000, "20000 x 30 / 300");
    }

    /// Принудительный REFUND через спред-гард выхода: поздний толчок в хвост
    /// окна выхода уводит anchor от среднего больше чем на 2% -> REFUND с
    /// комиссией 1% для всех. Считаем потерю игроков.
    function test_Oracle_ForcedRefundViaSpread_CostsPlayersOnePercent() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.5 ether, _up(), address(0));
        _bet(id, bob, 0.5 ether, _down(), address(0));
        uint256 settleAt = _times(id).settleAt;
        // Толчок на 1000 тиков в последние 10 с окна выхода (anchor - последняя
        // треть 60-секундного окна): среднее выхода ~166, anchor ~500 -> спред > 2%.
        pool.pushTick(uint32(settleAt - 10), 1000);
        _warpSettle(id);
        rounds.settle(id);
        assertEq(uint8(rounds.roundView(id).outcome), uint8(PoolRounds.Outcome.REFUND));
        assertEq(_claim(id, alice), 0.495 ether);
        assertEq(_claim(id, bob), 0.495 ether);
        assertEq(rounds.feesAccrued(), 0.01 ether, "1% of the 1 ETH bank booked to the project");
    }

    // ════════════════════════════════════════════════════════════
    //  4. Крайние входы против эталона
    // ════════════════════════════════════════════════════════════

    /// Дифференциальный фазз на очень перекошенных книгах, 1-wei хвостах, многих
    /// билетах одной стороны, всех исходах, при капе 1 и 4. Сверяет каждую
    /// выплату, банк и долю проекта с независимым переносом эталона.
    function testFuzz_ExtremeBooks_MatchReference(uint256 seed, uint8 nRaw, uint8 outSel, bool cap4) public {
        uint256 ratio = cap4 ? 4 : 1;
        if (cap4) _useRatio(4);
        uint256 n = 2 + (uint256(nRaw) % 8);
        uint256 outcome = outSel % 4; // 0 up 1 down 2 tie 3 refund
        rounds.setMinBank(rounds.MIN_BANK_FLOOR());
        rounds.setCostAllowance(rounds.COST_ALLOWANCE_FLOOR());

        uint256 id = _nextRound(pool, T);
        PoolRoundRefModel.Ticket[] memory book = new PoolRoundRefModel.Ticket[](n);
        address[] memory ps = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 stake = [uint256(1), 2, 0.005 ether, 1 ether, 50 ether][r % 5] + (r >> 8) % 1000;
            bool up = (r >> 3) % 4 != 0; // перекос к UP (3 из 4)
            ps[i] = _player(100 + i);
            _bet(id, ps[i], stake, up ? _up() : _down(), address(0));
            book[i] = PoolRoundRefModel.Ticket(up, stake);
        }
        if (outcome == 0) _exitTick(pool, id, 100);
        if (outcome == 1) _exitTick(pool, id, -100);

        PoolRoundRefModel.Result memory ref = PoolRoundRefModel.settle(
            book, uint8(outcome + 1), ratio, rounds.MIN_BANK_FLOOR(), rounds.COST_ALLOWANCE_FLOOR()
        );

        _warpSettle(id);
        assertEq(rounds.roundView(id).activated, ref.active, "activation matches reference");
        if (!ref.active) {
            vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotActivated.selector, id));
            rounds.settle(id);
        } else {
            if (outcome == 3) pool.setForceOld(true);
            rounds.settle(id);
            assertEq(rounds.roundView(id).bank, ref.bank, "bank matches reference");
            assertEq(rounds.feesAccrued(), ref.treasury, "project part matches reference treasury");
        }
        uint256 paid;
        for (uint256 i = 0; i < n; i++) {
            uint256 got = _claim(id, ps[i]);
            assertEq(got, ref.payouts[i], "payout matches reference, to the wei");
            paid += got;
        }
        uint256 deposits;
        for (uint256 i = 0; i < n; i++) {
            deposits += book[i].stake;
        }
        assertEq(deposits, paid + weth.balanceOf(address(rounds)), "conservation");
        assertLe(paid + rounds.feesAccrued(), deposits, "payouts + fee never exceed deposits");
    }
}
