// Backtest behind docs/rhc/SHARP-EDGE.md: how often does a FAST player (a bot that sees a swap
// and bets a couple of seconds later) beat the LP vault under the price rules PoolOracleResolver
// actually enforces, measured on real Uniswap v3 pools of Robinhood Chain mainnet (4663)?
//
// Read-only. Sequential, paced requests to the public RPC, retries with growing backoff, and a
// disk cache OUTSIDE the repository (OS temp dir by default), so a second run makes no requests.
// No keys, no writes to any chain.
//
// Usage, from the repository root (Node 24 strips the types itself):
//   node scripts/rhc/sharp-edge-backtest.mts                       all tables of SHARP-EDGE.md
//   node scripts/rhc/sharp-edge-backtest.mts --days 7 --delay 6    other period / reaction delay
//   node scripts/rhc/sharp-edge-backtest.mts --pools 0xabc..,0xdef.. --head latest
//   node scripts/rhc/sharp-edge-backtest.mts --discover            most active WETH pools, last hour
// Options:
//   --days N          period before the head block (default 14)
//   --head B|latest   head block (default: the pinned one the document was built from). "latest"
//                     also re-runs the TWAP check against observe(), which is only possible at the
//                     chain tip: the public RPC keeps ~8 minutes of state.
//   --pools LIST      comma-separated pool addresses (default: the 15-pool preset below)
//   --delay S         main reaction delay, seconds from the swap to the match (default 2)
//   --delays LIST     delays for the sensitivity table (default 0,2,6)
//   --cache DIR       cache directory (default <os tmp>/flipthememe-sharp-edge)
//   --json FILE       also write a machine-readable summary
//   --boot N          bootstrap replications for the key rows (default 400)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const RPC = process.env.RHC_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73' // SwapRouter02.WETH9(), docs/rhc/measurements
const V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa'
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
// Blocks between exact timestamps. Measured on a 2.4 h sample: 500 leaves 2.5% of swap blocks 2 s off,
// 1000 leaves 9% 2-3 s off; 1000 is what the public RPC's ~20 headers/s allows for 14 days in minutes.
const ANCHOR = 1000
const PINNED_HEAD = 75769939 // head of the run the document reports (2026-09-29 15:38 UTC); 0 means latest

// Most active canonical-v3 WETH memecoin pools on 2026-09-29 (fee tier 500/3000/10000, virtual WETH
// depth >= the factory gate of 2 ETH). Tokenized stocks, ETFs and USDG excluded; one pool per token.
// Reproduce the ranking with --discover. PAIR (0xc54c8ba6439ab4f5fb734779f83d00185b1ca4ee, 112 swaps in
// that hour) ranked above BONER and was left out by oversight; the document says so.
const PRESET = [
  ['0x34f73f488309208b8cb6012eb47ffeb086ca1c2d', 'ORBIO'],
  ['0xed50bdeea8adc232f159486192a4157281d722ff', 'PONS'],
  ['0xd42a491087a15e5afd51feb3606066cc152d2b09', 'CASHCAT'],
  ['0xd78480cafef722d75519e13b9f516e5704d0d659', 'AI'],
  ['0x52f32c64638804b9162fafe28f4f883a2812cfe9', 'VAULT'],
  ['0xe2c12a7379706a291cadaaec1d22458be2f7239d', 'MEME'],
  ['0xe972dfc9032d148f4b1618fb914fbbd2fc41d6dc', 'musebook'],
  ['0x2d620c391c0e97530e2f3c9015556ccf81669727', 'DREAM'],
  ['0x3fc825d1d585c6b73d57a28659afb3af0c13fa01', 'OPTIMUS'],
  ['0xa95d3882fb3ff32b6d8cc411f88cf7a2413f1a1c', 'INU'],
  ['0xa9d49caa5e906558dacdc66d563ac78f0c26d4ef', 'STONKBROKER'],
  ['0x237609918f330add285b8bc5f8f2922283d1c4c5', 'TENDIES'],
  ['0x9501a20bedb8bea0798fe5d4c411f5e270965d49', 'WALLET'],
  ['0x224bbe6b7a89e365db7f9d991e16f91440b433ce', 'Odin'],
  ['0xbd5cd6515ca6285941fbc177381dc8ed4844e6b8', 'BONER'],
]

// ── Contract rules, mirrored ─────────────────────────────────────────────────
const ENTRY_TWAP_WINDOW = 60 // PoolOracleResolver.sol:78, strike = 60 s TWAP ending at the match
const MIN_TWAP_WINDOW = 30 // :68
const TWAP_WINDOW_CAP = 300 // :67
const ANCHOR_FRACTION = 3 // :114, anchor = TWAP over the last window/3 seconds
const MAX_SPREAD_BPS = 200n // :116, used by both the entry guard (:193) and the exit guard (:344)
const DURATIONS = [60, 300, 900] // PoolMarketFactory.sol:176-178
const twapWindowFor = (d) => Math.min(TWAP_WINDOW_CAP, Math.max(MIN_TWAP_WINDOW, Math.floor(d / 5))) // :372-377
const EXIT_W = DURATIONS.map(twapWindowFor) // 30 / 60 / 180
const EXIT_A = EXIT_W.map((w) => Math.max(1, Math.floor(w / ANCHOR_FRACTION))) // 10 / 20 / 60 (:402-403)

// Entry rules: E0 is what the contracts do today, E1-E3 are the alternatives being priced.
const RULES = ['E0 TWAP 60 с до матча (сейчас)', 'E1 TWAP 30 с после матча', 'E2 TWAP 60 с после матча', 'E3 спот в момент матча']
// Strategies: S0 random; S1(k) bet in the direction spot is away from the strike; S2(k) against it;
// S3 with the last swap; S4 against it.
const KS = [0, 0.001, 0.0025, 0.005, 0.01, 0.015]
const STRATS = ['S0 случайно', ...KS.map((k) => `S1 k=${fmtK(k)}`), ...KS.map((k) => `S2 k=${fmtK(k)}`), 'S3 за свопом', 'S4 против свопа']
const NS = STRATS.length
function fmtK(k) { return k === 0 ? '0' : `${Number((k * 100).toFixed(2))}%` }

// ── Arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1] }
const DAYS = Number(arg('days', 14))
const HEAD_ARG = arg('head', PINNED_HEAD ? String(PINNED_HEAD) : 'latest')
const DELAY = Number(arg('delay', 2))
const DELAYS = [...new Set([DELAY, ...String(arg('delays', '0,2,6')).split(',').map(Number)])].sort((a, b) => a - b)
const MAIN_DI = DELAYS.indexOf(DELAY)
const BOOT = Number(arg('boot', 400))
const CACHE = arg('cache', join(tmpdir(), 'flipthememe-sharp-edge'))
const JSON_OUT = arg('json', null)
const poolArg = arg('pools', null)
const POOLS = poolArg ? poolArg.split(',').map((a) => [a.trim().toLowerCase(), null]) : PRESET
mkdirSync(CACHE, { recursive: true })

// ── RPC: one request at a time, paced, with backoff ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastReq = 0
let reqCount = 0
async function post(body, timeoutMs = 120_000) {
  let backoff = 1000
  for (let attempt = 0; ; attempt++) {
    const wait = lastReq + 800 - Date.now()
    if (wait > 0) await sleep(wait)
    lastReq = Date.now()
    reqCount++
    try {
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
      const text = await res.text()
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status)
      const json = JSON.parse(text)
      const errs = Array.isArray(json) ? json.filter((x) => x.error).map((x) => JSON.stringify(x.error)) : json.error ? [JSON.stringify(json.error)] : []
      if (errs.some((e) => /429|too many|rate limit|timeout/i.test(e))) throw new Error('rate: ' + errs[0])
      if (!Array.isArray(json) && json.error) { const e = new Error(errs[0]); e.fatal = true; throw e }
      return json
    } catch (e) {
      if (e.fatal || attempt >= 7) throw e
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 60_000)
    }
  }
}
let rid = 1
const rpc = async (method, params) => (await post({ jsonrpc: '2.0', id: rid++, method, params })).result
async function rpcBatch(calls) {
  const json = await post(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params })))
  const out = new Array(calls.length)
  for (const x of json) out[x.id] = x
  return out
}
const hex = (n) => '0x' + n.toString(16)
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d)
const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v)) }

// ── Block timestamps (headers are kept forever even on this non-archive RPC) ──
const TS_FILE = join(CACHE, 'block-ts.json')
const tsCache = readJson(TS_FILE, {})
async function fetchTs(blocks, label) {
  const need = [...new Set(blocks)].filter((b) => tsCache[b] === undefined)
  for (let i = 0; i < need.length; i += 20) {
    const part = need.slice(i, i + 20)
    const res = await rpcBatch(part.map((b) => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] })))
    res.forEach((r, j) => { if (r && r.result) tsCache[part[j]] = Number(BigInt(r.result.timestamp)) })
    if (label && (i / 20) % 25 === 0) process.stderr.write(`\r[ts] ${label} ${Math.min(i + 20, need.length)}/${need.length}   `)
    if ((i / 20) % 25 === 24) writeJson(TS_FILE, tsCache)
  }
  if (need.length) { writeJson(TS_FILE, tsCache); if (label) process.stderr.write('\n') }
}

