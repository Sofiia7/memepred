import { recordAllPrices, snapshotProbabilities } from './priceRecorder.js'
import { refundExpiredOrders } from './refundExpired.js'
import { pg } from '../db/pg.js'
import { redis } from '../db/redis.js'

console.log('Starting MemePred Keeper...')

async function start() {
  await pg.connect()
  await redis.connect()

  console.log('Connected to DB and Redis')

  // Record prices every 30 seconds
  setInterval(async () => {
    try {
      await recordAllPrices()
    } catch (err) {
      console.error('Price recording failed:', err)
    }
  }, 30_000)

  // Snapshot probabilities every 60 seconds
  setInterval(async () => {
    try {
      await snapshotProbabilities()
    } catch (err) {
      console.error('Probability snapshot failed:', err)
    }
  }, 60_000)

  // Refund expired orders every 5 minutes
  setInterval(async () => {
    try {
      await refundExpiredOrders()
    } catch (err) {
      console.error('Refund expired failed:', err)
    }
  }, 5 * 60_000)

  // Initial run
  await recordAllPrices()
  await snapshotProbabilities()

  console.log('Keeper running — prices 30s, snapshots 60s, refunds 5min')
}

start().catch((err) => {
  console.error('Keeper failed to start:', err)
  process.exit(1)
})
