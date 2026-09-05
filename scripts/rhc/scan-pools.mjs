// §7: distribution of Uniswap v3 pool state on Robinhood Chain, by pool age.
//
// Feeds two decisions:
//   * MIN_POOL_LIQUIDITY for PoolMarketFactory (open question TZ §9.1) - the
//     trade-off between "no markets exist" and "the TWAP is cheap to push".
//   * whether MIN_CARDINALITY = 60 is something pools ever reach on their own,
//     or something poolWatcher always has to pay for.
//
// Note on method: the public RPC keeps only ~8 minutes of historical state, so
// "liquidity one hour after graduation" cannot be read at a past block. Instead
// we read current liquidity for pools of known age and bucket by age - which
// also answers the more useful question, since a market on this chain lives
// forever and the pool has to stay deep for its whole life, not just at t+1h.
//
// Usage: node scripts/rhc/scan-pools.mjs [--hours 24] [--out FILE]
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MAINNET, rpc, call, words, toHex } from './rpc.mjs'

const V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa'
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const POOL_CREATED = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118'
const CHUNK = 100_000        // the public RPC accepts this range; 1M does not
const BLOCK_MS = 82          // measured: 12.2 blocks/s

const SEL = {
  liquidity: '0x1a686502',
  slot0: '0x3850c7bd',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
}

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const hours = Number(arg('hours', 24))
const out = arg('out', 'docs/rhc/measurements/pools.json')

const addrFromTopic = (t) => '0x' + t.slice(26).toLowerCase()

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++
        results[idx] = await fn(items[idx], idx)
      }
    }),
  )
  return results
}

const latest = Number(BigInt(await rpc(MAINNET, 'eth_blockNumber')))
const span = Math.round((hours * 3600 * 1000) / BLOCK_MS)
const from = Math.max(0, latest - span)
console.log(`[scan] blocks ${from}..${latest} (${span} blocks ~ ${hours}h)`)

// ---- 1. collect PoolCreated -------------------------------------------------
const events = []
for (let start = from; start <= latest; start += CHUNK) {
  const end = Math.min(start + CHUNK - 1, latest)
  const logs = await rpc(MAINNET, 'eth_getLogs', [
    { fromBlock: toHex(start), toBlock: toHex(end), address: V3_FACTORY, topics: [POOL_CREATED] },
  ])
  for (const l of logs) {
    events.push({
      block: Number(BigInt(l.blockNumber)),
      token0: addrFromTopic(l.topics[1]),
      token1: addrFromTopic(l.topics[2]),
      fee: Number(BigInt(l.topics[3])),
      // data = (int24 tickSpacing, address pool)
      pool: '0x' + l.data.slice(2 + 64 + 24, 2 + 128).toLowerCase(),
    })
  }
  process.stdout.write(`\r[scan] ${end - from}/${span} blocks, ${events.length} pools`)
}
console.log()

const wethPools = events.filter((e) => e.token0 === WETH || e.token1 === WETH)
console.log(`[scan] ${events.length} pools created, ${wethPools.length} paired with WETH`)

// ---- 2. block timestamps (cached per block) ---------------------------------
const tsCache = new Map()
const uniqueBlocks = [...new Set(wethPools.map((e) => e.block))]
await mapLimit(uniqueBlocks, 6, async (b) => {
  const blk = await rpc(MAINNET, 'eth_getBlockByNumber', [toHex(b), false])
  tsCache.set(b, Number(BigInt(blk.timestamp)))
})

// ---- 3. current pool state --------------------------------------------------
const now = Math.floor(Date.now() / 1000)
let done = 0
const rows = await mapLimit(wethPools, 5, async (e) => {
  const other = e.token0 === WETH ? e.token1 : e.token0
  const [liqHex, slot0Hex, symHex] = await Promise.all([
    call(MAINNET, e.pool, SEL.liquidity).catch(() => null),
    call(MAINNET, e.pool, SEL.slot0).catch(() => null),
    call(MAINNET, other, SEL.symbol).catch(() => null),
  ])
  done++
  process.stdout.write(`\r[scan] state ${done}/${wethPools.length}`)
  if (!liqHex || !slot0Hex) return null

  const L = BigInt(liqHex)
  const s = words(slot0Hex)
  const sqrtPriceX96 = BigInt(s[0])
  const tick = BigInt.asIntN(24, BigInt(s[1]))
  const observationCardinality = Number(BigInt(s[3]))
  const observationCardinalityNext = Number(BigInt(s[4]))

  // Virtual WETH reserve implied by in-range liquidity. For a full-range
  // position this equals the real reserve; for a concentrated one it is an
  // upper bound. Used only to give the raw uint128 L a human scale.
  const Q96 = 2n ** 96n
  const wethWei =
    sqrtPriceX96 === 0n
      ? 0n
      : e.token1 === WETH
        ? (L * sqrtPriceX96) / Q96   // y = L * sqrt(P)
        : (L * Q96) / sqrtPriceX96   // x = L / sqrt(P)

  const ts = tsCache.get(e.block) ?? 0
  return {
    pool: e.pool,
    token: other,
    symbol: decodeSymbol(symHex),
    fee: e.fee,
    block: e.block,
    createdAt: ts,
    ageSec: ts ? now - ts : null,
    liquidity: L.toString(),
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: Number(tick),
    observationCardinality,
    observationCardinalityNext,
    wethDepthWei: wethWei.toString(),
    wethDepthEth: Number(wethWei) / 1e18,
  }
})
console.log()

const pools = rows.filter(Boolean)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(
  out,
  JSON.stringify(
    { scannedAt: new Date().toISOString(), fromBlock: from, toBlock: latest, hours, totalPoolsCreated: events.length, wethPools: wethPools.length, pools },
    null,
    2,
  ),
)
console.log(`[scan] wrote ${pools.length} rows -> ${out}`)

function decodeSymbol(hex) {
  if (!hex || hex === '0x') return null
  try {
    const b = hex.slice(2)
    // ABI string: offset, length, bytes
    if (b.length >= 128) {
      const len = Number(BigInt('0x' + b.slice(64, 128)))
      if (len > 0 && len <= 64) {
        return Buffer.from(b.slice(128, 128 + len * 2), 'hex').toString('utf8')
      }
    }
    // bytes32 symbol (older tokens)
    return Buffer.from(b.slice(0, 64), 'hex').toString('utf8').replace(/\0+$/, '') || null
  } catch {
    return null
  }
}