// ── Uniswap TickMath and the resolver's WAD quote, exactly ───────────────────
const TM = [
  [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
]
function sqrtRatioAtTick(tick) { // contracts/src/lib/TickMath.sol:49-86
  const abs = BigInt(Math.abs(tick))
  let ratio = abs & 1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n
  for (const [bit, mul] of TM) if (abs & bit) ratio = (ratio * mul) >> 128n
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
}
const E18 = 10n ** 18n
function quoteWad(tick, wethIsToken0) { // PoolOracleResolver._quoteWad, :498-510
  const s = sqrtRatioAtTick(tick)
  const baseIsToken0 = !wethIsToken0
  if (s <= (1n << 128n) - 1n) {
    const r = s * s
    return baseIsToken0 ? (r * E18) >> 192n : ((1n << 192n) * E18) / r
  }
  const r = (s * s) >> 64n
  return baseIsToken0 ? (r * E18) >> 128n : ((1n << 128n) * E18) / r
}
function spreadBps(a, b) { // :512-516
  if (a === 0n || b === 0n) return 10_000n
  const diff = a > b ? a - b : b - a
  return (diff * 10_000n) / ((a + b) / 2n)
}
function makePricer(wethIsToken0, exactAlways) {
  const cache = new Map()
  const q = (t) => { let v = cache.get(t); if (v === undefined) { v = quoteWad(t, wethIsToken0); cache.set(t, v) } return v }
  // Far from the 2% boundary the tick distance decides; near it (and on pools with tiny quotes) the
  // rounded WAD quotes are compared exactly as the contract does. 201 ticks is 200.98 bps, 202 is 201.98.
  const spreadOk = (t1, t2) => {
    const d = t1 > t2 ? t1 - t2 : t2 - t1
    if (!exactAlways) { if (d <= 190) return true; if (d >= 215) return false }
    return spreadBps(q(t1), q(t2)) <= MAX_SPREAD_BPS
  }
  // +1 token price up (exit > entry), -1 down, 0 tie (OrderbookMarket.sol:637-642)
  const cmp = (exitT, entryT) => {
    if (exitT === entryT) return 0
    const d = exitT > entryT ? exitT - entryT : entryT - exitT
    if (exactAlways || d <= 3) { const a = q(exitT), b = q(entryT); return a === b ? 0 : a > b ? 1 : -1 }
    return (wethIsToken0 ? -1 : 1) * (exitT > entryT ? 1 : -1)
  }
  return { q, spreadOk, cmp }
}

// ── Pool metadata (immutable) and the observe() snapshot at the head ─────────
const w2a = (h) => '0x' + h.slice(26, 66).toLowerCase()
function decodeString(h) {
  try { const b = h.slice(2); const len = Number(BigInt('0x' + b.slice(64, 128))); return Buffer.from(b.slice(128, 128 + len * 2), 'hex').toString('utf8') } catch { return '?' }
}
async function poolMeta(addrs) {
  const f = join(CACHE, 'pool-meta.json')
  const meta = readJson(f, {})
  const need = addrs.filter((a) => !meta[a])
  for (const a of need) {
    const r = await rpcBatch(['0x0dfe1681', '0xd21220a7', '0xddca3f43', '0xc45a0155'].map((data) => ({ method: 'eth_call', params: [{ to: a, data }, 'latest'] })))
    const token0 = w2a(r[0].result), token1 = w2a(r[1].result)
    const token = token0 === WETH ? token1 : token0
    const r2 = await rpcBatch(['0x95d89b41', '0x313ce567', '0x06fdde03'].map((data) => ({ method: 'eth_call', params: [{ to: token, data }, 'latest'] })))
    meta[a] = { pool: a, token0, token1, token, fee: Number(BigInt(r[2].result)), factory: w2a(r[3].result), wethIsToken0: token0 === WETH, symbol: decodeString(r2[0].result), decimals: Number(BigInt(r2[1].result)), name: decodeString(r2[2].result) }
  }
  if (need.length) writeJson(f, meta)
  return addrs.map((a) => meta[a])
}
const OBS_SETS = [[300, 240, 180, 120, 90, 60, 45, 30, 20, 10, 0], [120, 90, 60, 45, 30, 20, 10, 0], [60, 45, 30, 20, 10, 0], [30, 20, 10, 0], [10, 0], [0]]
const encObserve = (agos) => '0x883bdbfd' + [0x20, agos.length, ...agos].map((n) => n.toString(16).padStart(64, '0')).join('')
function decObserve(h) {
  const b = h.slice(2), w = (i) => b.slice(i * 64, i * 64 + 64)
  const off = Number(BigInt('0x' + w(0))) / 32, len = Number(BigInt('0x' + w(off)))
  return Array.from({ length: len }, (_, i) => BigInt.asIntN(56, BigInt('0x' + w(off + 1 + i))).toString())
}
async function snapshotAtHead(metas, H) {
  const out = {}
  for (const m of metas) {
    const base = await rpcBatch([
      { method: 'eth_call', params: [{ to: m.pool, data: '0x3850c7bd' }, hex(H)] },
      { method: 'eth_call', params: [{ to: m.pool, data: '0x1a686502' }, hex(H)] },
    ])
    const s0 = base[0].result.slice(2)
    const sqrtP = BigInt('0x' + s0.slice(0, 64))
    const L = BigInt(base[1].result)
    const depth = sqrtP === 0n ? 0 : Number(m.wethIsToken0 ? (L * (1n << 96n)) / sqrtP : (L * sqrtP) >> 96n) / 1e18 // PoolMarketFactory.wethDepth, :275-284
    const rec = { tick: Number(BigInt.asIntN(24, BigInt('0x' + s0.slice(64, 128)))), cardinality: Number(BigInt('0x' + s0.slice(192, 256))), depthEth: depth, observe: null }
    for (const agos of OBS_SETS) {
      const r = (await rpcBatch([{ method: 'eth_call', params: [{ to: m.pool, data: encObserve(agos) }, hex(H)] }]))[0]
      if (r.result) { rec.observe = { agos, cums: decObserve(r.result) }; break }
      rec.observeError = JSON.stringify(r.error).slice(0, 120)
    }
    out[m.pool] = rec
  }
  return out
}

// ── Swap logs, cached per 100k-block chunk ───────────────────────────────────
async function getLogsSplit(from, to, addrs) {
  try {
    // the public RPC refuses more than 10 000 logs per query ("exceeds limit"): halve and retry
    const filter = { fromBlock: hex(from), toBlock: hex(to), topics: [SWAP_TOPIC] }
    if (addrs) filter.address = addrs
    return await rpc('eth_getLogs', [filter])
  } catch (e) {
    if (to - from < 500) throw e
    const mid = Math.floor((from + to) / 2)
    return [...(await getLogsSplit(from, mid, addrs)), ...(await getLogsSplit(mid + 1, to, addrs))]
  }
}
async function fetchLogs(metas, start, H, dir) {
  const idx = new Map(metas.map((m, i) => [m.pool, i]))
  const rows = []
  const k0 = Math.floor(start / 100_000), k1 = Math.floor(H / 100_000)
  for (let k = k0; k <= k1; k++) {
    const from = Math.max(start, k * 100_000), to = Math.min(H, k * 100_000 + 99_999)
    const f = join(dir, `logs-${from}-${to}.json`)
    let chunk = readJson(f, null)
    if (!chunk) {
      const logs = await getLogsSplit(from, to, metas.map((m) => m.pool))
      chunk = []
      for (const l of logs) {
        const pi = idx.get(l.address.toLowerCase())
        if (pi === undefined || l.removed) continue
        const m = metas[pi], d = l.data.slice(2)
        const a0 = BigInt.asIntN(256, BigInt('0x' + d.slice(0, 64))), a1 = BigInt.asIntN(256, BigInt('0x' + d.slice(64, 128)))
        const sqrtP = BigInt('0x' + d.slice(128, 192)), L = BigInt('0x' + d.slice(192, 256))
        const tick = Number(BigInt.asIntN(24, BigInt('0x' + d.slice(256, 320))))
        const wethAmt = m.wethIsToken0 ? a0 : a1 // pool balance delta: > 0 means WETH paid in, the token was bought
        const depth = sqrtP === 0n ? 0 : Number(m.wethIsToken0 ? (L * (1n << 96n)) / sqrtP : (L * sqrtP) >> 96n) / 1e18
        chunk.push([pi, Number(BigInt(l.blockNumber)), Number(BigInt(l.logIndex)), tick, wethAmt > 0n ? 1 : wethAmt < 0n ? -1 : 0, Number((Number(wethAmt < 0n ? -wethAmt : wethAmt) / 1e18).toFixed(6)), Number(depth.toFixed(2))])
      }
      writeJson(f, chunk)
      process.stderr.write(`\r[logs] ${to - start}/${H - start} blocks, chunk ${chunk.length} swaps   `)
    }
    for (const r of chunk) rows.push(r)
  }
  process.stderr.write('\n')
  return rows
}

// ── Discover mode ────────────────────────────────────────────────────────────
if (argv.includes('--discover')) {
  const head = Number(BigInt(await rpc('eth_blockNumber', [])))
  const counts = new Map()
  for (let s = head - 36_000; s <= head; s += 2000) {
    const logs = await getLogsSplit(s, Math.min(head, s + 1999), null)
    for (const l of logs) { const a = l.address.toLowerCase(); counts.set(a, (counts.get(a) ?? 0) + 1) }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80)
  console.log('swaps in the last 36 000 blocks (~1 h), canonical v3 WETH pools, fee 500/3000/10000:')
  for (const [a, n] of top) {
    const r = await rpcBatch(['0xc45a0155', '0x0dfe1681', '0xd21220a7', '0xddca3f43', '0x3850c7bd', '0x1a686502'].map((data) => ({ method: 'eth_call', params: [{ to: a, data }, 'latest'] })))
    if (r.some((x) => !x.result || x.result === '0x')) continue
    const [fac, t0, t1] = [w2a(r[0].result), w2a(r[1].result), w2a(r[2].result)]
    const fee = Number(BigInt(r[3].result))
    if (fac !== V3_FACTORY || (t0 !== WETH && t1 !== WETH) || ![500, 3000, 10000].includes(fee)) continue
    const sqrtP = BigInt('0x' + r[4].result.slice(2, 66)), L = BigInt(r[5].result)
    const depth = sqrtP === 0n ? 0 : Number(t0 === WETH ? (L * (1n << 96n)) / sqrtP : (L * sqrtP) >> 96n) / 1e18
    const tok = t0 === WETH ? t1 : t0
    const nm = decodeString((await rpcBatch([{ method: 'eth_call', params: [{ to: tok, data: '0x06fdde03' }, 'latest'] }]))[0].result ?? '0x')
    console.log(a, String(n).padStart(6), 'fee', String(fee).padStart(5), 'depth', depth.toFixed(1).padStart(10), nm)
  }
  process.exit(0)
}

// ── Collect ──────────────────────────────────────────────────────────────────
const t0Run = Date.now()
const poolAddrs = POOLS.map((p) => p[0])
const setHash = createHash('sha1').update([...poolAddrs].sort().join(',')).digest('hex').slice(0, 10)
const SET_DIR = join(CACHE, 'set-' + setHash)
const metas = await poolMeta(poolAddrs)
POOLS.forEach((p, i) => { metas[i].label = p[1] ?? metas[i].symbol })

let H
if (HEAD_ARG === 'latest') H = Number(BigInt(await rpc('eth_blockNumber', [])))
else H = Number(HEAD_ARG)
const snapFile = join(SET_DIR, `head-${H}.json`)
// The observe() snapshot can only be taken at the chain tip, so the one the document used is kept
// in the repository too: a later run from a clean cache still checks the series against it.
const REPO_SNAP = join('docs', 'rhc', 'measurements', 'sharp-edge', `observe-head-${H}.json`)
let snap = readJson(snapFile, null) ?? readJson(REPO_SNAP, null)
if (snap && !poolAddrs.every((a) => snap[a])) snap = null
if (!snap) {
  if (HEAD_ARG !== 'latest') console.error(`[warn] no observe() snapshot cached for head ${H}; the TWAP check is only possible at the chain tip (--head latest)`)
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])))
  if (H > latest) throw new Error(`head ${H} is past the chain tip ${latest}`)
  snap = latest - H < 3000 ? await snapshotAtHead(metas, H) : null
  if (snap) writeJson(snapFile, snap)
}
await fetchTs([H, H - 1_000_000])
const T_H = tsCache[H]
const rate = 1_000_000 / (T_H - tsCache[H - 1_000_000]) // blocks per second, measured
const START = H - Math.round(DAYS * 86400 * rate)
const anchors = [START]
for (let b = Math.ceil(START / ANCHOR) * ANCHOR; b < H; b += ANCHOR) if (b > START) anchors.push(b)
anchors.push(H)
await fetchTs(anchors, 'anchors')
const aTs = anchors.map((b) => tsCache[b])
function tsInterp(b) { // anchors every ANCHOR blocks (~100 s); linear inside, the phase of a second is unknown
  let lo = 0, hi = anchors.length - 1
  if (b <= anchors[0]) return aTs[0]
  if (b >= anchors[hi]) return aTs[hi]
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (anchors[mid] <= b) lo = mid; else hi = mid }
  const A = anchors[lo], B = anchors[hi]
  const v = Math.floor(aTs[lo] + 0.5 + ((b - A) * (aTs[hi] - aTs[lo])) / (B - A))
  return Math.min(aTs[hi], Math.max(aTs[lo], v))
}
const rows = await fetchLogs(metas, START, H, SET_DIR)
rows.sort((a, b) => a[1] - b[1] || a[2] - b[2])
const T0 = aTs[0]
const N = T_H - T0 + 1 // seconds T0..T_H; the head second itself is only partly known and never used as data
const HOUR0 = Math.floor(T0 / 3600)
const NH = Math.floor(T_H / 3600) - HOUR0 + 1
const MID_HOUR = Math.floor(NH / 2) // first half = train, second half = test

