import { pg } from '../db/pg.js'
import { FEED_IDS, PYTH_HERMES } from '../config.js'

/**
 * Record prices from Pyth Hermes every 30 seconds.
 */
export async function recordAllPrices() {
  for (const [symbol, feedId] of Object.entries(FEED_IDS)) {
    try {
      const hermesUrl = `${PYTH_HERMES}/api/latest_price_feeds?ids[]=${feedId}&binary=true`
      const hermes    = await fetch(hermesUrl)
      const data      = await hermes.json() as any[]

      if (!data[0]) continue

      const price   = parseInt(data[0].price.price)
      const expo    = data[0].price.expo
      const priceUsd = price * Math.pow(10, expo)

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
  const openMarkets = await pg.query(
    "SELECT market_address, up_pool, down_pool FROM markets WHERE status = 'OPEN'"
  )

  for (const row of openMarkets.rows) {
    await pg.query(
      'INSERT INTO prob_snapshots (market_address, up_pool, down_pool, snapshot_at) VALUES ($1, $2, $3, NOW())',
      [row.market_address, row.up_pool, row.down_pool]
    )
  }
}
