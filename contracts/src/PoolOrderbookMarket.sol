// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./OrderbookMarket.sol";
import "./interfaces/IPoolPriceSource.sol";

/**
 * @title  PoolOrderbookMarket
 * @notice OrderbookMarket priced from a Uniswap v3 pool and staked in WETH.
 *
 * @dev    Everything that makes a market a market - the order book, partial
 *         fills, the LP fallback, settlement, claims, refunds - is inherited
 *         unchanged. Four things differ, and all four are one-line overrides.
 *
 *         **The strike comes from the resolver, not from calldata.** This is
 *         the change that pays for itself twice over. On Base a price is a
 *         RedStone payload appended to the calldata of every call, which means
 *         no call can be made with an ordinary `writeContract` - not from the
 *         frontend, not from the keeper, not from a block explorer. Both have
 *         had bugs from hand-assembling that calldata. Here placeBet is a
 *         normal transaction.
 *
 *         Asking the resolver rather than reading the pool directly is
 *         deliberate: the resolver already owns tick-to-price, and a second
 *         copy of that arithmetic here would be a second thing to get wrong -
 *         the mistake OracleResolver._settleOne carries a comment about.
 *
 *         It also keeps TickMath out of this contract's bytecode, which was
 *         expected to matter and, measured, matters less than feared. The
 *         design doc predicted this subclass would inherit the whole RedStone
 *         verification path as dead weight. It does not: overriding
 *         _getCurrentPrice removes the only call to
 *         getOracleNumericValueFromTxMsg, so the unreachable half of that path
 *         is stripped and the child comes to **16,021 bytes against the
 *         parent's 17,810** - 8,555 bytes under EIP-170 rather than 6,766.
 *         RedStone is not gone entirely: aggregateValues,
 *         getAuthorisedSignerIndex and three more are public, so the five
 *         hardcoded signer addresses are still in there. They are simply
 *         unreachable, because nothing calls the verifier any more.
 *
 *         **The stake limits are restated in WETH.** The inherited values are
 *         6-decimal USDC amounts; 1e6 wei is not a minimum bet, it is dust.
 *         The numbers here come from measurement, not from taste - see below.
 */
contract PoolOrderbookMarket is OrderbookMarket {
    constructor(
        address _weth,
        address _resolver,
        address _liquidityPool,
        address _feeDistributor,
        address _referralRegistry,
        address _multisig,
        bytes32 _feedId,
        uint256 _duration
    )
        OrderbookMarket(
            _weth, _resolver, _liquidityPool, _feeDistributor, _referralRegistry, _multisig, _feedId, _duration
        )
    {}

    /**
     * The floor is set by gas, not by product taste.
     *
     * The protocol takes at most 1% of the bank (MarketFactory.FEE_MAX, a
     * constant), the bank is twice one side's stake, and settling a match costs
     * gas whatever the stake was. Break-even is therefore
     *
     *     0.01 * 2X > gas      i.e.      X > 50 * gas
     *
     * Settlement costs 137,926 gas per additional match, measured on chain
     * 46630 rather than derived: five matches in one batch cost 774,563 gas
     * against 222,861 for one, so the marginal is (774,563 - 222,861) / 4 and
     * the fixed part of the transaction is the remaining 84,935.
     *
     * That testnet runs a stand-in pool whose observe() is cheaper than a real
     * one's binary search over a populated ring - measured at 17,397 against
     * 41,500 on a live mainnet pool - so mainnet should be about 162,029.
     *
     * Batching does not rescue this: it removes 19%, not the "several times"
     * the design doc assumed, because the cost is per-match storage writes.
     *
     * Gas over the sampled period ran 0.383 to 3.059 gwei with a p90 of 0.612.
     * At 162,029 gas that puts break-even at 0.00496 ETH, so 0.005.
     *
     * p90 rather than the maximum on purpose: the spikes are short - the one
     * caught in the sample lasted four minutes - and a settlement is not
     * urgent, because its exit price is anchored to the match's own settleAt
     * rather than to whenever the keeper ran. The keeper waits the spike out.
     * Pricing for the maximum instead would put the floor at 0.025 ETH against
     * a 0.04 ETH ceiling, which is not a product.
     *
     * This was 0.004 until the live measurement. The bench alone had put the
     * marginal at 129,675, which made 0.004 break-even to within 1%; the real
     * chain is 25% dearer than that, and 0.004 covers gas only up to 0.494
     * gwei - below the p90 it was supposed to clear. The gas sample is still
     * short, so this is a number to check again before mainnet.
     */
    function MIN_BET() public view virtual override returns (uint256) {
        return 0.005 ether;
    }

    /// Unaudited-protocol ceiling, the same posture as Base's $100 cap: small
    /// enough that the worst case is survivable, and meant to be lifted once
    /// there is an audit to point at.
    function MAX_BET() public view virtual override returns (uint256) {
        return 0.04 ether;
    }

    /// 3x MAX_BET, the same ratio the inherited value has to its own cap.
    function MAX_TRADER_LP_EXPOSURE() public view virtual override returns (uint256) {
        return 0.12 ether;
    }

    /**
     * @dev The strike, from the pool's own 60-second TWAP.
     *
     *      Reverts rather than returning a stale or zero price: this is the
     *      entry path, and the inherited placeBet checks the caller's expected
     *      price against this one for slippage, so a wrong answer here is a bet
     *      opened at a strike nobody agreed to.
     */
    function _getCurrentPrice() internal view virtual override returns (uint256) {
        uint256 price = IPoolPriceSource(resolver).spotPriceWad(feedId);
        require(price > 0, "non-positive price");
        return price;
    }
}
