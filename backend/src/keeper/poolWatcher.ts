/**
 * poolWatcher - the rhc profile's replacement for a feed whitelist.
 *
 * On Base a market exists because a multisig called `addFeed`. On Robinhood
 * Chain 496 pools are created a day and no multisig can keep up, so the
 * decision moves here: watch the canonical Uniswap v3 factory, and onboard the
 * pools worth paying for.
 *
 * **Polling, not a subscription.** The design doc called for an Alchemy
 * websocket, since the public RPC offers no subscriptions. This polls
 * eth_getLogs instead, and that is a better fit rather than a fallback: the
 * watcher already needs a durable cursor (it must survive a restart without
 * re-onboarding or skipping pools), and once there is a cursor, a subscription
 * only saves latency the watcher does not need - a pool is not tradeable the
 * second it exists, it has to accumulate liquidity and observation history
 * first. The public RPC serves 100k-block ranges, which is about two hours of
 * this chain, so a tick is a handful of requests. Switching to a websocket
 * later means changing where new pools come from, not how they are judged.
 *
 * **The keeper's threshold is not the contract's.** PoolMarketFactory admits
 * pools from 2 ETH of depth so that anyone may create a market on a thin pool
 * at their own expense. This watcher spends our money, so it holds out for
 * KEEPER_MIN_POOL_DEPTH_ETH (20 by default). The gap between the two is
 * deliberate: pools we will not pay for, but will not prevent.
 *
 * Every decision is logged with its reason and written to pool_candidates, so
 * "why is there no market on X" is answerable without re-deriving anything.
 */
import { createPublicClient, http, parseAbiItem, type Address } from 'viem'
import { pg } from '../db/pg.js'
import { CHAIN_PROFILE } from '../chainProfile.js'
import { CONTRACTS } from '../config.js'
import { getKeeperWalletClient, sendKeeperTx } from './keeperWallet.js'
import { gasGuard, recordReceipt } from './gasGuardInstance.js'
import { decidePool, formatEth, type AdmissionPolicy, type PoolObservation } from './poolAdmission.js'
import { POOL_MARKET_FACTORY_ABI } from '../lib/poolFactoryAbi.js'

const STREAM = 'rhc:pool_created'

/** Two hours of this chain per request; the public RPC accepts it. */
const CHUNK = 100_000n

const E_POOL_CREATED = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
)

const POOL_ABI = [
  { name: 'slot0', type: 'function', stateMutability: 'view', inputs: [], outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' } ] },
  { name: 'increaseObservationCardinalityNext', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'observationCardinalityNext', type: 'uint16' }], outputs: [] },
] as const

