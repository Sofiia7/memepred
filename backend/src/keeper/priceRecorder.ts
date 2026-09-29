import { pg } from '../db/pg.js'
import { FEED_SYMBOLS, FEED_IDS } from '../config.js'
import { fetchPrice } from '../lib/redstone.js'
import { andFactory } from '../lib/marketScope.js'

/**
 * Record prices from Pyth Hermes every 30 seconds.
 */
export async function recordAllPrices() {
  for (const [symbol, feedId] of Object.entries(FEED_IDS)) {
    try {
      // RedStone hands back a plain number, so there is no exponent to apply.
      // Median across authorised signers - see lib/redstone.ts.
      const priceUsd = await fetchPrice(symbol)

      await pg.query(
        'INSERT INTO price_history (feed_id, symbol, price, recorded_at) VALUES ($1, $2, $3, NOW())',
        [feedId, symbol, priceUsd]
      )

    } catch (err) {
      console.error(`Failed to record price for ${symbol}:`, err)
    }
  }
}

/**
 * Snapshot probability for open markets every minute.
 */
export async function snapshotProbabilities() {
  // On rhc only the current factory's markets: an earlier deployment's markets
  // stay OPEN forever there, and a row per dead market per minute is a table
  // that grows for nothing.
  const openMarkets = await pg.query(
    `SELECT market_address, up_pool, down_pool FROM markets WHERE status = 'OPEN'${andFactory('factory_address')}`
  )

  for (const row of openMarkets.rows) {
    await pg.query(
      'INSERT INTO prob_snapshots (market_address, up_pool, down_pool, snapshot_at) VALUES ($1, $2, $3, NOW())',
      [row.market_address, row.up_pool, row.down_pool]
    )
  }
}
