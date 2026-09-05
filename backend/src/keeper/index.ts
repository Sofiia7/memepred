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
import { poolWatcherTick }        from './poolWatcher.js'
import { CHAIN_PROFILE }          from '../chainProfile.js'
import { runMigrations }          from '../db/migrate.js'
import { pg }                     from '../db/pg.js'
import { redis }                  from '../db/redis.js'

console.log(`Starting FlipTheMeme Keeper on the ${CHAIN_PROFILE.name} profile (chain ${CHAIN_PROFILE.chain.id})…`)

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

  const started: string[] = []
  const start = async (label: string, fn: () => Promise<unknown>, ms: number) => {
    await loop(label, fn, ms)
    started.push(label)
  }

  // Shared by both profiles. Settlement, refunds, indexing and the invariant
  // check do not care where a price came from.
  await start('probSnapshots',   snapshotProbabilities, 60_000)
  await start('indexer',         indexerTick,           45_000)
  await start('resolveKeeper',   settlePendingMarkets,  60_000)
  await start('refundExpired',   refundExpiredOrders,   5 * 60_000)
  await start('oracleWatchdog',  oracleWatchdogTick,    90_000)
  await start('invariantMonitor', invariantTick,        60_000)

  /**
   * The two loops that only make sense when a keeper is responsible for
   * prices, and the one that only makes sense when markets expire.
   *
   * On rhc neither is: a v3 pool keeps its own observation history, so there
   * is nothing to push, and a market has no close time, so there is nothing to
   * roll over. These were the entire recurring cost of the Base design, and
   * not starting them is most of why the rhc profile is affordable.
   */
  if (CHAIN_PROFILE.pushesPricesOnChain) {
    await start('priceRecorder',        recordAllPrices,     30_000)
    await start('onchainPriceRecorder', recordPricesOnChain, 30_000)
  }
  if (CHAIN_PROFILE.rollsOverMarkets) {
    // 30s, not 5 min: while idle this tick creates nothing, and when a visitor
    // arrives it is how fast the 5m and 15m markets come back onto the board.
    await start('marketCreator', createMissingMarkets, Number(process.env.CREATE_INTERVAL_MS ?? 30_000))
  }
  /** The rhc counterpart to a feed whitelist: onboard pools worth paying for. */
  if (CHAIN_PROFILE.watchesPools) {
    await start('poolWatcher', poolWatcherTick, Number(process.env.POOL_WATCH_INTERVAL_MS ?? 60_000))
  }
  // Slow on purpose: nothing about a badge is time-critical, and it is the one
  // loop here that mints for cosmetic reasons.
  await start('badgeSweep', badgeSweepTick, Number(process.env.BADGE_SWEEP_INTERVAL_MS ?? 10 * 60_000))

  // Listing what actually started, rather than a hardcoded sentence that would
  // keep claiming a price recorder on a chain that has none.
  console.log(`Keeper running on ${CHAIN_PROFILE.name}: ${started.join(', ')}`)
}

start().catch((err) => {
  console.error('Keeper failed to start:', err)
  process.exit(1)
})
