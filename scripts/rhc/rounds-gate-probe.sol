// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolRounds} from "../../contracts/src/PoolRounds.sol";
import {ReferralRegistry} from "../../contracts/src/ReferralRegistry.sol";
import {IUniswapV3Pool, IUniswapV3Factory} from "../../contracts/src/interfaces/IUniswapV3.sol";
import {TickMath} from "../../contracts/src/lib/TickMath.sol";

/// The two controls of the testnet stand-in pools (contracts/test/mocks/MockUniswapV3Pool.sol)
/// the probe needs: the ring size and the stored price steps.
interface IStandInPool {
    function setCardinality(uint16 c, uint16 next) external;
    function setLiquidity(uint128 l) external;
    function segments(uint256 i) external view returns (uint32 startTs, int24 tick);
}

/**
 * @title  RoundsGateProbe
 * @notice READ-ONLY by construction: it is meant to run ONLY as the init code of
 *         an eth_call without a `to` field (scripts/rhc/rounds-gate-check.mts).
 *         Nothing it does is persisted: the node executes the constructor on a
 *         throwaway copy of the state and returns what the constructor returns.
 *
 * @dev    Inside that simulation it does, against the real testnet state:
 *           1. deploys a fresh ReferralRegistry and a PoolRounds with the
 *              parameters DeployPoolRounds.s.sol uses by default, and wires them
 *              the way the script does (gas of each step);
 *           2. for every pool: the listing gate's inputs (tokens, canonical pool,
 *              WETH depth, ring, history) and listPool as the owner would call it;
 *           3. the fixes a stand-in pool allows anyone to make, one at a time, with
 *              listPool after each: the ring (setCardinality(minCardinality)),
 *              then the depth (setLiquidity to `deepenTo` wei of WETH depth);
 *           4. whether the pool reports secondsPerLiquidityCumulativeX128, the
 *              second array of observe() from which fixStrike and settle now take
 *              the WETH depth a window carried (re-audit V3-1, V3-2): a pool that
 *              returns zeros there carries depth 0 in every window;
 *           5. the gas of observe() with 2, 3 and 5 points, the reads fixStrike
 *              and settle make, because on a stand-in pool it grows with every
 *              stored price step.
 *         Gas is gasleft() around each call, so it excludes the 21 000 base, the
 *         calldata and the L1 component of a real transaction.
 */