// Exact timestamps: every swap block of the last ~400 s (TWAP check) and a random sample (interpolation error)
let seed = 0x5eed
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const tailBlocks = [...new Set(rows.filter((r) => r[1] >= H - 4000).map((r) => r[1]))]
await fetchTs(tailBlocks, 'tail')
const allBlocks = [...new Set(rows.map((r) => r[1]))]
const sampleBlocks = []
for (let i = 0; i < 300 && allBlocks.length; i++) sampleBlocks.push(allBlocks[Math.floor(rnd() * allBlocks.length)])
await fetchTs(sampleBlocks, 'sample')
const tsErr = { n: 0, exact: 0, off1: 0, worse: 0, maxAbs: 0 }
for (const b of new Set(sampleBlocks)) { const e = tsInterp(b) - tsCache[b]; tsErr.n++; if (e === 0) tsErr.exact++; else if (Math.abs(e) === 1) tsErr.off1++; else tsErr.worse++; tsErr.maxAbs = Math.max(tsErr.maxAbs, Math.abs(e)) }
console.error(`[collect] head ${H}, ${rows.length} swaps, ${reqCount} RPC requests, ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)

// ── Verification against observe() at the head ───────────────────────────────
const verify = []
if (snap) {
  for (let pi = 0; pi < metas.length; pi++) {
    const m = metas[pi], s = snap[m.pool]
    const all = rows.filter((r) => r[0] === pi)
    const last = all.at(-1)
    // the tail is enough: every window ends at the head and starts at most 300 s before it
    const firstTail = all.findIndex((r) => r[1] >= H - 6000)
    const sw = firstTail < 0 ? all.slice(-1) : all.slice(Math.max(0, firstTail - 1))
    const rec = { label: m.label, cardinality: s.cardinality, slot0Tick: s.tick, lastSwapTick: last ? last[3] : null, points: 0, maxCumDiffExact: null, maxMeanDiffExact: null, maxMeanDiffInterp: null, error: s.observe ? null : s.observeError }
    if (s.observe && s.observe.agos.length > 1) {
      const agos = s.observe.agos, cums = s.observe.cums.map(BigInt)
      const at0 = cums[agos.length - 1]
      // sum of the in-effect tick over seconds [Ta, T_H), from swaps with their timestamps
      const sumTo = (Ta, tsOf) => {
        let tick = null, acc = 0, u = Ta, i = 0
        const evs = sw.map((r) => [tsOf(r[1]), r[3]])
        while (i < evs.length && evs[i][0] <= Ta) { tick = evs[i][1]; i++ }
        for (; u < T_H; u++) { while (i < evs.length && evs[i][0] <= u) { tick = evs[i][1]; i++ } acc += tick }
        return acc
      }
      let mc = 0, me = 0, mi = 0
      for (let j = 0; j < agos.length - 1; j++) {
        const a = agos[j], obs = Number(at0 - cums[j])
        const ex = sumTo(T_H - a, (b) => (b >= H - 4000 ? tsCache[b] : tsInterp(b)))
        const ip = sumTo(T_H - a, tsInterp)
        mc = Math.max(mc, Math.abs(obs - ex))
        me = Math.max(me, Math.abs(Math.floor(obs / a) - Math.floor(ex / a)))
        mi = Math.max(mi, Math.abs(Math.floor(obs / a) - Math.floor(ip / a)))
        rec.points++
      }
      Object.assign(rec, { maxCumDiffExact: mc, maxMeanDiffExact: me, maxMeanDiffInterp: mi, windows: agos.slice(0, -1).join('/') })
    }
    verify.push(rec)
  }
}

// ── Simulation ───────────────────────────────────────────────────────────────
// Outcome codes of one bet: 0 rejected by the entry guard, 1 refunded by the exit guard, 2 tie, 3 won, 4 lost
const NR = RULES.length, ND = DURATIONS.length, NDL = DELAYS.length
const NCFG = NDL * NR * ND * NS
const NP = metas.length
const NCL = NP * NH
const tot = new Float64Array(NCFG * 5)
const poolTot = new Float64Array(NP * NCFG * 5)
const clW = new Int32Array(NCFG * NCL) // wins per (cfg, pool-hour)
const clN = new Int32Array(NCFG * NCL) // decided per (cfg, pool-hour)
const cfgIdx = (di, ri, dj, s) => ((di * NR + ri) * ND + dj) * NS + s
const poolInfo = []
const dirs = new Int8Array(NS)
// stage 2 (section 8+ of the document): per-event record for the main delay
const DUR2 = [60, 300, 900, 1800, 3600] // 1800 and 3600 are research only: the factory allows 60/300/900
const NR2 = 3 // E0, E1, E2
const REFUND2 = 1 << 30, OOR2 = (1 << 30) + 1
const st2 = { pool: [], hour: [], dir: [], rnd: [], gap: [], devBot: [], devC: [], rej: [], delta: Array.from({ length: NR2 }, () => DUR2.map(() => [])) }
const tStart = Date.now()
for (let pi = 0; pi < NP; pi++) {
  const m = metas[pi]
  const sw = rows.filter((r) => r[0] === pi)
  const info = { label: m.label, symbol: m.symbol, name: m.name, pool: m.pool, fee: m.fee, wethIsToken0: m.wethIsToken0, canonical: m.factory === V3_FACTORY, swaps: sw.length, events: 0, firstSwap: null, days: 0, depthNow: snap ? snap[m.pool].depthEth : null, cardinality: snap ? snap[m.pool].cardinality : null, depthMedian: null, depthP10: null }
  poolInfo.push(info)
  if (sw.length < 2) continue
  const dep = sw.map((r) => r[6]).sort((a, b) => a - b)
  info.depthMedian = dep[Math.floor(dep.length / 2)]
  info.depthP10 = dep[Math.floor(dep.length * 0.1)]
  // per-second tick in effect: the tick after the last swap of that second (Oracle.write accrues the
  // pre-swap tick up to the swap's block time, so a swap in second u is in effect from u + 1 on,
  // and several swaps in one second leave only the last one's tick in the cumulative)
  const tickAt = new Int32Array(N)
  const evU = [], evDir = []
  let cur = 0, firstSec = -1, j = 0
  const uOf = sw.map((r) => tsInterp(r[1]) - T0)
  for (let u = 0; u < N; u++) {
    let had = false, lastDir = 0
    while (j < sw.length && uOf[j] <= u) { cur = sw[j][3]; lastDir = sw[j][4] || lastDir; had = true; j++ }
    if (had) { if (firstSec < 0) firstSec = u; if (u < N - 1) { evU.push(u); evDir.push(lastDir) } }
    tickAt[u] = cur
  }
  const cum = new Float64Array(N + 1)
  for (let u = 0; u < N; u++) cum[u + 1] = cum[u] + tickAt[u]
  info.events = evU.length
  info.firstSwap = new Date((T0 + firstSec) * 1000).toISOString()
  info.days = (N - 1 - firstSec) / 86400
  let minT = Infinity, maxT = -Infinity
  for (let u = firstSec; u < N; u++) { if (tickAt[u] < minT) minT = tickAt[u]; if (tickAt[u] > maxT) maxT = tickAt[u] }
  const qA = quoteWad(minT, m.wethIsToken0), qB = quoteWad(maxT, m.wethIsToken0)
  const minQ = qA < qB ? qA : qB
  info.minQuoteWei = minQ.toString()
  const pr = makePricer(m.wethIsToken0, minQ < 10n ** 9n)
  const orient = m.wethIsToken0 ? -1 : 1
  let ps = 0x1234 + pi * 7919
  const prand = () => { ps = (Math.imul(ps, 1103515245) + 12345) & 0x7fffffff; return ps / 0x80000000 }
  const evRand = evU.map(() => (prand() < 0.5 ? 1 : -1))
  const LAST = N - 1 // cum[LAST] is the cumulative at the head's own second: every window must end by then
  for (let di = 0; di < NDL; di++) {
    const D = DELAYS[di]
    for (let i = 0; i < evU.length; i++) {
      const u = evU[i], mt = u + D
      if (mt - ENTRY_TWAP_WINDOW < firstSec || mt > LAST) continue
      // what the bot sees at the swap: spot after it, and the strike it expects at the match
      // (the real one, with the seconds until the match filled in at today's spot)
      const spot = tickAt[u]
      const pred = D === 0 ? (cum[u] - cum[u - 60]) / 60 : (cum[u + 1] - cum[mt - 60] + spot * (D - 1)) / 60
      const devT = orient * (spot - pred)
      const devF = Math.abs(Math.pow(1.0001, devT) - 1)
      const inGuard = Math.abs(spot - pred) <= 201
      dirs[0] = evRand[i]
      for (let k = 0; k < KS.length; k++) {
        const d = inGuard && devT !== 0 && devF >= KS[k] ? (devT > 0 ? 1 : -1) : 0
        dirs[1 + k] = d
        dirs[1 + KS.length + k] = -d
      }
      dirs[NS - 2] = evDir[i]
      dirs[NS - 1] = -evDir[i]
      // the contract at the match: strike = 60 s TWAP, refused if live spot is > 2% away (:176-196)
      const twapE = Math.floor((cum[mt] - cum[mt - 60]) / 60)
      const spotM = D >= 1 ? tickAt[mt - 1] : spot
      const rejected = !pr.spreadOk(twapE, spotM)
      const hr = Math.floor((T0 + mt) / 3600) - HOUR0
      const cl = pi * NH + hr
      if (di === MAIN_DI) {
        // stage 2 keeps every event of the main delay: who, when, both deviations, and for each entry rule
        // and duration the oriented tick move exit - entry (token price up > 0), so that dead zones, payout
        // tables and re-optimised bots can all be replayed without recomputing the series
        st2.pool.push(pi); st2.hour.push(hr); st2.dir.push(evDir[i]); st2.rnd.push(evRand[i]); st2.gap.push(i + 1 < evU.length ? evU[i + 1] - u : 1e9)
        st2.devBot.push(inGuard ? devT : NaN); st2.devC.push(orient * (spotM - twapE)); st2.rej.push(rejected ? 1 : 0)
        for (let r2 = 0; r2 < NR2; r2++) {
          const lag = r2 === 0 ? 0 : r2 === 1 ? 30 : 60
          const entryT = r2 === 0 ? twapE : mt + lag <= LAST ? Math.floor((cum[mt + lag] - cum[mt]) / lag) : null
          for (let q = 0; q < DUR2.length; q++) {
            const settle = mt + lag + DUR2[q]
            let v = OOR2
            if (entryT !== null && settle <= LAST) {
              const W = twapWindowFor(DUR2[q]), A = Math.max(1, Math.floor(W / ANCHOR_FRACTION))
              const exitT = Math.floor((cum[settle] - cum[settle - W]) / W)
              const ancT = Math.floor((cum[settle] - cum[settle - A]) / A)
              if (!pr.spreadOk(exitT, ancT)) v = REFUND2
              else { const c = pr.cmp(exitT, entryT); v = c === 0 ? 0 : c * Math.max(1, Math.abs(exitT - entryT)) }
            }
            st2.delta[r2][q].push(v)
          }
        }
      }
      for (let ri = 0; ri < NR; ri++) {
        let entryT, start
        if (ri === 0) { entryT = twapE; start = mt }
        else if (ri === 1) { if (mt + 30 > LAST) continue; entryT = Math.floor((cum[mt + 30] - cum[mt]) / 30); start = mt + 30 }
        else if (ri === 2) { if (mt + 60 > LAST) continue; entryT = Math.floor((cum[mt + 60] - cum[mt]) / 60); start = mt + 60 }
        else { entryT = spotM; start = mt }
        for (let dj = 0; dj < ND; dj++) {
          const settle = start + DURATIONS[dj] // settleAt = match + duration (OrderbookMarket.sol:601)
          if (settle > LAST) continue
          let oc // +1 token up, -1 down, 0 tie, 2 refunded by the exit guard, 3 rejected by the entry guard
          if (rejected) oc = 3
          else {
            const W = EXIT_W[dj], A = EXIT_A[dj]
            const exitT = Math.floor((cum[settle] - cum[settle - W]) / W) // floor like _meanFrom (:473-484)
            const ancT = Math.floor((cum[settle] - cum[settle - A]) / A)
            if (!pr.spreadOk(exitT, ancT)) oc = 2 // REASON_SPREAD refund, no fee (:344-346)
            else oc = pr.cmp(exitT, entryT)
          }
          const base = cfgIdx(di, ri, dj, 0)
          for (let s = 0; s < NS; s++) {
            const d = dirs[s]
            if (d === 0) continue
            const cfg = base + s
            // slots: 0 rejected, 1 refunded, 2 tie, 3 won, 4 lost
            const slot = oc === 3 ? 0 : oc === 2 ? 1 : oc === 0 ? 2 : oc === d ? 3 : 4
            tot[cfg * 5 + slot]++
            poolTot[(pi * NCFG + cfg) * 5 + slot]++
            if (slot >= 3) { const x = cfg * NCL + cl; clN[x]++; if (slot === 3) clW[x]++ }
          }
        }
      }
    }
  }
}
console.error(`[sim] ${((Date.now() - tStart) / 1000).toFixed(1)} s`)

// ── Statistics ───────────────────────────────────────────────────────────────
// p = wins / decided. Bets after neighbouring swaps overlap, so the error is cluster-robust over
// pool-hour blocks (and over 6-hour blocks as a check), not the binomial one.
function stats(cfg, { half = 'all', block = 1, pools = null, minus = null } = {}) {
  // `minus`: subtract another (nested) configuration cluster by cluster, e.g. S1 k=0.1% minus
  // S1 k=0.25% is the band of bets whose deviation was between the two thresholds
  let W = 0, Nn = 0
  const ws = [], ns = []
  for (let pi = 0; pi < NP; pi++) {
    if (pools && !pools.includes(pi)) continue
    for (let h0 = 0; h0 < NH; h0 += block) {
      let w = 0, n = 0
      for (let h = h0; h < Math.min(NH, h0 + block); h++) {
        if (half === 'train' && h >= MID_HOUR) continue
        if (half === 'test' && h < MID_HOUR) continue
        const x = cfg * NCL + pi * NH + h
        w += clW[x]; n += clN[x]
        if (minus !== null) { const y = minus * NCL + pi * NH + h; w -= clW[y]; n -= clN[y] }
      }
      if (n > 0) { ws.push(w); ns.push(n); W += w; Nn += n }
    }
  }
  const p = Nn ? W / Nn : NaN
  let s2 = 0
  for (let i = 0; i < ws.length; i++) { const r = ws[i] - p * ns[i]; s2 += r * r }
  const C = ws.length
  const se = C > 1 ? Math.sqrt((C / (C - 1)) * s2) / Nn : NaN
  return { p, se, n: Nn, wins: W, clusters: C, ws, ns }
}
function bootstrap(st, B) {
  if (!st.ws.length || B <= 0) return NaN
  let s = 0x9e37, acc = 0, acc2 = 0
  const r = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x80000000 }
  for (let b = 0; b < B; b++) {
    let w = 0, n = 0
    for (let i = 0; i < st.ws.length; i++) { const k = Math.floor(r() * st.ws.length); w += st.ws[k]; n += st.ns[k] }
    const p = w / n
    acc += p; acc2 += p * p
  }
  const mean = acc / B
  return Math.sqrt(Math.max(0, acc2 / B - mean * mean))
}
const counts = (cfg) => { const b = cfg * 5; return { rej: tot[b], ref: tot[b + 1], tie: tot[b + 2], win: tot[b + 3], loss: tot[b + 4] } }
const pct = (x, d = 1) => (Number.isFinite(x) ? (100 * x).toFixed(d) + '%' : '-')
const pad = (s, n) => String(s).padStart(n)
const padE = (s, n) => String(s).padEnd(n)

// ── Money (docs/rhc/ECONOMICS.md, section G) ─────────────────────────────────
// Vault's result per unit of the player's stake on a decided match:
//   player wins: -(1 - 2 f_lp);  vault wins: +(1 - 2 f_pr)
//   E = 1 - 2p + 2p (f_lp + f_pr) - 2 f_pr, scaled by the decided share (ties and refunds pay nothing)
const F_PR = 0.01
const F_LP = [0.01, 0.03, 0.05, 0.08, 0.1]
const evLp = (p, flp, decided) => decided * (1 - 2 * p + 2 * p * (flp + F_PR) - 2 * F_PR)
const pStar = (flp) => (1 - 2 * F_PR) / (2 * (1 - F_PR - flp))
const flpNeeded = (p) => 1 - F_PR - (1 - 2 * F_PR) / (2 * p)
const pStarProject = (flp) => 1 / (2 * (1 - F_PR - flp)) // vault + the protocol fee the treasury keeps, before gas

// ── Output ───────────────────────────────────────────────────────────────────
const out = []
const say = (s = '') => { out.push(s); console.log(s) }
say(`Период: ${new Date(T0 * 1000).toISOString()} - ${new Date(T_H * 1000).toISOString()} (${((T_H - T0) / 86400).toFixed(2)} сут), блоки ${START}-${H}, ${rate.toFixed(3)} блока/с`)
say(`Свопов ${rows.length}, пулов ${NP}, задержка ${DELAY} с (чувствительность ${DELAYS.join('/')} с), обучение - часы до ${new Date((HOUR0 + MID_HOUR) * 3600 * 1000).toISOString()}`)
say()
say('## Пулы')
say(`${padE('пул', 12)} ${padE('адрес', 42)} ${pad('fee', 5)} ${pad('WETH', 4)} ${pad('глуб.сейчас', 11)} ${pad('медиана', 8)} ${pad('p10', 7)} ${pad('кард.', 6)} ${pad('свопов', 7)} ${pad('секунд', 7)} ${pad('суток', 6)}`)
for (const p of poolInfo) say(`${padE(p.label, 12)} ${padE(p.pool, 42)} ${pad(p.fee, 5)} ${pad(p.wethIsToken0 ? 't0' : 't1', 4)} ${pad(p.depthNow == null ? '-' : p.depthNow.toFixed(1), 11)} ${pad(p.depthMedian == null ? '-' : p.depthMedian.toFixed(1), 8)} ${pad(p.depthP10 == null ? '-' : p.depthP10.toFixed(1), 7)} ${pad(p.cardinality ?? '-', 6)} ${pad(p.swaps, 7)} ${pad(p.events, 7)} ${pad(p.days.toFixed(1), 6)}`)
say()
say('## Проверка ряда против observe() пула на блоке головы')
say(`Время блоков: интерполяция по опорным блокам через ${ANCHOR}; на выборке ${tsErr.n} блоков со свопами точно ${pct(tsErr.exact / tsErr.n)}, на 1 с ${pct(tsErr.off1 / tsErr.n)}, больше ${pct(tsErr.worse / tsErr.n)}, максимум ${tsErr.maxAbs} с`)
if (!verify.length) say('снимка observe() для этой головы нет (он возможен только на вершине цепочки, --head latest)')
for (const v of verify) say(`${padE(v.label, 12)} кард. ${pad(v.cardinality, 5)}  slot0 ${pad(v.slot0Tick, 7)} / последний своп ${pad(v.lastSwapTick, 7)}  окна ${v.windows ?? '-'}  макс. расхождение: накопленный тик ${v.maxCumDiffExact ?? '-'}, средний тик ${v.maxMeanDiffExact ?? '-'} (точное время) / ${v.maxMeanDiffInterp ?? '-'} (интерполяция)${v.error ? '  observe: ' + v.error : ''}`)
say()

function stratTable(di, ri, title) {
  say(`## ${title}`)
  say(`${padE('стратегия', 16)} ${DURATIONS.map((d) => `${pad(d + ' с: ставок', 13)} ${pad('p', 6)} ${pad('+-1ч', 5)} ${pad('+-6ч', 5)} ${pad('нич.', 5)} ${pad('возвр', 5)} ${pad('откл', 5)}`).join(' |')}`)
  for (let s = 0; s < NS; s++) {
    const cells = DURATIONS.map((_, dj) => {
      const cfg = cfgIdx(di, ri, dj, s), c = counts(cfg), st = stats(cfg), st6 = stats(cfg, { block: 6 })
      const acc = c.ref + c.tie + c.win + c.loss
      return `${pad(acc, 13)} ${pad(pct(st.p), 6)} ${pad((100 * st.se).toFixed(1), 5)} ${pad((100 * st6.se).toFixed(1), 5)} ${pad(pct(c.tie / acc), 5)} ${pad(pct(c.ref / acc), 5)} ${pad(pct(c.rej / (acc + c.rej)), 5)}`
    })
    say(`${padE(STRATS[s], 16)} ${cells.join(' |')}`)
  }
  say()
}
stratTable(MAIN_DI, 0, `Текущие правила (E0), задержка ${DELAY} с: доля побед игрока p среди решённых, ошибка по блокам 1 ч и 6 ч (п.п.)`)
for (let ri = 1; ri < NR; ri++) stratTable(MAIN_DI, ri, `${RULES[ri]}, задержка ${DELAY} с`)

