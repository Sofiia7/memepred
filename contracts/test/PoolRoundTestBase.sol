// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PoolRounds.sol";
import "../src/ReferralRegistry.sol";
import "./PoolRoundMockPool.sol";
import "./mocks/MockUniswapV3Factory.sol";
import "./mocks/MockWETH.sol";

/**
 * Reference model of scripts/rhc/positive-ev.mts, transcribed a second time and
 * independently of PoolRoundMath: plain uint256 arithmetic in the reference's
 * own order, no mulDiv, whole-book loops. Callers keep stakes at or below 1e21
 * wei so the three-factor products stay far below 2^256.
 */
library PoolRoundRefModel {
    uint256 internal constant BPS = 10_000;

    struct Ticket {
        bool up;
        uint256 stake;
    }

    struct Result {
        bool active;
        uint256[] payouts;
        uint256 bank;
        uint256 grossFee;
        uint256 referral;
        uint256 treasury;
        uint256 dust;
    }

    /// outcome: 1 up, 2 down, 3 tie, 4 oracle refund (only read when active); ratio: side cap
    function settle(Ticket[] memory ts, uint8 outcome, uint256 ratio, uint256 minBank, uint256 costAllowance)
        internal
        pure
        returns (Result memory r)
    {
        uint256[6] memory b; // rawUp, rawDown, up, down, bank, prize
        for (uint256 i = 0; i < ts.length; i++) {
            if (ts[i].up) b[0] += ts[i].stake;
            else b[1] += ts[i].stake;
        }
        r.payouts = new uint256[](ts.length);
        b[2] = b[0] > ratio * b[1] ? ratio * b[1] : b[0];
        b[3] = b[1] > ratio * b[0] ? ratio * b[0] : b[1];
        b[4] = b[2] + b[3];
        uint256 voidGross = b[4] * 100 / BPS;
        if (b[0] == 0 || b[1] == 0 || b[4] < minBank || voidGross - voidGross * 1000 / BPS < 2 * costAllowance) {
            for (uint256 i = 0; i < ts.length; i++) {
                r.payouts[i] = ts[i].stake;
            }
            return r;
        }
        r.active = true;
        r.bank = b[4];
        r.grossFee = b[4] * (outcome == 3 || outcome == 4 ? 100 : 200) / BPS;
        r.referral = r.grossFee * 1000 / BPS;
        r.treasury = r.grossFee - r.referral;
        b[5] = b[4] - r.grossFee;
        uint256 paid;
        for (uint256 i = 0; i < ts.length; i++) {
            r.payouts[i] = _payout(ts[i], outcome, b);
            paid += r.payouts[i];
        }
        r.dust = b[0] + b[1] - paid - r.grossFee;
    }

    /// b = [rawUp, rawDown, up, down, bank, prize]
    function _payout(Ticket memory t, uint8 outcome, uint256[6] memory b) private pure returns (uint256) {
        uint256 sideRaw = t.up ? b[0] : b[1];
        uint256 sideAccepted = t.up ? b[2] : b[3];
        uint256 unmatched = t.stake * (sideRaw - sideAccepted) / sideRaw;
        uint256 award;
        if (outcome == 3 || outcome == 4) award = t.stake * sideAccepted * b[5] / (sideRaw * b[4]);
        else if ((outcome == 1) == t.up) award = t.stake * b[5] / sideRaw;
        return unmatched + award;
    }
}

/// Registry stand-in that reverts on every call: a claim must still pay.
contract RevertingReferrals is IPoolRoundReferrals {
    function referrerOf(address) external pure returns (address) {
        revert("registry down");
    }

    function register(address, address) external pure {
        revert("registry down");
    }
}

