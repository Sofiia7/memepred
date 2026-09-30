/**
 * The rounds keeper wired to the real chain, wallet, gas guard and Redis.
 *
 * keeper/index.ts loads this file only when ROUNDS_ENABLED=true (a dynamic
 * import behind config.roundsEnabled), so with rounds off none of it, not even
 * its clients, exists in the process.
 *
 * Shared with the keeper of the existing markets, deliberately:
 *   - the wallet and sendKeeperTx (keeperWallet.ts): one EOA, one nonce
 *     sequence. A second wallet object would collide on nonces with the other
 *     loops, which is the 2026-07-06 incident that module exists to prevent;
 *   - the gas guard (gasGuardInstance.ts): round work is billed as critical and
 *     fee withdrawal as routine, so the wallet's daily figures stay whole.
 *
 * Switched on but unable to start (a bad ROUNDS_ADDRESS, a poll outside
 * 1-10 s, no keeper key): the rounds loop does not run, every other loop does,
 * and a snapshot carrying the error is published once a minute so that
 * /health/deep reads rounds-config-invalid instead of saying nothing.
 */
import { createPublicClient, http, type PublicClient } from 'viem'
import { CHAIN_PROFILE } from '../chainProfile.js'
import { redis } from '../db/redis.js'
import { getKeeperWalletClient, sendKeeperTx } from '../keeper/keeperWallet.js'
import { gasGuard, recordReceipt } from '../keeper/gasGuardInstance.js'
import { readRoundsConfig } from './config.js'
import { createViemRoundsChain, type RoundsWallet } from './chain.js'
import { createRedisRoundsStore, ROUNDS_STATE_KEY, ROUNDS_STATE_TTL_SEC, type RedisLike } from './store.js'
import { createRoundsKeeper } from './keeper.js'

type Start = (label: string, fn: () => Promise<unknown>, intervalMs: number) => Promise<void>

async function refuse(start: Start, error: string): Promise<void> {
  console.error(`[rounds] ROUNDS_ENABLED=true but not started: ${error}`)
  await start('roundsConfigError', async () => {
    await redis.setEx(ROUNDS_STATE_KEY, ROUNDS_STATE_TTL_SEC, JSON.stringify({ version: 1, lastTick: Date.now(), configError: error }))
  }, 60_000)
}

export async function startRoundsKeeper(start: Start): Promise<void> {
  const r = readRoundsConfig(process.env)
  if (!r.enabled) {
    if (r.error) await refuse(start, r.error)
    return
  }
  const wallet = getKeeperWalletClient()
  if (!wallet) {
    await refuse(start, 'KEEPER_PRIVATE_KEY is missing')
    return
  }
  const { config } = r
  const publicClient = createPublicClient({ chain: CHAIN_PROFILE.chain, transport: http(CHAIN_PROFILE.rpcUrl) }) as PublicClient

  const keeper = createRoundsKeeper({
    chain: createViemRoundsChain({ publicClient, wallet: wallet as unknown as RoundsWallet, address: config.deployment.address }),
    store: createRedisRoundsStore(redis as unknown as RedisLike, config.deployment.address),
    sendTx: sendKeeperTx,
    gasGuard: { check: (p) => gasGuard.check(p), record: (receipt, p) => recordReceipt(receipt, p) },
    config,
  })

  console.log(
    `[rounds] PoolRounds keeper on ${config.deployment.address} ` +
    `(start block ${config.deployment.startBlock ?? 'lookback'}, every ${config.intervalMs} ms)`,
  )
  await start('roundsKeeper', keeper.tick, config.intervalMs)
}
