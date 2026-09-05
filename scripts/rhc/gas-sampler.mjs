// §7: sample ArbGasInfo.getPricesInWei() over time.
//
// Why not eth_gasPrice: on Robinhood Chain it reports 0.45-0.56 gwei while the
// price transactions actually execute at is perArbGasTotal, ~1.8 gwei - a 4x
// understatement. The keeper's gasGuard ceiling has to come from this call, so
// we need its spread over a full day before picking a threshold.
//
// Usage: node scripts/rhc/gas-sampler.mjs [--hours 24] [--interval 60]
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MAINNET, rpc, call, words } from './rpc.mjs'

const ARB_GAS_INFO = '0x000000000000000000000000000000000000006c'
const GET_PRICES_IN_WEI = '0x41b247a8'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}
const hours = arg('hours', 24)
const intervalSec = arg('interval', 60)
const out = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'docs/rhc/measurements/arb-gas-samples.jsonl'

mkdirSync(dirname(out), { recursive: true })

const deadline = Date.now() + hours * 3600_000
let n = 0

console.log(`[gas-sampler] every ${intervalSec}s for ${hours}h -> ${out}`)

while (Date.now() < deadline) {
  try {
    const [blockHex, pricesHex] = await Promise.all([
      rpc(MAINNET, 'eth_blockNumber'),
      call(MAINNET, ARB_GAS_INFO, GET_PRICES_IN_WEI),
    ])
    // (perL2Tx, perL1CalldataByte, perStorageAllocation,
    //  perArbGasBase, perArbGasCongestion, perArbGasTotal)
    const w = words(pricesHex).map((x) => BigInt(x).toString())
    const sample = {
      t: new Date().toISOString(),
      block: Number(BigInt(blockHex)),
      perL2Tx: w[0],
      perL1CalldataByte: w[1],
      perStorageAllocation: w[2],
      perArbGasBase: w[3],
      perArbGasCongestion: w[4],
      perArbGasTotal: w[5],
    }
    appendFileSync(out, JSON.stringify(sample) + '\n')
    n++
    if (n % 10 === 1) {
      console.log(`[gas-sampler] #${n} block ${sample.block} total ${Number(w[5]) / 1e9} gwei`)
    }
  } catch (err) {
    appendFileSync(out, JSON.stringify({ t: new Date().toISOString(), error: String(err) }) + '\n')
    console.error('[gas-sampler]', String(err))
  }
  await new Promise((r) => setTimeout(r, intervalSec * 1000))
}
console.log(`[gas-sampler] done, ${n} samples`)
