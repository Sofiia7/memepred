// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoolRoundTestBase.sol";

/**
 * Повторный аудит PoolRounds v3, часть 2: видимая ставка при капе 1.
 * Есть ли у бота, который ставит последним и видит книгу, выигрыш помимо
 * прогноза цены: двусторонняя ставка с двух адресов, вытеснение излишка,
 * отмена раунда манипуляцией min(UP, DOWN), границы окон и конструктора.
 */
contract PoolRoundsAttackV3BotTest is PoolRoundTestBase {
    address alice = _player(1);
    address bob = _player(2);
    address whale = makeAddr("whale");
    address m1 = makeAddr("bot-1");
    address m2 = makeAddr("bot-2");

    struct Book {
        uint256 rawUp;
        uint256 rawDown;
        uint256 up;
        uint256 down;
    }

    function _book(uint256 U, uint256 D, uint256 a, uint256 b, uint256 ratio) internal pure returns (Book memory k) {
        k.rawUp = U + a;
        k.rawDown = D + b;
        (k.up, k.down) = PoolRoundMath.accepted(k.rawUp, k.rawDown, ratio);
    }

    /// Итог бота (ставка a на UP и b на DOWN с двух адресов) при исходе o: 1 UP, 2 DOWN, 3 ничья.
    function _botTotal(Book memory k, uint256 a, uint256 b, uint8 o) internal pure returns (uint256 t) {
        uint256 bank = k.up + k.down;
        if (a > 0) {
            (uint256 pa,) = PoolRoundMath.ticketClaim(a, k.rawUp, k.up, bank, o == 3, o == 1);
            t += pa;
        }
        if (b > 0) {
            (uint256 pb,) = PoolRoundMath.ticketClaim(b, k.rawDown, k.down, bank, o == 3, o == 2);
            t += pb;
        }
    }

    // ════════════════════════════════════════════════════════════
    //  1. Двусторонняя ставка при капе 1: ровно минус комиссия, при капе 4: плюс
    // ════════════════════════════════════════════════════════════

    /// Сетка книг (честные стороны 0..1 ETH, ставки бота 0.005..0.4 ETH на каждую
    /// сторону). При капе 1 среднее по UP и DOWN итога бота равно вложению минус
    /// 2% его принятых частей (с точностью до округления): выигрыша от вида книги нет.
    function test_Cap1_TwoSidedBet_AverageOverOutcomesIsInvestedMinusFee() public pure {
        uint256[6] memory honest = [uint256(0), 0.005 ether, 0.02 ether, 0.05 ether, 0.2 ether, 1 ether];
        uint256[5] memory own = [uint256(0.005 ether), 0.01 ether, 0.04 ether, 0.1 ether, 0.4 ether];
        uint256 points;
        for (uint256 iu = 0; iu < 6; iu++) {
            for (uint256 id = 0; id < 6; id++) {
                for (uint256 ia = 0; ia < 5; ia++) {
                    for (uint256 ib = 0; ib < 5; ib++) {
                        _checkCap1(honest[iu], honest[id], own[ia], own[ib]);
                        points++;
                    }
                }
            }
        }
        assertEq(points, 900);
    }

    function _checkCap1(uint256 U, uint256 D, uint256 a, uint256 b) internal pure {
        Book memory k = _book(U, D, a, b, 1);
        if (!PoolRoundMath.isActive(k.rawUp, k.rawDown, 1, 0.02 ether, 69_692e9)) return; // всё назад, EV 0
        uint256 accA = a * k.up / k.rawUp;
        uint256 accB = b * k.down / k.rawDown;
        uint256 sum = _botTotal(k, a, b, 1) + _botTotal(k, a, b, 2);
        uint256 invested2 = 2 * (a + b);
        assertLe(sum, invested2, "no book gives the two-sided bot more than it staked, on average");
        // Ровно минус 2% принятых частей: 0.96 x acc - acc на каждой стороне, до округления (< 4 wei).
        assertGe(sum + 4, invested2 - (accA + accB) * 4 / 100, "the loss is exactly the fee");
        uint256 tie = _botTotal(k, a, b, 3);
        assertLe(tie, a + b, "tie: 1% of the accepted parts");
        assertGe(tie + 2, a + b - (accA + accB) / 100);
    }

    /// При капе 4 на перекошенной книге двусторонний бот в плюсе при p = 0.5
    /// (множитель тонкой стороны 4.4x против 1.26x толстой): это и есть причина,
    /// по которой POSITIVE-EV выбрал кап 1. Контракт допускает развёртывание с
    /// капом 4, и тогда этот выигрыш возвращается.
    function test_Cap4_TwoSidedBet_HasPositiveEdgeOnASkewedBook() public pure {
        Book memory k = _book(0.05 ether, 0.005 ether, 0.02 ether, 0.015 ether, 4);
        uint256 invested = 0.035 ether;
        uint256 up = _botTotal(k, 0.02 ether, 0.015 ether, 1);
        uint256 down = _botTotal(k, 0.02 ether, 0.015 ether, 2);
        assertLt(up, invested, "UP: loses 0.0098");
        assertGt(down, invested, "DOWN: wins 0.031");
        assertGt(up + down, 2 * invested, "average over a fair coin is positive at cap 4");
        assertEq(up + down - 2 * invested, 0.02135 ether, "= +0.0107 per round on 0.035 staked");
    }

    // ════════════════════════════════════════════════════════════
    //  2. Вытеснение: последняя большая ставка забирает исполнение у своей стороны
    // ════════════════════════════════════════════════════════════

    /// Честные 0.05/0.05 полностью исполнены. Кит в последнюю секунду ставит
    /// 0.45 UP: принято по-прежнему 0.05 на сторону, но у Алисы исполнено только
    /// 0.005 (10%), её выигрыш 0.0098 вместо 0.098; кит забрал 90% исполнения UP.
    /// Кит платит за это только честную ставку (EV минус 2% принятого): очереди
    /// по времени нет, исполнение делится пропорционально в момент closeAt.
    function test_Cap1_LastSecondWhale_CrowdsOutEarlierSameSideBettors() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
        vm.warp(_times(id).closeAt - 1);
        _bet(id, whale, 0.45 ether, _up(), address(0));
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);
        assertEq(rounds.roundView(id).acceptedUp, 0.05 ether);
        uint256 alicePaid = _claim(id, alice);
        uint256 whalePaid = _claim(id, whale);
        // alice: unmatched 0.045 + 1.96 x 0.005 = 0.0548
        assertEq(alicePaid, 0.045 ether + 0.005 ether * 196 / 100);
        // whale: unmatched 0.405 + 1.96 x 0.045 = 0.4932
        assertEq(whalePaid, 0.405 ether + 0.045 ether * 196 / 100);
        assertEq(alicePaid - 0.045 ether, 0.0098 ether, "alice's win shrank tenfold");
    }

    // ════════════════════════════════════════════════════════════
    //  3. Отменить чужой раунд ставкой нельзя: активация монотонна
    // ════════════════════════════════════════════════════════════

    /// Ставки только прибавляют; принятая сумма и банк не убывают ни при каком
    /// капе, значит активированный раунд ставкой не отменить. Перебор: любая
    /// добавка к любой стороне сохраняет активацию.
    function test_ActivationIsMonotone_NoBetCanCancelARound() public pure {
        uint256[5] memory sides = [uint256(0.005 ether), 0.01 ether, 0.04 ether, 0.1 ether, 1 ether];
        uint256[4] memory adds = [uint256(1), 0.005 ether, 0.04 ether, 10 ether];
        for (uint256 ratio = 1; ratio <= 4; ratio++) {
            for (uint256 i = 0; i < 5; i++) {
                for (uint256 j = 0; j < 5; j++) {
                    bool before = PoolRoundMath.isActive(sides[i], sides[j], ratio, 0.02 ether, 69_692e9);
                    if (!before) continue;
                    for (uint256 k = 0; k < 4; k++) {
                        assertTrue(PoolRoundMath.isActive(sides[i] + adds[k], sides[j], ratio, 0.02 ether, 69_692e9));
                        assertTrue(PoolRoundMath.isActive(sides[i], sides[j] + adds[k], ratio, 0.02 ether, 69_692e9));
                    }
                }
            }
        }
    }

    /// На цепочке: бот с двух адресов ставит на обе стороны в последнюю секунду
    /// раунда, который без него не активировался бы (0.005/0.005 < minBank).
    /// Он может только ВКЛЮЧИТЬ раунд (и заплатить свою честную ставку), но не
    /// выключить: после его ставок отменить раунд уже некому.
    function test_Cap1_BotCanOnlyActivate_NeverCancel() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.005 ether, _up(), address(0));
        _bet(id, bob, 0.005 ether, _down(), address(0));
        vm.warp(_times(id).closeAt - 1);
        assertFalse(PoolRoundMath.isActive(0.005 ether, 0.005 ether, 1, MIN_BANK, COST_0398));
        _bet(id, m1, 0.04 ether, _up(), address(0));
        _bet(id, m2, 0.04 ether, _down(), address(0));
        _warpClose(id);
        assertTrue(rounds.roundView(id).activated, "the bot's bets activated the round");
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);
        // Бот: m1 выиграл 1.96 x 0.04 = 0.0784, m2 проиграл 0.04: итого 0.0784 на 0.08.
        assertEq(_claim(id, m1) + _claim(id, m2), 0.0784 ether, "the bot pays the 2% fee on its accepted 0.08");
    }

    // ════════════════════════════════════════════════════════════
    //  4. Границы окон
    // ════════════════════════════════════════════════════════════

    /// bet: openAt и closeAt-1 принимаются, closeAt, strikeStart, strikeEnd,
    /// settleAt - нет. claim неактивированного: closeAt-1 нет, closeAt да.
    /// claim активированного до settle: NotSettled.
    function test_Boundaries_BetAndClaimAtEverySecondThatMatters() public {
        uint256 id = _nextRound(pool, T);
        PoolRounds.Times memory tm = _times(id);
        assertEq(block.timestamp, tm.openAt);
        _bet(id, alice, 0.05 ether, _up(), address(0)); // exactly openAt
        _fund(rounds, bob, 1 ether);
        uint256[4] memory closed = [tm.closeAt, tm.strikeStart, tm.strikeEnd, tm.settleAt];
        for (uint256 i = 0; i < 4; i++) {
            vm.warp(closed[i]);
            vm.prank(bob);
            vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotCollecting.selector, id));
            rounds.bet(id, 0.05 ether, _down(), address(0));
        }
        vm.warp(tm.closeAt - 1);
        vm.prank(bob);
        rounds.bet(id, 0.005 ether, _down(), address(0)); // last second: taken
        // Not activated (bank 0.01 < 0.02): claim from closeAt, not before.
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotSettled.selector, id));
        vm.prank(alice);
        rounds.claim(id);
        vm.warp(tm.closeAt);
        assertEq(_claim(id, alice), 0.05 ether);
        assertEq(_claim(id, bob), 0.005 ether);

        // Activated round: claim before settle is NotSettled even at settleAt.
        uint256 id2 = _nextRound(pool, T);
        _bet(id2, alice, 0.05 ether, _up(), address(0));
        _bet(id2, bob, 0.05 ether, _down(), address(0));
        vm.warp(_times(id2).settleAt);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NotSettled.selector, id2));
        vm.prank(alice);
        rounds.claim(id2);
    }

    // ════════════════════════════════════════════════════════════
    //  5. Конструктор: границы и неудачные сочетания
    // ════════════════════════════════════════════════════════════

    function test_Constructor_Bounds() public {
        PoolRounds.Params memory p = _params(address(registry), 1);
        p.maxSideRatio = 0;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 0));
        new PoolRounds(p);
        p.maxSideRatio = 5;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 5));
        new PoolRounds(p);
        p = _params(address(registry), 1);
        p.strikePause = 59;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 59));
        new PoolRounds(p);
        p.strikePause = 901;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 901));
        new PoolRounds(p);
        p = _params(address(registry), 1);
        p.strikeWindow = 59;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 59));
        new PoolRounds(p);
        p.strikeWindow = 601;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 601));
        new PoolRounds(p);
        p = _params(address(registry), 1);
        p.minStake = 0;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, p.maxStake));
        new PoolRounds(p);
        p = _params(address(registry), 1);
        p.maxStake = p.minStake - 0; // minStake 1, maxStake 0 < minStake
        p.maxStake = 0;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, 0));
        new PoolRounds(p);
        p = _params(address(registry), 1);
        p.maxStake = uint256(type(uint96).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.OutOfBounds.selector, p.maxStake));
        new PoolRounds(p);
        // Крайние допустимые: кап 4, пауза 900, окно 600 -> minCardinality 720.
        p = _params(address(registry), 4);
        p.strikePause = 900;
        p.strikeWindow = 600;
        PoolRounds r = new PoolRounds(p);
        assertEq(r.minCardinality(), 1200, "max(600, 300) + 600");
        p.strikeWindow = 60;
        r = new PoolRounds(p);
        assertEq(r.minCardinality(), 900, "the 300 s exit cap dominates a short strike window");
    }

    /// Неудачное сочетание: costAllowance на потолке (1e16) и maxStake 0.04 -
    /// для активации нужен банк >= 2.22 ETH, то есть 28 кошельков на сторону по
    /// максимуму. 20 на сторону не хватает: всё возвращается без комиссии.
    /// Продукт выключен, деньги целы.
    function test_UnluckyParams_CeilingCostAllowance_RoundsNeverActivate() public {
        PoolRounds.Params memory p = _params(address(registry), 1);
        p.minStake = 0.005 ether;
        p.maxStake = 0.04 ether;
        p.costAllowance = 1e16;
        PoolRounds r = _deployWith(p);
        PoolRoundMockPool pl = _newPoolOn(r, false);
        uint256 id = _nextRoundOn(r, address(pl), T);
        for (uint256 i = 0; i < 20; i++) {
            _betOn(r, id, address(uint160(0xB0B0 + i)), 0.04 ether, _up(), address(0));
            _betOn(r, id, address(uint160(0xC0C0 + i)), 0.04 ether, _down(), address(0));
        }
        vm.warp(r.roundTimes(id).closeAt);
        PoolRounds.RoundView memory v = r.roundView(id);
        assertEq(v.bank, 1.6 ether);
        assertFalse(v.activated, "retained 1% x 0.9 = 0.0144 ETH < 2 x 0.01 ETH");
        assertEq(_claimOn(r, id, address(0xB0B0)), 0.04 ether);
        assertEq(r.feesAccrued(), 0);
        // Наименьший активирующий банк при 1e16: 2e16 / 0.009 = 2.222.. ETH.
        assertFalse(PoolRoundMath.isActive(1.111 ether, 1.111 ether, 1, MIN_BANK, 1e16));
        assertTrue(PoolRoundMath.isActive(1.112 ether, 1.112 ether, 1, MIN_BANK, 1e16));
    }

    /// Неудачное сочетание: maxStake меньше половины minBank (0.005 против 0.02):
    /// одна пара игроков раунд не активирует, нужны хотя бы две пары. Не дефект,
    /// но порог участия, который надо показывать в UI.
    function test_UnluckyParams_MaxStakeBelowHalfMinBank_NeedsTwoPairs() public {
        PoolRounds.Params memory p = _params(address(registry), 1);
        p.minStake = 0.001 ether;
        p.maxStake = 0.005 ether;
        p.costAllowance = 2e13; // the floor since re-audit V3-7
        PoolRounds r = _deployWith(p);
        PoolRoundMockPool pl = _newPoolOn(r, false);
        uint256 id = _nextRoundOn(r, address(pl), T);
        _betOn(r, id, alice, 0.005 ether, _up(), address(0));
        _betOn(r, id, bob, 0.005 ether, _down(), address(0));
        vm.warp(r.roundTimes(id).closeAt);
        assertFalse(r.roundView(id).activated, "0.01 < minBank 0.02 even at both maxima");
        uint256 id2 = _nextRoundOn(r, address(pl), T);
        _betOn(r, id2, alice, 0.005 ether, _up(), address(0));
        _betOn(r, id2, m1, 0.005 ether, _up(), address(0));
        _betOn(r, id2, bob, 0.005 ether, _down(), address(0));
        _betOn(r, id2, m2, 0.005 ether, _down(), address(0));
        vm.warp(r.roundTimes(id2).closeAt);
        assertTrue(r.roundView(id2).activated);
    }
}
