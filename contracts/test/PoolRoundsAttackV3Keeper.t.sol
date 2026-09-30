// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoolRoundTestBase.sol";
import "./PoolRoundsAttackOracle.t.sol";

/**
 * Повторный аудит PoolRounds v3, часть 3: сроки кипера на кольце 420 при записи
 * наблюдения каждую секунду, что стирает историю и что нет, экономика допуска
 * при значениях владельца и стоимость сдвига цены относительно банка.
 */
contract PoolRoundsAttackV3KeeperTest is PoolRoundTestBase {
    address alice = _player(1);
    address bob = _player(2);

    uint256 internal ringNonce;

    function _ringPool(uint16 cardinality, int24 tick0) internal returns (RingPool p) {
        address token = address(uint160(uint256(keccak256(abi.encode("v3-keeper-ring", ringNonce++)))));
        p = new RingPool(token, address(weth), FEE_TIER, cardinality, uint32(block.timestamp - 7200), tick0);
        p.setLiquidity(POOL_LIQUIDITY);
        v3.register(token, address(weth), FEE_TIER, address(p));
        rounds.listPool(address(p));
    }

    function _round(address p, uint256 dur) internal returns (uint256 id) {
        id = _nextRound(PoolRoundMockPool(p), dur);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
    }

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
    //  1. Точные границы: 119 / 120 и 359 / 360
    // ════════════════════════════════════════════════════════════

    /// V3-7: кольцо 900 при записи каждую секунду помнит ровно 899 с. fixStrike на
    /// strikeEnd + 599 (keeperDeadlines) читает окно, на +600 уже нет (REFUND).
    function test_Deadline_FixStrike_600IsAlreadyTooLate() public {
        RingPool p = _ringPool(900, 0);
        uint256 id = _round(address(p), T);
        PoolRounds.Times memory tm = _times(id);
        (uint256 fixBy,) = rounds.keeperDeadlines(id);
        assertEq(fixBy, tm.strikeEnd + 599);
        _pokeEverySecond(p, tm.closeAt, tm.strikeEnd + 600);
        assertEq(p.oldestTs(), tm.strikeStart + 1, "oldest observation is one second past strikeStart");
        rounds.fixStrike(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND), "exactly 600 s late: REFUND");
    }

    /// settle (страйк зафиксирован) на settleAt + 839 считает, на +840 - REFUND.
    function test_Deadline_Settle_840IsAlreadyTooLate() public {
        RingPool p = _ringPool(900, 0);
        uint256 id = _round(address(p), T);
        PoolRounds.Times memory tm = _times(id);
        (, uint256 settleBy) = rounds.keeperDeadlines(id);
        assertEq(settleBy, tm.settleAt + 839);
        vm.warp(tm.strikeEnd);
        rounds.fixStrike(id);
        _pokeEverySecond(p, tm.strikeEnd + 1, tm.settleAt + 840);
        assertEq(p.oldestTs(), tm.settleAt - 59, "oldest is one second past the exit window start");
        rounds.settle(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND), "exactly 840 s late: REFUND");
    }

    /// V3-5: для T = 900 окно выхода 180 с, запас settle 719 с = 899 - 180, и
    /// keeperDeadlines возвращает ровно его: формула, а не константа.
    function test_Deadline_Settle_T900_Is719() public {
        RingPool pa = _ringPool(900, 0);
        uint256 a = _round(address(pa), 900);
        PoolRounds.Times memory ta = _times(a);
        (, uint256 settleBy) = rounds.keeperDeadlines(a);
        assertEq(settleBy, ta.settleAt + 719);
        vm.warp(ta.strikeEnd);
        rounds.fixStrike(a);
        _pokeEverySecond(pa, ta.strikeEnd + 1, settleBy);
        rounds.settle(a);
        assertEq(uint8(_outcome(a)), uint8(PoolRounds.Outcome.TIE), "719 s late on T=900: priced");

        RingPool pb = _ringPool(900, 0);
        uint256 b = _round(address(pb), 900);
        PoolRounds.Times memory tb = _times(b);
        vm.warp(tb.strikeEnd);
        rounds.fixStrike(b);
        _pokeEverySecond(pb, tb.strikeEnd + 1, tb.settleAt + 720);
        rounds.settle(b);
        assertEq(uint8(_outcome(b)), uint8(PoolRounds.Outcome.REFUND), "720 s late on T=900: REFUND");
    }

    // ════════════════════════════════════════════════════════════
    //  2. Что стирает историю, а что нет
    // ════════════════════════════════════════════════════════════

    /// Остановка сети НЕ стирает окно: без свопов кольцо не пишется, и после
    /// паузы в 3 часа fixStrike читает окно страйка экстраполяцией. Опасен не
    /// простой цепочки, а кипер, лежащий ПОКА пул торгует каждую секунду.
    function test_ChainHalt_DoesNotEraseTheWindow() public {
        RingPool p = _ringPool(900, 0);
        uint256 id = _round(address(p), T);
        PoolRounds.Times memory tm = _times(id);
        _pokeEverySecond(p, tm.closeAt, tm.strikeStart - 1); // busy until the window starts
        vm.warp(tm.strikeEnd + 3 hours); // nothing written since: a halted chain
        rounds.fixStrike(id);
        assertTrue(rounds.roundView(id).strikeFixed, "3 hours late, still readable");
        vm.warp(tm.settleAt + 3 hours);
        rounds.settle(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.TIE));
    }

    /// Атакующий не может писать чаще раза в секунду (Oracle.write выходит при
    /// равном timestamp): десять транзакций в одну секунду - одна запись. Поэтому
    /// границы 119/359 с - предел при ЛЮБОЙ активности, ускорить стирание нельзя;
    /// можно только гарантировать максимальную скорость, если пул сам тих.
    function test_Attacker_CannotWriteFasterThanOncePerSecond() public {
        RingPool p = _ringPool(900, 0);
        vm.warp(block.timestamp + 1); // listing wrote this second already (setLiquidity writes, as a mint does)
        uint256 w0 = p.writes();
        for (uint256 i = 0; i < 10; i++) {
            p.poke();
        }
        assertEq(p.writes() - w0, 1, "ten pokes in one second: one observation");
        vm.warp(block.timestamp + 1);
        p.poke();
        assertEq(p.writes() - w0, 2);
        // Цена гарантии: 120 записей для страйка (или 360 для выхода) по одной
        // транзакции в секунду, около 100-150 тыс. газа каждая (оценка, не замер).
        emit log_named_uint("gas to guarantee 1 write/s over the strike slack, at 120k per write", 120 * 120_000);
        emit log_named_uint("wei at 0.05 gwei (p50 15-29.09)", 120 * 120_000 * 50_000_000);
    }

    /// Стерев окно страйка, атакующий получает REFUND: все платят 1%, он тоже,
    /// и он ничего не выигрывает, если не был на проигрывающей стороне. Игрок
    /// на проигрывающей стороне возвращает 99% вместо 0: это единственный, кому
    /// атака выгодна, и только если кипер опоздал на 120 с.
    function test_ForcedRefund_WhoLosesWhat() public {
        RingPool p = _ringPool(900, 0);
        uint256 id = _round(address(p), T);
        PoolRounds.Times memory tm = _times(id);
        vm.warp(tm.strikeStart);
        p.swapTo(100); // UP is winning
        _pokeEverySecond(p, tm.strikeStart + 1, tm.strikeEnd + 600); // the keeper is 600 s late
        rounds.fixStrike(id);
        assertEq(uint8(_outcome(id)), uint8(PoolRounds.Outcome.REFUND));
        assertEq(_claim(id, alice), 0.0495 ether, "the would-be winner loses 1% and its 0.048 profit");
        assertEq(_claim(id, bob), 0.0495 ether, "the would-be loser keeps 99% instead of 0");
        assertEq(rounds.feesAccrued(), 0.001 ether, "the project keeps 1% of the bank for a round it did not price");
    }

    // ════════════════════════════════════════════════════════════
    //  3. Экономика допуска при значениях владельца
    // ════════════════════════════════════════════════════════════

    /// V3-7 закрыт: пол costAllowance поднят до 2e13 (1 000 000 газа по полу
    /// цепочки 0.020142 gwei). На полу minBank 0.001 ETH раунд больше не
    /// активируется (удержано 9e12 < 4e13); наименьший активирующий банк на полах
    /// удерживает не меньше 4e13, а один путь кипера 207 тыс. газа по p99 0.0697
    /// gwei стоит 1.44e13. При значениях развёртывания запас 29%.
    function test_Admission_FloorCoversTheKeeperPath_DefaultsHaveMargin() public pure {
        uint256 floorAllowance = 2e13;
        (uint256 g, uint256 ref) = PoolRoundMath.fees(0.001 ether, 100);
        assertEq(g - ref, 9e12);
        assertFalse(
            PoolRoundMath.isActive(0.0005 ether, 0.0005 ether, 1, 0.001 ether, floorAllowance),
            "the old floor case no longer activates"
        );
        // smallest balanced bank that activates at both floors: retained >= 4e13
        assertFalse(PoolRoundMath.isActive(0.00222 ether, 0.00222 ether, 1, 0.001 ether, floorAllowance));
        assertTrue(PoolRoundMath.isActive(0.002223 ether, 0.002223 ether, 1, 0.001 ether, floorAllowance));
        (g, ref) = PoolRoundMath.fees(0.004446 ether, 100);
        uint256 keeperPathAtP99 = 207_421 * uint256(69_692_000); // wei, ROUNDS-CONTRACT.md estimate at 0.069692 gwei
        assertGe(g - ref, keeperPathAtP99, "the retained fee at the floors covers one keeper path at p99 gas");

        (g, ref) = PoolRoundMath.fees(0.02 ether, 100);
        assertEq(g - ref, 1.8e14);
        assertGe(g - ref, 2 * 69_692e9, "deployment defaults: retained 1.8e14 >= 1.39e14");
        assertEq((g - ref) * 100 / (2 * 69_692e9), 129, "29% margin");
    }

    /// V3-1 с правилом глубины. Сдвиг цены на x в течение окна на пуле глубиной W
    /// с комиссией fee стоит около fee x W x x (объём W x x / 2 туда и обратно).
    /// Банк раунда не больше W / K, выигрыш манипулятора от переворота исхода не
    /// больше 1.96 x его принятой части, а она не больше половины банка:
    /// swing <= 0.98 x W / K. Сдвиг окупается, только если fee x x x K < 0.98.
    /// Порог сдвига x* = 0.98 / (fee x K) от глубины НЕ зависит.
    /// При K = 2500: x* = 3.92% при комиссии пула 1%, 13.07% при 0.3%, 78.4% при 0.05%.
    /// То есть правило ограничивает выигрыш манипуляции долей глубины, но сдвиги
    /// меньше x* окупаются по-прежнему, включая сдвиг на один тик, которого хватает,
    /// чтобы решить раунд, в котором цена иначе стояла бы (ничья).
    function test_Economics_PriceSteering_WithTheDepthRule() public {
        uint256 k = 2500;
        uint256 depth = k * 0.02 ether; // at the gate: 50 WETH, max bank 0.02
        uint256 maxBank = depth / k;
        uint256 swing = maxBank * 98 / 100; // 1.96 x half the bank
        assertEq(swing, 0.0196 ether);
        // cost of a shift x (bps) at fee f (bps): depth x f x x
        uint256[3] memory feeBps = [uint256(100), 30, 5];
        for (uint256 f = 0; f < 3; f++) {
            // break-even shift in bps: 0.98 / (f x K) x 1e4 x 1e4
            uint256 xStar = (uint256(98) * 1e8 / 100 + feeBps[f] * k - 1) / (feeBps[f] * k); // rounded up
            uint256 costAtXStar = depth * feeBps[f] / 10_000 * xStar / 10_000;
            uint256 costBelow = depth * feeBps[f] / 10_000 * (xStar - 1) / 10_000;
            emit log_named_uint(string.concat("break-even shift, bps, pool fee bps ", vm.toString(feeBps[f])), xStar);
            assertGe(costAtXStar, swing, "at x* the shift costs the whole swing");
            assertLt(costBelow, swing, "below x* it still pays");
        }
        // 1% pool: x* = 392 bps. A 2% shift costs half the max bank and still pays two to one.
        uint256 cost2pct = depth * 100 / 10_000 * 200 / 10_000;
        assertEq(cost2pct, 0.01 ether);
        assertEq(swing * 100 / cost2pct, 196, "a 2% shift at the gate: gain 1.96x its cost");
        // One tick (0.01%) decides a round whose price would otherwise not move.
        uint256 costOneTick = depth * 100 / 10_000 * 1 / 10_000;
        assertEq(costOneTick, 0.00005 ether);
        assertEq(swing / costOneTick, 392, "a one-tick push still pays 392 times its cost");
        // K at which a one-tick push stops paying at a 1% pool: 0.98 / (0.01 x 0.0001) = 980 000.
        assertEq(uint256(98) * 1e8 / 100 / (100 * 1), 980_000);
    }
}
