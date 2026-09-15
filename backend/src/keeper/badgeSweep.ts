/**
 * Award badges to addresses that have settled something recently.
 *
 * The badge machinery has been complete for months and unreachable: sixteen
 * conditions implemented, a contract that can mint them, a profile endpoint
 * that reads `minted_badges`, and nothing anywhere that writes to it.
 * badgeService.ts was imported by no file in the repository, so the grid on
 * every profile was permanently empty.
 *
 * A sweep rather than a hook on settlement, for two reasons. Minting is a
 * transaction, and hanging one off the indexer would put a wallet, a gas price
 * and a possible revert in the path of indexing chain events - the one loop
 * that must not stall. And several badges do not depend on the trader's own
 * last bet at all: Champion is a position on the weekly leaderboard, Connector
 * and Network count referrals who have since placed their first bet. Those
 * become true while the holder is doing nothing.
 */
import { pg } from '../db/pg.js'
import { checkAndMintBadges } from '../services/badgeService.js'

/**
 * Addresses considered per tick.
 *
 * Each one is a handful of queries and, when something is actually earned, a
 * transaction. Bounded so a busy day cannot turn this into the loop that
 * spends the routine gas budget; the rest are picked up on later ticks, and
 * nothing about a badge is time-critical.
 */
const MAX_PER_TICK = Number(process.env.BADGE_SWEEP_MAX ?? '20')

/** How far back a settlement still makes an address interesting. */
const LOOKBACK = '2 days'

export async function badgeSweepTick() {
  // See badgeService.ts: accepts BADGE_MINTER_PRIVATE_KEY too, since that is
  // what .env.rhc was actually set up with.
  if (!process.env.BADGE_MINTER_KEY && !process.env.BADGE_MINTER_PRIVATE_KEY) return // nothing to sign with; stay quiet

  const { rows } = await pg.query<{ trader_address: string }>(
    `SELECT DISTINCT o.trader_address
       FROM orders o
      WHERE o.status IN ('SETTLED', 'CLAIMED')
        AND o.settled_at > NOW() - INTERVAL '${LOOKBACK}'
      ORDER BY o.trader_address
      LIMIT $1`,
    [MAX_PER_TICK],
  )

  for (const { trader_address } of rows) {
    try {
      await checkAndMintBadges(trader_address)
    } catch (err) {
      // One address failing must not stop the others. Short message only: this
      // runs on a timer and a full viem error object per address per tick is
      // how the keeper once wrote 4 GB of logs in three days.
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
      console.warn(`[badges] ${trader_address}: ${msg}`)
    }
  }
}
