// §7 follow-up: how many seconds of TWAP history does one observation slot buy?
//
// Uniswap v3 stores at most ONE observation per SECOND (Oracle.write returns
// early when last.blockTimestamp == uint32(block.timestamp)). Robinhood Chain
// produces ~12 blocks per second, so "60 observations at 82ms blocks" does NOT
// cover 60*0.082 seconds - it covers up to 60 seconds, and only if a swap lands
// in every one of those seconds. This measures the actual write rate r (share
// of seconds carrying at least one swap) for the busiest WETH pools, which is
// what MIN_CARDINALITY has to be sized against:
//
//     history_seconds = cardinality / r      =>   cardinality >= window * r
//
// Usage: node scripts/rhc/swap-rate.mjs --pools docs/rhc/measurements/pools-24h.json --top 12
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MAINNET, rpc, toHex } from './rpc.mjs'

// Swap(address,address,int256,int256,uint160,uint128,int24)
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const BLOCK_MS = 82

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const poolsFile = arg('pools', 'docs/rhc/measurements/pools-24h.json')
const top = Number(arg('top', 12))
const windowSec = Number(arg('window', 600))
const out = arg('out', 'docs/rhc/measurements/swap-rate.json')

const data = JSON.parse(readFileSync(poolsFile, 'utf8'))
const candidates = data.pools
  .filter((p) => BigInt(p.liquidity) > 0n)
  .sort((a, b) => b.wethDepthEth - a.wethDepthEth)
  .slice(0, top)

const latest = Number(BigInt(await rpc(MAINNET, 'eth_blockNumber')))
const span = Math.round((windowSec * 1000) / BLOCK_MS)
const from = latest - span
console.log(`[swap-rate] ${candidates.length} pools, blocks ${from}..${latest} (~${windowSec}s)`)

// One timestamp lookup per block, shared across pools.
const tsCache = new Map()
async function tsOf(block) {
  if (!tsCache.has(block)) {
    const blk = await rpc(MAINNET, 'eth_getBlockByNumber', [toHex(block), false])
    tsCache.set(block, Number(BigInt(blk.timestamp)))
  }
  return tsCache.get(block)
}

const rows = []
for (const p of candidates) {
  const logs = await rpc(MAINNET, 'eth_getLogs', [
    { fromBlock: toHex(from), toBlock: toHex(latest), address: p.pool, topics: [SWAP_TOPIC] },
  ])
  const blocks = [...new Set(logs.map((l) => Number(BigInt(l.blockNumber))))]
  const seconds = new Set()
  for (const b of blocks) seconds.add(await tsOf(b))

  // r = share of wall-clock seconds in the window that carry >=1 swap, i.e.
  // observations written per second. history = cardinality / r.
  const r = seconds.size / windowSec
  const row = {
    pool: p.pool,
    symbol: p.symbol,
    wethDepthEth: p.wethDepthEth,
    swaps: logs.length,
    distinctBlocks: blocks.length,
    distinctSeconds: seconds.size,
    writesPerSecond: Number(r.toFixed(4)),
    // seconds of history that N slots would hold at this rate
    historySecAt60: r > 0 ? Math.round(60 / r) : null,
    historySecAt300: r > 0 ? Math.round(300 / r) : null,
    // slots needed to guarantee the longest exit window we use (180s) plus 50%
    cardinalityFor180s: r > 0 ? Math.ceil(180 * r * 1.5) : 0,
  }
  rows.push(row)
  console.log(
    `${(row.symbol || '?').padEnd(12)} depth ${row.wethDepthEth.toFixed(2).padStart(9)} ETH  ` +
      `swaps ${String(row.swaps).padStart(5)}  sec-with-swaps ${String(row.distinctSeconds).padStart(4)}/${windowSec}  ` +
      `r=${row.writesPerSecond}  60 slots = ${row.historySecAt60}s`,
  )
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), windowSec, fromBlock: from, toBlock: latest, pools: rows }, null, 2))
console.log(`[swap-rate] wrote ${out}`)
