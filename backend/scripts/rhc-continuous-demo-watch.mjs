/** Read-only supervisor for the immutable testnet demo oracles. No keys or transactions. */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createPublicClient, http, parseAbi } from 'viem'

const config = JSON.parse(readFileSync(process.env.DEMO_POOLS_FILE ?? '/app/continuous-demo-pools.json', 'utf8'))
if (config.chainId !== 46630 || config.pools.length !== 3) throw new Error('Expected three testnet-only demo pools')
const client = createPublicClient({ transport: http('https://rpc.testnet.chain.robinhood.com', { timeout: 10_000, retryCount: 1 }) })
const abi = parseAbi(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function observe(uint32[]) view returns (int56[],uint160[])'])
let status = { ok: false, checkedAt: 0, pools: [], error: 'starting' }
let previous = '', lastMove = Date.now(), failures = 0, checks = 0
createServer((req, res) => {
  res.writeHead(status.ok && Date.now() - status.checkedAt < 120_000 ? 200 : 503, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ...status, simulated: true, chainId: 46630 }))
}).listen(9090, '0.0.0.0')

if (await client.getChainId() !== 46630) throw new Error('Refusing another chain')
console.log('Continuous simulated testnet price schedule: read-only supervisor started; no wallet and no hourly stop')
for (;;) {
  try {
    const pools = await Promise.all(config.pools.map(async ({ symbol, pool }) => {
      const [spot, oracle] = await Promise.all([
        client.readContract({ address: pool, abi, functionName: 'slot0' }),
        client.readContract({ address: pool, abi, functionName: 'observe', args: [[600, 60, 0]] }),
      ])
      if (oracle[0].length !== 3 || oracle[1].length !== 3) throw new Error(`${symbol}: incomplete oracle response`)
      return { symbol, pool, tick: Number(spot[1]) }
    }))
    const values = pools.map((p) => p.tick).join(',')
    if (values !== previous) { previous = values; lastMove = Date.now() }
    if (Date.now() - lastMove > 180_000) throw new Error('All three demo prices stayed unchanged for over three minutes')
    status = { ok: true, checkedAt: Date.now(), pools, error: null }
    failures = 0
    if (checks++ % 15 === 0) console.log(JSON.stringify({ at: new Date().toISOString(), ...status }))
  } catch (e) {
    status = { ...status, ok: false, checkedAt: Date.now(), error: String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 200) }
    console.error(status.error)
    if (++failures >= 5) process.exit(1) // Docker restarts a failed supervisor; prices themselves need no process.
  }
  await new Promise((resolve) => setTimeout(resolve, 20_000))
}
