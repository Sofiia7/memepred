import 'dotenv/config'
import { recordAllPrices, snapshotProbabilities } from './priceRecorder.js'
import { refundExpiredOrders }    from './refundExpired.js'
import { indexerTick }            from './indexer.js'
import { recordPricesOnChain }    from './onchainPriceRecorder.js'
import { settlePendingMarkets }   from './resolveKeeper.js'
import { oracleWatchdogTick }     from './oracleWatchdog.js'
import { createMissingMarkets }   from './marketCreator.js'
import { badgeSweepTick } from './badgeSweep.js'
import { invariantTick }          from './invariantMonitor.js'
import { runMigrations }          from '../db/migrate.js'
import { pg }                     from '../db/pg.js'
import { redis }                  from '../db/redis.js'

console.log('Starting FlipTheMeme Keeper…')

async function loop(label: string, fn: () => Promise<unknown>, intervalMs: number) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try { await fn() } catch (err) { console.error(`[${label}] failed:`, err) }
    finally { running = false }
  }
  await tick()
  setInterval(tick, intervalMs)
}

async function start() {
  await pg.connect()
  await runMigrations()
  await redis.connect()
  console.log('Connected to DB + Redis, migrations applied')

  await loop('priceRecorder',        recordAllPrices,        30_000)
  await loop('onchainPriceRecorder', recordPricesOnChain,    30_000)
  await loop('probSnapshots',        snapshotProbabilities,  60_000)
  await loop('indexer',              indexerTick,            45_000)
  await loop('resolveKeeper',        settlePendingMarkets,   60_000)
  await loop('refundExpired',        refundExpiredOrders,    5 * 60_000)
  await loop('oracleWatchdog',       oracleWatchdogTick,     90_000)
  // 30s, not 5 min: while idle this tick creates nothing, and when a visitor
  // arrives it is how fast the 5m and 15m markets come back onto the board.
  await loop('marketCreator',        createMissingMarkets,   Number(process.env.CREATE_INTERVAL_MS ?? 30_000))
  await loop('invariantMonitor',     invariantTick,          60_000)
  // Slow on purpose: nothing about a badge is time-critical, and it is the one
  // loop here that mints for cosmetic reasons.
  await loop('badgeSweep',           badgeSweepTick,         Number(process.env.BADGE_SWEEP_INTERVAL_MS ?? 10 * 60_000))

  console.log('Keeper running: priceOffchain/30s, priceOnchain/30s, snapshots/60s, indexer/45s, resolver/60s, refund/5m, watchdog/90s, createMarkets/30s, invariant/60s, badges/10m')
}

start().catch((err) => {
  console.error('Keeper failed to start:', err)
  process.exit(1)
})