const ERC20_ABI = [
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const


const client = createPublicClient({ chain: CHAIN_PROFILE.chain, transport: http(CHAIN_PROFILE.rpcUrl) })

// One five-minute market is the production default. Extra durations are an
// explicit experiment, not a reason to spend keeper gas creating three empty
// books for every candidate pool.
const DURATIONS = (process.env.RHC_DURATIONS_SEC || '300')
  .split(',').map((s) => Number(s.trim())).filter((n) => n > 0)

// Discovery and admission remain automatic; spending money to create a market
// is opt-in. This prevents a numerical depth gate from silently becoming a
// listing policy for every newly launched token.
const AUTO_CREATE_MARKETS = process.env.RHC_AUTO_CREATE_MARKETS === 'true'

export const POLICY: AdmissionPolicy = {
  weth: CHAIN_PROFILE.addresses.weth ?? '0x',
  minDepthWei: BigInt(Math.round(Number(process.env.KEEPER_MIN_POOL_DEPTH_ETH ?? '20') * 1e6)) * 10n ** 12n,
  allowedFeeTiers: (process.env.RHC_FEE_TIERS || '500,3000,10000').split(',').map(Number),
  durations: DURATIONS,
  minCardinality: Number(process.env.RHC_MIN_CARDINALITY ?? '300'),
  cardinalityTarget: Number(process.env.RHC_CARDINALITY_TARGET ?? '300'),
  maxPendingAgeSec: Number(process.env.RHC_MAX_PENDING_AGE_SEC ?? String(24 * 3600)),
}

/** How many candidates to re-observe per tick. Bounds RPC work. */
const CHECK_BATCH = Number(process.env.RHC_CHECK_BATCH ?? '25')

async function getCursor(): Promise<bigint | null> {
  const r = await pg.query('SELECT last_block FROM _indexer_cursor WHERE stream = $1', [STREAM])
  return r.rowCount === 0 ? null : BigInt(r.rows[0].last_block)
}

async function setCursor(block: bigint) {
  await pg.query(
    `INSERT INTO _indexer_cursor(stream, last_block, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (stream) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = NOW()`,
    [STREAM, block.toString()],
  )
}

/** Record a decision in one place, so the log line and the row cannot disagree. */
async function record(pool: string, status: string, reason: string, extra: Record<string, unknown> = {}) {
  await pg.query(
    `UPDATE pool_candidates
        SET status = $2, reason = $3, last_checked_at = NOW(), updated_at = NOW(),
            weth_depth = COALESCE($4, weth_depth), cardinality = COALESCE($5, cardinality)
      WHERE pool_address = $1`,
    [pool.toLowerCase(), status, reason, extra.depthEth ?? null, extra.cardinality ?? null],
  )
  console.log(`[poolWatcher] ${pool} ${status}: ${reason}`)
}

/** Pull new PoolCreated events into pool_candidates. */
async function ingestNewPools(): Promise<number> {
  const factory = CHAIN_PROFILE.addresses.uniswapV3Factory
  if (!factory) return 0

  const latest = await client.getBlockNumber()
  // First run: start one chunk back rather than at genesis. Older pools are
  // reachable, but a watcher that has to walk 54 million blocks before it
  // reports anything is one nobody will wait for; the ones that matter are
  // created continuously.
  let from = (await getCursor()) ?? latest - CHUNK
  let found = 0

  while (from <= latest) {
    const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n
    const logs = await client.getLogs({ address: factory, event: E_POOL_CREATED, fromBlock: from, toBlock: to })

    for (const log of logs) {
      const { token0, token1, fee, pool } = log.args as {
        token0: Address; token1: Address; fee: number; pool: Address
      }
      const weth = (CHAIN_PROFILE.addresses.weth ?? '').toLowerCase()
      const isWeth0 = token0.toLowerCase() === weth
      const isWeth1 = token1.toLowerCase() === weth
      // Pools with no WETH side are dropped here rather than stored and
      // rejected later: they are 40% of what the factory emits, they can never
      // become eligible, and a table that keeps them makes every later scan
      // slower for no reason.
      if (!isWeth0 && !isWeth1) continue

      const token = isWeth0 ? token1 : token0
      const r = await pg.query(
        `INSERT INTO pool_candidates
           (pool_address, chain_id, token_address, token_symbol, fee_tier, created_block, status, reason)
         VALUES (LOWER($1), $2, LOWER($3), $4, $5, $6, 'PENDING', 'seen')
         ON CONFLICT (pool_address) DO NOTHING
         RETURNING pool_address`,
        [pool, CHAIN_PROFILE.chain.id, token, await symbolOf(token), Number(fee), log.blockNumber!.toString()],
      )
      if (r.rowCount) found++
    }

    await setCursor(to)
    from = to + 1n
  }
  return found
}

/**
 * The token's ticker, for the UI and for log lines that a human has to read.
 *
 * On Base a feed id decodes to a symbol because we chose the symbol; here the
 * pool is the identity and the ticker has to be asked for. Null on failure
 * rather than throwing: a token with no symbol(), or one returning bytes32 the
 * way some older ERC20s do, is still perfectly tradeable, and refusing to
 * onboard a pool over a display string would be absurd.
 */
async function symbolOf(token: Address): Promise<string | null> {
  try {
    const s = await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' })
    return s.slice(0, 64) || null
  } catch {
    return null
  }
}

/** Observe one pool on chain, well enough to decide about it. */
async function observe(row: {
  pool_address: string; token_address: string; fee_tier: number
  first_seen_at: Date; cardinality_paid_at: Date | null
}): Promise<PoolObservation | null> {
  const factory = CONTRACTS.MARKET_FACTORY
  const pool = row.pool_address as Address

  const [slot0, depth] = await Promise.all([
    client.readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0' }),
    client.readContract({ address: factory, abi: POOL_MARKET_FACTORY_ABI, functionName: 'wethDepth', args: [pool] }),
  ])

  const feedId = await client.readContract({
    address: factory, abi: POOL_MARKET_FACTORY_ABI, functionName: 'feedIdFor', args: [pool],
  })
  const markets = await client.readContract({
    address: factory, abi: POOL_MARKET_FACTORY_ABI, functionName: 'getActiveMarkets', args: [feedId],
  })

  // Which durations the pool can actually price, asked of the contract so the
  // watcher and the factory cannot disagree about what a window is.
  const servable: number[] = []
  for (const d of POLICY.durations) {
    const window = await client.readContract({
      address: factory, abi: POOL_MARKET_FACTORY_ABI, functionName: 'twapWindowFor', args: [BigInt(d)],
    })
    const ok = await client.readContract({
      address: factory, abi: POOL_MARKET_FACTORY_ABI, functionName: 'canServeWindow', args: [pool, window],
    })
    if (ok) servable.push(d)
  }

  // Which durations already have a market. getActiveMarkets returns addresses,
  // and the DB knows their durations from the indexer.
  const existing = markets.length
    ? (await pg.query(
        `SELECT duration_secs FROM markets WHERE market_address = ANY($1::text[])`,
        [markets.map((m) => m.toLowerCase())],
      )).rows.map((r) => Number(r.duration_secs))
    : []

  return {
    pool: row.pool_address,
    // Ingest only stores WETH pairs, and wethDepth resolves the direction on
    // chain, so which slot each token sits in stops mattering here. Reported
    // in a fixed order rather than re-read, which would be two RPC calls a
    // tick to learn something already known.
    token0: row.token_address,
    token1: CHAIN_PROFILE.addresses.weth ?? '0x',
    fee: row.fee_tier,
    wethDepthWei: depth,
    cardinality: Number(slot0[3]),
    cardinalityNext: Number(slot0[4]),
    servableDurations: servable,
    existingDurations: existing,
    ageSec: Math.floor((Date.now() - new Date(row.first_seen_at).getTime()) / 1000),
    cardinalityPaid: row.cardinality_paid_at !== null,
  }
}

async function payForCardinality(pool: Address, target: number) {
  const wallet = getKeeperWalletClient()
  if (!wallet) throw new Error('KEEPER_PRIVATE_KEY missing')

  const skip = await gasGuard.check('routine')
  if (skip) {
    await record(pool, 'PENDING', `cardinality deferred: ${skip}`)
    return
  }

  const hash = await sendKeeperTx(
    (fees) => wallet.writeContract({
      address: pool, abi: POOL_ABI, functionName: 'increaseObservationCardinalityNext',
      args: [target], ...fees,
    }),
    'increaseObservationCardinalityNext',
  )
  const receipt = await client.waitForTransactionReceipt({ hash })
  await recordReceipt(receipt, 'routine')

  // waitForTransactionReceipt resolves for a reverted tx too - it waits for
  // inclusion, not success. Marking cardinality_paid_at unconditionally
  // meant a reverted payment was recorded as if it had landed, and nothing
  // ever retries a pool once that column is set - it stalls there forever,
  // spent real gas and gained nothing.
  if (receipt.status !== 'success') {
    console.error(`[poolWatcher] ${pool}: increaseObservationCardinalityNext reverted on-chain, tx=${hash}`)
    await record(pool, 'PENDING', `cardinality payment reverted, will retry`)
    return
  }

  await pg.query(
    `UPDATE pool_candidates SET cardinality_paid_at = NOW(), updated_at = NOW() WHERE pool_address = $1`,
    [pool.toLowerCase()],
  )
  await record(pool, 'PENDING', `paid to grow ring to ${target}, waiting for a swap to apply it`)
}

async function createMarkets(pool: Address, durations: number[], reason: string) {
  const wallet = getKeeperWalletClient()
  if (!wallet) throw new Error('KEEPER_PRIVATE_KEY missing')

  for (const d of durations) {
    const skip = await gasGuard.check('routine')
    if (skip) {
      await record(pool, 'READY', `market ${d}s deferred: ${skip}`)
      return
    }
    const hash = await sendKeeperTx(
      (fees) => wallet.writeContract({
        address: CONTRACTS.MARKET_FACTORY, abi: POOL_MARKET_FACTORY_ABI,
        functionName: 'createMarket', args: [pool, BigInt(d)], ...fees,
      }),
      `createMarket ${d}s`,
    )
    const receipt = await client.waitForTransactionReceipt({ hash })
    await recordReceipt(receipt, 'routine')
    // Same reasoning as payForCardinality: a receipt resolves on inclusion,
    // not success, and logging "created" for a reverted tx (e.g. a race
    // against another permissionless caller creating the same slot first)
    // would misreport a market that does not exist.
    if (receipt.status !== 'success') {
      console.error(`[poolWatcher] ${pool}: createMarket(${d}s) reverted on-chain, tx=${hash}`)
      continue
    }
    console.log(`[poolWatcher] ${pool} created ${d}s market (${reason})`)
  }
}

export async function poolWatcherTick() {
  if (!CHAIN_PROFILE.watchesPools) return

  const found = await ingestNewPools()
  if (found) console.log(`[poolWatcher] ${found} new WETH pools`)

  const { rows } = await pg.query(
    `SELECT pool_address, token_address, fee_tier, first_seen_at, cardinality_paid_at
       FROM pool_candidates
      WHERE chain_id = $1 AND status IN ('PENDING', 'READY')
      ORDER BY last_checked_at NULLS FIRST, first_seen_at
      LIMIT $2`,
    [CHAIN_PROFILE.chain.id, CHECK_BATCH],
  )

  for (const row of rows) {
    try {
      const obs = await observe(row)
      if (!obs) continue
      const decision = decidePool(obs, POLICY)
      const extra = { depthEth: formatEth(obs.wethDepthWei).replace(' ETH', ''), cardinality: obs.cardinality }

      switch (decision.action) {
        case 'reject':
          await record(row.pool_address, 'REJECTED', decision.reason, extra)
          break
        case 'defer':
          await record(row.pool_address, 'PENDING', decision.reason, extra)
          break
        case 'increaseCardinality':
          await record(row.pool_address, 'PENDING', decision.reason, extra)
          // Same gate as market creation, and for the same reason: this is
          // real keeper spend (~6.7M gas, measured) on a pool nobody has
          // reviewed yet. The previous fix only gated the 'create' branch -
          // increaseObservationCardinalityNext kept firing unconditionally
          // for any pool deep enough, so a numerical depth gate was still
          // silently acting as the spending policy for this half of it.
          if (AUTO_CREATE_MARKETS) {
            await payForCardinality(row.pool_address as Address, decision.target)
          } else {
            console.log(
              `[poolWatcher] ${row.pool_address} needs cardinality growth: manual review required before spending on it`,
            )
          }
          break
        case 'create':
          await record(row.pool_address, 'READY', decision.reason, extra)
          if (AUTO_CREATE_MARKETS) {
            await createMarkets(row.pool_address as Address, decision.durations, decision.reason)
          } else {
            console.log(
              `[poolWatcher] ${row.pool_address} READY: manual review required before market creation`,
            )
          }
          break
        case 'done':
          await record(row.pool_address, 'ONBOARDED', decision.reason, extra)
          break
      }
    } catch (err) {
      // One unreadable pool must not stop the tick: a self-destructed or
      // otherwise broken pool would otherwise block every candidate behind it.
      await record(row.pool_address, 'PENDING', `observation failed: ${String(err).slice(0, 120)}`)
    }
  }
}