// best fast strategy: chosen on the first half, reported on the second
const summary = { head: H, headTime: new Date(T_H * 1000).toISOString(), start: START, startTime: new Date(T0 * 1000).toISOString(), days: (T_H - T0) / 86400, swaps: rows.length, delay: DELAY, delays: DELAYS, tsInterpolation: tsErr, verify, pools: poolInfo, rules: RULES, strategies: STRATS, durations: DURATIONS, best: [], table: [], money: [] }
const MIN_TRAIN = Number(arg("min-train", 2000))
function pickBest(di, ri, dj) {
  let best = null
  for (let s = 1; s < NS; s++) {
    const tr = stats(cfgIdx(di, ri, dj, s), { half: 'train' })
    if (tr.n < MIN_TRAIN) continue
    if (!best || tr.p > best.tr.p) best = { s, tr }
  }
  return best
}
say(`## Лучшая быстрая стратегия: выбрана на первой половине периода (не меньше ${MIN_TRAIN} решённых ставок), проверена на второй`)
say(`${padE('правило', 32)} ${pad('длит.', 5)} ${padE(' стратегия', 17)} ${pad('p обуч.', 8)} ${pad('p пров.', 8)} ${pad('+-1ч', 5)} ${pad('+-6ч', 5)} ${pad('бутстрап', 8)} ${pad('ставок пров.', 12)} ${pad('p весь', 7)}`)
for (let ri = 0; ri < NR; ri++) {
  for (let dj = 0; dj < ND; dj++) {
    const b = pickBest(MAIN_DI, ri, dj)
    if (!b) continue
    const cfg = cfgIdx(MAIN_DI, ri, dj, b.s)
    const te = stats(cfg, { half: 'test' }), te6 = stats(cfg, { half: 'test', block: 6 }), all = stats(cfg)
    const bs = bootstrap(te, BOOT)
    const c = counts(cfg)
    const acc = c.ref + c.tie + c.win + c.loss
    const row = { rule: RULES[ri], duration: DURATIONS[dj], strategy: STRATS[b.s], pTrain: b.tr.p, pTest: te.p, seTest1h: te.se, seTest6h: te6.se, seTestBoot: bs, nTest: te.n, pAll: all.p, seAll: all.se, tieShare: c.tie / acc, refundShare: c.ref / acc, rejectShare: c.rej / (acc + c.rej) }
    summary.best.push(row)
    say(`${padE(RULES[ri], 32)} ${pad(DURATIONS[dj], 5)}  ${padE(STRATS[b.s], 16)} ${pad(pct(b.tr.p), 8)} ${pad(pct(te.p), 8)} ${pad((100 * te.se).toFixed(1), 5)} ${pad((100 * te6.se).toFixed(1), 5)} ${pad((100 * bs).toFixed(1), 8)} ${pad(te.n, 12)} ${pad(pct(all.p), 7)}`)
    // S5: per deviation band, take whichever side won on the first half, and only bands that were
    // at least 2 points away from 50% there. A bot that reads the bands, not one fixed rule.
    const combo = comboBands(ri, dj)
    if (combo.n > 0) {
      const cRow = { rule: RULES[ri], duration: DURATIONS[dj], strategy: 'S5 полосы ' + combo.label, pTrain: combo.pTrain, pTest: combo.p, seTest1h: combo.se, seTest6h: NaN, seTestBoot: bootstrap(combo, BOOT), nTest: combo.n, pAll: NaN, seAll: NaN, tieShare: combo.tieShare, refundShare: combo.refundShare, rejectShare: combo.rejectShare }
      summary.best.push(cRow)
      say(`${padE('', 32)} ${pad(DURATIONS[dj], 5)}  ${padE('S5 ' + combo.label, 16)} ${pad(pct(combo.pTrain), 8)} ${pad(pct(combo.p), 8)} ${pad((100 * combo.se).toFixed(1), 5)} ${pad('-', 5)} ${pad((100 * cRow.seTestBoot).toFixed(1), 8)} ${pad(combo.n, 12)} ${pad('-', 7)}`)
    }
  }
}
say()
function comboBands(ri, dj) {
  const bandCfg = (k) => [cfgIdx(MAIN_DI, ri, dj, 1 + k), k + 1 < KS.length ? cfgIdx(MAIN_DI, ri, dj, 2 + k) : null]
  const choice = KS.map((_, k) => {
    const [a, b] = bandCfg(k)
    const tr = stats(a, { half: 'train', minus: b })
    return tr.n >= 200 && Math.abs(tr.p - 0.5) >= 0.02 ? (tr.p > 0.5 ? 1 : -1) : 0
  })
  const label = choice.map((c) => (c > 0 ? '+' : c < 0 ? '-' : '0')).join('')
  const run = (half) => {
    const ws = [], ns = []
    let W = 0, Nn = 0
    for (let pi = 0; pi < NP; pi++) for (let h = 0; h < NH; h++) {
      if ((half === 'test') !== (h >= MID_HOUR)) continue
      let w = 0, n = 0
      for (let k = 0; k < KS.length; k++) {
        if (!choice[k]) continue
        const [a, b] = bandCfg(k)
        let wk = clW[a * NCL + pi * NH + h], nk = clN[a * NCL + pi * NH + h]
        if (b !== null) { wk -= clW[b * NCL + pi * NH + h]; nk -= clN[b * NCL + pi * NH + h] }
        w += choice[k] > 0 ? wk : nk - wk // S2 is the same bet the other way: its wins are S1's losses
        n += nk
      }
      if (n > 0) { ws.push(w); ns.push(n); W += w; Nn += n }
    }
    const p = Nn ? W / Nn : NaN
    let s2 = 0
    for (let i = 0; i < ws.length; i++) { const r = ws[i] - p * ns[i]; s2 += r * r }
    const C = ws.length
    return { p, se: C > 1 ? Math.sqrt((C / (C - 1)) * s2) / Nn : NaN, n: Nn, ws, ns }
  }
  const te = run('test'), tr = run('train')
  // outcome shares of the chosen bands, whole period (bands are nested sets, so totals subtract)
  const sh = { tie: 0, ref: 0, rej: 0, all: 0 }
  KS.forEach((_, k) => {
    if (!choice[k]) return
    const [a, b] = bandCfg(k)
    const ca = counts(a), cb = b === null ? { rej: 0, ref: 0, tie: 0, win: 0, loss: 0 } : counts(b)
    sh.tie += ca.tie - cb.tie; sh.ref += ca.ref - cb.ref; sh.rej += ca.rej - cb.rej
    sh.all += ca.tie + ca.ref + ca.win + ca.loss - (cb.tie + cb.ref + cb.win + cb.loss)
  })
  return { ...te, pTrain: tr.p, label, tieShare: sh.tie / sh.all, refundShare: sh.ref / sh.all, rejectShare: sh.rej / (sh.all + sh.rej) }
}

