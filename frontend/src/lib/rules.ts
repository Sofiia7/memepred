import { formatDuration } from './symbols'
import { MATCH_TIMEOUT_SEC, SETTLE_GRACE_SEC } from './orderTiming'

/**
 * The rules a trader is agreeing to when they sign, as numbers and sentences.
 *
 * Every number here mirrors a contract constant, and each one is printed to
 * users as a promise. They live in one file for the same reason MIN_BET and
 * MAX_BET live in lib/chain: prose that repeats a literal becomes a false
 * statement the day the contract's own constant moves. If a constant below
 * changes on chain, change it here and the Composer's pre-sign block, the
 * risk gate and the tests follow.
 */

/**
 * OrderbookMarket.MATCH_TIMEOUT: an unmatched remainder is refundable after
 * this. Derived from lib/orderTiming, where the order pages read the same
 * clock, so the two cannot disagree.
 */
export const MATCH_TIMEOUT_MIN = MATCH_TIMEOUT_SEC / 60

/** PoolOracleResolver.ENTRY_TWAP_WINDOW: the entry price is a 60 second average. */
export const ENTRY_TWAP_SEC = 60

/**
 * PoolOracleResolver.MAX_SPREAD_BPS (200) as a percentage: past this jump at
 * the end of the exit window the match is refunded instead of settled.
 */
export const PRICE_JUMP_REFUND_PCT = 2

/**
 * How long after the window closes the result normally lands. Not a contract
 * constant: it is the keeper's usual latency, so it is worded as "about".
 */
export const RESULT_DELAY_HINT_SEC = 60

/**
 * OrderbookMarket.SETTLE_GRACE: a pool with no liquidity at settlement is
 * retried, and refunded once this has passed at the latest.
 */
export const REFUND_GRACE_HOURS = SETTLE_GRACE_SEC / 3600

/** Price band a bet is placed with (the slippage tolerance the Composer sends). */
export const DEFAULT_SLIPPAGE_BPS = 100

/**
 * Native ETH worth keeping back for gas on Robinhood Chain: an approval and a
 * bet cost a small fraction of this, so it is a comfortable floor rather than
 * an estimate. Wrapping should not spend the wallet below it.
 */
export const GAS_RESERVE_ETH = '0.0005'
export const GAS_RESERVE_WEI = 500_000_000_000_000n

export interface RuleLine {
  id: 'matching' | 'timeout' | 'prices' | 'band' | 'refunds'
  title: string
  text: string
}

/**
 * The block shown before the confirm button on Robinhood Chain.
 *
 * Five short points, written so that none of them promises a guaranteed
 * outcome: the result timing is "about a minute", not "exactly at expiry", and
 * the refund rules say what happens rather than that nothing can go wrong.
 */
export function preSignRules(opts: { durationSec: number; slippageBps?: number }): RuleLine[] {
  const windowLabel = formatDuration(opts.durationSec)
  const bandPct = (opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS) / 100
  const resultMinutes = Math.max(1, Math.round(RESULT_DELAY_HINT_SEC / 60))
  const resultDelay = resultMinutes === 1 ? 'a minute' : `${resultMinutes} minutes`
  return [
    {
      id: 'matching',
      title: 'Who you trade against',
      text:
        'Your bet is matched against another trader or, on markets where it is enabled, ' +
        'against the LP vault. It can be filled in parts.',
    },
    {
      id: 'timeout',
      title: 'Unmatched part',
      text:
        `If nothing matches within ${MATCH_TIMEOUT_MIN} minutes, the unmatched part is refunded. ` +
        'You can cancel it any time before that.',
    },
    {
      id: 'prices',
      title: 'Entry and exit price',
      text:
        `Entry is the pool's ${ENTRY_TWAP_SEC} second average price (TWAP) when you are matched. ` +
        `Exit is its average when your ${windowLabel} window ends.`,
    },
    {
      id: 'band',
      title: 'Price band',
      text:
        `Your order waits only inside the ${bandPct}% price band you chose. If the market leaves it, ` +
        'the order is dropped from the queue and can be cancelled or refunded.',
    },
    {
      id: 'refunds',
      title: 'Refunds and timing',
      text:
        `If the price jumps more than ${PRICE_JUMP_REFUND_PCT}% at the end of the window, or the pool has no ` +
        'price history for it, both stakes are refunded immediately with no fee. ' +
        `The result normally arrives within about ${resultDelay} after the window ends.`,
    },
  ]
}
