// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoolRoundTestBase.sol";
import "./PoolRoundsAttackOracle.t.sol";

/// Реестр с кодом, у которого любой вызов «успешен» и возвращает пустые данные
/// (прокси без реализации, контракт с пустым fallback, чужой контракт без
/// такого селектора, но с fallback). Проверку NoCode проходит.
contract EmptyReturnRegistry {
    fallback() external {
        assembly {
            return(0, 0)
        }
    }
}

/**
 * Повторный аудит PoolRounds v3 (docs/rhc/ROUNDS-AUDIT.md, раздел «Повторный
 * аудит v3»), часть 1: закрыты ли M1, M2, L3, и что остаётся от гейта после
 * листинга. Обвязка и чужие файлы не менялись.
 */
contract PoolRoundsAttackV3GateTest is PoolRoundTestBase {
    address alice = _player(1);
    address bob = _player(2);

    uint256 internal ringNonce;

    function _ringPoolUnlisted(uint16 cardinality, int24 tick0) internal returns (RingPool p) {
        address token = address(uint160(uint256(keccak256(abi.encode("v3-ring", ringNonce++)))));
        p = new RingPool(token, address(weth), FEE_TIER, cardinality, uint32(block.timestamp - 7200), tick0);
        p.setLiquidity(POOL_LIQUIDITY);
        v3.register(token, address(weth), FEE_TIER, address(p));
    }

    function _balanced(address p) internal returns (uint256 id) {
        id = _nextRound(PoolRoundMockPool(p), T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
    }

    // ════════════════════════════════════════════════════════════
    //  1. M1: закрыт для адреса без кода, открыт для кода без интерфейса
    // ════════════════════════════════════════════════════════════

    /// V3-4 закрыт: реестр с кодом, чей referrerOf отвечает пустыми данными,
    /// проходит NoCode, но больше не запирает claim. _referrerOf читает ответ
    /// низкоуровневым staticcall и принимает только 32 байта адреса; иначе доля
    /// реферера уходит в казну. (Было: claim победителя откатывался навсегда.)
    function test_V3_4_RegistryWithCodeButNoReturnData_ClaimStillPays() public {
        address badRegistry = address(new EmptyReturnRegistry());
        assertGt(badRegistry.code.length, 0);
        PoolRounds r = _deployWith(_params(badRegistry, 1)); // NoCode не срабатывает
        PoolRoundMockPool p = _newPoolOn(r, false);
        uint256 id = _nextRoundOn(r, address(p), T);
        _betOn(r, id, alice, 0.05 ether, _up(), _player(9)); // реферер указан: register() «успешен»
        _betOn(r, id, bob, 0.05 ether, _down(), address(0));
        _exitTickOn(r, p, id, 100);
        vm.warp(r.roundTimes(id).settleAt);
        r.settle(id);
        assertEq(_claimOn(r, id, alice), 0.098 ether, "the winner is paid");
        assertEq(r.feesAccrued(), 0.002 ether, "the unreadable referrer's share went to the treasury");
        assertEq(_claimOn(r, id, bob), 0);
        assertEq(weth.balanceOf(address(r)), 0.002 ether, "only the fee is left");
    }

    /// Для сравнения: реестр с кодом, который откатывается, безопасен (catch).
    function test_M1_RevertingRegistryIsStillFine() public {
        PoolRounds r = _deployWith(_params(address(new RevertingReferrals()), 1));
        PoolRoundMockPool p = _newPoolOn(r, false);
        uint256 id = _nextRoundOn(r, address(p), T);
        _betOn(r, id, alice, 0.05 ether, _up(), _player(9));
        _betOn(r, id, bob, 0.05 ether, _down(), address(0));
        _exitTickOn(r, p, id, 100);
        vm.warp(r.roundTimes(id).settleAt);
        r.settle(id);
        assertEq(_claimOn(r, id, alice), 0.098 ether);
    }

    // ════════════════════════════════════════════════════════════
    //  2. M2: гейт есть, но проверяется один раз
    // ════════════════════════════════════════════════════════════

    /// Формула глубины учитывает ориентацию: при цене 2 (тик 6932) одна и та же
    /// ликвидность даёт L x sqrt(2) WETH, если WETH - token1, и L / sqrt(2), если
    /// token0. Пул с L = 40 ETH проходит гейт 50 WETH в одной ориентации и не
    /// проходит в другой.
    function test_M2_DepthGate_RespectsOrientation() public {
        int24 tick = 6932; // price ~2.0
        PoolRoundMockPool asToken1 = _unlistedPool(rounds, false); // WETH = token1: depth = L x sqrtP
        asToken1.pushTick(uint32(block.timestamp - 3600), tick);
        asToken1.setLiquidity(40 ether);
        uint256 d1 = rounds.wethDepth(address(asToken1));
        assertGt(d1, 50 ether, "40 x 1.414 = 56.6 WETH passes the 50 WETH gate");
        rounds.listPool(address(asToken1));

        PoolRoundMockPool asToken0 = _unlistedPool(rounds, true); // WETH = token0: depth = L / sqrtP
        asToken0.pushTick(uint32(block.timestamp - 3600), tick);
        asToken0.setLiquidity(40 ether);
        uint256 d0 = rounds.wethDepth(address(asToken0));
        assertLt(d0, 50 ether, "40 / 1.414 = 28.3 WETH fails");
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PoolTooThin.selector, d0));
        rounds.listPool(address(asToken0));
    }

    /// V3-3 закрыт: «сэндвич» вокруг listPool больше не даёт играть на тонком
    /// пуле. Ликвидность убрана сразу после листинга: ставка не проходит
    /// повторную проверку гейта (PoolTooThin), и любой может снять пул.
    function test_V3_3_MintListBurn_ThinPoolTakesNoBets_AndAnyoneDelists() public {
        RingPool p = _ringPoolUnlisted(900, 0);
        p.setLiquidity(1000 ether); // mint before the owner's listPool
        rounds.listPool(address(p));
        p.setLiquidity(0.1 ether); // burn right after
        assertLt(rounds.wethDepth(address(p)), rounds.gateDepth(), "below the gate now");

        uint256 id = _nextRound(PoolRoundMockPool(address(p)), T);
        _fund(rounds, alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PoolTooThin.selector, 0.1 ether));
        rounds.bet(id, 0.05 ether, _up(), address(0));

        vm.prank(bob); // anyone
        rounds.delistIfBelowGate(address(p));
        (bool listed,) = rounds.pools(address(p));
        assertFalse(listed, "delisted by a player, not the owner");
    }

    /// V3-2: единственный LP (игрок на проигрывающей стороне) снимает ликвидность
    /// после ставок, до окна страйка. Раньше: сутки блокировки, затем REFUND.
    /// Теперь окно страйка прошло без ликвидности, и fixStrike сразу даёт REFUND
    /// (REASON_THIN): деньги доступны сразу. Остаток риска: проигравший LP
    /// по-прежнему возвращает 99% вместо 0 (пул без ликвидности не даёт цены), но
    /// его ставка ограничена банком <= глубина / K. Новый раунд на мёртвом пуле
    /// не открывается.
    function test_V3_2_LiquidityPulledAfterBets_RefundsAtOnce_NoLock() public {
        uint256 id = _balanced(address(pool));
        _exitTick(pool, id, 100); // UP would win: bob (DOWN) is the losing LP
        pool.setLiquidity(0);
        vm.warp(_times(id).strikeEnd);
        rounds.fixStrike(id);
        assertEq(uint8(rounds.roundView(id).outcome), uint8(PoolRounds.Outcome.REFUND), "refund at once, no 24 h lock");
        assertEq(_claim(id, bob), 0.0495 ether, "the losing LP keeps 99% instead of losing 100%");
        assertEq(_claim(id, alice), 0.0495 ether, "the honest winner loses its 1.96x and 1%");
        assertEq(rounds.feesAccrued(), 0.001 ether);
        uint256 next = _nextRound(pool, T);
        _fund(rounds, alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.PoolTooThin.selector, 0));
        rounds.bet(next, 0.05 ether, _up(), address(0));
    }

    /// V3-2: ликвидность убрана после окон. Кольцо окна помнит, и теперь settle
    /// читает ликвидность за окно (secondsPerLiquidity), а не в момент вызова:
    /// раунд считается как обычно.
    function test_V3_2_LiquidityPulledAfterTheWindows_SettlesNormally() public {
        uint256 id = _balanced(address(pool));
        _exitTick(pool, id, 100);
        vm.warp(_times(id).strikeEnd);
        rounds.fixStrike(id);
        vm.warp(_times(id).settleAt + 1); // window fully in the past, liquidity was there all along
        pool.setLiquidity(0);
        assertTrue(rounds.canServeWindow(address(pool), 60), "the ring can still price the exit window");
        rounds.settle(id);
        assertEq(uint8(rounds.roundView(id).outcome), uint8(PoolRounds.Outcome.UP));
        assertEq(_claim(id, alice), 0.098 ether);
    }

    // ════════════════════════════════════════════════════════════
    //  3. L3: закрыт для контракта, остаётся для любого мёртвого адреса
    // ════════════════════════════════════════════════════════════

    /// Реферером можно назначить адрес, с которого никто не позовёт claimReferral
    /// (сам пул, реестр, WETH): 10% комиссии билета уходит туда и не выводится.
    /// Игрок ничего не выигрывает, проект теряет долю комиссии. Контракт этого
    /// различить не может; это не обход правки, а её граница.
    function test_L3_Residual_DeadAddressReferrerDivertsTheShare() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(pool));
        _bet(id, bob, 0.05 ether, _down(), address(0));
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);
        _claim(id, alice);
        assertEq(rounds.referralOwed(address(pool)), 0.0002 ether, "credited to the pool contract");
        assertEq(rounds.feesAccrued(), 0.0018 ether);
    }

    /// Владелец не может поменять кап, паузу и окно (нет сеттеров), а повторный
    /// listPool уже допущенного пула ничего не сбрасывает.
    function test_Owner_ImmutablesAndRelisting() public {
        uint256 id = _balanced(address(pool));
        rounds.listPool(address(pool)); // re-list: gate re-run, config re-written with the same values
        (bool listed, bool w0) = rounds.pools(address(pool));
        assertTrue(listed);
        assertFalse(w0);
        assertEq(rounds.maxSideRatio(), 1);
        assertEq(rounds.strikePause(), 300);
        assertEq(rounds.strikeWindow(), 300);
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);
        assertEq(_claim(id, alice), 0.098 ether, "the open round is untouched by the re-listing");
    }

    /// Владелец поднимает minBank до 10 ETH перед первой ставкой: раунд берёт
    /// снимок 10 ETH и никогда не активируется; обе ставки возвращаются целиком
    /// с closeAt, комиссии нет. Владелец может выключить продукт, но не деньги.
    function test_Owner_FrontRunsFirstBetWithMinBank_OnlyCancels() public {
        uint256 id = _nextRound(pool, T);
        rounds.setMinBank(10 ether);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        rounds.setMinBank(0.02 ether); // back to normal: the round keeps its snapshot
        _bet(id, bob, 0.05 ether, _down(), address(0));
        _warpClose(id);
        assertFalse(rounds.roundView(id).activated);
        assertEq(_claim(id, alice), 0.05 ether);
        assertEq(_claim(id, bob), 0.05 ether);
        assertEq(rounds.feesAccrued(), 0);
    }
}