say('## Чувствительность к задержке (E0): p на всём периоде, для S0, S1 k=0.5% и S3')
const sensS = [0, 1 + 3, NS - 2, NS - 1]
say(`${padE('задержка', 9)} ${DURATIONS.map((d) => sensS.map((s) => pad(STRATS[s].split(' ')[0] + (s === 4 ? '(.5)' : '') + '@' + d, 11)).join(' ')).join(' | ')}`)
for (let di = 0; di < NDL; di++) {
  say(`${padE(DELAYS[di] + ' с', 9)} ${DURATIONS.map((_, dj) => sensS.map((s) => { const st = stats(cfgIdx(di, 0, dj, s)); return pad(pct(st.p) + '±' + (100 * st.se).toFixed(1), 11) }).join(' ')).join(' | ')}`)
}
say()

for (const ri of [0, 1, 2]) {
  say(`## S1 по полосам отклонения спота от ожидаемого страйка, ${RULES[ri]}, задержка ${DELAY} с (S2 - зеркало: 100% - p)`)
  say(`${padE('полоса', 14)} ${DURATIONS.map((d) => `${pad(d + ' с: решено', 12)} ${pad('p', 6)} ${pad('+-1ч', 5)}`).join(' |')}`)
  for (let k = 0; k < KS.length; k++) {
    const lo = KS[k], hi = KS[k + 1]
    const cells = DURATIONS.map((_, dj) => {
      const st = stats(cfgIdx(MAIN_DI, ri, dj, 1 + k), { minus: hi === undefined ? null : cfgIdx(MAIN_DI, ri, dj, 2 + k) })
      return `${pad(st.n, 12)} ${pad(pct(st.p), 6)} ${pad((100 * st.se).toFixed(1), 5)}`
    })
    say(`${padE(`${lo === 0 ? '>0' : fmtK(lo)} - ${hi === undefined ? 'гард' : fmtK(hi)}`, 14)} ${cells.join(' |')}`)
  }
  say()
}

say(`## По пулам: E0, задержка ${DELAY} с, S1 k=0 и S3 (p, решённых ставок)`)
say(`${padE('пул', 12)} ${DURATIONS.map((d) => `${pad('S1@' + d, 14)} ${pad('S3@' + d, 14)}`).join(' | ')}`)
for (let pi = 0; pi < NP; pi++) {
  const cells = DURATIONS.map((_, dj) => [1, NS - 2].map((s) => { const st = stats(cfgIdx(MAIN_DI, 0, dj, s), { pools: [pi] }); return pad(st.n ? `${pct(st.p)} ${st.n}` : '-', 14) }).join(' ')).join(' | ')
  say(`${padE(poolInfo[pi].label, 12)} ${cells}`)
}
for (const [name, sel] of [['>= 20 ETH', (p) => (p.depthNow ?? 0) >= 20], ['< 20 ETH', (p) => (p.depthNow ?? 0) < 20]]) {
  const pools = poolInfo.map((p, i) => (sel(p) ? i : -1)).filter((i) => i >= 0)
  const cells = DURATIONS.map((_, dj) => [1, NS - 2].map((s) => { const st = stats(cfgIdx(MAIN_DI, 0, dj, s), { pools }); return pad(st.n ? `${pct(st.p)}±${(100 * st.se).toFixed(1)}` : '-', 14) }).join(' ')).join(' | ')
  say(`${padE(name, 12)} ${cells}`)
}
say()

