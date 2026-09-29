// Read-only: base fee history of Robinhood Chain mainnet (4663) from block headers.
// Headers are available for old blocks even on a non-archive node (they are not state).
// Usage: node basefee-history.mjs <daysBack> <stepMinutes> <outFile>
import { writeFileSync } from 'node:fs'
const URL = process.env.RPC ?? 'https://rpc.mainnet.chain.robinhood.com'
let id = 1
async function rpc(method, params = [], tries = 5) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }), signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const b = await res.json()
      if (b.error) throw new Error(JSON.stringify(b.error))
      return b.result
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 400 * 2 ** i)) }
  }
  throw last
}
const daysBack = Number(process.argv[2] ?? 1)
const stepMin = Number(process.argv[3] ?? 10)
const out = process.argv[4] ?? 'basefee.json'

const head = await rpc('eth_getBlockByNumber', ['latest', false])
const headN = Number(BigInt(head.number)); const headT = Number(BigInt(head.timestamp))
// calibrate blocks per second from a block ~1M back
const probeN = headN - 1_000_000
const probe = await rpc('eth_getBlockByNumber', ['0x' + probeN.toString(16), false])
const bps = 1_000_000 / (headT - Number(BigInt(probe.timestamp)))
console.log('head', headN, new Date(headT * 1000).toISOString(), 'blocks/s', bps.toFixed(3))

const samples = []
const total = Math.floor(daysBack * 24 * 60 / stepMin)
for (let k = 0; k <= total; k++) {
  const targetT = headT - k * stepMin * 60
  let n = Math.max(1, Math.round(headN - (headT - targetT) * bps))
  let b
  try { b = await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false]) } catch (e) { console.log('fail', n, e.message); continue }
  if (!b) continue
  samples.push({ n, t: new Date(Number(BigInt(b.timestamp)) * 1000).toISOString(), baseFeeGwei: Number(BigInt(b.baseFeePerGas)) / 1e9 })
  if (k % 50 === 0) console.log(k, '/', total, samples.at(-1))
  await new Promise(r => setTimeout(r, 60))
}
writeFileSync(out, JSON.stringify({ url: URL, head: headN, headTime: new Date(headT * 1000).toISOString(), stepMin, daysBack, samples }, null, 1))
const v = samples.map(s => s.baseFeeGwei).sort((a, b) => a - b)
const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))]
console.log('n', v.length, 'min', v[0], 'p50', q(0.5), 'p90', q(0.9), 'p95', q(0.95), 'p99', q(0.99), 'max', v.at(-1))