abstract contract PoolRoundTestBase is Test {
    PoolRounds internal rounds;
    MockWETH internal weth;
    MockUniswapV3Factory internal v3;
    ReferralRegistry internal registry;
    PoolRoundMockPool internal pool;

    address internal treasury = makeAddr("treasury");
    address internal pauserAddr = makeAddr("pauser");

    uint256 internal constant T = 300;
    /// The design (POSITIVE-EV.md, third edition): cap 1:1, pause 300 s, strike window 300 s.
    uint256 internal constant RATIO = 1;
    uint256 internal constant PAUSE = 300;
    uint256 internal constant WINDOW = 300;
    /// 1 000 000 gas x 0.398 gwei, the policy positive-ev.mts selfTest() uses.
    uint256 internal constant COST_0398 = 398e12;
    /// positive-ev.mts MIN_BANK.
    uint256 internal constant MIN_BANK = 0.02 ether;
    uint32 internal constant T0 = 1_790_000_000;
    uint24 internal constant FEE_TIER = 3000;
    /// K of the design: a round's accepted bank may not exceed the pool's WETH depth / 2500.
    uint256 internal constant K = 2500;
    /// In-range liquidity of the stand-in pools: at tick 0 this is the WETH depth. Large on
    /// purpose, so that the depth rule never binds in tests that are about something else;
    /// the tests of the rule set their own liquidity.
    uint128 internal constant POOL_LIQUIDITY = 1e9 ether;

    uint256 internal tokenNonce;

    function setUp() public virtual {
        vm.warp(T0);
        weth = new MockWETH();
        v3 = new MockUniswapV3Factory();
        registry = new ReferralRegistry();
        rounds = _deploy(address(registry), RATIO);
        registry.setMarketFactory(address(rounds));
        registry.authorizeMarket(address(rounds));
        pool = _newPool(false);
    }

    function _params(address referrals, uint256 ratio) internal view returns (PoolRounds.Params memory p) {
        p = PoolRounds.Params({
            weth: address(weth),
            v3Factory: address(v3),
            referralRegistry: referrals,
            treasury: treasury,
            maxSideRatio: ratio,
            strikePause: PAUSE,
            strikeWindow: WINDOW,
            depthPerBank: K,
            minStake: 1,
            maxStake: 100 ether,
            minBank: MIN_BANK,
            costAllowance: COST_0398
        });
    }

    /// Replace `rounds`, `registry` and `pool` with a fresh deployment at side cap `ratio`.
    function _useRatio(uint256 ratio) internal {
        registry = new ReferralRegistry();
        rounds = _deploy(address(registry), ratio);
        registry.setMarketFactory(address(rounds));
        registry.authorizeMarket(address(rounds));
        pool = _newPool(false);
    }

    function _deploy(address referrals, uint256 ratio) internal returns (PoolRounds r) {
        r = _deployWith(_params(referrals, ratio));
    }

    function _deployWith(PoolRounds.Params memory p) internal returns (PoolRounds r) {
        r = new PoolRounds(p);
        r.setDuration(60, true);
        r.setDuration(300, true);
        r.setDuration(900, true);
        r.setPauser(pauserAddr);
    }

    /// A canonical WETH pool that passes the listing gate, listed. wethIsToken0 picks the orientation.
    function _newPool(bool wethIsToken0) internal returns (PoolRoundMockPool p) {
        return _newPoolOn(rounds, wethIsToken0);
    }

    function _newPoolOn(PoolRounds target, bool wethIsToken0) internal returns (PoolRoundMockPool p) {
        p = _unlistedPool(target, wethIsToken0);
        target.listPool(address(p));
    }

    function _unlistedPool(PoolRounds target, bool wethIsToken0) internal returns (PoolRoundMockPool p) {
        address token = address(uint160(uint256(keccak256(abi.encode("token", tokenNonce++)))));
        p = wethIsToken0
            ? new PoolRoundMockPool(address(weth), token, FEE_TIER)
            : new PoolRoundMockPool(token, address(weth), FEE_TIER);
        p.pushTick(uint32(block.timestamp - 7200), 0);
        uint16 card = uint16(target.minCardinality());
        p.setCardinality(card, card);
        p.setLiquidity(POOL_LIQUIDITY);
        v3.register(token, address(weth), FEE_TIER, address(p));
    }

    function _player(uint256 i) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("player", i)))));
    }

    /// Warp to the first second of the next window of `duration` and return its round.
    function _nextRound(PoolRoundMockPool p, uint256 duration) internal returns (uint256 roundId) {
        return _nextRoundOn(rounds, address(p), duration);
    }

    function _nextRoundOn(PoolRounds target, address p, uint256 duration) internal returns (uint256 roundId) {
        uint256 next = (block.timestamp / duration + 1) * duration;
        vm.warp(next);
        roundId = target.roundIdOf(p, duration, next / duration);
    }

    function _fund(PoolRounds target, address player, uint256 amount) internal {
        weth.mint(player, amount);
        vm.prank(player);
        weth.approve(address(target), type(uint256).max);
    }

    function _bet(uint256 roundId, address player, uint256 stake, PoolRounds.Side side, address referrer) internal {
        _betOn(rounds, roundId, player, stake, side, referrer);
    }

    function _betOn(
        PoolRounds target,
        uint256 roundId,
        address player,
        uint256 stake,
        PoolRounds.Side side,
        address referrer
    ) internal {
        _fund(target, player, stake);
        vm.prank(player);
        target.bet(roundId, stake, side, referrer);
    }

    function _claim(uint256 roundId, address player) internal returns (uint256 paid) {
        return _claimOn(rounds, roundId, player);
    }

    function _claimOn(PoolRounds target, uint256 roundId, address player) internal returns (uint256 paid) {
        uint256 before = weth.balanceOf(player);
        vm.prank(player);
        target.claim(roundId);
        paid = weth.balanceOf(player) - before;
    }

    function _times(uint256 roundId) internal view returns (PoolRounds.Times memory) {
        return rounds.roundTimes(roundId);
    }

    function _warpClose(uint256 roundId) internal {
        vm.warp(_times(roundId).closeAt);
    }

    function _warpSettle(uint256 roundId) internal {
        vm.warp(_times(roundId).settleAt);
    }

    /// From strikeEnd on the pool sits at `tick`: the strike window keeps the
    /// earlier tick, the whole exit window sees this one.
    function _exitTick(PoolRoundMockPool p, uint256 roundId, int24 tick) internal {
        p.pushTick(uint32(_times(roundId).strikeEnd), tick);
    }

    function _exitTickOn(PoolRounds target, PoolRoundMockPool p, uint256 roundId, int24 tick) internal {
        p.pushTick(uint32(target.roundTimes(roundId).strikeEnd), tick);
    }

    function _up() internal pure returns (PoolRounds.Side) {
        return PoolRounds.Side.UP;
    }

    function _down() internal pure returns (PoolRounds.Side) {
        return PoolRounds.Side.DOWN;
    }
}
