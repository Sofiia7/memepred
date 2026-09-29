// Read-only probe behind docs/rhc/ECONOMICS.md: receipts of the 29.09 e2e transactions (gasUsed and
// gasUsedForL1), the size of the signed settle transaction before and after brotli, the stand-in pools'
// record counts and read cost, wallet balances, and ArbGasInfo prices on both chains.
// No keys, no writes.  Run from the repository root:  node docs/rhc/measurements/economics/chain-probe.mjs
import zlib from 'node:zlib'
import { serializeTransaction } from '../../../../scripts/node_modules/viem/_esm/index.js'

const TESTNET = 'https://rpc.testnet.chain.robinhood.com'
const MAINNET = 'https://rpc.mainnet.chain.robinhood.com'
let id = 1
async function rpc(url, method, params = []) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }), signal: AbortSignal.timeout(30000) })
  const b = await res.json()
  if (b.error) throw new Error(method + ': ' + JSON.stringify(b.error))
  return b.result
}
const words = (hex) => { const b = hex.slice(2); const o = []; for (let i = 0; i + 64 <= b.length; i += 64) o.push(BigInt('0x' + b.slice(i, i + 64))); return o }
const gwei = (w) => Number(w) / 1e9

console.log('time', new Date().toISOString())
for (const [name, url] of [['testnet 46630', TESTNET], ['mainnet 4663', MAINNET]]) {
  const p = words(await rpc(url, 'eth_call', [{ to: '0x000000000000000000000000000000000000006c', data: '0x41b247a8' }, 'latest']))
  console.log(name, 'eth_gasPrice', gwei(BigInt(await rpc(url, 'eth_gasPrice'))), 'perArbGasTotal', gwei(p[5]), 'perL1CalldataByte', gwei(p[1]), 'gwei')
}

const TXS = {
  'settle PvP (FROGGO)': '0xe475de28b62c1181b5026c67cc3d1def9691a7e8701ad0f157867d133ab5a8d9',
  'settle vault, user wins (MOONCAT)': '0x728a54f735ade942929f2054231f9f51c5a383adcf208d0b1b1bc7f284768157',
  'resolver refund, vault (MOONCAT)': '0x4ea099e26ef61ddbe38abec0fb7d66f5c38db508c7d4dd27a787a5f6e5f3bb93',
  cancelOrder: '0xceda4118b20df76f4cbcfb1bef93c676e72da93151b1cf977370832b13d74121',
  pushTick: '0x7fa70d170b00bd527be9165b382e0b33133fa35119e4498435ea95fe0012b25b',
  'placeBet matched by the vault': '0x29e65073f5920e521d9b10223e27295036dcd46e153747ac3028959a9d2366cb',
}
for (const [k, h] of Object.entries(TXS)) {
  const r = await rpc(TESTNET, 'eth_getTransactionReceipt', [h])
  const t = await rpc(TESTNET, 'eth_getTransactionByHash', [h])
  const raw = serializeTransaction({ type: 'eip1559', chainId: Number(BigInt(t.chainId)), nonce: Number(BigInt(t.nonce)), gas: BigInt(t.gas), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas), to: t.to, value: BigInt(t.value), data: t.input, accessList: t.accessList ?? [] }, { r: t.r, s: t.s, yParity: Number(BigInt(t.yParity ?? t.v)) })
  const buf = Buffer.from(raw.slice(2), 'hex')
  const br = (q) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: q, [zlib.constants.BROTLI_PARAM_LGWIN]: 22 } }).length
  console.log(k.padEnd(34), 'gasUsed', Number(BigInt(r.gasUsed)), 'gasUsedForL1', Number(BigInt(r.gasUsedForL1)), 'effectiveGasPrice', gwei(BigInt(r.effectiveGasPrice)), 'signed bytes', buf.length, 'brotli q0/q1/q11', br(0), br(1), br(11))
}

const OBS3 = '0x883bdbfd' + [0x20, 3, 180, 60, 0].map((n) => n.toString(16).padStart(64, '0')).join('')
async function records(pool) {
  const has = async (i) => { try { await rpc(TESTNET, 'eth_call', [{ to: pool, data: '0x31560626' + i.toString(16).padStart(64, '0') }, 'latest']); return true } catch { return false } }
  if (!(await has(0))) return 0
  let lo = 0, hi = 1
  while (await has(hi)) { lo = hi; hi *= 2 }
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await has(mid)) lo = mid; else hi = mid }
  return lo + 1
}
for (const [name, pool] of [['MOONCAT', '0xfc5fb7d3b1ddffc0b50b0cddffe3b016d4ff57cb'], ['PEPE', '0xefd4618f36268ce8c1c8ad3783bdca6185221dbd'], ['FROGGO', '0x779e9b50837478fccd7db50592edb16ed45d8a18']]) {
  console.log(name, 'records', await records(pool), 'eth_estimateGas observe([180,60,0])', Number(BigInt(await rpc(TESTNET, 'eth_estimateGas', [{ to: pool, data: OBS3 }]))))
}
for (const [k, a] of [['keeper', '0xbFa008e5A8d46d2014b83551ce6209108416eea4'], ['deployer', '0x12f9B9De75ccEa7be573F643A99AAA63b9448BD2'], ['badge minter', '0xb183b09f0D41314EA597598B741b41bcddd875e6']]) {
  console.log(k, 'balance', (Number(BigInt(await rpc(TESTNET, 'eth_getBalance', [a, 'latest']))) / 1e18).toFixed(8), 'ETH')
}
console.log('vault totalAssets', (Number(BigInt(await rpc(TESTNET, 'eth_call', [{ to: '0x3695D11A79D7625a7126588Ad94b5878139409E2', data: '0x01e1d114' }, 'latest']))) / 1e18).toFixed(6), 'WETH')
