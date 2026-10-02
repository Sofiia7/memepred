// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/PoolRounds.sol";
import "../src/ReferralRegistry.sol";

/**
 * @title  DeployPoolRounds
 * @notice Deploys PoolRounds (interface v3), the matched rounds of
 *         docs/rhc/POSITIVE-EV.md (candidate v2, third edition), next to the
 *         existing Robinhood Chain stack. Used for the Robinhood Chain testnet
 *         deployment on 30 September 2026; see docs/rhc/DEPLOYMENTS.md.
 *
 * @dev    Same shape as DeployRhc.s.sol: deploy, wire, operational roles,
 *         handover; mainnet (4663) refuses to run without handover.
 *
 *         Referrals. By default a NEW ReferralRegistry is deployed and pointed
 *         at PoolRounds, which answers the registry's isMarket() for itself, so
 *         bet() can record links without any change to the registry's code.
 *         ROUNDS_REFERRAL_REGISTRY instead reuses a deployed registry: PoolRounds
 *         then only reads referrerOf(), and links made through bet() are
 *         silently skipped, because that registry's factory is already set to
 *         PoolMarketFactory, once and for all, and cannot vouch for PoolRounds.
 *         The constructor refuses a registry address without code (audit M1).
 *
 *         Pools. listPool() applies the gate of PoolMarketFactory in code (audit
 *         M2): canonical WETH pool, WETH depth of at least gateDepth() =
 *         max(2, depthPerBank x minBank) (50 WETH with the defaults), a ring of at
 *         least minCardinality slots (900 with the default strike window) and
 *         history for the strike window. A pool in ROUNDS_POOLS that fails it stops the
 *         script: grow its ring first (increaseObservationCardinalityNext).
 *
 *         Defaults, all overridable by environment:
 *           ROUNDS_MAX_SIDE_RATIO  1: accepted = min(UP, DOWN), a fixed 1.96x (POSITIVE-EV.md rule 2).
 *                                  The script refuses anything else: at cap 4 a two-sided bettor wins on a
 *                                  skewed book without any forecast (re-audit V3-6). The contract itself
 *                                  still accepts 1..4 so that the reference can be checked at both caps.
 *           ROUNDS_STRIKE_PAUSE    300 s between the close of betting and the strike window (rule 4)
 *           ROUNDS_STRIKE_WINDOW   60 s averaged for the strike. POSITIVE-EV.md rule 4 measured 300 s; the
 *                                  owner chose 60 on 2 October 2026 so that the result comes 11 minutes after
 *                                  the close instead of 15 (section 16 of pool-toxicity: the ordinary player
 *                                  loses 7.2% instead of 4.3% at 2 bets per hour, 3.3% instead of 2.2% at 5)
 *           ROUNDS_DEPTH_PER_BANK  2500: a round's accepted bank <= pool WETH depth / 2500 (re-audit V3-1);
 *                                  with ROUNDS_MIN_BANK 0.02 a pool needs 50 WETH of depth to be listed
 *           ROUNDS_MIN_STAKE       0.005 WETH, the current MIN_BET
 *           ROUNDS_MAX_STAKE       0.04 WETH, the current unaudited cap
 *           ROUNDS_COST_ALLOWANCE  69 692 gwei = 1 000 000 gas x 0.069692 gwei (p99, 15-29.09)
 *           ROUNDS_MIN_BANK        0.02 WETH (POSITIVE-EV.md rule 5 and its gas table)
 *           ROUNDS_DURATIONS       300 (rule 8: only 300 s)
 *           ROUNDS_POOLS           none
 */
