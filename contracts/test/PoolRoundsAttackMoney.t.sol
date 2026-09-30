// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoolRoundTestBase.sol";

/**
 * Аудит PoolRounds (docs/rhc/ROUNDS-AUDIT.md), часть 1: деньги и арифметика.
 * Приведено к интерфейсу v3 (ставка видимая, кап задаётся при развёртывании):
 * тесты, доказывавшие денежные свойства, сохранены; тесты на M1 и L3
 * перевёрнуты - теперь они доказывают, что дефект закрыт.
 */
contract PoolRoundsAttackMoneyTest is PoolRoundTestBase {
    address alice = _player(1);
    address bob = _player(2);
    address carol = _player(3);
    address mallory = makeAddr("mallory");

    uint256 internal constant MAX96 = type(uint96).max;

    /// Контракт с максимально допустимыми границами ставки: minStake 1 wei, maxStake 2^96 - 1.
    function _deployWide(uint256 ratio) internal returns (PoolRounds r, PoolRoundMockPool p) {
        PoolRounds.Params memory prm = _params(address(registry), ratio);
        prm.maxStake = MAX96;
        r = _deployWith(prm);
        p = _newPoolOn(r, false);
        p.setLiquidity(1e36); // depth 1e18 WETH: the depth rule must not bind a 2^96 bank
    }

    // ════════════════════════════════════════════════════════════
    //  1. Крайние значения uint96: переполнений нет, выплаты + комиссия <= депозитов
    // ════════════════════════════════════════════════════════════

    /// Две ставки, в сумме ровно 2^96 - 1 wei, с разных сторон: settle и оба
    /// claim проходят, сумма выплат и комиссии не превышает депозитов.
    /// Проверяет mulDiv-путь формулы ничьей и обычный путь на границе хранилища.
    function test_ExtremeStakes_MaxUint96_BothOutcomes_Solvent() public {
        for (uint8 mode = 0; mode < 2; mode++) {
            (PoolRounds r, PoolRoundMockPool p) = _deployWide(1);
            uint256 id = _nextRoundOn(r, address(p), T);
            _betOn(r, id, alice, MAX96 / 2, _up(), address(0));
            _betOn(r, id, bob, MAX96 - MAX96 / 2, _down(), address(0));
            if (mode == 0) _exitTickOn(r, p, id, 100);
            vm.warp(r.roundTimes(id).settleAt);
            r.settle(id);

            uint256 deposits = MAX96;
            uint256 paid = _claimOn(r, id, alice) + _claimOn(r, id, bob);
            uint256 fees = r.feesAccrued();
            assertLe(paid + fees, deposits, "payouts + fee never exceed deposits");
            assertGe(weth.balanceOf(address(r)), fees, "the fee is still inside");
            uint256 bank = r.roundView(id).bank; // cap 1: 2 x min, 1 wei of the odd side comes back
            uint256 gross = bank * (mode == 0 ? 200 : 100) / 10_000;
            assertLe(paid, deposits - gross, "never more than stakes minus the fee");
            assertLe(gross - fees, 2, "no referrers: the whole fee is the project's up to pot-split rounding");
        }
    }

    /// Сумма ставок одной стороны хранится в uint96: ставка, переполняющая
    /// сторону, откатывается (checked arithmetic), деньги не берутся. Потолок
    /// стороны 7.9e10 ETH недостижим, но maxStake = 2^96 - 1 из конструктора не
    /// означает две такие ставки на одной стороне (аудит I2).
    function test_ExtremeStakes_SideOverflow_RevertsCleanly() public {
        (PoolRounds r, PoolRoundMockPool p) = _deployWide(1);
        uint256 id = _nextRoundOn(r, address(p), T);
        _betOn(r, id, alice, MAX96, _up(), address(0));
        _fund(r, bob, 1);
        vm.prank(bob);
        vm.expectRevert(); // panic 0x11: rawUp (uint96) + 1
        r.bet(id, 1, _up(), address(0));
        assertEq(weth.balanceOf(bob), 1, "the reverted stake was not taken");
        vm.prank(bob);
        r.bet(id, 1, _down(), address(0)); // the other side has its own counter
    }

    /// Перекошенная книга на пределе uint96: 2^96 - 2 против 1 wei. При капе 1
    /// принимается 1 wei с каждой стороны, при капе 4 - 4 и 1 wei. Выплаты не
    /// переполняются, банк меньше minBank, раунд не играется.
    function test_ExtremeSkew_MaxAgainstOneWei_NoOverflow() public {
        for (uint256 ratio = 1; ratio <= 4; ratio += 3) {
            (PoolRounds r, PoolRoundMockPool p) = _deployWide(ratio);
            r.setMinBank(0.001 ether);
            r.setCostAllowance(r.COST_ALLOWANCE_FLOOR());
            uint256 id = _nextRoundOn(r, address(p), T);
            _betOn(r, id, alice, MAX96 - 1, _up(), address(0));
            _betOn(r, id, bob, 1, _down(), address(0));
            vm.warp(r.roundTimes(id).closeAt);
            PoolRounds.RoundView memory v = r.roundView(id);
            assertEq(v.acceptedUp, ratio, "min(rawUp, ratio x 1 wei)");
            assertEq(v.bank, ratio + 1);
            assertFalse(v.activated, "bank of a few wei < minBank: full refund, no fee");
            assertEq(_claimOn(r, id, alice), MAX96 - 1);
            assertEq(_claimOn(r, id, bob), 1);
            assertEq(weth.balanceOf(address(r)), 0);
        }
    }

    // ════════════════════════════════════════════════════════════
    //  2. Округление на границах
    // ════════════════════════════════════════════════════════════

    /// Кап 1: rawUp = rawDown + 1 wei, сторона UP из двух ставок. Неисполненный
    /// 1 wei не достаётся никому (unmatched каждого билета округляется вниз до 0),
    /// остаётся пылью; выплаты не превышают банк. Совпадает с эталоном.
    function test_CapBoundary_OneWeiOverTheCap_DustNotRevenue_Cap1() public {
        uint256 down = 0.1 ether; // bank 0.2: passes the admission gate at 0.398 gwei
        _checkOneWeiOver(1, down / 2 + 1, down / 2, down);
    }

    /// То же при капе 4 (исходный тест аудитора): rawUp = 4 x rawDown + 1 wei.
    function test_CapBoundary_OneWeiOverTheCap_DustNotRevenue_Cap4() public {
        _useRatio(4);
        uint256 down = 0.02 ether;
        _checkOneWeiOver(4, 2 * down + 1, 2 * down, down);
    }

    function _checkOneWeiOver(uint256 ratio, uint256 a, uint256 c, uint256 down) internal {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, a, _up(), address(0));
        _bet(id, carol, c, _up(), address(0));
        _bet(id, bob, down, _down(), address(0));
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);
        assertEq(rounds.roundView(id).acceptedUp, ratio * down);
        uint256 paidA = _claim(id, alice);
        uint256 paidC = _claim(id, carol);
        uint256 paidB = _claim(id, bob);
        assertEq(paidB, 0);
        uint256 dust = weth.balanceOf(address(rounds)) - rounds.feesAccrued();
        assertGe(dust, 1, "the 1 wei over the cap stays inside");
        assertLe(dust, 3, "plus award rounding, < 1 wei per ticket");
        assertLe(paidA + paidC + paidB + rounds.feesAccrued(), a + c + down);
        PoolRoundRefModel.Ticket[] memory book = new PoolRoundRefModel.Ticket[](3);
        book[0] = PoolRoundRefModel.Ticket(true, a);
        book[1] = PoolRoundRefModel.Ticket(true, c);
        book[2] = PoolRoundRefModel.Ticket(false, down);
        PoolRoundRefModel.Result memory ref = PoolRoundRefModel.settle(book, 1, ratio, MIN_BANK, COST_0398);
        assertEq(paidA, ref.payouts[0]);
        assertEq(paidC, ref.payouts[1]);
        assertGe(dust, ref.dust, "reference dust plus referral-split rounding");
        assertLt(dust - ref.dust, 3, "< 1 wei per ticket");
    }

    /// Банк ровно на пороге активации по бюджету: retained = 2 x costAllowance
    /// активирует; на 1 wei меньше банка - не активирует. Порог совпадает с эталоном.
    /// Ставки делят банк пополам; при капе 1 принятый банк равен 2 x min, поэтому
    /// порог ищется в чётных банках.
    function test_ActivationThreshold_ExactWeiBoundary() public {
        uint256 ca = COST_0398;
        uint256 lo = MIN_BANK / 2;
        uint256 hi = 0.1 ether / 2;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (PoolRoundMath.isActive(mid, mid, 1, MIN_BANK, ca)) hi = mid;
            else lo = mid + 1;
        }
        uint256 half = lo; // smallest per-side stake that activates a balanced book
        uint256 bank = 2 * half;
        (uint256 gross, uint256 referral) = PoolRoundMath.fees(bank, 100);
        assertGe(gross - referral, 2 * ca);
        (gross, referral) = PoolRoundMath.fees(bank - 2, 100);
        assertLt(gross - referral, 2 * ca);
        emit log_named_uint("smallest activating balanced bank at cap 1, wei", bank);

        // На цепочке: ровно этот банк играется, на 1 wei меньше с одной стороны - возвращается целиком.
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, half, _up(), address(0));
        _bet(id, bob, half, _down(), address(0));
        _warpClose(id);
        assertTrue(rounds.roundView(id).activated);

        uint256 id2 = _nextRound(pool, T);
        _bet(id2, alice, half, _up(), address(0));
        _bet(id2, bob, half - 1, _down(), address(0));
        _warpClose(id2);
        assertFalse(rounds.roundView(id2).activated);
        assertEq(_claim(id2, alice), half);
    }

    /// Сторона с одной ставкой в 1 wei против 100 ETH: активации нет (банк 2 wei при капе 1), всё назад.
    function test_OneWeiSide_NeverActivates() public {
        rounds.setMinBank(rounds.MIN_BANK_FLOOR());
        rounds.setCostAllowance(rounds.COST_ALLOWANCE_FLOOR());
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 100 ether, _up(), address(0));
        _bet(id, bob, 1, _down(), address(0));
        _warpClose(id);
        assertFalse(rounds.roundView(id).activated);
        assertEq(_claim(id, alice), 100 ether);
        assertEq(_claim(id, bob), 1);
    }

    // ════════════════════════════════════════════════════════════
    //  3. Реферальный реестр (M1, L3 закрыты)
    // ════════════════════════════════════════════════════════════

    /// M1: адрес реестра без кода запирал claim навсегда. Теперь его не
    /// принимает конструктор, а после EIP-6780 код развёрнутого реестра
    /// selfdestruct не удаляет.
    function test_M1_RegistryWithoutCode_RefusedAtDeployment() public {
        address eoaRegistry = makeAddr("registry-without-code");
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.NoCode.selector, eoaRegistry));
        new PoolRounds(_params(eoaRegistry, 1));
    }

    /// L3: реферером нельзя назначить сам контракт при ставке...
    function test_L3_ReferrerIsTheContract_RefusedAtBet() public {
        uint256 id = _nextRound(pool, T);
        _fund(rounds, alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(PoolRounds.SelfReferral.selector);
        rounds.bet(id, 0.05 ether, _up(), address(rounds));
    }

    /// ...а если общий реестр уже держит контракт реферером (связь записана
    /// другим рынком или владельцем реестра), доля уходит в казну, а не в
    /// неснимаемый баланс.
    function test_L3_ContractAsReferrerFromTheRegistry_ShareGoesToTreasury() public {
        registry.register(alice, address(rounds)); // the registry's owner may register directly
        assertEq(registry.referrerOf(alice), address(rounds));
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);
        _claim(id, alice);
        assertEq(rounds.referralOwed(address(rounds)), 0, "nothing stuck on the contract");
        assertEq(rounds.feesAccrued(), 0.002 ether, "the treasury gets the whole 2%");
    }

    // ════════════════════════════════════════════════════════════
    //  4. Владелец не может двинуть деньги игроков
    // ════════════════════════════════════════════════════════════

    /// После расчёта с невостребованными выплатами владелец вызывает всё, что
    /// может; баланс контракта остаётся не меньше долгов игрокам, а withdrawFees
    /// уносит ровно feesAccrued, не больше.
    function test_Owner_CannotReachPlayerMoney() public {
        uint256 id = _nextRound(pool, T);
        _bet(id, alice, 0.05 ether, _up(), address(0));
        _bet(id, bob, 0.05 ether, _down(), address(0));
        _bet(id, carol, 0.03 ether, _down(), address(0)); // partly unmatched at cap 1
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);

        address newTreasury = makeAddr("new-treasury");
        rounds.setTreasury(newTreasury);
        rounds.setPauser(mallory);
        rounds.setMinBank(10 ether);
        rounds.setCostAllowance(1e16);
        rounds.delistPool(address(pool));
        rounds.setDuration(T, false);
        rounds.pause();
        rounds.transferOwnership(mallory);
        vm.prank(mallory);
        rounds.acceptOwnership();

        uint256 fees = rounds.feesAccrued();
        vm.prank(mallory);
        rounds.withdrawFees();
        assertEq(weth.balanceOf(newTreasury), fees, "only the booked fee left");
        address[3] memory ps = [alice, bob, carol];
        uint256 owed;
        for (uint256 i = 0; i < 3; i++) {
            (uint256 payout, uint256 share) = rounds.previewClaim(id, ps[i]);
            owed += payout + share;
        }
        assertGe(weth.balanceOf(address(rounds)), owed, "every player's claim is still covered");
        assertEq(_claim(id, alice), 0.098 ether, "the winner still collects after every owner action");
        assertEq(_claim(id, bob), 0.05 ether * 0.03 ether / 0.08 ether, "bob's unmatched part");
        assertEq(_claim(id, carol), 0.03 ether * 0.03 ether / 0.08 ether, "carol's unmatched part");
        vm.prank(mallory);
        rounds.withdrawFees(); // the winner's referral share, no referrer: to the treasury
        assertLe(weth.balanceOf(address(rounds)), 3, "only dust is left, and nobody can move it");
        vm.prank(mallory);
        vm.expectRevert(PoolRounds.NothingToWithdraw.selector);
        rounds.withdrawFees();
    }

    /// Сумма реферальных долей и казны никогда не превышает gross-комиссии,
    /// даже когда у каждого победителя свой реферер (максимум округлений).
    function test_ReferralShares_PlusTreasury_NeverExceedGross() public {
        uint256 id = _nextRound(pool, T);
        uint256 n = 12;
        address[] memory refs = new address[](n);
        uint256 deposits;
        for (uint256 i = 0; i < n; i++) {
            refs[i] = address(uint160(0xBEEF00 + i));
            uint256 stake = 0.01 ether + i * 7919; // нечётные хвосты для округлений
            _bet(id, _player(10 + i), stake, i % 2 == 0 ? _up() : _down(), refs[i]);
            deposits += stake;
        }
        _exitTick(pool, id, 100);
        _warpSettle(id);
        rounds.settle(id);
        uint256 bank = rounds.roundView(id).bank;
        uint256 gross = bank * 200 / 10_000;
        uint256 paid;
        for (uint256 i = 0; i < n; i++) {
            paid += _claim(id, _player(10 + i));
        }
        uint256 refsTotal;
        for (uint256 i = 0; i < n; i++) {
            refsTotal += rounds.referralOwed(refs[i]);
        }
        assertLe(rounds.feesAccrued() + refsTotal, gross, "fee accounting never exceeds gross");
        assertEq(deposits, paid + (weth.balanceOf(address(rounds))), "conservation");
        assertGe(weth.balanceOf(address(rounds)), rounds.feesAccrued() + refsTotal, "solvent for fee and referrals");
    }

    // ════════════════════════════════════════════════════════════
    //  5. Одна ставка на адрес: обход кошельками (из PoolRoundsAttackReveal, I4)
    // ════════════════════════════════════════════════════════════

    /// maxStake ограничивает адрес, не игрока: пять кошельков дают 5 x maxStake
    /// на одну сторону. Кап и множитель считаются по суммам сторон, так что для
    /// честных игроков разницы с одной большой ставкой нет; но любой лимит
    /// экспозиции «на игрока» контрактом не обеспечивается.
    function test_OneStakePerAddress_MaxStakeIsPerWalletOnly() public {
        PoolRounds.Params memory prm = _params(address(registry), 1);
        prm.minStake = 0.005 ether;
        prm.maxStake = 0.04 ether;
        PoolRounds r = _deployWith(prm);
        PoolRoundMockPool p = _newPoolOn(r, false);
        uint256 id = _nextRoundOn(r, address(p), T);
        for (uint256 i = 0; i < 5; i++) {
            _betOn(r, id, address(uint160(0xA11CE0 + i)), 0.04 ether, _up(), address(0));
        }
        _fund(r, alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolRounds.StakeOutOfBounds.selector, 0.05 ether));
        r.bet(id, 0.05 ether, _up(), address(0));
        assertEq(r.roundView(id).committed, 0.2 ether, "5 x maxStake from one operator");
    }
}