say('## Деньги: ожидание хранилища на единицу ставки игрока, протокольная комиссия 1%')
say(`Порог p*, при котором хранилище в нуле: ${F_LP.map((f) => `f_lp ${pct(f, 0)} -> ${pct(pStar(f), 2)}`).join(', ')}`)
say(`Порог для проекта целиком (хранилище + комиссия казны, до газа): ${F_LP.map((f) => `${pct(f, 0)} -> ${pct(pStarProject(f), 2)}`).join(', ')}`)
say(`${padE('правило / длит. / стратегия', 52)} ${pad('p пров.', 8)} ${pad('решено', 7)} ${F_LP.map((f) => pad('f_lp ' + pct(f, 0), 9)).join(' ')} ${pad('нужна f_lp', 11)}`)
const moneyRows = []
for (let dj = 0; dj < ND; dj++) {
  const st = stats(cfgIdx(MAIN_DI, 0, dj, 0), { half: 'test' }); const c = counts(cfgIdx(MAIN_DI, 0, dj, 0)); const acc = c.ref + c.tie + c.win + c.loss
  moneyRows.push({ label: `${RULES[0].split(' ')[0]} ${DURATIONS[dj]} с ${STRATS[0]}`, p: st.p, decided: (c.win + c.loss) / acc })
}
for (const b of summary.best) moneyRows.push({ label: `${b.rule.split(' ')[0]} ${b.duration} с ${b.strategy}`, p: b.pTest, decided: 1 - b.tieShare - b.refundShare })
for (const r of moneyRows) {
  const need = flpNeeded(r.p)
  summary.money.push({ ...r, ev: F_LP.map((f) => evLp(r.p, f, r.decided)), flpNeeded: need })
  say(`${padE(r.label, 52)} ${pad(pct(r.p), 8)} ${pad(pct(r.decided), 7)} ${F_LP.map((f) => pad((100 * evLp(r.p, f, r.decided)).toFixed(2) + '%', 9)).join(' ')} ${pad(need <= 0 ? 'не нужна' : pct(need), 11)}`)
}
say()
for (let di = 0; di < NDL; di++) for (let ri = 0; ri < NR; ri++) for (let dj = 0; dj < ND; dj++) for (let s = 0; s < NS; s++) {
  const cfg = cfgIdx(di, ri, dj, s), st = stats(cfg), c = counts(cfg)
  summary.table.push({ delay: DELAYS[di], rule: ri, duration: DURATIONS[dj], strategy: STRATS[s], ...c, p: st.p, se1h: st.se, se6h: stats(cfg, { block: 6 }).se, pTrain: stats(cfg, { half: 'train' }).p, pTest: stats(cfg, { half: 'test' }).p })
}
// ════════════════════════════════════════════════════════════════════════════
// STAGE 2 (document sections 8-13): which RULE makes the fast bot harmless.
// Everything that is chosen - zone, payout table, the bot's own strategy - is chosen on the first half and
// scored on the second, and every rule is scored against bots that re-optimise themselves for that rule.
// ════════════════════════════════════════════════════════════════════════════
const t2 = Date.now()
const E2N = st2.pool.length
const P2 = Uint8Array.from(st2.pool), H2 = Int16Array.from(st2.hour), DIR2 = Int8Array.from(st2.dir), RND2 = Int8Array.from(st2.rnd)
const DB2 = Float64Array.from(st2.devBot), DC2 = Int32Array.from(st2.devC), RJ2 = Uint8Array.from(st2.rej)
const DL2 = st2.delta.map((rr) => rr.map((a) => Int32Array.from(a)))
const TR2 = new Uint8Array(E2N)
for (let i = 0; i < E2N; i++) TR2[i] = H2[i] < MID_HOUR ? 1 : 0
const RULES2 = ['E0', 'E1', 'E2']
const ZONES = [0, 10, 25, 50, 100, 200]
// Dead zone: decided only if |exit/entry - 1| >= d bps; otherwise both stakes back, no fee (like a tie).
const zoneUp = (d) => (d === 0 ? 1 : Math.ceil(Math.log(1 + d / 1e4) / Math.log(1.0001) - 1e-9))
const zoneDn = (d) => (d === 0 ? 1 : Math.ceil(-Math.log(1 - d / 1e4) / Math.log(1.0001) - 1e-9))
// The bot's features: the band of its expected deviation, and whether the last swap agrees with it.
const BOT_EDGES = [5, 10, 25, 50, 100, 150, 202] // ticks, ~bps; band 0 = exactly zero, band 8 = outside the guard
const NB2 = BOT_EDGES.length + 2
const bandOf = (dev, edges) => {
  if (Number.isNaN(dev)) return edges.length + 1
  const a = Math.abs(dev)
  if (a === 0) return 0
  for (let k = 0; k < edges.length; k++) if (a < edges[k]) return k + 1
  return edges.length + 1
}
const BB2 = new Uint8Array(E2N), REF2 = new Int8Array(E2N), S3A2 = new Uint8Array(E2N)
for (let i = 0; i < E2N; i++) {
  BB2[i] = bandOf(DB2[i], BOT_EDGES)
  const sg = Number.isFinite(DB2[i]) && DB2[i] !== 0 ? Math.sign(DB2[i]) : 0
  REF2[i] = sg !== 0 ? sg : DIR2[i] || 1 // "with" = along the deviation, or along the last swap when there is none
  S3A2[i] = sg === 0 ? 2 : DIR2[i] === sg ? 0 : 1
}
// outcome of an UP bet: +1 token up (decided), -1 down (decided), 0 tie or inside the zone, 2 refund, 3 not placed
function upOutcomes(r, q, d) {
  const up = zoneUp(d), dn = zoneDn(d), a = DL2[r][q], o = new Int8Array(E2N)
  for (let i = 0; i < E2N; i++) {
    const v = a[i]
    o[i] = RJ2[i] || v === OOR2 ? 3 : v === REFUND2 ? 2 : v >= up ? 1 : v <= -dn ? -1 : 0
  }
  return o
}
// ── fixed payouts: counts per (half, pool, bot band, swap agreement, option) ──
// options: 0 bet along REF2, 1 against it, 2 random; counts: won, lost, other (tie, zone, refund)
const NCELL2 = NP * NB2 * 3
const cellIdx = (i) => (P2[i] * NB2 + BB2[i]) * 3 + S3A2[i]
function cellCounts(o) {
  const c = new Float64Array(2 * NCELL2 * 9)
  for (let i = 0; i < E2N; i++) {
    const oc = o[i]
    if (oc === 3) continue
    const base = ((TR2[i] ? 0 : 1) * NCELL2 + cellIdx(i)) * 9
    for (let opt = 0; opt < 3; opt++) {
      const dir = opt === 0 ? REF2[i] : opt === 1 ? -REF2[i] : RND2[i]
      c[base + opt * 3 + (oc === 0 || oc === 2 ? 2 : oc === dir ? 0 : 1)]++
    }
  }
  return c
}
const cellPool = (cell) => Math.floor(cell / (NB2 * 3)), cellBand = (cell) => Math.floor(cell / 3) % NB2, cellS3 = (cell) => cell % 3
// A strategy on cells: (cell) => option 0/1/2 or -1 for no bet. Returns summed counts on a half.
function sumStrat(c, half, pick) {
  const t = [0, 0, 0]
  for (let cell = 0; cell < NCELL2; cell++) {
    const opt = pick(cell)
    if (opt < 0) continue
    const b = (half * NCELL2 + cell) * 9 + opt * 3
    t[0] += c[b]; t[1] += c[b + 1]; t[2] += c[b + 2]
  }
  return t
}
const fixedPay = (flp) => ({ pw: 1 - 2 * F_PR - 2 * flp, vw: -(1 - 2 * flp), vl: 1 - 2 * F_PR }) // player win, vault if player wins / loses
const evPlayer = (t, fp) => (t[0] * fp.pw - t[1]) / (t[0] + t[1] + t[2])
const evVault = (t, fp) => (t[0] * fp.vw + t[1] * fp.vl) / (t[0] + t[1] + t[2])
const KBAND = [1, 3, 4, 5, 6, 7] // first band of S1(k) for k = 0, 0.1, 0.25, 0.5, 1, 1.5%
const FIXED2 = [
  ['S0', (cell) => 2],
  ...KBAND.map((b0, k) => [`S1 k=${fmtK(KS[k])}`, (cell) => (cellBand(cell) >= b0 && cellBand(cell) <= 7 ? 0 : -1)]),
  ...KBAND.map((b0, k) => [`S2 k=${fmtK(KS[k])}`, (cell) => (cellBand(cell) >= b0 && cellBand(cell) <= 7 ? 1 : -1)]),
  ['S3', (cell) => (cellS3(cell) === 1 ? 1 : 0)],
  ['S4', (cell) => (cellS3(cell) === 1 ? 0 : 1)],
]
// The re-optimising bot: per cell group (band / band+swap / pool+band+swap) the option with the best
// first-half EV, if that EV beats 1% on at least 100 bets. `evOf(t)` is the bot's EV from counts.
function optimise(c, gran, evOf) {
  const key = (cell) => (gran === 'band' ? cellBand(cell) : gran === 'band+s3' ? cellBand(cell) * 3 + cellS3(cell) : cell)
  const agg = new Map()
  for (let cell = 0; cell < NCELL2; cell++) {
    const k = key(cell)
    let a = agg.get(k)
    if (!a) agg.set(k, (a = [[0, 0, 0], [0, 0, 0]]))
    for (let opt = 0; opt < 2; opt++) { const b = cell * 9 + opt * 3; a[opt][0] += c[b]; a[opt][1] += c[b + 1]; a[opt][2] += c[b + 2] }
  }
  const choice = new Map()
  for (const [k, a] of agg) {
    let best = -1, bestEv = 0.01
    for (let opt = 0; opt < 2; opt++) { const n = a[opt][0] + a[opt][1] + a[opt][2]; if (n < 100) continue; const ev = evOf(a[opt]); if (ev > bestEv) { bestEv = ev; best = opt } }
    choice.set(k, best)
  }
  return (cell) => choice.get(key(cell)) ?? -1
}
const FEES2 = [0.01, 0.03, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.3, 0.45]
// For one (rule, duration, zone): every bot re-selected per fee; returns the worst case for the vault.
function sweepFixed(r, q, d) {
  const o = upOutcomes(r, q, d)
  const c = cellCounts(o)
  const s0 = sumStrat(c, 1, () => 2)
  const res = { rule: RULES2[r], duration: DUR2[q], zone: d, tieShare: s0[2] / (s0[0] + s0[1] + s0[2]), s0p: s0[0] / (s0[0] + s0[1]), byFee: [] }
  for (const flp of FEES2) {
    const fp = fixedPay(flp)
    const ev = (t) => evPlayer(t, fp)
    const bots = []
    let bestFixed = null
    for (const [name, pick] of FIXED2) {
      const tr = sumStrat(c, 0, pick)
      if (tr[0] + tr[1] < 2000) continue
      if (!bestFixed || ev(tr) > bestFixed.trEv) bestFixed = { name, pick, trEv: ev(tr) }
    }
    if (bestFixed) bots.push({ name: 'лучшая простая: ' + bestFixed.name, pick: bestFixed.pick })
    for (const g of ['band', 'band+s3', 'pool+band+s3']) {
      const pick = optimise(c.subarray(0, NCELL2 * 9), g, ev)
      bots.push({ name: g === 'band' ? 'S5 полосы' : g === 'band+s3' ? 'S6 полоса+своп' : 'S6 пул+полоса+своп', pick })
    }
    let worst = null
    for (const b of bots) {
      const te = sumStrat(c, 1, b.pick)
      const n = te[0] + te[1] + te[2]
      if (n < 500) continue
      const row = { name: b.name, n, p: te[0] / (te[0] + te[1]), evVault: evVault(te, fp), evBot: evPlayer(te, fp) }
      if (!worst || row.evVault < worst.evVault) worst = row
    }
    res.byFee.push({ flp, honest: evPlayer(s0, fp), worst })
  }
  return res
}
const sweep = []
for (let r = 0; r < NR2; r++) for (let q = 0; q < DUR2.length; q++) for (const d of ZONES) sweep.push(sweepFixed(r, q, d))
const feeRow = (s, flp) => s.byFee.find((x) => Math.abs(x.flp - flp) < 1e-9)
const neededFee = (s) => { for (const f of s.byFee) if (!f.worst || f.worst.evVault >= 0) return f.flp; return null }
say('# ЭТАП 2: какое правило делает быстрого бота безвредным')
say()
say(`## Мёртвая зона и окно входа, фиксированные выплаты: худший для хранилища бот, подобранный на 1-й половине заново для каждого правила и каждой f_lp (вторая половина)`)
say(`Боты: лучшая простая из S0-S4 (k), S5 по полосам, S6 по полосе и направлению свопа, S6 по пулу, полосе и свопу. Ничьи - доля ставок S0 без исхода (ничья, зона, возврат).`)
say(`${padE('правило', 7)} ${pad('длит.', 5)} ${pad('зона', 5)} ${pad('ничьи', 6)} ${pad('p бота 5%', 9)} ${pad('EV хр 5%', 8)} ${pad('EV хр 8%', 8)} ${pad('честн 5%', 8)} ${pad('честн 8%', 8)} ${pad('нужна f_lp', 10)} ${padE(' худший бот при 5%', 26)}`)
for (const s of sweep) {
  const f5 = feeRow(s, 0.05), f8 = feeRow(s, 0.08), need = neededFee(s)
  say(`${padE(s.rule, 7)} ${pad(s.duration, 5)} ${pad(s.zone, 5)} ${pad(pct(s.tieShare), 6)} ${pad(f5.worst ? pct(f5.worst.p) : '-', 9)} ${pad(f5.worst ? pct(f5.worst.evVault, 1) : 'нет', 8)} ${pad(f8.worst ? pct(f8.worst.evVault, 1) : 'нет', 8)} ${pad(pct(f5.honest, 1), 8)} ${pad(pct(f8.honest, 1), 8)} ${pad(need === null ? '> 45%' : pct(need, 0), 10)}  ${f5.worst ? f5.worst.name : 'бот не ставит'}`)
}
say()