contract RoundsGateProbe {
    struct PoolResult {
        address pool;
        address token0;
        address token1;
        uint24 fee;
        bool wethIsToken0;
        bool isWethPool;
        bool canonical;
        uint256 liquidity;
        int24 tick;
        uint16 cardinality;
        uint16 cardinalityNext;
        uint256 depth;
        uint256 gateDepth;
        bool canServeWindow;
        uint256 segments;
        uint32 firstSegmentTs;
        uint32 lastSegmentTs;
        bool listedAsIs;
        bytes listErrorAsIs;
        uint256 listGasAsIs;
        bool growOk;
        uint256 growGas;
        uint16 cardinalityAfterGrow;
        bool listedAfterGrow;
        bytes listErrorAfterGrow;
        uint256 listGasAfterGrow;
        bool deepenOk;
        uint256 depthAfterDeepen;
        bool listedAfterDeepen;
        bytes listErrorAfterDeepen;
        uint256 splDelta;
        uint256 windowDepth;
        uint256 observe2Gas;
        uint256 observe3Gas;
        uint256 observe5Gas;
    }

    struct Result {
        uint256 chainId;
        uint256 blockNumber;
        uint256 timestamp;
        uint256 registryDeployGas;
        uint256 roundsDeployGas;
        uint256 wireGas;
        uint256 minCardinality;
        address rounds;
        PoolResult[] pools;
    }

    /// `cfg` = [maxSideRatio, strikePause, strikeWindow, depthPerBank, minStake, maxStake, minBank,
    /// costAllowance, deepenTo]: DeployPoolRounds.s.sol's defaults, which the caller reads from the
    /// script's source (scripts/rhc/rounds-lib.mts), and the depth the probe raises a pool to.
    uint256 internal deepenTo;

    constructor(address weth, address v3Factory, address[] memory pools, uint256[9] memory cfg) {
        deepenTo = cfg[8];
        Result memory r;
        r.chainId = block.chainid;
        r.blockNumber = block.number;
        r.timestamp = block.timestamp;

        uint256 g = gasleft();
        ReferralRegistry registry = new ReferralRegistry();
        r.registryDeployGas = g - gasleft();

        g = gasleft();
        PoolRounds rounds = new PoolRounds(
            PoolRounds.Params({
                weth: weth,
                v3Factory: v3Factory,
                referralRegistry: address(registry),
                treasury: address(this),
                maxSideRatio: cfg[0],
                strikePause: cfg[1],
                strikeWindow: cfg[2],
                depthPerBank: cfg[3],
                minStake: cfg[4],
                maxStake: cfg[5],
                minBank: cfg[6],
                costAllowance: cfg[7]
            })
        );
        r.roundsDeployGas = g - gasleft();
        r.rounds = address(rounds);
        r.minCardinality = rounds.minCardinality();

        g = gasleft();
        registry.setMarketFactory(address(rounds));
        registry.authorizeMarket(address(rounds));
        rounds.setDuration(300, true);
        rounds.setPauser(address(0xBEEF));
        r.wireGas = g - gasleft();

        r.pools = new PoolResult[](pools.length);
        for (uint256 i = 0; i < pools.length; i++) {
            r.pools[i] = _probePool(rounds, weth, v3Factory, pools[i], uint16(r.minCardinality));
            _probeDepthSource(rounds, r.pools[i]);
        }

        bytes memory out = abi.encode(r);
        assembly {
            return(add(out, 32), mload(out))
        }
    }

    function _probePool(PoolRounds rounds, address weth, address v3Factory, address pool, uint16 need)
        internal
        returns (PoolResult memory p)
    {
        IUniswapV3Pool u = IUniswapV3Pool(pool);
        p.pool = pool;
        p.token0 = u.token0();
        p.token1 = u.token1();
        p.fee = u.fee();
        p.wethIsToken0 = p.token0 == weth;
        p.isWethPool = p.wethIsToken0 || p.token1 == weth;
        p.canonical = IUniswapV3Factory(v3Factory).getPool(p.token0, p.token1, p.fee) == pool;
        p.liquidity = u.liquidity();
        (, p.tick,, p.cardinality, p.cardinalityNext,,) = u.slot0();
        if (p.isWethPool) p.depth = rounds.wethDepth(pool);
        p.gateDepth = rounds.gateDepth();
        p.canServeWindow = rounds.canServeWindow(pool, 300);
        (p.segments, p.firstSegmentTs, p.lastSegmentTs) = _segments(pool);

        uint256 g = gasleft();
        (p.listedAsIs, p.listErrorAsIs) = address(rounds).call(abi.encodeCall(PoolRounds.listPool, (pool)));
        p.listGasAsIs = g - gasleft();

        if (!p.listedAsIs) {
            g = gasleft();
            (p.growOk,) = pool.call(abi.encodeCall(IStandInPool.setCardinality, (need, need)));
            p.growGas = g - gasleft();
            (,,, p.cardinalityAfterGrow,,,) = u.slot0();
            g = gasleft();
            (p.listedAfterGrow, p.listErrorAfterGrow) =
                address(rounds).call(abi.encodeCall(PoolRounds.listPool, (pool)));
            p.listGasAfterGrow = g - gasleft();
        } else {
            p.cardinalityAfterGrow = p.cardinality;
            p.listedAfterGrow = true;
        }

        // The reads of a 300 s round: fixStrike at strikeEnd + 5 s (strike window),
        // settle at settleAt + 5 s with the strike fixed (3 points) or not (5 points).
        p.observe2Gas = _observeGas(u, _ages2());
        p.observe3Gas = _observeGas(u, _ages3());
        p.observe5Gas = _observeGas(u, _ages5());
    }

    /// The depth fix, then the window depth the pool would report to fixStrike and settle.
    function _probeDepthSource(PoolRounds rounds, PoolResult memory p) internal {
        IUniswapV3Pool u = IUniswapV3Pool(p.pool);
        if (!p.listedAfterGrow) {
            // `deepenTo` of WETH depth at the current tick: L = depth x (sqrt(P) or 1 / sqrt(P)).
            (uint160 sqrtP,,,,,,) = u.slot0();
            uint256 l = p.wethIsToken0 ? (deepenTo * uint256(sqrtP)) >> 96 : (deepenTo << 96) / sqrtP;
            (p.deepenOk,) = p.pool.call(abi.encodeCall(IStandInPool.setLiquidity, (uint128(l))));
            p.depthAfterDeepen = rounds.wethDepth(p.pool);
            (p.listedAfterDeepen, p.listErrorAfterDeepen) =
                address(rounds).call(abi.encodeCall(PoolRounds.listPool, (p.pool)));
        } else {
            p.listedAfterDeepen = true;
            p.depthAfterDeepen = p.depth;
        }
        // The strike window of a round, as fixStrike reads it: [strikeStart, strikeEnd] = 305 .. 5 s ago.
        uint32[] memory a = _ages2();
        try u.observe(a) returns (int56[] memory, uint160[] memory spl) {
            unchecked {
                p.splDelta = uint256(spl[1] - spl[0]);
            }
            if (p.splDelta > 0) {
                (, int24 tick,,,,,) = u.slot0();
                p.windowDepth = _depthFromSpl(p.splDelta, tick, p.wethIsToken0);
            }
        } catch {}
    }

    /// PoolRoundOracle.windowDepth for a 300 s window: harmonic-mean liquidity to WETH depth.
    function _depthFromSpl(uint256 delta, int24 tick, bool wethIsToken0) internal pure returns (uint256) {
        uint256 l = (uint256(300) << 128) / delta;
        uint160 sqrtP = TickMath.getSqrtRatioAtTick(tick);
        return wethIsToken0 ? (l << 96) / sqrtP : (l * sqrtP) >> 96;
    }

    function _observeGas(IUniswapV3Pool u, uint32[] memory ages) internal view returns (uint256 used) {
        uint256 g = gasleft();
        try u.observe(ages) returns (int56[] memory, uint160[] memory) {
            used = g - gasleft();
        } catch {
            used = type(uint256).max;
        }
    }

    function _ages2() internal pure returns (uint32[] memory a) {
        a = new uint32[](2);
        a[0] = 305;
        a[1] = 5;
    }

    function _ages3() internal pure returns (uint32[] memory a) {
        a = new uint32[](3);
        a[0] = 65;
        a[1] = 25;
        a[2] = 5;
    }

    function _ages5() internal pure returns (uint32[] memory a) {
        a = new uint32[](5);
        a[0] = 65;
        a[1] = 25;
        a[2] = 5;
        a[3] = 905;
        a[4] = 605;
    }

    /// Number of stored price steps (exponential then binary search over the public array).
    function _segments(address pool) internal view returns (uint256 n, uint32 firstTs, uint32 lastTs) {
        IStandInPool s = IStandInPool(pool);
        if (!_has(s, 0)) return (0, 0, 0);
        uint256 lo = 0; // known present
        uint256 hi = 1; // probe upward until absent
        while (_has(s, hi)) {
            lo = hi;
            hi *= 2;
            if (hi > 1 << 20) return (type(uint256).max, 0, 0);
        }
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (_has(s, mid)) lo = mid;
            else hi = mid;
        }
        n = lo + 1;
        (firstTs,) = s.segments(0);
        (lastTs,) = s.segments(lo);
    }

    function _has(IStandInPool s, uint256 i) internal view returns (bool) {
        try s.segments(i) returns (uint32, int24) {
            return true;
        } catch {
            return false;
        }
    }
}