contract DeployPoolRounds is Script {
    struct Env {
        uint256 deployerKey;
        address deployer;
        address multisig;
        address treasury;
        address keeper;
        address weth;
        address v3Factory;
        address existingRegistry;
        uint256 maxSideRatio;
        uint256 strikePause;
        uint256 strikeWindow;
        uint256 depthPerBank;
        uint256 minStake;
        uint256 maxStake;
        uint256 minBank;
        uint256 costAllowance;
        uint256[] durations;
        address[] pools;
        bool handover;
    }

    function _loadEnv() internal view returns (Env memory e) {
        e.deployerKey = vm.envUint("PRIVATE_KEY");
        e.deployer = vm.addr(e.deployerKey);
        e.multisig = vm.envAddress("MULTISIG_ADDRESS");
        e.treasury = vm.envAddress("TREASURY_ADDRESS");
        e.keeper = vm.envAddress("KEEPER_ADDRESS");
        // No defaults, as in DeployRhc: a default would be an address with no code.
        e.weth = vm.envAddress("RHC_WETH_ADDRESS");
        e.v3Factory = vm.envAddress("RHC_V3_FACTORY_ADDRESS");
        e.existingRegistry = vm.envOr("ROUNDS_REFERRAL_REGISTRY", address(0));

        e.maxSideRatio = vm.envOr("ROUNDS_MAX_SIDE_RATIO", uint256(1));
        e.strikePause = vm.envOr("ROUNDS_STRIKE_PAUSE", uint256(300));
        e.strikeWindow = vm.envOr("ROUNDS_STRIKE_WINDOW", uint256(60));
        e.depthPerBank = vm.envOr("ROUNDS_DEPTH_PER_BANK", uint256(2500));
        e.minStake = vm.envOr("ROUNDS_MIN_STAKE", uint256(0.005 ether));
        e.maxStake = vm.envOr("ROUNDS_MAX_STAKE", uint256(0.04 ether));
        e.costAllowance = vm.envOr("ROUNDS_COST_ALLOWANCE", uint256(69_692e9));
        e.minBank = vm.envOr("ROUNDS_MIN_BANK", uint256(0.02 ether));
        uint256[] memory defaultDurations = new uint256[](1);
        defaultDurations[0] = 300;
        e.durations = vm.envOr("ROUNDS_DURATIONS", ",", defaultDurations);
        e.pools = vm.envOr("ROUNDS_POOLS", ",", new address[](0));
        e.handover = vm.envOr("RHC_HANDOVER", block.chainid == 4663);

        require(
            e.multisig != address(0) && e.multisig != e.deployer,
            "MULTISIG_ADDRESS must be set and differ from deployer"
        );
        require(e.treasury != address(0), "TREASURY_ADDRESS not set");
        require(e.weth.code.length > 0, "RHC_WETH_ADDRESS has no code on this chain");
        require(e.v3Factory.code.length > 0, "RHC_V3_FACTORY_ADDRESS has no code on this chain");
        require(
            e.existingRegistry == address(0) || e.existingRegistry.code.length > 0,
            "ROUNDS_REFERRAL_REGISTRY has no code"
        );
        require(block.chainid != 4663 || e.handover, "mainnet deployment must hand over to the multisig");
        require(e.maxSideRatio == 1, "ROUNDS_MAX_SIDE_RATIO must be 1: cap 4 pays a two-sided bettor (re-audit V3-6)");
    }

    function run() external {
        Env memory e = _loadEnv();
        vm.startBroadcast(e.deployerKey);
        _deploy(e);
        vm.stopBroadcast();
    }

    function _deploy(Env memory e) internal {
        // ── 1. Deploy ────────────────────────────────────────
        bool fresh = e.existingRegistry == address(0);
        ReferralRegistry registry = fresh ? new ReferralRegistry() : ReferralRegistry(e.existingRegistry);
        PoolRounds rounds = new PoolRounds(
            PoolRounds.Params({
                weth: e.weth,
                v3Factory: e.v3Factory,
                referralRegistry: address(registry),
                treasury: e.treasury,
                maxSideRatio: e.maxSideRatio,
                strikePause: e.strikePause,
                strikeWindow: e.strikeWindow,
                depthPerBank: e.depthPerBank,
                minStake: e.minStake,
                maxStake: e.maxStake,
                minBank: e.minBank,
                costAllowance: e.costAllowance
            })
        );
        console.log("chainId:", block.chainid);
        console.log("PoolRounds:", address(rounds));
        console.log(fresh ? "ReferralRegistry (new):" : "ReferralRegistry (reused, read only):", address(registry));
        console.log("minCardinality for listing:", rounds.minCardinality());
        console.log("gateDepth (wei of WETH) for listing:", rounds.gateDepth());

        // ── 2. Wire ──────────────────────────────────────────
        if (fresh) {
            registry.setMarketFactory(address(rounds));
            registry.authorizeMarket(address(rounds));
        }
        for (uint256 i = 0; i < e.durations.length; i++) {
            rounds.setDuration(e.durations[i], true);
        }
        for (uint256 i = 0; i < e.pools.length; i++) {
            rounds.listPool(e.pools[i]);
            console.log("listed pool:", e.pools[i]);
        }

        // ── 3. Operational role: the keeper may pause new bets, never unpause ──
        rounds.setPauser(e.keeper);

        // ── 4. Handover ──────────────────────────────────────
        if (e.handover) {
            // Ownable2Step: the multisig must still call acceptOwnership().
            rounds.transferOwnership(e.multisig);
            if (fresh) registry.transferOwnership(e.multisig);
            console.log("\n--- Handover started ---");
            console.log("PoolRounds pending owner (must acceptOwnership):", e.multisig);
        } else {
            console.log("\n--- NO HANDOVER ---");
            console.log("deployer still owns PoolRounds:", e.deployer);
        }

        console.log("\n--- Copy to .env ---");
        console.log("POOL_ROUNDS=%s", address(rounds));
        console.log("POOL_ROUNDS_REFERRAL_REGISTRY=%s", address(registry));
    }
}