// ── dynamic payouts: m(band, side) = (1 - margin) / p_hat, clipped to [1.1, 6] ──
const C_EDGES = { 6: [10, 25, 50, 100, 202], 10: [3, 6, 10, 20, 40, 70, 110, 150, 202] } // contract bands, ticks
const oCache = new Map(), bcCache = new Map()
function dynTable(r, q, nb, perPool, margin, mode) {
  const edges = C_EDGES[nb], NBC = edges.length + 2
  if (!oCache.has(r * 10 + q)) oCache.set(r * 10 + q, upOutcomes(r, q, 0))
  const o = oCache.get(r * 10 + q)
  if (!bcCache.has(nb)) { const a = new Uint8Array(E2N); for (let i = 0; i < E2N; i++) a[i] = bandOf(DC2[i], edges); bcCache.set(nb, a) }
  const bc = bcCache.get(nb)
  // first-half calibration of the "with the deviation" side; "against" is its complement; zero band is 50%
  const w = new Float64Array(NP * NBC), n = new Float64Array(NP * NBC), wA = new Float64Array(NBC), nA = new Float64Array(NBC)
  for (let i = 0; i < E2N; i++) {
    if (!TR2[i] || (o[i] !== 1 && o[i] !== -1) || DC2[i] === 0) continue
    const win = o[i] === Math.sign(DC2[i]) ? 1 : 0
    w[P2[i] * NBC + bc[i]] += win; n[P2[i] * NBC + bc[i]]++; wA[bc[i]] += win; nA[bc[i]]++
  }
  const pWith = (pool, b) => {
    if (b === 0) return 0.5
    const pooled = nA[b] > 0 ? wA[b] / nA[b] : 0.5
    if (!perPool) return pooled
    const k = pool * NBC + b
    return (w[k] + 50 * pooled) / (n[k] + 50) // shrunk towards the pooled band with a weight of 50 bets
  }
  const mOf = (p) => { const raw = (1 - margin) / p; if (raw < 1.1) return mode === 'close' ? 0 : 1.1; return Math.min(6, raw) }
  // payout multiple for event i and direction dir; 0 = the vault refuses the bet
  const pay = (i, dir) => { const b = bc[i]; const pw = pWith(P2[i], b); const side = b === 0 || DC2[i] === 0 ? 0.5 : Math.sign(DC2[i]) === dir ? pw : 1 - pw; return b === 0 ? mOf(0.5) : mOf(side) }
  const pooled = (b) => (b === 0 ? 0.5 : nA[b] > 0 ? wA[b] / nA[b] : 0.5)
  return { o, pay, pWith, mOf, edges, NBC, pooled }
}
function evalDyn(t, dirOf, half) {
  let n = 0, dec = 0, win = 0, house = 0, player = 0
  const cH = new Float64Array(NP * NH), cN = new Float64Array(NP * NH)
  for (let i = 0; i < E2N; i++) {
    if ((half === 'test') === !!TR2[i]) continue
    const dir = dirOf(i)
    if (!dir || t.o[i] === 3) continue
    const m = t.pay(i, dir)
    if (m === 0) continue
    n++
    const c = P2[i] * NH + H2[i]
    cN[c]++
    const oc = t.o[i]
    if (oc === 0 || oc === 2) continue
    dec++
    const h = oc === dir ? -(m - 1) : 1
    if (oc === dir) win++
    house += h; player -= h; cH[c] += h
  }
  // cluster-robust error of the house EV per bet, blocks of pool x hour
  const ev = house / n
  let s2 = 0, C = 0
  for (let c = 0; c < cN.length; c++) if (cN[c] > 0) { const x = cH[c] - ev * cN[c]; s2 += x * x; C++ }
  return { n, p: win / dec, house: ev, player: player / n, tie: 1 - dec / n, se: C > 1 ? Math.sqrt((s2 * C) / (C - 1)) / n : NaN }
}
function optimiseDyn(t, gran) {
  const key = (i) => (gran === 'band' ? BB2[i] : cellIdx(i))
  const s = new Map()
  for (let i = 0; i < E2N; i++) {
    if (!TR2[i] || t.o[i] === 3) continue
    const k = key(i)
    let a = s.get(k)
    if (!a) s.set(k, (a = [0, 0, 0, 0]))
    for (let opt = 0; opt < 2; opt++) {
      const dir = opt === 0 ? REF2[i] : -REF2[i]
      const m = t.pay(i, dir)
      if (m === 0) continue
      a[opt * 2 + 1]++
      const oc = t.o[i]
      if (oc === 1 || oc === -1) a[opt * 2] += oc === dir ? m - 1 : -1
    }
  }
  const choice = new Map()
  for (const [k, a] of s) {
    let best = 0, bestEv = 0.01
    for (let opt = 0; opt < 2; opt++) { if (a[opt * 2 + 1] < 100) continue; const ev = a[opt * 2] / a[opt * 2 + 1]; if (ev > bestEv) { bestEv = ev; best = opt === 0 ? 1 : -1 } }
    choice.set(k, best)
  }
  return (i) => { const c = choice.get(key(i)) ?? 0; return c === 0 ? 0 : c * REF2[i] }
}
const dynRows = []
const S1dir = (i) => (BB2[i] >= 1 && BB2[i] <= 7 ? REF2[i] : 0)
say('## Динамические выплаты: m(полоса, сторона) = (1 - маржа) / p_hat, p_hat по 1-й половине, m в [1.1x, 6x]; EV дома на единицу ставки, 2-я половина')
say('Дом = хранилище, маржа включает комиссию протокола. S0 - это и потеря честного игрока. Ошибка S6 - по блокам пул x час.')
say(`${padE('правило', 7)} ${pad('длит.', 5)} ${pad('полос', 5)} ${padE(' таблица', 10)} ${pad('маржа', 5)} ${pad('S0', 7)} ${pad('S1', 7)} ${pad('S3', 7)} ${pad('S5', 7)} ${pad('S6', 7)} ${pad('+-S6', 5)} ${pad('p S6', 6)} ${pad('ставок S6', 9)}`)
for (const r of [0, 2]) for (let q = 0; q < DUR2.length; q++) for (const nb of [6, 10]) for (const perPool of [false, true]) for (const margin of [0.03, 0.05, 0.06, 0.07, 0.08]) {
  const t = dynTable(r, q, nb, perPool, margin, 'clip')
  const s0 = evalDyn(t, (i) => RND2[i], 'test'), s1 = evalDyn(t, S1dir, 'test'), s3 = evalDyn(t, (i) => DIR2[i], 'test')
  const s5 = evalDyn(t, optimiseDyn(t, 'band'), 'test'), s6 = evalDyn(t, optimiseDyn(t, 'cell'), 'test')
  const worst = Math.min(...[s0, s1, s3, s5, s6].filter((y) => y.n >= 300).map((y) => y.house))
  const row = { rule: RULES2[r], duration: DUR2[q], bands: nb, perPool, margin, s0, s1, s3, s5, s6, worst }
  dynRows.push(row)
  const f = (x) => (x.n >= 300 ? pct(x.house, 1) : 'нет')
  say(`${padE(RULES2[r], 7)} ${pad(DUR2[q], 5)} ${pad(nb, 5)} ${padE(perPool ? ' по пулам' : ' общая', 10)} ${pad(pct(margin, 0), 5)} ${pad(f(s0), 7)} ${pad(f(s1), 7)} ${pad(f(s3), 7)} ${pad(f(s5), 7)} ${pad(f(s6), 7)} ${pad((100 * s6.se).toFixed(1), 5)} ${pad(s6.n ? pct(s6.p) : '-', 6)} ${pad(s6.n, 9)}`)
}
say()
// E0 at 60 s with "close" instead of paying 1.1x where the formula gives less (checked because E0 60 s has cells above 90%)
say('E0, 60 с, режим «закрыть» (ставка не принимается, если расчётный m < 1.1), 10 полос по пулам:')
for (const margin of [0.05, 0.08]) {
  const t = dynTable(0, 0, 10, true, margin, 'close')
  const s0 = evalDyn(t, (i) => RND2[i], 'test'), s6 = evalDyn(t, optimiseDyn(t, 'cell'), 'test')
  say(`  маржа ${pct(margin, 0)}: честный ${pct(-s0.house, 1)}, S6 ${pct(s6.house, 1)} ± ${(100 * s6.se).toFixed(1)} (${s6.n} ставок, p ${pct(s6.p)})`)
}
say()

