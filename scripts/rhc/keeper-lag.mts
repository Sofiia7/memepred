/**
 * How long after a match was due did the keeper settle (or refund) it? Exact: it reads the
 * MatchSettled and MatchRefunded events of every live market and subtracts the match's
 * settleAt from the block time of the event that closed it. Read-only, sends nothing.
 *
 *   scripts/node_modules/.bin/tsx scripts/rhc/keeper-lag.mts [--hours 24]
 *
 * It also prints the gas each settlement transaction used, oldest to newest. That column is how a
 * growing stand-in pool shows up: MockUniswapV3Pool re-reads its whole push history on every
 * observe(), so each pushTick adds about 8.4 thousand gas to every bet and settlement on that
 * pool, for good. (A real Uniswap pool does not do this.) A settlement costing far more than the
 * measured 288-293 thousand means the pool's history has grown.
 *
 * Why this exists: soak-traders.mts prints a lag too, but it only looks at an order once per
 * action (every couple of minutes), so its number includes its own polling gap and is an upper
 * bound. This one has no such gap.
 *
 * Env: RHC_API (default https://api-rhc.flipthememe.com), RHC_RPC_URL (default the public testnet RPC).
 */
import {
  createPublicClient, http, parseAbi, defineChain, type Address,
} from 'viem'

const RPC = process.env.RHC_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com'
const API = process.env.RHC_API ?? 'https://api-rhc.flipthememe.com'
const hoursArg = process.argv.indexOf('--hours')
const HOURS = hoursArg >= 0 ? Number(process.argv[hoursArg + 1]) : 24

const chain = defineChain({
  id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const pub = createPublicClient({ chain, transport: http(RPC) })

const MARKET = parseAbi([
  'function getMatch(uint256) view returns ((uint256 upOrderId,uint256 downOrderId,uint256 amount,uint256 entryPrice,uint256 settleAt,uint256 exitPrice,bool settled,bool upWon,bool lpMatch))',
  'event MatchSettled(uint256 indexed matchId,bool upWon,uint256 entry,uint256 exit)',
  'event MatchRefunded(uint256 indexed matchId)',
])

const percentile = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const summary = (xs: number[]) =>
  xs.length === 0
    ? 'no matches'
    : `n=${xs.length}  p50 ${percentile(xs, 50)}s  p90 ${percentile(xs, 90)}s  p95 ${percentile(xs, 95)}s  max ${Math.max(...xs)}s`

const blockTime = new Map<bigint, number>()
async function tsOf(n: bigint) {
  const hit = blockTime.get(n)
  if (hit !== undefined) return hit
  const t = Number((await pub.getBlock({ blockNumber: n })).timestamp)
  blockTime.set(n, t)
  return t
}

/** getLogs over a range, halving it whenever the RPC refuses. */
async function logsIn(address: Address, event: any, from: bigint, to: bigint): Promise<any[]> {
  try {
    return (await pub.getLogs({ address, event, fromBlock: from, toBlock: to })) as any[]
  } catch (e) {
    if (to <= from) throw e
    const mid = from + (to - from) / 2n
    return [...(await logsIn(address, event, from, mid)), ...(await logsIn(address, event, mid + 1n, to))]
  }
}

async function main() {
  const list = await (await fetch(`${API}/api/markets`)).json() as any
  const rows: any[] = Array.isArray(list) ? list : list.markets ?? []
  const head = await pub.getBlockNumber()
  const headTs = await tsOf(head)
  // Block time from a sample, to turn "hours" into a block range.
  const probe = 2000n
  const perBlock = (headTs - (await tsOf(head - probe))) / Number(probe) || 0.25
  const from = head - BigInt(Math.ceil((HOURS * 3600) / perBlock))
  console.log(`window: last ${HOURS} h (about ${from > 0n ? from : 0n}..${head}, ${perBlock.toFixed(2)} s per block)`)

  const all: number[] = []
  const refunds: number[] = []
  const worst: { market: string; matchId: bigint; lag: number; kind: string }[] = []
  // One row per settlement transaction: a batch can close several matches at once.
  const txs = new Map<string, { market: string; matches: number; block: bigint }>()
  for (const r of rows) {
    const market = r.address as Address
    const label = `${r.feedSymbol ?? market.slice(0, 8)} ${r.duration}s`
    const lags: number[] = []
    for (const [ev, kind] of [[MARKET[1], 'settled'], [MARKET[2], 'refunded']] as const) {
      for (const log of await logsIn(market, ev, from > 0n ? from : 0n, head)) {
        const matchId = log.args.matchId as bigint
        const m = (await pub.readContract({ address: market, abi: MARKET, functionName: 'getMatch', args: [matchId] })) as any
        const lag = (await tsOf(log.blockNumber as bigint)) - Number(m.settleAt)
        lags.push(lag)
        all.push(lag)
        if (kind === 'refunded') refunds.push(lag)
        worst.push({ market: label, matchId, lag, kind })
        if (kind === 'settled') {
          const key = log.transactionHash as string
          const row = txs.get(key) ?? { market: label, matches: 0, block: log.blockNumber as bigint }
          row.matches++
          txs.set(key, row)
        }
      }
    }
    console.log(`${label.padEnd(14)} ${summary(lags)}`)
  }
  console.log(`${'ALL'.padEnd(14)} ${summary(all)}   (of which refunds: ${refunds.length})`)
  const buckets: [string, (x: number) => boolean][] = [
    ['settled before due (negative lag)', (x) => x < 0],
    ['0-15 s', (x) => x >= 0 && x <= 15],
    ['16-30 s', (x) => x > 15 && x <= 30],
    ['31-60 s', (x) => x > 30 && x <= 60],
    ['over 60 s', (x) => x > 60],
  ]
  for (const [name, test] of buckets) console.log(`  ${name.padEnd(36)} ${all.filter(test).length}`)
  worst.sort((a, b) => b.lag - a.lag)
  console.log('slowest five:')
  for (const w of worst.slice(0, 5)) console.log(`  ${w.market} match ${w.matchId} ${w.kind}: ${w.lag}s after due`)

  console.log('gas per settled match (transaction gas / matches in it), oldest to newest:')
  const txRows = [...txs.entries()].sort((a, b) => (a[1].block < b[1].block ? -1 : 1))
  const perMatch: number[] = []
  for (const [hash, row] of txRows) {
    const gas = Number((await pub.getTransactionReceipt({ hash: hash as `0x${string}` })).gasUsed)
    const each = Math.round(gas / row.matches)
    perMatch.push(each)
    console.log(`  block ${row.block} ${row.market.padEnd(14)} ${row.matches} match(es)  ${each} gas each`)
  }
  if (perMatch.length) console.log(`  first ${perMatch[0]}, last ${perMatch[perMatch.length - 1]}, max ${Math.max(...perMatch)}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