// ── what satisfies (a) vault EV >= 0 against the worst bot at f_lp or margin <= 8% and (b) honest loss <= 8% ──
say('## Наборы правил, прошедшие оба условия: (а) хранилище не в минусе против худшего бота при f_lp или марже до 8%, (б) честный игрок теряет не больше 8%')
const passFixed = []
for (const s of sweep) for (const f of s.byFee) {
  if (f.flp > 0.08) continue
  if ((!f.worst || f.worst.evVault >= 0) && f.honest >= -0.08) { passFixed.push({ s, f }); break }
}
for (const { s, f } of passFixed) say(`фикс.: ${s.rule} ${s.duration} с, зона ${s.zone} bps, f_lp ${pct(f.flp, 0)}: ничьи ${pct(s.tieShare)}, худший бот ${f.worst ? `${f.worst.name}, p ${pct(f.worst.p)}, EV хранилища ${pct(f.worst.evVault, 2)}` : 'не ставит'}, честный ${pct(f.honest, 1)}`)
if (!passFixed.length) say('фикс.: ни одна комбинация правило / длительность / зона не прошла при f_lp до 8%')
const passDyn = dynRows.filter((x) => x.worst >= 0 && x.s0.house <= 0.08)
for (const x of passDyn) say(`динам.: ${x.rule} ${x.duration} с, ${x.bands} полос, ${x.perPool ? 'по пулам' : 'общая'}, маржа ${pct(x.margin, 0)}: честный теряет ${pct(x.s0.house, 1)}, худший бот ${pct(x.worst, 1)}; S6 ${pct(x.s6.house, 1)} ± ${(100 * x.s6.se).toFixed(1)} (p ${pct(x.s6.p)}, ${x.s6.n} ставок), ничьи S0 ${pct(x.s0.tie)}`)
if (!passDyn.length) say('динам.: ни одна таблица не прошла')
// the closest misses, so the recommendation can say what would be needed
const bestFixed2 = [...sweep].map((s) => ({ s, need: neededFee(s) ?? 1, f8: feeRow(s, 0.08) })).sort((a, b) => a.need - b.need || b.f8.worst.evVault - a.f8.worst.evVault)
const bestDyn2 = dynRows.filter((x) => x.s0.house <= 0.08).sort((a, b) => b.worst - a.worst)
say('Ближе всего (фикс.): ' + bestFixed2.slice(0, 5).map(({ s, need, f8 }) => `${s.rule} ${s.duration} с зона ${s.zone}: нужна f_lp ${pct(need, 0)}, при 8% хранилище ${pct(f8.worst.evVault, 1)}, ничьи ${pct(s.tieShare)}`).join('; '))
say('Ближе всего (динам., честный теряет не больше 8%): ' + bestDyn2.slice(0, 5).map((x) => `${x.rule} ${x.duration} с, ${x.bands} полос ${x.perPool ? 'по пулам' : 'общая'}, маржа ${pct(x.margin, 0)}: худший бот ${pct(x.worst, 1)}, S6 ${pct(x.s6.house, 1)} ± ${(100 * x.s6.se).toFixed(1)}, честный ${pct(x.s0.house, 1)}`).join('; '))
say()

// ── the payout table of the candidate configuration, as it would be stored ──
for (const [r, q, nb, margin] of [[2, 4, 6, 0.05], [2, 2, 10, 0.06]]) {
  const t = dynTable(r, q, nb, true, margin, 'clip')
  const lo = [0, ...t.edges.slice(0, -1)]
  say(`## Таблица множителей: ${RULES2[r]}, ${DUR2[q]} с, ${nb} полос, маржа ${pct(margin, 0)} (общая p_hat и m; по пулам - разброс m)`)
  say(`${padE('полоса, тиков', 14)} ${pad('p по ходу', 9)} ${pad('m по ходу', 9)} ${pad('m против', 9)} ${pad('по пулам: по ходу', 18)} ${pad('против', 12)}`)
  for (let b = 0; b < t.NBC - 1; b++) {
    const pw = t.pooled(b)
    const mw = [], ma = []
    for (let p = 0; p < NP; p++) { mw.push(t.mOf(t.pWith(p, b))); ma.push(t.mOf(b === 0 ? 0.5 : 1 - t.pWith(p, b))) }
    const label = b === 0 ? '0' : `${Math.max(1, lo[b - 1])}-${t.edges[b - 1] - 1}`
    const rng = (a) => `${Math.min(...a).toFixed(2)}-${Math.max(...a).toFixed(2)}x`
    say(`${padE(label, 14)} ${pad(pct(pw), 9)} ${pad(t.mOf(pw).toFixed(2) + 'x', 9)} ${pad((b === 0 ? t.mOf(0.5) : t.mOf(1 - pw)).toFixed(2) + 'x', 9)} ${pad(rng(mw), 18)} ${pad(rng(ma), 12)}`)
  }
  say()
}

// ── why tiny deviations won: after the swap the price simply stays where it is ──
{
  let nNo = 0, wNo = 0, nYes = 0, wYes = 0
  const up = zoneUp(0), dn = zoneDn(0), a = DL2[0][0]
  for (let i = 0; i < E2N; i++) {
    if (BB2[i] < 1 || BB2[i] > 2 || RJ2[i] || a[i] === OOR2 || a[i] === REFUND2) continue // S1 bets with |dev| < 10 ticks
    const v = a[i]
    if (v < up && v > -dn) continue
    const won = Math.sign(v) === REF2[i] ? 1 : 0
    if (st2.gap[i] > DELAY + 60) { nNo++; wNo += won } else { nYes++; wYes += won }
  }
  say(`## Почему мелкие отклонения выигрывали (E0, 60 с, S1, отклонение меньше 10 тиков, решённые ставки)`)
  say(`без единого свопа от ставки до расчёта: ${pct(nNo / (nNo + nYes))} ставок, p ${pct(wNo / nNo)}; со свопами: p ${pct(wYes / nYes)}`)
  say()
}

// ── flow mix and PvP for the current rule and the best candidates ──
function mixLine(label, honestEv, botEv) {
  return `${padE(label, 64)} ${[0, 0.1, 0.3, 1].map((b) => pad(pct((1 - b) * honestEv + b * botEv, 2), 8)).join(' ')}`
}
say('## Смесь потока: EV хранилища (дома) на единицу оборота при доле бот-потока 0 / 10 / 30 / 100%, остальное - случайные игроки')
const mixRows = []
say(`${padE('правило', 64)} ${['0%', '10%', '30%', '100%'].map((x) => pad(x, 8)).join(' ')}`)
const honestVault = (s, flp) => evVault(sumStrat(cellCounts(upOutcomes(RULES2.indexOf(s.rule), DUR2.indexOf(s.duration), s.zone)), 1, () => 2), fixedPay(flp))
const mixFixed = [
  [sweep.find((x) => x.rule === 'E0' && x.duration === 60 && x.zone === 0), 0.05],
  [sweep.find((x) => x.rule === 'E0' && x.duration === 900 && x.zone === 0), 0.05],
  [bestFixed2[0].s, 0.05],
  [bestFixed2[0].s, 0.08],
]
for (const [s, flp] of mixFixed) {
  const f = feeRow(s, flp)
  const hv = honestVault(s, flp)
  const label = `фикс. ${s.rule}, ${s.duration} с, зона ${s.zone}, f_lp ${pct(flp, 0)}`
  say(mixLine(label, hv, f.worst ? f.worst.evVault : 0))
  mixRows.push({ label, honestVault: hv, botVault: f.worst ? f.worst.evVault : 0 })
}
const recDyn = dynRows.find((y) => y.rule === 'E2' && y.duration === 3600 && y.bands === 6 && y.perPool && Math.abs(y.margin - 0.05) < 1e-9)
for (const x of [recDyn, bestDyn2.find((y) => Math.abs(y.margin - 0.05) < 1e-9), bestDyn2[0]].filter(Boolean)) {
  const label = `динам. ${x.rule}, ${x.duration} с, ${x.bands} полос ${x.perPool ? 'по пулам' : 'общая'}, маржа ${pct(x.margin, 0)}`
  say(mixLine(label, x.s0.house, x.worst))
  mixRows.push({ label, honestVault: x.s0.house, botVault: x.worst })
}
say()
say('## PvP: живой игрок держит заявку, бот встаёт против неё сразу после свопа (выплата 1:1, комиссия 1% банка)')
say(`${padE('правило', 34)} ${pad('p бота', 7)} ${pad('живой теряет, % ставки', 22)} ${pad('ничьи', 6)} ${padE(' бот', 24)}`)
const pvpRows = []
const pvpSet = [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 4, 0], [2, 2, 0], [2, 2, 100], [2, 4, 0], [2, 4, 50]]
const bf = bestFixed2[0].s
if (!pvpSet.some(([r, q, d]) => RULES2[r] === bf.rule && DUR2[q] === bf.duration && d === bf.zone)) pvpSet.push([RULES2.indexOf(bf.rule), DUR2.indexOf(bf.duration), bf.zone])
for (const [r, q, d] of pvpSet) {
  const c = cellCounts(upOutcomes(r, q, d))
  const fp = fixedPay(0) // PvP: the winner gets 2X minus 1% of the bank, no vault fee
  const ev = (t) => evPlayer(t, fp)
  let worst = null
  for (const g of ['band', 'band+s3', 'pool+band+s3']) {
    const te = sumStrat(c, 1, optimise(c.subarray(0, NCELL2 * 9), g, ev))
    const n = te[0] + te[1] + te[2]
    if (n < 500) continue
    const live = (te[1] * fp.pw - te[0]) / n // the live player wins what the bot loses
    if (!worst || live < worst.live) worst = { g, p: te[0] / (te[0] + te[1]), live, tie: te[2] / n, n }
  }
  pvpRows.push({ rule: RULES2[r], duration: DUR2[q], zone: d, ...worst })
  say(`${padE(`${RULES2[r]}, ${DUR2[q]} с, зона ${d}`, 34)} ${pad(worst ? pct(worst.p) : '-', 7)} ${pad(worst ? pct(-worst.live, 1) : '-', 22)} ${pad(worst ? pct(worst.tie) : '-', 6)}  ${worst ? worst.g : 'бот не ставит'}`)
}
say()
console.error(`[stage2] ${((Date.now() - t2) / 1000).toFixed(1)} s, ${E2N} events`)
summary.stage2 = {
  sweep: sweep.map((s) => ({ ...s, byFee: s.byFee.map((f) => ({ flp: f.flp, honest: f.honest, worst: f.worst })) })),
  dynamic: dynRows,
  passFixed: passFixed.map(({ s, f }) => ({ rule: s.rule, duration: s.duration, zone: s.zone, flp: f.flp, tieShare: s.tieShare, honest: f.honest, worst: f.worst })),
  passDynamic: passDyn.map((x) => ({ rule: x.rule, duration: x.duration, bands: x.bands, perPool: x.perPool, margin: x.margin, worst: x.worst, s0: x.s0, s6: x.s6 })),
  mix: mixRows,
  pvp: pvpRows,
}

console.error(`[done] ${reqCount} RPC requests this run, ${((Date.now() - t0Run) / 1000).toFixed(0)} s total; cache ${CACHE}`)
if (JSON_OUT) { writeJson(JSON_OUT, summary); console.error(`[json] ${JSON_OUT}`) }
