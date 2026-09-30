// Stage 3 behind docs/rhc/POOL-TOXICITY.md: pooled rounds (the proposal in docs/rhc/POSITIVE-EV.md) replayed
// on the same real price series as docs/rhc/SHARP-EDGE.md. The project's fee does not depend on who wins; the
// question here is how much ORDINARY players lose to an informed bot through the shared bank, and which rule
// protects them.
//
// No network: reads the cache that scripts/rhc/sharp-edge-backtest.mts builds (run that first). Everything the
// bot learns (its win rates per cell) is learned on the first week and scored on the second, exactly like
// stages 1-2. Ordinary flow is simulated (random side, "mix" stakes, uniform arrival), with the same random
// numbers for every configuration so that configurations are compared on identical flow.
//
// Sections 1-9 of the output are the first pass (38.5 bets per hour, a bot that sees only the expected flow
// when the bank is hidden) and stay byte for byte as they were: scripts/rhc/positive-ev.mts reads them.
// Sections 10-14 are the second pass: the protections at 2-30 bets per hour, commit-reveal as a mechanism
// (sizes visible, sides hidden, reveal window R, burned stakes, selective non-reveal from several addresses),
// players who follow the price and come in bunches at the end of the window, and a parameter search.
//
// Usage, from the repository root:
//   node scripts/rhc/pool-toxicity.mts                  all tables of the document (several minutes)
//   node scripts/rhc/pool-toxicity.mts --quick          smaller grids in sections 10-14, for a smoke run
//   node scripts/rhc/pool-toxicity.mts --json docs/rhc/measurements/pool-toxicity/summary.json
// Sections 15-17 (third pass): the cap 1:1 with the book visible against commit-reveal, the strike window and
// 1800 s rounds, and configurations chosen on the first week and reported on the second.
// Options: --cache DIR (default <os tmp>/flipthememe-sharp-edge), --head BLOCK, --days N,
//          --only-old (sections 1-9 only), --no-search (skip sections 13-14 and 17),
//          --skip-stage4 (development: sections 15-17 without 10-14)
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1] }
const CACHE = arg('cache', join(tmpdir(), 'flipthememe-sharp-edge'))
const HEAD = Number(arg('head', 75769939)) // the pinned head of SHARP-EDGE.md
const DAYS = Number(arg('days', 14))
const QUICK = argv.includes('--quick')
const t0Run = Date.now()

// ── Round rules (docs/rhc/POSITIVE-EV.md, "Предложенные правила") ─────────────
const FEE = 0.02 // of the accepted bank, normal outcome
const FEE_TIE = 0.01 // of the accepted bank, tie or oracle refund after activation
const REF_SHARE = 0.1 // up to 10% of the fee to referrers: the worst case for the project
const MIN_BANK = 0.01 // ETH, the activation floor at 0.020 gwei (POSITIVE-EV, gas table)
const MIN_STAKE = 0.005 // ETH, MIN_BET of today's market, kept for the bot
const MIX = [[0.005, 0.4], [0.01, 0.3], [0.02, 0.2], [0.04, 0.1]] // ECONOMICS.md "mix", mean 0.013
const MIX_MEAN = MIX.reduce((a, [s, w]) => a + s * w, 0)
const WEEK_CUT = 0.5 // first half of the period trains the bot, second half scores
const ETH_USD = 2713.8 // frozen, as in scripts/rhc/positive-ev.mts
const GAS_GWEI = 0.020142 // the gas floor of POSITIVE-EV.md
const COST = 1_000_000 * GAS_GWEI * 1e-9 // ETH: the whole lifecycle gas budget, charged to every activated round

// ── The same pools and cache layout as scripts/rhc/sharp-edge-backtest.mts ────
const PRESET = [
  '0x34f73f488309208b8cb6012eb47ffeb086ca1c2d', '0xed50bdeea8adc232f159486192a4157281d722ff', '0xd42a491087a15e5afd51feb3606066cc152d2b09',
  '0xd78480cafef722d75519e13b9f516e5704d0d659', '0x52f32c64638804b9162fafe28f4f883a2812cfe9', '0xe2c12a7379706a291cadaaec1d22458be2f7239d',
  '0xe972dfc9032d148f4b1618fb914fbbd2fc41d6dc', '0x2d620c391c0e97530e2f3c9015556ccf81669727', '0x3fc825d1d585c6b73d57a28659afb3af0c13fa01',
  '0xa95d3882fb3ff32b6d8cc411f88cf7a2413f1a1c', '0xa9d49caa5e906558dacdc66d563ac78f0c26d4ef', '0x237609918f330add285b8bc5f8f2922283d1c4c5',
  '0x9501a20bedb8bea0798fe5d4c411f5e270965d49', '0x224bbe6b7a89e365db7f9d991e16f91440b433ce', '0xbd5cd6515ca6285941fbc177381dc8ed4844e6b8',
]
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))
const setDir = join(CACHE, 'set-' + createHash('sha1').update([...PRESET].sort().join(',')).digest('hex').slice(0, 10))
if (!existsSync(join(CACHE, 'block-ts.json')) || !existsSync(setDir)) {
  console.error(`no cache in ${CACHE}: run node scripts/rhc/sharp-edge-backtest.mts first`)
  process.exit(1)
}
const tsCache = readJson(join(CACHE, 'block-ts.json'))
const meta = readJson(join(CACHE, 'pool-meta.json'))
const H = HEAD
const T_H = tsCache[H]
const rate = 1_000_000 / (T_H - tsCache[H - 1_000_000])
const START = H - Math.round(DAYS * 86400 * rate)
const ANCHOR = 1000
const anchors = [START]
for (let b = Math.ceil(START / ANCHOR) * ANCHOR; b < H; b += ANCHOR) if (b > START) anchors.push(b)
anchors.push(H)
const aTs = anchors.map((b) => tsCache[b])
if (aTs.some((x) => x === undefined)) { console.error('anchor timestamps missing from the cache: rerun sharp-edge-backtest.mts'); process.exit(1) }
function tsInterp(b) { // identical to sharp-edge-backtest.mts
  let lo = 0, hi = anchors.length - 1
  if (b <= anchors[0]) return aTs[0]
  if (b >= anchors[hi]) return aTs[hi]
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (anchors[mid] <= b) lo = mid; else hi = mid }
  const A = anchors[lo], B = anchors[hi]
  const v = Math.floor(aTs[lo] + 0.5 + ((b - A) * (aTs[hi] - aTs[lo])) / (B - A))
  return Math.min(aTs[hi], Math.max(aTs[lo], v))
}
const rows = []
for (let k = Math.floor(START / 100_000); k <= Math.floor(H / 100_000); k++) {
  const from = Math.max(START, k * 100_000), to = Math.min(H, k * 100_000 + 99_999)
  const f = join(setDir, `logs-${from}-${to}.json`)
  if (!existsSync(f)) { console.error(`missing ${f}: rerun sharp-edge-backtest.mts`); process.exit(1) }
  for (const r of readJson(f)) rows.push(r)
}
rows.sort((a, b) => a[1] - b[1] || a[2] - b[2])
const T0 = aTs[0]
const N = T_H - T0 + 1
const LAST = N - 1
const HOUR0 = Math.floor(T0 / 3600)
const NH = Math.floor(T_H / 3600) - HOUR0 + 1
const MID_HOUR = Math.floor(NH * WEEK_CUT)
// the scoring week is split in two halves by UTC day, to show how stable a number is inside it
const HALF_DAY = Math.floor(((HOUR0 + MID_HOUR) * 3600 + T_H) / 2 / 86400)
if (Math.floor(T0 / 86400 / 1000) !== Math.floor(T_H / 86400 / 1000)) { console.error('the pool x day keys assume the period does not cross a day number divisible by 1000'); process.exit(1) }

// ── WAD quotes and the 2% guard, exactly as in the resolver (copied from sharp-edge-backtest.mts) ──
const TM = [
  [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn], [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n], [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n], [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n], [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n], [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n], [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
]
function sqrtRatioAtTick(tick) {
  const abs = BigInt(Math.abs(tick))
  let ratio = abs & 1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n
  for (const [bit, mul] of TM) if (abs & bit) ratio = (ratio * mul) >> 128n
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
}
const E18 = 10n ** 18n
function quoteWad(tick, wethIsToken0) {
  const s = sqrtRatioAtTick(tick)
  if (s <= (1n << 128n) - 1n) { const r = s * s; return !wethIsToken0 ? (r * E18) >> 192n : ((1n << 192n) * E18) / r }
  const r = (s * s) >> 64n
  return !wethIsToken0 ? (r * E18) >> 128n : ((1n << 128n) * E18) / r
}
function makePricer(wethIsToken0) {
  const cache = new Map()
  const q = (t) => { let v = cache.get(t); if (v === undefined) { v = quoteWad(t, wethIsToken0); cache.set(t, v) } return v }
  const spreadOk = (a, b) => { const d = Math.abs(a - b); if (d <= 190) return true; if (d >= 215) return false; const x = q(a), y = q(b); const diff = x > y ? x - y : y - x; return (diff * 10_000n) / ((x + y) / 2n) <= 200n }
  const cmp = (exitT, entryT) => { if (exitT === entryT) return 0; if (Math.abs(exitT - entryT) <= 3) { const a = q(exitT), b = q(entryT); return a === b ? 0 : a > b ? 1 : -1 } return (wethIsToken0 ? -1 : 1) * (exitT > entryT ? 1 : -1) }
  return { spreadOk, cmp }
}

// ── Per-pool series: tick in effect per second, cumulative, last swap direction ──
const pools = []
for (let pi = 0; pi < PRESET.length; pi++) {
  const m = meta[PRESET[pi]]
  const sw = rows.filter((r) => r[0] === pi)
  const tickAt = new Int32Array(N), lastDir = new Int8Array(N)
  let cur = 0, dir = 0, firstSec = -1, j = 0
  const uOf = sw.map((r) => tsInterp(r[1]) - T0)
  for (let u = 0; u < N; u++) {
    while (j < sw.length && uOf[j] <= u) { cur = sw[j][3]; if (sw[j][4]) dir = sw[j][4]; if (firstSec < 0) firstSec = u; j++ }
    tickAt[u] = cur; lastDir[u] = dir
  }
  const cum = new Float64Array(N + 1)
  for (let u = 0; u < N; u++) cum[u + 1] = cum[u] + tickAt[u]
  pools.push({ label: m.symbol, tickAt, lastDir, cum, firstSec, orient: m.wethIsToken0 ? -1 : 1, pr: makePricer(m.wethIsToken0) })
}
console.error(`[load] ${rows.length} swaps, ${pools.length} pools, ${((Date.now() - t0Run) / 1000).toFixed(1)} s`)

// ── Round outcome: +1 token up, -1 down, 0 tie, 2 oracle refund, 3 not settleable in the data ──
const twapWindowFor = (d) => Math.min(300, Math.max(30, Math.floor(d / 5))) // PoolOracleResolver.sol:372-377
function outcome(P, close, T, rule) {
  let entryT, settle
  if (typeof rule === 'number') { // stage 5: E2 with a strike window of `rule` seconds after the close (60 = E2)
    if (close + rule > LAST) return 3
    entryT = Math.floor((P.cum[close + rule] - P.cum[close]) / rule)
    settle = close + rule + T
  } else if (rule === 'E2') {
    if (close + 60 > LAST) return 3
    entryT = Math.floor((P.cum[close + 60] - P.cum[close]) / 60)
    settle = close + 60 + T
  } else {
    entryT = Math.floor((P.cum[close] - P.cum[close - 60]) / 60)
    if (!P.pr.spreadOk(entryT, P.tickAt[close - 1])) return 2 // today's entry guard, applied to the whole round
    settle = close + T
  }
  if (settle > LAST) return 3
  const W = twapWindowFor(T), A = Math.max(1, Math.floor(W / 3))
  const exitT = Math.floor((P.cum[settle] - P.cum[settle - W]) / W)
  const ancT = Math.floor((P.cum[settle] - P.cum[settle - A]) / A)
  if (!P.pr.spreadOk(exitT, ancT)) return 2
  return P.pr.cmp(exitT, entryT)
}
// what the bot sees at second tb: spot against the trailing 60 s average, and the last swap's direction
const EDGES = [5, 10, 25, 50, 100, 150, 202]
const NB = EDGES.length + 2
function features(P, tb) {
  const dev = P.orient * (P.tickAt[tb] - (P.cum[tb + 1] - P.cum[tb - 59]) / 60)
  const a = Math.abs(dev)
  let band = 0
  if (a > 0) { band = EDGES.length + 1; for (let k = 0; k < EDGES.length; k++) if (a < EDGES[k]) { band = k + 1; break } }
  const s3 = P.lastDir[tb]
  const sg = dev > 0 ? 1 : dev < 0 ? -1 : 0
  return { band, ref: sg || s3 || 1, agree: sg === 0 ? 2 : s3 === sg ? 0 : 1, sg, s3 }
}

// ── Deterministic randomness: the same flow for every configuration ──
function rngFor(a, b, c) {
  let s = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b) ^ Math.imul(c + 13, 0xc2b2ae35)) | 0
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function poisson(r, mean) {
  if (mean > 50) { const u = Math.max(1e-12, r()), v = r(); return Math.max(0, Math.round(mean + Math.sqrt(mean) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v))) }
  const L = Math.exp(-mean)
  let k = 0, p = 1
  do { k++; p *= r() } while (p > L)
  return k - 1
}
function mixStake(u) { let acc = 0; for (const [s, w] of MIX) { acc += w; if (u < acc) return s } return MIX[MIX.length - 1][0] }
// ordinary bets of one round: times in [0, T), side +1/-1, stake
function ordinaryFlow(pi, k, T, lambda, level) {
  const r = rngFor(pi, k, level * 100003 + T)
  const n = poisson(r, lambda * T)
  const t = new Float64Array(n), side = new Int8Array(n), st = new Float64Array(n)
  for (let i = 0; i < n; i++) { t[i] = r() * T; side[i] = r() < 0.5 ? 1 : -1; st[i] = mixStake(r()) }
  return { n, t, side, st }
}

// ── Rounds on the real series ──
// A round collects over [s, s + T); its nominal close is s + T. With a random close (measure a) the real close
// is uniform over the last R seconds, unknown in advance, and a bot that wants to be included bets at
// nominal - R - 1.
function roundsOf(T) {
  const out = []
  for (let pi = 0; pi < pools.length; pi++) {
    const P = pools[pi]
    if (P.firstSec < 0) continue
    for (let k = 0; ; k++) {
      const s = P.firstSec + 61 + k * T
      if (s + T + 60 + T > LAST) break
      const hour = Math.floor((T0 + s + T) / 3600) - HOUR0
      out.push({ pi, k, s, train: hour < MID_HOUR })
    }
  }
  return out
}
// the bot's decision second and the real close, for a timing mode
function timing(rd, T, mode) {
  const nominal = rd.s + T
  if (mode.kind === 'last') return { tb: nominal - 1, close: nominal }
  // commit-reveal: commits close at the nominal close, reveals run R seconds, the E2 strike starts after them;
  // 'commit' decides at the last second of the window, 'reveal' at the last second of the reveal window
  if (mode.kind === 'cr') return { tb: mode.at === 'reveal' ? nominal + mode.R - 1 : nominal - 1, close: nominal + mode.R }
  const r = rngFor(rd.pi, rd.k, 777 + T)
  if (mode.kind === 'random') return { tb: rd.s + Math.floor(r() * (T - 1)), close: nominal }
  // random close over the last R seconds
  return { tb: nominal - mode.R - 1, close: nominal - Math.floor(r() * mode.R) }
}

// ── The bot: win rates per cell learned on the first week ──
// cells: pool x deviation band x (last swap agrees / disagrees / no deviation); counts for betting WITH ref
function trainBot(rounds, T, rule, mode) {
  const cell = new Float64Array(pools.length * NB * 3 * 3)
  const g = { s1: [0, 0, 0], s3: [0, 0, 0], with: [0, 0, 0] }
  for (const rd of rounds) {
    if (!rd.train) continue
    const P = pools[rd.pi]
    const tm = timing(rd, T, mode)
    const oc = outcome(P, tm.close, T, rule)
    if (oc === 3) continue
    const f = features(P, tm.tb)
    const k = oc === 0 || oc === 2 ? 2 : oc === f.ref ? 0 : 1
    cell[((rd.pi * NB + f.band) * 3 + f.agree) * 3 + k]++
    g.with[k]++
    if (f.band >= 1 && f.band <= 7) g.s1[k]++
    if (f.s3 !== 0) g.s3[oc === 0 || oc === 2 ? 2 : oc === f.s3 ? 0 : 1]++
  }
  const share = (c) => { const n = c[0] + c[1] + c[2]; return n ? [c[0] / n, c[1] / n, c[2] / n] : [0.5, 0.5, 0] }
  const gw = share(g.with)
  return {
    // returns [side, pWin, pLose, pTie] or null
    decide(strategy, P, pi, f) {
      if (strategy === 'S1') { if (f.band < 1 || f.band > 7) return null; const [w, l, t] = share(g.s1); return [f.sg, w, l, t] }
      if (strategy === 'S3') { if (!f.s3) return null; const [w, l, t] = share(g.s3); return [f.s3, w, l, t] }
      const b = ((pi * NB + f.band) * 3 + f.agree) * 3
      const n = cell[b] + cell[b + 1] + cell[b + 2], a = 50 // shrink thin cells towards the pooled rate
      const w = (cell[b] + a * gw[0]) / (n + a), l = (cell[b + 1] + a * gw[1]) / (n + a), t = 1 - w - l
      return w >= l ? [f.ref, w, l, t] : [-f.ref, l, w, t]
    },
    gS1: share(g.s1), gS3: share(g.s3), gw,
  }
}
// bot's expected profit for stake X on its side, own-side ordinary S, opposite O, cap c, address cap kap
function botEv(X, S, O, c, pw, pl, pt, kap) {
  const own = S + X
  const aOwn = Math.min(own, c * O), aOpp = Math.min(O, c * own)
  const B = aOwn + aOpp
  if (aOwn <= 0 || aOpp <= 0 || B < MIN_BANK) return { ev: 0, ok: false }
  let acc = (X * aOwn) / own
  if (kap < 1 && acc > kap * B) return { ev: -1, ok: false }
  const m = ((1 - FEE) * B) / aOwn
  return { ev: acc * (pw * (m - 1) - pl - FEE_TIE * pt), ok: true }
}
function sizeBot(S, O, c, pw, pl, pt, L, kap) {
  if (L < MIN_STAKE || O <= 0) return 0
  const cand = [MIN_STAKE, L]
  if (Number.isFinite(c)) { cand.push(O / c - S, c * O - S) }
  const k = (1 - FEE) * pw, gg = pw + pl + FEE_TIE * pt
  if (gg > k && S > 0) cand.push(Math.sqrt((k * O * S) / (gg - k)) - S)
  for (let i = 1; i < 8; i++) cand.push(MIN_STAKE * Math.pow(L / MIN_STAKE, i / 8))
  if (kap < 1) { // largest X that keeps the bot inside its share of the bank
    let lo = MIN_STAKE, hi = L
    if (botEv(lo, S, O, c, pw, pl, pt, kap).ev === -1) return 0
    for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (botEv(mid, S, O, c, pw, pl, pt, kap).ev === -1) hi = mid; else lo = mid }
    cand.push(lo)
  }
  let best = 0, bestEv = 1e-9
  for (const x0 of cand) {
    const x = Math.min(L, Math.max(MIN_STAKE, x0))
    const e = botEv(x, S, O, c, pw, pl, pt, kap)
    if (e.ok && e.ev > bestEv) { bestEv = e.ev; best = x }
  }
  return best
}

// Bots that together take a target share of the bank: the size that gives that share on the expected book,
// but never past the size at which their expected profit reaches zero (a competitive fringe stops there).
function sizeShare(target, S, O, c, pw, pl, pt, kap, big) {
  if (O <= 0) return 0
  const shareAt = (X) => { const own = S + X, aOwn = Math.min(own, c * O), aOpp = Math.min(O, c * own); return (X * aOwn) / own / (aOwn + aOpp) }
  let lo = MIN_STAKE, hi = big
  if (shareAt(lo) >= target) hi = lo
  else for (let it = 0; it < 50; it++) { const mid = (lo + hi) / 2; if (shareAt(mid) < target) lo = mid; else hi = mid }
  const Xt = hi
  const e = botEv(Xt, S, O, c, pw, pl, pt, kap)
  if (e.ok && e.ev >= 0) return Xt
  const Xo = sizeBot(S, O, c, pw, pl, pt, big, kap)
  if (!Xo || Xo >= Xt) return Xo && Xo <= Xt ? Xo : 0
  let a = Xo, b = Xt // EV falls past the optimum: largest X with EV >= 0
  for (let it = 0; it < 50; it++) { const mid = (a + b) / 2; const em = botEv(mid, S, O, c, pw, pl, pt, kap); if (em.ok && em.ev >= 0) a = mid; else b = mid }
  return a
}

// ── One configuration on the second week ──
const LEVELS = { 0.01: 1, 0.03: 2, 0.1: 3 }
function simulate(cfg, rounds, bot, spec) {
  // spec: null (no bot), { opt: true } (profit-maximising bot), { share } (bots take this share of the bank, never past zero profit)
  // stage 4 options: cfg.flowFn(rd) supplies the ordinary flow (default: ordinaryFlow), cfg.bothSides lets the
  // bot take the side against its own forecast when the multiplier pays for it
  const { T, rule, cap, mode, hidden, kap, strategy, lambda, bank } = cfg
  const acc = { rounds: 0, active: 0, ties: 0, bank: 0, fee: 0, rev: 0, ordAcc: 0, ordNet: 0, ordRaw: 0, botAcc: 0, botNet: 0, botRounds: 0, cons: 0, mMajor: [] }
  const clNet = new Map(), clAcc = new Map() // clusters pool x day, for the error of the ordinary return
  const clWin = new Map(), clRev = new Map(), clBot = new Map() // the same clusters: windows, project net, bot net
  const level = LEVELS[bank]
  const expSide = (lambda * T * MIX_MEAN) / 2
  for (const rd of rounds) {
    if (rd.train) continue
    const P = pools[rd.pi]
    const tm = timing(rd, T, mode)
    const oc = outcome(P, tm.close, T, rule)
    if (oc === 3) continue
    acc.rounds++
    const ck = rd.pi * 1000 + Math.floor((T0 + rd.s) / 86400)
    clWin.set(ck, (clWin.get(ck) ?? 0) + 1)
    const fl = cfg.flowFn ? cfg.flowFn(rd) : ordinaryFlow(rd.pi, rd.k, T, lambda, level)
    const cutoff = tm.close - rd.s // ordinary bets after the real close are refused
    let uO = 0, dO = 0, visU = 0, visD = 0
    const seen = tm.tb - rd.s + 1
    for (let i = 0; i < fl.n; i++) {
      if (fl.t[i] >= cutoff) continue
      if (fl.side[i] > 0) uO += fl.st[i]; else dO += fl.st[i]
      if (fl.t[i] < seen) { if (fl.side[i] > 0) visU += fl.st[i]; else visD += fl.st[i] }
    }
    // the bot
    let bSide = 0, X = 0
    // spec.q (stage 4): the bot plays only a random share q of the rounds, to scale its share of the turnover
    if (spec && strategy && (spec.q === undefined || rngFor(rd.pi, rd.k, 4242 + T)() < spec.q)) {
      const f = features(P, tm.tb)
      const d = bot.decide(strategy, P, rd.pi, f)
      if (d) {
        const [side, pw, pl, pt] = d
        // what it believes the final ordinary book will be
        let eU, eD
        if (hidden) { eU = expSide; eD = expSide }
        else {
          const rest = Math.max(0, (mode.kind === 'rclose' ? T - mode.R / 2 : T) - seen) // expected seconds of flow still to come
          eU = visU + (lambda * rest * MIX_MEAN) / 2; eD = visD + (lambda * rest * MIX_MEAN) / 2
        }
        const S = side > 0 ? eU : eD, O = side > 0 ? eD : eU
        const big = 50 * (eU + eD + MIN_STAKE)
        X = spec.opt ? sizeBot(S, O, cap, pw, pl, pt, big, kap) : sizeShare(spec.share, S, O, cap, pw, pl, pt, kap, big)
        if (X > 0) bSide = side
        if (cfg.bothSides) { // the other side: its win and loss probabilities swap
          const X2 = spec.opt ? sizeBot(O, S, cap, pl, pw, pt, big, kap) : sizeShare(spec.share, O, S, cap, pl, pw, pt, kap, big)
          const e1 = X > 0 ? botEv(X, S, O, cap, pw, pl, pt, kap).ev : -Infinity
          const e2 = X2 > 0 ? botEv(X2, O, S, cap, pl, pw, pt, kap).ev : -Infinity
          if (e2 > e1) { X = X2; bSide = -side }
        }
      }
    }
    // the address cap is enforced on the real book: the excess of the bot is refused
    let U = uO + (bSide > 0 ? X : 0), D = dO + (bSide < 0 ? X : 0)
    let aU = Math.min(U, cap * D), aD = Math.min(D, cap * U)
    if (kap < 1 && X > 0) {
      for (let it = 0; it < 40; it++) {
        const own = bSide > 0 ? U : D, aOwn = bSide > 0 ? aU : aD
        const botAcc = (X * aOwn) / own
        if (botAcc <= kap * (aU + aD) * (1 + 1e-9)) break
        X *= 0.9
        U = uO + (bSide > 0 ? X : 0); D = dO + (bSide < 0 ? X : 0)
        aU = Math.min(U, cap * D); aD = Math.min(D, cap * U)
      }
    }
    const Bk = aU + aD
    const deposits = U + D
    acc.ordRaw += uO + dO
    if (U <= 0 || D <= 0 || Bk < MIN_BANK) continue // not activated: everything back, no fee, no keeper spend
    acc.active++
    acc.bank += Bk
    // what each side gets back in total
    let recU, recD, fee
    if (oc === 1) { recU = U - aU + (1 - FEE) * Bk; recD = D - aD; fee = FEE * Bk }
    else if (oc === -1) { recU = U - aU; recD = D - aD + (1 - FEE) * Bk; fee = FEE * Bk }
    else { recU = U - aU + (1 - FEE_TIE) * aU; recD = D - aD + (1 - FEE_TIE) * aD; fee = FEE_TIE * Bk; acc.ties++ }
    acc.cons = Math.max(acc.cons, Math.abs(recU + recD + fee - deposits)) // money is conserved
    acc.fee += fee
    acc.rev += fee * (1 - REF_SHARE)
    clRev.set(ck, (clRev.get(ck) ?? 0) + fee * (1 - REF_SHARE) - COST)
    // split each side between ordinary players and the bot, pro rata to raw stake
    const ordU = U > 0 ? uO / U : 0, ordD = D > 0 ? dO / D : 0
    acc.ordAcc += aU * ordU + aD * ordD
    const on = recU * ordU + recD * ordD - (uO + dO), oa = aU * ordU + aD * ordD
    acc.ordNet += on
    clNet.set(ck, (clNet.get(ck) ?? 0) + on); clAcc.set(ck, (clAcc.get(ck) ?? 0) + oa)
    if (bSide !== 0) {
      const own = bSide > 0 ? U : D, rec = bSide > 0 ? recU : recD, aOwn = bSide > 0 ? aU : aD
      acc.botAcc += (aOwn * X) / own
      acc.botNet += (rec * X) / own - X
      acc.botRounds++
      clBot.set(ck, (clBot.get(ck) ?? 0) + (rec * X) / own - X)
    }
    const aMaj = Math.max(aU, aD)
    acc.mMajor.push(((1 - FEE) * Bk) / aMaj)
  }
  const q = (p) => { const a = acc.mMajor; if (!a.length) return NaN; return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))] }
  acc.mMajor.sort((a, b) => a - b)
  return {
    ordSe: (() => { const r = acc.ordNet / acc.ordAcc; let s2 = 0, C = 0; for (const [k, a] of clAcc) { const x = clNet.get(k) - r * a; s2 += x * x; C++ } return C > 1 ? Math.sqrt((s2 * C) / (C - 1)) / acc.ordAcc : NaN })(), tieShare: acc.ties / acc.active,
    rounds: acc.rounds, activeShare: acc.active / acc.rounds, meanBank: acc.bank / acc.active, feePct: acc.fee / acc.bank, revPerRound: acc.rev / acc.active,
    ordRet: acc.ordNet / acc.ordAcc, botRet: acc.botAcc ? acc.botNet / acc.botAcc : NaN, botShare: acc.botAcc / acc.bank, botRoundShare: acc.botRounds / acc.active,
    m10: q(0.1), m50: q(0.5), m90: q(0.9), cons: acc.cons,
    // stage 4 additions: project net after the gas budget and bot net, ETH per pool per day, with cluster errors
    ...perDay(clWin, clRev, T, 'revDay'), ...perDay(clWin, clBot, T, 'botDay'),
    ...halves(clNet, clAcc), activeRoundsPerDay: (acc.active / acc.rounds) * (86400 / T),
  }
}
// a per-window total scaled to one pool-day, with its error by the same pool x day blocks
function perDay(win, val, T, name) {
  let W = 0, S = 0
  for (const [k, w] of win) { W += w; S += val.get(k) ?? 0 }
  const rate = W ? S / W : NaN
  let s2 = 0, C = 0
  for (const [k, w] of win) { const x = (val.get(k) ?? 0) - rate * w; s2 += x * x; C++ }
  const k = 86400 / T
  return { [name]: rate * k, [name + 'Se']: C > 1 ? (Math.sqrt((s2 * C) / (C - 1)) / W) * k : NaN }
}
// the ordinary return on the two halves of the scoring week (days before and after HALF_DAY)
function halves(net, acc) {
  const r = [0, 0, 0, 0]
  for (const [k, a] of acc) { const h = k % 1000 < HALF_DAY % 1000 ? 0 : 2; r[h] += net.get(k) ?? 0; r[h + 1] += a }
  return { ordRetH1: r[0] / r[1], ordRetH2: r[2] / r[3] }
}

// ── Flow intensity for a target mean accepted bank per round (over all rounds, no bot) ──
function flowOnly(T, lambda, level, n, cap) {
  let bank = 0, act = 0
  for (let k = 0; k < n; k++) {
    const fl = ordinaryFlow(99, k, T, lambda, level)
    let U = 0, D = 0
    for (let i = 0; i < fl.n; i++) { if (fl.side[i] > 0) U += fl.st[i]; else D += fl.st[i] }
    const a = Math.min(U, cap * D) + Math.min(D, cap * U)
    if (U > 0 && D > 0 && a >= MIN_BANK) { bank += a; act++ }
  }
  return { meanAll: bank / n, meanActive: act ? bank / act : 0, active: act / n }
}
function lambdaFor(T, target, level) {
  let lo = 1e-6, hi = 5
  for (let it = 0; it < 40; it++) { const mid = Math.sqrt(lo * hi); if (flowOnly(T, mid, level, 4000, 4).meanAll < target) lo = mid; else hi = mid }
  return Math.sqrt(lo * hi)
}

// ── Output helpers ──
const out = []
const say = (s = '') => { out.push(s); console.log(s) }
const pct = (x, d = 1) => (Number.isFinite(x) ? (100 * x).toFixed(d) + '%' : '-')
const pad = (s, n) => String(s).padStart(n)
const padE = (s, n) => String(s).padEnd(n)
const TARGETS = [0.05, 0.1, 0.25, 0.5]
function curve(cfg, rounds, bot) {
  const none = simulate(cfg, rounds, bot, null)
  const opt = simulate(cfg, rounds, bot, { opt: true })
  const forced = TARGETS.map((t) => simulate(cfg, rounds, bot, { share: t }))
  return { none, opt, forced }
}
const cfgLabel = (c) => `${c.rule} ${c.T} с, кап ${capLabel(c.cap)}, банк ${c.bank}, ${c.strategy ?? '-'}, ${modeLabel(c)}`
const capLabel = (c) => (c === Infinity ? 'нет' : c === 1.5 ? '60:40' : c === 4 ? '80:20' : c === 9 ? '90:10' : String(c))
function modeLabel(c) {
  const t = c.mode.kind === 'last' ? 'последняя секунда' : c.mode.kind === 'random' ? 'случайный момент' : `случайное закрытие ${c.mode.R} с`
  return t + (c.hidden ? ', банк скрыт' : '') + (c.kap < 1 ? `, кап адреса ${Math.round(c.kap * 100)}%` : '')
}
// a cell: ordinary return at that bot share; the realised share in brackets when the bots stop short of it
function row(label, c, cv) {
  const f = cv.forced.map((r, i) => pad(Math.abs(r.botShare - TARGETS[i]) < 0.02 ? pct(r.ordRet) : `${pct(r.ordRet)} (${Math.round(100 * r.botShare)})`, 13))
  say(`${padE(label, 56)} ${pad(pct(cv.none.ordRet), 8)} ${pad(pct(cv.opt.botShare, 0), 5)} ${pad(pct(cv.opt.ordRet), 7)} ${pad('±' + (100 * cv.opt.ordSe).toFixed(1), 5)} ${pad(pct(cv.opt.botRet), 7)} ${f.join(' ')}`)
}
const HEADER = `${padE('конфигурация', 56)} ${pad('без бота', 8)} ${pad('доля', 5)} ${pad('обычн.', 7)} ${pad('', 5)} ${pad('бот', 7)} ${TARGETS.map((t) => pad('боты ' + Math.round(t * 100) + '%', 13)).join(' ')}`
// ════════════════════════════════════════════════════════════════════════════
say(`Период ${new Date(T0 * 1000).toISOString()} - ${new Date(T_H * 1000).toISOString()}, обучение до ${new Date((HOUR0 + MID_HOUR) * 3600 * 1000).toISOString()}, оценка после.`)
say(`Правила раунда: комиссия ${pct(FEE, 0)} принятого банка (ничья или возврат оракула ${pct(FEE_TIE, 0)}), рефералам ${pct(REF_SHARE, 0)} комиссии, активация при обеих сторонах и банке от ${MIN_BANK} ETH.`)
say(`Обычные игроки: сторона 50/50, ставки mix (средняя ${MIX_MEAN.toFixed(3)} ETH), приход равномерный. Доходность - на единицу принятой ставки, после комиссии.`)
say()

const lambdas = {}
for (const T of [60, 300, 900]) for (const bank of [0.01, 0.03, 0.1]) lambdas[`${T}:${bank}`] = lambdaFor(T, bank, LEVELS[bank])
const roundsBy = {}
for (const T of [60, 300, 900]) roundsBy[T] = roundsOf(T)
const botCache = new Map()
function botFor(T, rule, mode) {
  const key = `${T}:${rule}:${mode.kind}:${mode.R ?? 0}`
  if (!botCache.has(key)) botCache.set(key, trainBot(roundsBy[T], T, rule, mode))
  return botCache.get(key)
}
const base = { T: 300, rule: 'E2', cap: 4, mode: { kind: 'last' }, hidden: false, kap: 1, strategy: 'S6', bank: 0.03 }
const mk = (over) => { const c = { ...base, ...over }; c.lambda = lambdas[`${c.T}:${c.bank}`]; return c }
const results = []
function run(label, over) {
  const c = mk(over)
  const cv = curve(c, roundsBy[c.T], botFor(c.T, c.rule, c.mode))
  results.push({ label, cfg: { ...c, cap: capLabel(c.cap) }, none: cv.none, opt: cv.opt, forced: cv.forced })
  row(label, c, cv)
  return cv
}

say('## 1. Базовая конфигурация и деньги проекта')
{
  const c = mk({})
  const bot = botFor(c.T, c.rule, c.mode)
  const r0 = simulate(c, roundsBy[c.T], bot, 0)
  say(`${cfgLabel(c)}: интенсивность ${(c.lambda * 3600).toFixed(1)} ставок в час на пул; раундов на второй неделе ${r0.rounds}`)
  say(`без бота: активировано ${pct(r0.activeShare)}, средний принятый банк активного раунда ${r0.meanBank.toFixed(4)} ETH, комиссия ${pct(r0.feePct, 2)} банка, доход проекта ${(r0.revPerRound * 1e6).toFixed(1)} мкETH на раунд = ${pct(r0.revPerRound / r0.meanBank, 3)} банка; невязка денег ${r0.cons.toExponential(1)} ETH`)
  say(`обычный игрок без бота: ${pct(r0.ordRet, 2)} ± ${(100 * r0.ordSe).toFixed(2)} принятой ставки; ничьих и возвратов оракула ${pct(r0.tieShare)} активных раундов; множитель большей стороны p10 / p50 / p90: ${r0.m10.toFixed(3)} / ${r0.m50.toFixed(3)} / ${r0.m90.toFixed(3)}`)
  const r1 = simulate(c, roundsBy[c.T], bot, { opt: true })
  say(`с ботом-монополистом: множитель большей стороны p10 / p50 / p90: ${r1.m10.toFixed(3)} / ${r1.m50.toFixed(3)} / ${r1.m90.toFixed(3)}; бот участвует в ${pct(r1.botRoundShare)} активных раундов; доход проекта ${pct(r1.revPerRound / r1.meanBank, 3)} банка`)
  say(`обучение бота (первая неделя): S1 побед ${pct(bot.gS1[0])} / поражений ${pct(bot.gS1[1])}, S3 ${pct(bot.gS3[0])} / ${pct(bot.gS3[1])} (остальное - ничьи и возвраты)`)
  for (const T of [60, 300, 900]) for (const rule of ['E0', 'E2']) {
    const cc = mk({ T, rule })
    const rr = simulate(cc, roundsBy[T], botFor(T, rule, cc.mode), 0)
    say(`  ${rule} ${T} с без бота: ничьих и возвратов оракула ${pct(rr.tieShare)} активных раундов, доход проекта ${pct(rr.revPerRound / rr.meanBank, 3)} банка, обычный игрок ${pct(rr.ordRet, 2)}`)
  }
  say()
}
say('## 2. Доходность обычного игрока (на единицу принятой ставки, после комиссии)')
say('«без бота» - только случайные игроки; «доля / обычн. / бот» - бот-монополист, максимизирующий свою прибыль: его доля принятого банка, доходность обычных игроков (± ошибка по блокам пул x сутки) и его собственная; «боты N%» - боты, которые вместе берут N% банка, но не дальше нулевой прибыли (в скобках реальная доля, если остановились раньше)')
say(HEADER)
run('база: E2 300 с, 80:20, банк 0.03, S6, последняя секунда', {})
run('  S1 вместо S6', { strategy: 'S1' })
run('  S3 вместо S6', { strategy: 'S3' })
run('  бот в случайный момент окна', { mode: { kind: 'random' } })
say()
say('## 3. Окно и длительность, вход E0 против E2 (S6, последняя секунда, 80:20, банк 0.03)')
say(HEADER)
for (const T of [60, 300, 900]) for (const rule of ['E0', 'E2']) run(`${rule}, ${T} с`, { T, rule })
say()
say('## 4. Кап перекоса (E2 300 с, банк 0.03, S6, последняя секунда)')
say(HEADER)
for (const cap of [1.5, 4, 9, Infinity]) run(`кап ${capLabel(cap)}`, { cap })
say()
say('## 5. Размер банка (E2 300 с, 80:20, S6, последняя секунда)')
say(HEADER)
for (const bank of [0.01, 0.03, 0.1]) run(`банк ${bank} ETH`, { bank })
say()
say('## 6. Меры защиты (E2, S6, 80:20, банк 0.03)')
say(HEADER)
for (const T of [60, 300, 900]) {
  run(`${T} с: без мер`, { T })
  run(`${T} с: (а) случайное закрытие за последние 10 с`, { T, mode: { kind: 'rclose', R: 10 } })
  run(`${T} с: (а) случайное закрытие за последние 30 с`, { T, mode: { kind: 'rclose', R: 30 } })
  run(`${T} с: (б) кап адреса 20% банка`, { T, kap: 0.2 })
  run(`${T} с: (б) кап адреса 10% банка`, { T, kap: 0.1 })
  run(`${T} с: (в) банк скрыт до закрытия`, { T, hidden: true })
  run(`${T} с: (а 30 с) + (в)`, { T, mode: { kind: 'rclose', R: 30 }, hidden: true })
  run(`${T} с: (а 30 с) + (б 10%) + (в)`, { T, mode: { kind: 'rclose', R: 30 }, hidden: true, kap: 0.1 })
}
say()
say('## 7. Худшее и E0 с мерами (для сравнения)')
say(HEADER)
run('E0 60 с, без капа, последняя секунда', { T: 60, rule: 'E0', cap: Infinity })
run('E0 60 с, 80:20, (а 30) + (б 10%) + (в)', { T: 60, rule: 'E0', mode: { kind: 'rclose', R: 30 }, hidden: true, kap: 0.1 })
run('E0 900 с, 80:20, (а 30) + (б 10%) + (в)', { T: 900, rule: 'E0', mode: { kind: 'rclose', R: 30 }, hidden: true, kap: 0.1 })
say()

// ── Which configurations keep the ordinary player's loss within 5% / 8% at a bot share up to 25%? ──
say('## 8. Конфигурации, где обычный игрок теряет не больше 8% (и 5%) при доле бота до 25% банка')
// worst ordinary return over: the profit-maximising bot (if its share stays within 25%), and bots forced to
// 5 / 10 / 25% of the bank. The monopolist is the worst case: bots taking more than it wants dilute themselves.
const worst25 = (r) => Math.min(...(r.opt.botShare <= 0.25 + 1e-9 ? [r.opt.ordRet] : []), ...r.forced.slice(0, 3).map((x) => x.ordRet))
const ok = results.filter((r) => worst25(r) >= -0.08)
for (const r of ok) {
  const w = worst25(r)
  say(`${r.label}: худшая доходность до 25% бота ${pct(w)}${w >= -0.05 ? ' (в пределах 5%)' : ''}; бот-монополист берёт ${pct(r.opt.botShare, 0)} банка`)
}
if (!ok.length) say('ни одна')
const best = [...results].sort((a, b) => worst25(b) - worst25(a))[0]
say(`наименьшая потеря до 25% бота: ${best.label}, ${pct(worst25(best))}`)
const worstAll = [...results].sort((a, b) => worst25(a) - worst25(b))[0]
say(`наибольшая: ${worstAll.label}, ${pct(worst25(worstAll))}`)
say()

// ── Rounds per day for a 0.03 ETH mean bank ──
say('## 9. Сколько раундов в сутки на пул даёт средний принятый банк 0.03 ETH (только поток обычных игроков, 80:20)')
say(`${padE('ставок в час на пул', 20)} ${[60, 300, 900, 1800, 3600, 7200].map((T) => pad(`${T} с`, 18)).join(' ')}`)
const demandScenarios = []
for (const perHour of [2, 5, 10, 30, 100, 300]) {
  const cells = [60, 300, 900, 1800, 3600, 7200].map((T) => {
    const f = flowOnly(T, perHour / 3600, 5, 4000, 4)
    demandScenarios.push({ betsPerHourPerPool: perHour, durationSec: T, simulatedRounds: 4000,
      activeShare: f.active, avgActiveBankEth: f.meanActive, activeRoundsPerDay: 86400 / T * f.active })
    return pad(`${f.meanActive.toFixed(3)} x ${(86400 / T * f.active).toFixed(0)}`, 18)
  })
  say(`${padE(perHour, 20)} ${cells.join(' ')}`)
}
say('ячейка: средний принятый банк активного раунда (ETH) x активных раундов в сутки на пул')
say()
console.error(`[stage 1-9] ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)

// ════════════════════════════════════════════════════════════════════════════
// Stage 4: sections 10-14. Everything above is unchanged; POSITIVE-EV.md reads its numbers.
// ════════════════════════════════════════════════════════════════════════════
const ONLY_OLD = argv.includes('--only-old')
const NO_SEARCH = argv.includes('--no-search')
const SKIP4 = argv.includes('--skip-stage4') // development: sections 15-17 without 10-14 (summary.json then lacks their fields)
const UNIT = 0.005 // every stake of the mix is a multiple of it
const RMAX = 300 // the longest reveal window tried; every stage-4 round leaves room for it
const DEMAND = QUICK ? [5, 10] : [2, 5, 10, 30]
const SHARES = [0.05, 0.1, 0.25] // bots that together take up to 25% of the bank
const RS = QUICK ? [120] : [60, 120, 300] // reveal windows, seconds
const PHIS = QUICK ? [0.25, 1] : [0.1, 0.25, 0.5, 1] // share of an unrevealed stake that burns; the rest goes back to its owner
const FATES = ['win', 'reveal'] // burned stakes: to the winners' bank, or back to everyone who revealed
const FATE_LABEL = { win: 'в банк победителей', reveal: 'в возврат раскрывшим' }
const REC = { R: 120, phi: 1, fate: 'win' } // the reveal rules used in sections 12-14 (see section 11)
const stage4 = {}

// Rounds of stage 4: the same schedule as roundsOf (so the same flows), but every round leaves room for RMAX.
const roundsR = {}
for (const T of [300, 900, 1800]) { // 1800 s is used only by stage 5 (sections 15-17)
  const out = []
  for (let pi = 0; pi < pools.length; pi++) {
    const P = pools[pi]
    if (P.firstSec < 0) continue
    for (let k = 0; ; k++) {
      const s = P.firstSec + 61 + k * T
      if (s + T + RMAX + 60 + T > LAST) break
      out.push({ pi, k, s, train: Math.floor((T0 + s + T) / 3600) - HOUR0 < MID_HOUR, day: Math.floor((T0 + s) / 86400), idx: out.length })
    }
  }
  roundsR[T] = out
}
const memo = new Map()
const once = (key, f) => { if (!memo.has(key)) memo.set(key, f()); return memo.get(key) }
// bots for commit-reveal: 'commit' decides at the last second of the window, 'reveal' at the last second of the
// reveal window; both predict the E2 outcome whose strike starts after the reveal window
// W (stage 5): the strike window after the reveal window, seconds; 60 is E2 and keeps the stage-4 cache keys
const wKey = (W) => (W === 60 ? '' : `:W${W}`)
const ruleOf = (W) => (W === 60 ? 'E2' : W)
const botCR = (T, R, at, W = 60) => once(`bot:${T}:${R}:${at}${wKey(W)}`, () => trainBot(roundsR[T], T, ruleOf(W), { kind: 'cr', R, at }))
const outcomesR = (T, R, W = 60) => once(`oc:${T}:${R}${wKey(W)}`, () => {
  const rs = roundsR[T], a = new Int8Array(rs.length)
  for (const rd of rs) a[rd.idx] = outcome(pools[rd.pi], rd.s + T + R, T, ruleOf(W))
  return a
})
const decisionsR = (T, R, at, W = 60) => once(`dec:${T}:${R}:${at}${wKey(W)}`, () => {
  const rs = roundsR[T], bot = botCR(T, R, at, W), a = new Float64Array(rs.length * 4)
  for (const rd of rs) {
    const P = pools[rd.pi]
    a.set(bot.decide('S6', P, rd.pi, features(P, at === 'reveal' ? rd.s + T + R - 1 : rd.s + T - 1)), rd.idx * 4)
  }
  return a
})

// ── Ordinary players: side, timing and bunching scenarios ──
// rho: share of players who follow the price over the last TREND_LOOK seconds; kappa: they take the trend side with
// probability (1 + kappa) / 2. late: share of bets (bunches) placed in the last LATE_FRAC of the window. group: mean
// bunch size (a bunch arrives at one second and takes one side). nu: share of commitments never revealed.
const LATE_FRAC = 0.1, TREND_LOOK = 300
const SCN = {
  uniform: { label: 'случайная сторона, приход равномерный (как в разделах 1-9)' },
  trendHalf: { label: 'половина игроков за трендом 5 мин, сигнал 0.5', rho: 0.5, kappa: 0.5 },
  trendAll: { label: 'все игроки за трендом 5 мин, всегда', rho: 1, kappa: 1 },
  late: { label: '70% ставок в последние 10% окна', late: 0.7 },
  bunchLate: { label: 'пачки по 3 в среднем на одну сторону, 70% пачек в последние 10% окна', late: 0.7, group: 3 },
  trendBunchLate: { label: 'половина за трендом (сигнал 1) и пачки в конце окна', rho: 0.5, kappa: 1, late: 0.7, group: 3 },
  noReveal: { label: '5% обычных ставок не раскрыты в срок', nu: 0.05 },
}
// One round of ordinary flow. The first stream is drawn exactly as ordinaryFlow (time, side, stake per bet), so the
// uniform scenario reproduces it; everything the scenarios add comes from a second stream. pUp of a bunch is what a
// bot that knows the behaviour (learnable on the first week from revealed sides) infers from its time and the price.
function makeFlow(rd, T, lam, level, scn) {
  const r = rngFor(rd.pi, rd.k, level * 100003 + T)
  const n = poisson(r, lam * T)
  const t = new Float64Array(n), side = new Int8Array(n), st = new Float64Array(n), uS = new Float64Array(n)
  for (let i = 0; i < n; i++) { t[i] = r() * T; uS[i] = r(); st[i] = mixStake(r()) }
  const rho = scn.rho ?? 0, kappa = scn.kappa ?? 0, late = scn.late ?? 0, group = scn.group ?? 0, nu = scn.nu ?? 0
  const P = pools[rd.pi], r2 = rngFor(rd.pi, rd.k, level * 100003 + T + 55555)
  const gU = [], gP = []
  let Uo = 0, Do = 0, Zo = 0, V = 0
  for (let i = 0; i < n;) {
    const j1 = Math.min(n, i + (group ? 1 + poisson(r2, group - 1) : 1))
    let tg = t[i]
    if (late && r2() < late) tg = T * (1 - LATE_FRAC) + r2() * T * LATE_FRAC
    let sd = uS[i] < 0.5 ? 1 : -1, pu = 0.5
    if (rho) {
      const u = rd.s + Math.floor(tg)
      const g = Math.sign(P.orient * (P.tickAt[u] - P.tickAt[Math.max(0, u - TREND_LOOK)]))
      if (g !== 0) { if (r2() < rho) sd = uS[i] < (1 + kappa) / 2 ? g : -g; pu = (1 - rho) / 2 + (rho * (1 + kappa * g)) / 2 }
    }
    let units = 0
    for (let m = i; m < j1; m++) {
      t[m] = tg; side[m] = sd; units += Math.round(st[m] / UNIT); V += st[m]
      if (nu && r2() < nu) Zo += st[m]; else if (sd > 0) Uo += st[m]; else Do += st[m]
    }
    gU.push(units); gP.push(pu)
    i = j1
  }
  return { n, t, side, st, Uo, Do, Zo, V, gU, gP }
}
// what a bot that sees every commitment's size and time, but no side, knows: the distribution of the UP total, in UNITs
function distOf(fl) {
  let tot = 0
  for (const u of fl.gU) tot += u
  const d = new Float64Array(tot + 1)
  d[0] = 1
  let cur = 0
  for (let g = 0; g < fl.gU.length; g++) {
    const w = fl.gU[g], p = fl.gP[g]
    for (let u = cur; u >= 0; u--) { const v = d[u]; if (v === 0) continue; d[u + w] += v * p; d[u] = v * (1 - p) }
    cur += w
  }
  return d
}
// all rounds of one flow setting, packed (a few MB, not one object per round)
function flowsFor(T, lam, level, scnKey) {
  return once(`fl:${T}:${lam}:${level}:${scnKey}`, () => {
    const rs = roundsR[T], n = rs.length
    const Uo = new Float64Array(n), Do = new Float64Array(n), Zo = new Float64Array(n), V = new Float64Array(n), off = new Int32Array(n + 1)
    const parts = []
    let tot = 0
    for (const rd of rs) {
      const fl = makeFlow(rd, T, lam, level, SCN[scnKey])
      Uo[rd.idx] = fl.Uo; Do[rd.idx] = fl.Do; Zo[rd.idx] = fl.Zo; V[rd.idx] = fl.V
      const d = distOf(fl)
      parts.push(d); off[rd.idx] = tot; tot += d.length
    }
    off[n] = tot
    const dist = new Float64Array(tot)
    let p = 0
    for (const d of parts) { dist.set(d, p); p += d.length }
    return { Uo, Do, Zo, V, off, dist }
  })
}
const dropFlows = (scnKey) => { for (const k of [...memo.keys()]) if ((k.startsWith('fl:') || k.startsWith('flv:')) && k.endsWith(':' + scnKey)) memo.delete(k) }
// stage 5: the same rounds with the book VISIBLE (no commit-reveal): the bot's distribution of the UP total is a
// point at the real one, so every bot of passCR sees the exact book at the last second of the window
function flowsVisible(T, lam, level, scnKey) {
  return once(`flv:${T}:${lam}:${level}:${scnKey}`, () => {
    const f = flowsFor(T, lam, level, scnKey), n = f.V.length
    const off = new Int32Array(n + 1)
    let tot = 0
    for (let i = 0; i < n; i++) { off[i] = tot; tot += Math.round(f.V[i] / UNIT) + 1 }
    off[n] = tot
    const dist = new Float64Array(tot)
    for (let i = 0; i < n; i++) dist[off[i] + Math.round(f.Uo[i] / UNIT)] = 1
    return { Uo: f.Uo, Do: f.Do, Zo: f.Zo, V: f.V, off, dist }
  })
}

// ── Money of one commit-reveal round ──
// ru: { c cap, f fee, ft tie fee, bmin minimum accepted bank, phi burned share of an unrevealed stake, fate }.
// U, D: revealed raw stakes (everyone), Z: the burned pool. Burned stakes never reach the project: 'win' gives them
// to the winning side, 'reveal' to everyone who revealed; a tie, a refund or a round that is not activated always
// returns them to the revealers, pro rata. out = [active, receipts UP side, receipts DOWN side, fee, unallocated, B, aU, aD]
function crPay(U, D, Z, oc, ru, out) {
  const aU = Math.min(U, ru.c * D), aD = Math.min(D, ru.c * U), B = aU + aD
  out[4] = 0; out[5] = B; out[6] = aU; out[7] = aD
  if (!(U > 0 && D > 0) || B < ru.bmin - 1e-12) {
    const tot = U + D
    out[0] = 0; out[3] = 0
    if (tot > 0) { out[1] = U + (Z * U) / tot; out[2] = D + (Z * D) / tot } else { out[1] = 0; out[2] = 0; out[4] = Z }
    return false
  }
  out[0] = 1
  if (oc === 1 || oc === -1) {
    const win = ru.fate === 'win'
    out[1] = U - aU + (oc === 1 ? (1 - ru.f) * B : 0) + (win ? (oc === 1 ? Z : 0) : (Z * aU) / B)
    out[2] = D - aD + (oc === -1 ? (1 - ru.f) * B : 0) + (win ? (oc === -1 ? Z : 0) : (Z * aD) / B)
    out[3] = ru.f * B
  } else {
    out[1] = U - aU + (1 - ru.ft) * aU + (Z * aU) / B
    out[2] = D - aD + (1 - ru.ft) * aD + (Z * aD) / B
    out[3] = ru.ft * B
  }
  return true
}
// the bot's expected receipts at its reveal decision: it has seen every ordinary reveal and the price up to the last
// second of the reveal window; bu / bd revealed, ub left unrevealed
function revEv(Uo, Do, Zo, bu, bd, ub, pU, pD, pT, ru) {
  const U = Uo + bu, D = Do + bd, Z = ru.phi * (ub + Zo)
  const e = (1 - ru.phi) * ub
  const aU = Math.min(U, ru.c * D), aD = Math.min(D, ru.c * U), B = aU + aD
  if (!(U > 0 && D > 0) || B < ru.bmin - 1e-12) { const tot = U + D; return e + (tot > 0 ? (bu + bd) * (1 + Z / tot) : 0) }
  const sU = bu / U, sD = bd / D, win = ru.fate === 'win'
  const upWin = sU * (U - aU + (1 - ru.f) * B + (win ? Z : (Z * aU) / B)) + sD * (D - aD + (win ? 0 : (Z * aD) / B))
  const dnWin = sU * (U - aU + (win ? 0 : (Z * aU) / B)) + sD * (D - aD + (1 - ru.f) * B + (win ? Z : (Z * aD) / B))
  const tie = sU * (U - aU + (1 - ru.ft) * aU + (Z * aU) / B) + sD * (D - aD + (1 - ru.ft) * aD + (Z * aD) / B)
  return e + pU * upWin + pD * dnWin + pT * tie
}
// the (a) bot at the last second of the window: stake X on side sd, expected over the hidden split of the commitments
function evBook(X, S, O, ru, pw, pl, pt) {
  const own = S + X, aOwn = Math.min(own, ru.c * O), aOpp = Math.min(O, ru.c * own), B = aOwn + aOpp
  if (aOwn <= 0 || aOpp <= 0 || B < ru.bmin - 1e-12) return 0
  // stage 5, fill 'time': inside a side earlier stakes are filled first, the bot (last) gets only what is left
  if (ru.fill === 'time') return Math.max(0, aOwn - Math.min(S, aOwn)) * (pw * (((1 - ru.f) * B) / aOwn - 1) - pl - ru.ft * pt)
  return ((X * aOwn) / own) * (pw * (((1 - ru.f) * B) / aOwn - 1) - pl - ru.ft * pt)
}
function evA(X, sd, c, pw, pl, pt) {
  let e = 0
  const top = c.len - 1
  for (let u = 0; u <= top; u++) {
    const p = c.dist[c.o + u]
    if (p < 1e-12) continue
    e += p * evBook(X, (sd > 0 ? u : top - u) * UNIT, (sd > 0 ? top - u : u) * UNIT, c.ru, pw, pl, pt)
  }
  return e
}
function optA(c, sd, pw, pl, pt) {
  const big = 50 * (c.V + MIN_STAKE), f = (x) => evA(x, sd, c, pw, pl, pt)
  const xs = []
  for (let x = MIN_STAKE; x <= big; x *= 1.25) xs.push(x)
  let bi = -1, be = 1e-12
  for (let i = 0; i < xs.length; i++) { const e = f(xs[i]); if (e > be) { be = e; bi = i } }
  if (bi < 0) return { x: 0, ev: 0 }
  let lo = bi > 0 ? xs[bi - 1] : MIN_STAKE, hi = bi < xs.length - 1 ? xs[bi + 1] : xs[bi]
  for (let it = 0; it < 16; it++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (f(m1) < f(m2)) lo = m1; else hi = m2 }
  const xr = (lo + hi) / 2, er = f(xr)
  return er > be ? { x: xr, ev: er } : { x: xs[bi], ev: be }
}
// bots that together take a target share of the deposits, never past their zero expected profit (as sizeShare)
function shareA(c, t, sd, pw, pl, pt, opt) {
  const f = (x) => evA(x, sd, c, pw, pl, pt)
  const Xt = Math.max(MIN_STAKE, (t / (1 - t)) * c.V), et = f(Xt)
  if (et > 1e-12) return { x: Xt, ev: et }
  if (opt.x <= 0 || opt.x >= Xt) return { x: 0, ev: 0 }
  let a = opt.x, b = Xt
  for (let it = 0; it < 30; it++) { const m = (a + b) / 2; if (f(m) >= 0) a = m; else b = m }
  return { x: a, ev: f(a) }
}

// ── One pass over the rounds of a commit-reveal setting, for several bot specs at once ──
// Spec kinds (these bots reveal everything):
//   none; opt - the (a) monopolist: one side, size by expected profit over the hidden split of the commitments;
//   share - bots up to a share of the deposits, never past zero expected profit; two - both sides, k x the visible
//   commitments on each, no price forecast at all. q < 1: the bot plays only a random share q of the rounds.
// pol - a policy that may commit from several addresses on both sides and leave commitments unrevealed.
// Policies are scored on both weeks (a bot picks one on the first); the other kinds only on the second.
const POLS = [{ id: 'a', kind: 'a', abandon: false, burn: false }, { id: 'a+', kind: 'a', abandon: true, burn: true }]
for (const k of [0.125, 0.25, 0.5, 1, 2]) for (const w of [0.5, 1]) POLS.push({ id: `h k${k} w${w}`, kind: 'h', k, w, burn: false })
for (const gate of [false, true]) for (const k of [0.25, 0.5, 1, 2]) for (const w of [0.5, 1]) POLS.push({ id: `b${gate ? 'g' : ''} k${k} w${w}`, kind: 'b', gate, k, w, burn: true })
for (const gate of [false, true]) for (const k of [0.25, 0.5, 1]) POLS.push({ id: `c${gate ? 'g' : ''} k${k} w1`, kind: 'c', gate, k, w: 1, burn: true })
const POL_SPECS = POLS.map((pol) => ({ kind: 'pol', pol }))
const newAcc = () => ({ win: 0, act: 0, ties: 0, bank: 0, fee: 0, rev: 0, ordNet: 0, ordAcc: 0, ordCom: 0, botNet: 0, botAcc: 0, botCommit: 0, burn: 0, burnRounds: 0, botRounds: 0, un: 0, cons: 0, minC: Infinity, cl: new Map() })
function clAdd(a, ck, i, v) { let x = a.cl.get(ck); if (!x) { x = new Float64Array(5); a.cl.set(ck, x) } x[i] += v } // windows, ordinary net, ordinary accepted, project net, bot net
const SCR = new Float64Array(8)
// stage 5: the same accounting when a side is filled in time order (ordinary stakes first, the bot last); the
// prize and the burned pool are shared per accepted unit
function realizeTime(a, ck, fl, bu, bd, ub, commit, oc, ru) {
  const U = fl.Uo + bu, D = fl.Do + bd, Z = ru.phi * (ub + fl.Zo)
  const aU = Math.min(U, ru.c * D), aD = Math.min(D, ru.c * U), B = aU + aD
  const oU = Math.min(fl.Uo, aU), oD = Math.min(fl.Do, aD), xU = aU - oU, xD = aD - oD
  const act = U > 0 && D > 0 && B >= ru.bmin - 1e-12
  let ordRec, botRec, fee = 0, un = 0
  if (!act) {
    const tot = U + D
    ordRec = fl.Uo + fl.Do + (tot > 0 ? (Z * (fl.Uo + fl.Do)) / tot : 0)
    botRec = bu + bd + (tot > 0 ? (Z * (bu + bd)) / tot : 0)
    if (tot <= 0) un = Z
  } else {
    let gU, gD
    if (oc === 1 || oc === -1) {
      const win = ru.fate === 'win'
      gU = (oc === 1 ? ((1 - ru.f) * B) / aU : 0) + (win ? (oc === 1 ? Z / aU : 0) : Z / B)
      gD = (oc === -1 ? ((1 - ru.f) * B) / aD : 0) + (win ? (oc === -1 ? Z / aD : 0) : Z / B)
      fee = ru.f * B
    } else { gU = gD = 1 - ru.ft + Z / B; fee = ru.ft * B }
    ordRec = fl.Uo - oU + fl.Do - oD + oU * gU + oD * gD
    botRec = bu - xU + bd - xD + xU * gU + xD * gD
  }
  ordRec += (1 - ru.phi) * fl.Zo
  botRec += (1 - ru.phi) * ub
  a.cons = Math.max(a.cons, Math.abs(ordRec + botRec + fee + un - fl.V - commit))
  a.un += un
  const on = ordRec - fl.V
  let oa = fl.Zo
  if (act) {
    const net = fee * (1 - REF_SHARE) - COST
    a.act++; a.bank += B; a.fee += fee; a.rev += net; a.minC = Math.min(a.minC, net)
    if (oc !== 1 && oc !== -1) a.ties++
    oa += oU + oD
    a.botAcc += xU + xD
    clAdd(a, ck, 3, net)
  }
  a.ordNet += on; a.ordAcc += oa; a.ordCom += fl.V
  clAdd(a, ck, 1, on); clAdd(a, ck, 2, oa)
  if (commit > 0) {
    const bn = botRec - commit
    a.botNet += bn; a.botCommit += commit; a.botRounds++
    clAdd(a, ck, 4, bn)
    if (ub > 0) { a.burn += ru.phi * ub; a.burnRounds++ }
  }
}
function realize(a, ck, fl, bu, bd, ub, commit, oc, ru) {
  if (ru.fill === 'time') return realizeTime(a, ck, fl, bu, bd, ub, commit, oc, ru)
  const U = fl.Uo + bu, D = fl.Do + bd
  const act = crPay(U, D, ru.phi * (ub + fl.Zo), oc, ru, SCR)
  const rU = SCR[1], rD = SCR[2], fee = SCR[3]
  const botRec = (bu > 0 ? (rU * bu) / U : 0) + (bd > 0 ? (rD * bd) / D : 0) + (1 - ru.phi) * ub
  const ordRec = (fl.Uo > 0 ? (rU * fl.Uo) / U : 0) + (fl.Do > 0 ? (rD * fl.Do) / D : 0) + (1 - ru.phi) * fl.Zo
  a.cons = Math.max(a.cons, Math.abs(ordRec + botRec + fee + SCR[4] - fl.V - commit)) // money is conserved
  a.un += SCR[4]
  const on = ordRec - fl.V
  let oa = fl.Zo // an unrevealed ordinary stake counts as played: its owner lost the burned part
  if (act) {
    const B = SCR[5], aU = SCR[6], aD = SCR[7], net = fee * (1 - REF_SHARE) - COST
    a.act++; a.bank += B; a.fee += fee; a.rev += net; a.minC = Math.min(a.minC, net)
    if (oc !== 1 && oc !== -1) a.ties++
    oa += (fl.Uo > 0 ? (aU * fl.Uo) / U : 0) + (fl.Do > 0 ? (aD * fl.Do) / D : 0)
    a.botAcc += (bu > 0 ? (aU * bu) / U : 0) + (bd > 0 ? (aD * bd) / D : 0)
    clAdd(a, ck, 3, net)
  }
  a.ordNet += on; a.ordAcc += oa; a.ordCom += fl.V
  clAdd(a, ck, 1, on); clAdd(a, ck, 2, oa)
  if (commit > 0) {
    const bn = botRec - commit
    a.botNet += bn; a.botCommit += commit; a.botRounds++
    clAdd(a, ck, 4, bn)
    if (ub > 0) { a.burn += ru.phi * ub; a.burnRounds++ }
  }
}
// a bot without any price forecast: the pooled first-week rates, the same for both sides
const blindDecisions = (T, R, at, W = 60) => once(`blind:${T}:${R}:${at}${wKey(W)}`, () => {
  const gw = botCR(T, R, at, W).gw, t = gw[2], w = (1 - t) / 2, a = new Float64Array(roundsR[T].length * 4)
  for (let i = 0; i < roundsR[T].length; i++) a.set([1, w, w, t], 4 * i)
  return a
})
// mode5 (stage 5): { W: strike window, bothWeeks: score every spec on both weeks (for choosing on the first) }
function passCR(T, R, ru, flows, specs, aCache = null, blind = false, mode5 = {}) {
  const W = mode5.W ?? 60, both = !!mode5.bothWeeks
  const rs = roundsR[T], ocs = outcomesR(T, R, W), dc = (blind ? blindDecisions : decisionsR)(T, R, 'commit', W)
  const pol = specs.some((s) => s.kind === 'pol'), dr = pol ? (blind ? blindDecisions : decisionsR)(T, R, 'reveal', W) : null
  if (pol && ru.fill === 'time') throw new Error('reveal policies are modeled only with the pro rata fill')
  const useQ = specs.some((s) => s.q !== undefined && s.q < 1)
  const A = specs.map(() => [newAcc(), newAcc()]) // [first week, second week]
  const aDec = aCache ?? new Float64Array(rs.length * 3).fill(NaN) // side, stake, EV of the (a) monopolist
  const fl = { Uo: 0, Do: 0, Zo: 0, V: 0 }
  for (const rd of rs) {
    if (rd.train && !pol && !both) continue
    const i = rd.idx, oc = ocs[i]
    if (oc === 3) continue
    const w = rd.train ? 0 : 1, ck = rd.pi * 1000 + rd.day
    fl.Uo = flows.Uo[i]; fl.Do = flows.Do[i]; fl.Zo = flows.Zo[i]; fl.V = flows.V[i]
    const c = { dist: flows.dist, o: flows.off[i], len: flows.off[i + 1] - flows.off[i], ru, V: fl.V }
    const cs = dc[4 * i], cw = dc[4 * i + 1], cl = dc[4 * i + 2], ct = dc[4 * i + 3]
    const part = useQ ? rngFor(rd.pi, rd.k, 4242 + T)() : 0
    let o1 = null, o2 = null
    const opts = () => { if (!o1) { o1 = optA(c, cs, cw, cl, ct); o2 = optA(c, -cs, cl, cw, ct) } }
    const getA = () => {
      if (Number.isNaN(aDec[3 * i])) { opts(); aDec.set(o2.ev > o1.ev ? [-cs, o2.x, o2.ev] : [cs, o1.x, o1.ev], 3 * i) }
      return [aDec[3 * i], aDec[3 * i + 1]]
    }
    for (let si = 0; si < specs.length; si++) {
      const sp = specs[si]
      if (w === 0 && sp.kind !== 'pol' && !both) continue
      const a = A[si][w]
      a.win++; clAdd(a, ck, 0, 1)
      if (fl.V <= 0) continue // nobody committed: nothing to play
      if (sp.kind === 'none' || (sp.q !== undefined && part >= sp.q)) { realize(a, ck, fl, 0, 0, 0, 0, oc, ru); continue }
      if (sp.kind === 'opt') { const [sd, x] = getA(); realize(a, ck, fl, sd > 0 ? x : 0, sd < 0 ? x : 0, 0, x, oc, ru); continue }
      if (sp.kind === 'two') { const x = Math.max(MIN_STAKE, sp.k * fl.V); realize(a, ck, fl, x, x, 0, 2 * x, oc, ru); continue }
      if (sp.kind === 'share') {
        opts()
        const s1 = shareA(c, sp.share, cs, cw, cl, ct, o1), s2 = shareA(c, sp.share, -cs, cl, cw, ct, o2)
        const alt = s2.x > 0 && (s1.x <= 0 || s2.ev > s1.ev)
        const sd = alt ? -cs : cs, x = alt ? s2.x : s1.x
        realize(a, ck, fl, sd > 0 ? x : 0, sd < 0 ? x : 0, 0, x, oc, ru)
        continue
      }
      const p = sp.pol
      const [aSd, aX] = getA()
      let qU = 0, mU = 0, qD = 0, mD = 0
      if ((p.kind === 'a' || p.gate) && aX <= 0) { realize(a, ck, fl, 0, 0, 0, 0, oc, ru); continue }
      if (p.kind === 'a') {
        if (aSd > 0) { qU = aX; mU = 1 } else { qD = aX; mD = 1 }
        if (!p.abandon) { realize(a, ck, fl, qU * mU, qD * mD, 0, aX, oc, ru); continue }
      } else {
        const fav = aX > 0 ? aSd : cs, Af = Math.max(MIN_STAKE, p.k * fl.V)
        let qF, mF, qO, mO
        if (p.kind === 'c') { qF = qO = Math.max(MIN_STAKE, Af / 4); mF = 4; mO = Math.max(1, Math.round(4 * p.w)) }
        else { qF = Af; mF = 1; qO = Math.max(MIN_STAKE, p.w * Af); mO = 1 }
        if (fav > 0) { qU = qF; mU = mF; qD = qO; mD = mO } else { qU = qO; mU = mO; qD = qF; mD = mF }
        if (p.kind === 'h') { realize(a, ck, fl, qU, qD, 0, qU + qD, oc, ru); continue }
      }
      const rsd = dr[4 * i], rw = dr[4 * i + 1], rl = dr[4 * i + 2], rt = dr[4 * i + 3]
      const pU = rsd > 0 ? rw : rl, pD = rsd > 0 ? rl : rw
      let bi = mU, bj = mD, be = -Infinity
      for (let ii = 0; ii <= mU; ii++) for (let jj = 0; jj <= mD; jj++) {
        const e = revEv(fl.Uo, fl.Do, fl.Zo, ii * qU, jj * qD, (mU - ii) * qU + (mD - jj) * qD, pU, pD, rt, ru)
        if (e > be + 1e-15) { be = e; bi = ii; bj = jj }
      }
      realize(a, ck, fl, bi * qU, bj * qD, (mU - bi) * qU + (mD - bj) * qD, qU * mU + qD * mD, oc, ru)
    }
  }
  return A
}
// cluster (pool x day) ratio and its error
function clRatio(a, iNum, iDen, pick) {
  let N = 0, Dn = 0
  for (const [k, x] of a.cl) if (!pick || pick(k)) { N += x[iNum]; Dn += x[iDen] }
  const r = N / Dn
  let s2 = 0, C = 0
  for (const [k, x] of a.cl) if (!pick || pick(k)) { const d = x[iNum] - r * x[iDen]; s2 += d * d; C++ }
  return { r, se: C > 1 && Dn ? Math.sqrt((s2 * C) / (C - 1)) / Math.abs(Dn) : NaN }
}
const H1 = (k) => k % 1000 < HALF_DAY % 1000
function crStats(a, T) {
  const k = 86400 / T, o = clRatio(a, 1, 2), rv = clRatio(a, 3, 0), bt = clRatio(a, 4, 0)
  return {
    rounds: a.win, activeShare: a.act / a.win, activeRoundsPerDay: (a.act / a.win) * k, meanBank: a.bank / a.act,
    tieShare: a.ties / a.act, feePct: a.fee / a.bank, retainedPct: (a.fee * (1 - REF_SHARE)) / a.bank,
    revDay: rv.r * k, revDaySe: rv.se * k, ordRet: o.r, ordSe: o.se, ordRetPerCommitted: a.ordNet / a.ordCom,
    ordRetH1: clRatio(a, 1, 2, H1).r, ordRetH2: clRatio(a, 1, 2, (x) => !H1(x)).r,
    ordSeH1: clRatio(a, 1, 2, H1).se, ordSeH2: clRatio(a, 1, 2, (x) => !H1(x)).se,
    botShare: a.bank ? a.botAcc / a.bank : 0, botRet: a.botAcc ? a.botNet / a.botAcc : NaN, botRetCommit: a.botCommit ? a.botNet / a.botCommit : NaN,
    botDay: bt.r * k, botDaySe: bt.se * k, botRoundShare: a.act ? a.botRounds / a.act : 0,
    burnShare: a.botCommit ? a.burn / a.botCommit : 0, burnRounds: a.burnRounds, unallocated: a.un, cons: a.cons,
    minContribution: Number.isFinite(a.minC) ? a.minC : null,
  }
}
// paired difference of the bot's profit per pool-day between two specs on the same rounds
function pairedBot(a, b, T) {
  let N = 0, W = 0
  for (const [k, x] of a.cl) { N += x[4] - (b.cl.get(k)?.[4] ?? 0); W += x[0] }
  const r = N / W
  let s2 = 0, C = 0
  for (const [k, x] of a.cl) { const d = x[4] - (b.cl.get(k)?.[4] ?? 0) - r * x[0]; s2 += d * d; C++ }
  return { d: (r * 86400) / T, se: C > 1 ? (Math.sqrt((s2 * C) / (C - 1)) / W) * (86400 / T) : NaN }
}
// the policy a bot would pick after the first week, among a family; maxShare limits its first-week share of the bank
function pickPolicy(A, family, maxShare = Infinity) {
  let best = -1, bv = 0 // abstaining earns 0
  for (let i = 0; i < POLS.length; i++) {
    const a = A[i][0]
    if (family(POLS[i]) && a.botNet > bv && (a.bank ? a.botAcc / a.bank : 0) <= maxShare) { bv = a.botNet; best = i }
  }
  return best
}

// ── Output helpers of stage 4 ──
const mEth = (x, d = 2) => (Number.isFinite(x) ? (1000 * x).toFixed(d) : '-')
const usd = (x, d = 2) => (Number.isFinite(x) ? '$' + (x * ETH_USD).toFixed(d) : '-')
const se1 = (x) => (Number.isFinite(x) ? '±' + (100 * x).toFixed(1) : '')
const capName = (c) => (c === 1 ? '50:50' : capLabel(c))
// The ordinary return of one bot family at exactly 25% of the bank: its points (growing participation or target
// share) joined to the no-bot point and interpolated; if the family never reaches 25%, its largest point.
function at25(none, pts) {
  const P = [{ s: 0, r: none.ordRet, se: none.ordSe, h1: none.ordRetH1, h2: none.ordRetH2, s1: none.ordSeH1, s2: none.ordSeH2 },
    ...pts.map((p) => ({ s: p.botShare, r: p.ordRet, se: p.ordSe, h1: p.ordRetH1, h2: p.ordRetH2, s1: p.ordSeH1, s2: p.ordSeH2 }))].sort((a, b) => a.s - b.s)
  let best = null
  for (const p of P) if (p.s <= 0.25 && (!best || p.r < best.r)) best = p
  for (let i = 0; i + 1 < P.length; i++) {
    if (P[i].s <= 0.25 && P[i + 1].s > 0.25) {
      const t = (0.25 - P[i].s) / (P[i + 1].s - P[i].s), L = (x, y) => x + t * (y - x)
      const q = { s: 0.25, r: L(P[i].r, P[i + 1].r), se: Math.max(P[i].se, P[i + 1].se), h1: L(P[i].h1, P[i + 1].h1), h2: L(P[i].h2, P[i + 1].h2),
        s1: Math.max(P[i].s1, P[i + 1].s1), s2: Math.max(P[i].s2, P[i + 1].s2) }
      if (q.r < best.r) best = q
    }
  }
  return best
}
// the worst ordinary return at a bot share up to 25% of the bank, over every bot family of the curve
function worstUpTo25(cv) {
  const fam = [['монополист', cv.optQ], ['боты по доле', cv.forced], ...(cv.two ? [['двусторонний k0.25', cv.two[0.25]], ['двусторонний k1', cv.two[1]]] : [])]
  let w = null
  for (const [src, pts] of fam) { const x = at25(cv.none, pts); if (!w || x.r < w.ordRet) w = { ordRet: x.r, ordSe: x.se, src, share: x.s, H1: x.h1, H2: x.h2, H1se: x.s1, H2se: x.s2 } }
  return w
}
// the fields of a result kept in summary.json (the full set is in the objects, the file stays small)
const BRIEF = ['rounds', 'activeShare', 'activeRoundsPerDay', 'meanBank', 'tieShare', 'retainedPct', 'revDay', 'revDaySe', 'ordRet', 'ordSe', 'ordRetH1', 'ordRetH2',
  'ordRetPerCommitted', 'botShare', 'botRet', 'botDay', 'botDaySe', 'burnShare', 'unallocated', 'cons', 'minContribution']
const strip = (s) => { const o = {}; for (const k of BRIEF) if (typeof s[k] === 'number' || s[k] === null) o[k] = s[k]; return o }
const HEAD4 = `${padE('мера', 60)} ${pad('без бота', 8)} ${pad('монополист: доля, обычн., бот', 29)} ${pad('двустор. k0.25', 15)} ${pad('боты 25%', 13)} ${pad('худшая при доле бота до 25%', 36)}`
function row4(label, cv) {
  const w = worstUpTo25(cv)
  const two = cv.two ? cv.two[0.25][2] : null, f25 = cv.forced[2]
  say(`${padE(label, 60)} ${pad(pct(cv.none.ordRet), 8)} ${pad(`${pct(cv.opt.botShare, 0)} ${pct(cv.opt.ordRet)} ${se1(cv.opt.ordSe)} ${pct(cv.opt.botRet, 0)}`, 29)} ${pad(two ? `${pct(two.botShare, 0)} ${pct(two.ordRet)}` : '-', 15)} ${pad(`${pct(f25.botShare, 0)} ${pct(f25.ordRet)}`, 13)} ${pad(`${pct(w.ordRet)} ${se1(w.ordSe)} (${w.src})`, 36)}`)
  return w
}
const RU0 = { c: 4, f: FEE, ft: FEE_TIE, bmin: MIN_BANK, phi: REC.phi, fate: REC.fate }
const QS = [0.25, 0.5, 1]
function oldCurve(c, rounds) {
  const bot = botFor(c.T, c.rule, c.mode)
  const optQ = QS.map((q) => simulate(c, rounds, bot, q === 1 ? { opt: true } : { opt: true, q }))
  return { none: simulate(c, rounds, bot, null), opt: optQ[2], optQ, forced: SHARES.map((t) => simulate(c, rounds, bot, { share: t })) }
}
const CURVE_SPECS = [{ kind: 'none' }, ...QS.map((q) => ({ kind: 'opt', q })), ...SHARES.map((share) => ({ kind: 'share', share })), ...[0.25, 1].flatMap((k) => QS.map((q) => ({ kind: 'two', k, q })))]
function crCurve(T, R, ru, flows, extra = [], blind = false, mode5 = {}) {
  const A = passCR(T, R, ru, flows, [...CURVE_SPECS, ...extra], null, blind, mode5)
  const n0 = CURVE_SPECS.length
  const shape = (st) => ({ none: st[0], optQ: st.slice(1, 4), opt: st[3], forced: st.slice(4, 7), two: { 0.25: st.slice(7, 10), 1: st.slice(10, 13) } })
  const cv = { ...shape(A.map((x) => crStats(x[1], T))), extraA: A.slice(n0), acc: A.map((x) => x[1]) }
  if (mode5.bothWeeks) cv.week1 = shape(A.map((x) => crStats(x[0], T))) // the first week: for choosing a configuration
  return cv
}
// in summary.json: no bot, the monopolist, bots at 25%, the two-sided bot k0.25 in every round, and the worst point up to 25%
const cvJson = (cv) => ({ none: strip(cv.none), opt: strip(cv.opt), bots25: strip(cv.forced[2]),
  ...(cv.two ? { twoSidedK025: strip(cv.two[0.25][2]) } : {}), worst25: worstUpTo25(cv) })
// the selective bot of one setting: the plain (a) bot, the best policy without burning, the best with burning, the
// best one whose first-week share is at most 25%; every choice made on the first week, numbers of the second
function selectiveOf(A, T) {
  const ia = 0, inb = pickPolicy(A, (p) => !p.burn), ib = pickPolicy(A, (p) => p.burn), iall = pickPolicy(A, () => true), i25 = pickPolicy(A, () => true, 0.25)
  const st = (i) => {
    if (i < 0) return null
    const s = crStats(A[i][1], T), o = { policy: POLS[i].id }
    for (const k of ['ordRet', 'ordSe', 'botShare', 'botRet', 'botDay', 'botDaySe', 'burnShare', 'revDay', 'activeRoundsPerDay']) o[k] = s[k]
    return o
  }
  const nb = st(inb), bb = st(ib)
  const dNb = inb >= 0 ? pairedBot(A[inb][1], A[ia][1], T) : null
  const dB = ib >= 0 ? (inb >= 0 ? pairedBot(A[ib][1], A[inb][1], T) : pairedBot(A[ib][1], A[ia][1], T)) : null
  return { a: st(ia), noBurn: nb && { ...nb, deltaVsA: dNb.d, deltaVsASe: dNb.se }, burn: bb && { ...bb, deltaVsNoBurn: dB.d, deltaVsNoBurnSe: dB.se }, chosen: st(iall), upTo25: st(i25) }
}

if (!ONLY_OLD && !SKIP4) {
  // ════════════════════════════════════════════════════════════════════════════
  say('## 10. Реальный спрос 2-30 ставок в час на пул: меры защиты и commit-reveal (E2, S6, кап 80:20, комиссия 2% / 1%, банк от 0.01 ETH)')
  say('Отличия от разделов 1-9: бот выбирает любую сторону (в том числе против своего прогноза, если множитель это окупает); поток задан числом ставок в час, а не целевым банком; раунды оставляют место для окна раскрытия до 300 с.')
  say('commit-reveal (а): бот видит размер и время каждого обязательства, но не сторону; раскрывает всё; страйк E2 начинается после окна раскрытия R. «без прогноза» - тот же бот без модели цены: вероятности исхода одинаковы для обеих сторон.')
  say('Колонки: обычный игрок без бота; монополист (его доля банка, доходность обычных игроков ± ошибка по блокам пул x сутки, его доходность на принятую ставку); двусторонний бот k0.25 (по 0.25 видимых обязательств на каждую сторону, не меньше 0.005, без прогноза): доля, обычные; боты, берущие 25%: доля, обычные;')
  say('худшая при доле бота до 25%: для каждого семейства ботов (монополист и двусторонний, играющие в случайной 1/4, 1/2 или всех раундах; боты по доле 5 / 10 / 25%) доходность обычных игроков при доле бота ровно 25% (линейно между точками) или при его наибольшей доле, если 25% он не набирает; худшая из семейств.')
  const realDemand = []
  const flowLine = (T, perHour, s) => say(`${T} с, ${perHour} ставок в час на пул: без бота активных раундов ${s.activeRoundsPerDay.toFixed(1)} в сутки (${pct(s.activeShare)} окон), банк активного раунда ${s.meanBank.toFixed(4)} ETH, ничьих и возвратов ${pct(s.tieShare)}, доход проекта после газа ${mEth(s.revDay, 3)} ± ${mEth(s.revDaySe, 3)} мETH на пул в сутки (${usd(s.revDay)})`)
  {
    const T = 300, lam = lambdas['300:0.03'], level = 2 // the first-pass base: the same flow as sections 1-8
    const flowFn = (rd) => makeFlow(rd, T, lam, level, SCN.uniform)
    const bc = { T, rule: 'E2', cap: 4, mode: { kind: 'last' }, hidden: false, kap: 1, strategy: 'S6', lambda: lam, flowFn, bothSides: true }
    const fls = flowsFor(T, lam, level, 'uniform')
    say()
    say(`### База разделов 1-9: ${(lam * 3600).toFixed(1)} ставки в час, 300 с`)
    say(HEAD4)
    const rows = [
      ['банк виден, бот только на стороне прогноза (как в разделе 6)', oldCurve({ ...bc, bothSides: false }, roundsR[T])],
      ['банк виден, бот на любой стороне', oldCurve(bc, roundsR[T])],
      ['(в) старая модель скрытого банка (раздел 6)', oldCurve({ ...bc, hidden: true, bothSides: false }, roundsR[T])],
      ...[0, REC.R].map((R) => [`commit-reveal (а), R = ${R} с`, crCurve(T, R, RU0, fls)]),
      [`commit-reveal (а), R = ${REC.R} с, бот без прогноза`, crCurve(T, REC.R, RU0, fls, [], true)],
    ]
    for (const [label, cv] of rows) { const w = row4(label, cv); realDemand.push({ T, betsPerHour: lam * 3600, base: true, measure: label, ...cvJson(cv), worst25: w }) }
  }
  for (const T of [300, 900]) {
    for (const perHour of DEMAND) {
      const lam = perHour / 3600, level = 1000 + perHour
      const flowFn = (rd) => makeFlow(rd, T, lam, level, SCN.uniform)
      const bc = { T, rule: 'E2', cap: 4, mode: { kind: 'last' }, hidden: false, kap: 1, strategy: 'S6', lambda: lam, flowFn, bothSides: true }
      const fls = flowsFor(T, lam, level, 'uniform')
      say()
      const rows = [
        ['банк виден, без мер', oldCurve(bc, roundsR[T])],
        ['(а) случайное закрытие за последние 30 с', oldCurve({ ...bc, mode: { kind: 'rclose', R: 30 } }, roundsR[T])],
        ['(б) кап адреса 10% банка (только для бота)', oldCurve({ ...bc, kap: 0.1 }, roundsR[T])],
        ['(в) старая модель скрытого банка', oldCurve({ ...bc, hidden: true }, roundsR[T])],
        ...[0, ...RS].map((R) => [`commit-reveal (а), R = ${R} с`, crCurve(T, R, RU0, fls)]),
        [`commit-reveal (а), R = ${REC.R} с, бот без прогноза`, crCurve(T, REC.R, RU0, fls, [], true)],
        [`commit-reveal (а), R = ${REC.R} с, кап 50:50`, crCurve(T, REC.R, { ...RU0, c: 1 }, fls)],
        [`commit-reveal (а), R = ${REC.R} с, кап 50:50, бот без прогноза`, crCurve(T, REC.R, { ...RU0, c: 1 }, fls, [], true)],
      ]
      flowLine(T, perHour, rows[4][1].none)
      say(HEAD4)
      for (const [label, cv] of rows) { const w = row4(label, cv); realDemand.push({ T, betsPerHour: perHour, measure: label, ...cvJson(cv), worst25: w }) }
    }
  }
  say()
  stage4.realDemand = realDemand
  console.error(`[section 10] ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)

  // ════════════════════════════════════════════════════════════════════════════
  say('## 11. Выборочное нераскрытие: бот со ставками с нескольких адресов на обе стороны (E2, S6, кап 80:20 и 50:50, 2% / 1%, банк от 0.01)')
  say('Бот коммитит в последнюю секунду окна и решает, что раскрыть, в последнюю секунду окна раскрытия R: он видит все раскрытые стороны обычных игроков и цену. Нераскрытая ставка сгорает на долю φ, остаток возвращается владельцу.')
  say('Политики: a - одна сторона, раскрывает всё (как (а) в разделе 10); h - обе стороны (сторона прогноза k x видимые обязательства, другая w от неё), раскрывает всё; a+ - как a, но может не раскрыть; b - по адресу на сторону; c - по 4 адреса на сторону (можно раскрыть часть); g - коммитит, только если участвовал бы a.')
  say('Без сжигания: a, h; со сжиганием: a+, b, c. Бот выбирает политику по своей прибыли на первой неделе, числа - вторая неделя, мETH на пул в сутки; Δ - разница прибыли бота на тех же раундах, ошибка парная по блокам пул x сутки.')
  const selective = []
  const SEL_CAPS = [4, 1]
  for (const cap of SEL_CAPS) {
    say()
    say(`### Кап ${capName(cap)}`)
    for (const T of [300, 900]) for (const perHour of DEMAND) for (const R of RS) {
      const lam = perHour / 3600, level = 1000 + perHour, flows = flowsFor(T, lam, level, 'uniform')
      const aCache = new Float64Array(roundsR[T].length * 3).fill(NaN)
      for (const fate of FATES) for (const phi of PHIS) {
        const s = selectiveOf(passCR(T, R, { ...RU0, c: cap, phi, fate }, flows, POL_SPECS, aCache), T)
        selective.push({ cap: capName(cap), T, betsPerHour: perHour, R, fate, phi, ...s })
        const nb = s.noBurn, bb = s.burn, u = s.upTo25
        say(`${T} с, ${pad(perHour, 2)}/ч, R ${pad(R, 3)}, ${padE(FATE_LABEL[fate], 20)} φ ${pad(Math.round(100 * phi) + '%', 4)}: a ${pad(mEth(s.a.botDay), 6)}, обычн. ${pad(pct(s.a.ordRet), 6)}; без сжигания ${padE(nb ? nb.policy : '-', 10)} Δ к a ${pad(nb ? mEth(nb.deltaVsA) : '-', 6)} ± ${nb ? mEth(nb.deltaVsASe) : '-'}, обычн. ${nb ? pct(nb.ordRet) : '-'}; ` +
          `со сжиганием ${padE(bb ? bb.policy : '-', 10)} Δ к лучшей без ${pad(bb ? mEth(bb.deltaVsNoBurn) : '-', 6)} ± ${bb ? mEth(bb.deltaVsNoBurnSe) : '-'}, сожжено ${bb ? pct(bb.burnShare) : '-'} коммитов, обычн. ${bb ? pct(bb.ordRet) : '-'}; доля до 25%: ${u ? `${u.policy}, доля ${pct(u.botShare, 0)}, обычн. ${pct(u.ordRet)}` : '-'}`)
      }
    }
  }
  say()
  say('Порог: наименьшая φ из сетки, начиная с которой ни при каком спросе лучшая политика со сжиганием не обгоняет лучшую без сжигания больше чем на 2 ошибки (обе выбраны по первой неделе).')
  const thresholds = []
  for (const cap of SEL_CAPS.map(capName)) for (const T of [300, 900]) for (const fate of FATES) for (const R of RS) {
    const pays = (phi) => selective.some((x) => x.cap === cap && x.T === T && x.fate === fate && x.R === R && x.phi === phi && x.burn && x.burn.deltaVsNoBurn > 0 && x.burn.deltaVsNoBurn > 2 * x.burn.deltaVsNoBurnSe)
    const phiStar = PHIS.find((phi) => PHIS.filter((q) => q >= phi).every((q) => !pays(q)))
    thresholds.push({ cap, T, fate, R, phiStar: phiStar ?? null, paysAt: PHIS.filter(pays) })
    say(`кап ${cap}, ${T} с, ${padE(FATE_LABEL[fate], 20)} R ${pad(R, 3)} с: ${phiStar === undefined ? 'выгодно даже при φ 100%' : `не выгодно начиная с φ ${Math.round(100 * phiStar)}%`}${PHIS.filter(pays).length ? ` (выгодно при φ ${PHIS.filter(pays).map((q) => Math.round(100 * q) + '%').join(', ')})` : ''}`)
  }
  say()
  stage4.selective = selective
  stage4.selectiveThresholds = thresholds
  console.error(`[section 11] ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)

  // ════════════════════════════════════════════════════════════════════════════
  say(`## 12. Как играют обычные игроки: тренд, пачки, конец окна (E2, S6, 80:20, 2% / 1%, банк от 0.01; commit-reveal R ${REC.R} с, φ ${Math.round(100 * REC.phi)}%, сгоревшее ${FATE_LABEL[REC.fate]})`)
  say('Бот знает модель поведения (её можно выучить на первой неделе по раскрытым сторонам): у ставок «за трендом» он выводит вероятную сторону из цены в момент обязательства.')
  say('Обычный игрок: без бота / банк виден, монополист (доля) / commit-reveal: монополист (доля), худшая при доле бота до 25%, выбранная по первой неделе политика из раздела 11 (доля).')
  say('Доход проекта: % банка после рефералов без бота / с монополистом commit-reveal / с монополистом при видимом банке; после газа на пул в сутки без бота. Ничьи без бота / с монополистом. Проверки: наибольшая невязка денег, нераспределённые сгоревшие ставки за неделю, наименьший итог активного раунда.')
  const behavior = []
  const BEH_DEMAND = QUICK ? [10] : DEMAND
  for (const key of Object.keys(SCN)) {
    say()
    say(`### ${SCN[key].label}`)
    for (const T of [300, 900]) for (const perHour of BEH_DEMAND) {
      const lam = perHour / 3600, level = 1000 + perHour
      let vis = null
      if (!SCN[key].nu) {
        const bot = botFor(T, 'E2', { kind: 'last' })
        const bc = { T, rule: 'E2', cap: 4, mode: { kind: 'last' }, hidden: false, kap: 1, strategy: 'S6', lambda: lam, flowFn: (rd) => makeFlow(rd, T, lam, level, SCN[key]), bothSides: true }
        vis = { none: simulate(bc, roundsR[T], bot, null), opt: simulate(bc, roundsR[T], bot, { opt: true }) }
      }
      const cv = crCurve(T, REC.R, RU0, flowsFor(T, lam, level, key), POL_SPECS)
      const sel = selectiveOf(cv.extraA, T)
      const w = worstUpTo25(cv)
      const all = [cv.none, ...cv.optQ, ...cv.forced, ...cv.two[0.25], ...cv.two[1]]
      const rec = { scenario: key, T, betsPerHour: perHour, visible: vis ? { none: strip(vis.none), opt: strip(vis.opt) } : null, cr: cvJson(cv), selective: sel,
        checks: { maxConservationError: Math.max(...all.map((s) => s.cons)), unallocatedEthWeek2: cv.none.unallocated, minContributionEth: Math.min(...all.map((s) => s.minContribution ?? Infinity)) } }
      behavior.push(rec)
      const ch = sel.chosen
      say(`${T} с, ${pad(perHour, 2)}/ч: обычн. ${pad(pct(cv.none.ordRet), 6)} / ${pad(vis ? `${pct(vis.opt.ordRet)} (${pct(vis.opt.botShare, 0)})` : '-', 13)} / ${pad(`${pct(cv.opt.ordRet)} ${se1(cv.opt.ordSe)} (${pct(cv.opt.botShare, 0)})`, 20)}, при 25% ${pad(`${pct(w.ordRet)} ${se1(w.ordSe)}`, 13)}, ${ch ? `${ch.policy} ${pct(ch.ordRet)} (${pct(ch.botShare, 0)})` : '-'}; ` +
        `доход ${pct(cv.none.retainedPct, 3)} / ${pct(cv.opt.retainedPct, 3)}${vis ? ` / ${pct(vis.opt.feePct * (1 - REF_SHARE), 3)}` : ''} банка, ${mEth(cv.none.revDay, 3)} ± ${mEth(cv.none.revDaySe, 3)} мETH/сут; ничьи ${pct(cv.none.tieShare)} / ${pct(cv.opt.tieShare)}; невязка ${rec.checks.maxConservationError.toExponential(1)}, нераспределено ${rec.checks.unallocatedEthWeek2.toFixed(3)} ETH, мин. итог ${mEth(rec.checks.minContributionEth, 4)} мETH` +
        (SCN[key].nu ? `; на поставленную (не принятую) ставку без бота ${pct(cv.none.ordRetPerCommitted)}, с монополистом ${pct(cv.opt.ordRetPerCommitted)}; нераспределено ${mEth((cv.none.unallocated / cv.none.rounds) * (86400 / T), 2)} мETH на пул в сутки` : ''))
    }
    if (key !== 'uniform') dropFlows(key)
  }
  say()
  stage4.behavior = behavior
  console.error(`[section 12] ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)

  if (!NO_SEARCH) {
    // ════════════════════════════════════════════════════════════════════════════
    const GRID = QUICK
      ? { T: [300, 900], cap: [1, 4], bmin: [0.01, 0.03], f: [0.02, 0.03], ft: [0.01], R: [120] }
      : { T: [300, 900], cap: [1, 1.5, 4, 9], bmin: [0.01, 0.02, 0.03], f: [0.02, 0.03, 0.04], ft: [0, 0.01], R: RS }
    const SD = QUICK ? [5, 10] : [2, 5, 10]
    say('## 13. Поиск параметров: доход проекта на пул в сутки против потери обычного игрока при доле бота до 25%')
    say(`Сетка: длительность ${GRID.T.join(' / ')} с, кап ${GRID.cap.map(capName).join(' / ')}, минимальный банк ${GRID.bmin.join(' / ')} ETH, комиссия ${GRID.f.map((x) => pct(x, 0)).join(' / ')}, комиссия ничьей ${GRID.ft.map((x) => pct(x, 0)).join(' / ')}, окно раскрытия ${GRID.R.join(' / ')} с; спрос ${SD.join(' / ')} ставок в час. Кап 50:50 добавлен сверх заданной сетки.`)
    say(`Механика: commit-reveal, сгоревшее ${FATE_LABEL[REC.fate]}; боты - семейства раздела 10, S6 выучен на первой неделе, оценка на второй. Доход - комиссия после рефералов минус весь газовый бюджет ${(COST * 1e6).toFixed(3)} мкETH на активный раунд, без бота, по $${ETH_USD} за ETH, без постоянных расходов.`)
    const cells = []
    for (const T of GRID.T) for (const R of GRID.R) for (const cap of GRID.cap) for (const bmin of GRID.bmin) for (const f of GRID.f) for (const ft of GRID.ft) for (const perHour of SD) {
      const ru = { c: cap, f, ft, bmin, phi: REC.phi, fate: REC.fate }
      const cv = crCurve(T, R, ru, flowsFor(T, perHour / 3600, 1000 + perHour, 'uniform'))
      const w = worstUpTo25(cv), two1 = cv.two[1][2]
      cells.push({ T, R, cap: capName(cap), capRatio: cap, bmin, fee: f, tieFee: ft, betsPerHour: perHour,
        revDay: cv.none.revDay, revDaySe: cv.none.revDaySe, revDayWithBot: cv.opt.revDay, activeRoundsPerDay: cv.none.activeRoundsPerDay,
        meanBank: cv.none.meanBank, tieShare: cv.none.tieShare, lossNone: -cv.none.ordRet, loss25: -w.ordRet, loss25Se: w.ordSe, loss25Src: w.src,
        loss25H1: -w.H1, loss25H2: -w.H2, optShare: cv.opt.botShare, optLoss: -cv.opt.ordRet, optLossSe: cv.opt.ordSe,
        twoSidedShare: two1.botShare, twoSidedLoss: -two1.ordRet, minContribution: cv.none.minContribution })
    }
    console.error(`[section 13 grid] ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)
    const keyOf = (c) => `${c.T}|${c.R}|${c.cap}|${c.bmin}|${c.fee}|${c.tieFee}`
    const label = (c) => `${c.T} с, R ${c.R}, кап ${c.cap}, банк от ${c.bmin}, комиссия ${pct(c.fee, 0)} / ничья ${pct(c.tieFee, 0)}`
    const HEADS = `${padE('набор', 58)} ${pad('потеря при 25%', 15)} ${pad('без бота', 8)} ${pad('монополист (доля)', 18)} ${pad('доход/сут ± ош.', 17)} ${pad('$/30 сут', 9)} ${pad('раундов', 7)} ${pad('банк', 6)}`
    const cellLine = (c) => say(`${padE(label(c), 58)} ${pad(pct(c.loss25) + ' ' + se1(c.loss25Se), 15)} ${pad(pct(c.lossNone), 8)} ${pad(pct(c.optLoss) + ' (' + pct(c.optShare, 0) + ')', 18)} ${pad(usd(c.revDay) + ' ± ' + usd(c.revDaySe).slice(1), 17)} ${pad(usd(30 * c.revDay, 0), 9)} ${pad(c.activeRoundsPerDay.toFixed(1), 7)} ${pad(c.meanBank.toFixed(3), 6)}`)
    const frontier = {}
    for (const perHour of SD) {
      const cs = cells.filter((c) => c.betsPerHour === perHour).sort((a, b) => a.loss25 - b.loss25 || b.revDay - a.revDay)
      const fr = []
      let top = -Infinity
      for (const c of cs) if (c.revDay > top) { fr.push(c); top = c.revDay }
      frontier[perHour] = fr
      say()
      say(`### ${perHour} ставок в час на пул: граница «потеря - доход» (каждый следующий набор даёт больше дохода ценой большей потери); потеря не больше 5% у ${cs.filter((c) => c.loss25 <= 0.05).length} из ${cs.length} наборов, не больше 5% и доход больше нуля у ${cs.filter((c) => c.loss25 <= 0.05 && c.revDay > 0).length}`)
      say(HEADS)
      for (const c of fr) cellLine(c)
    }
    // one set for every demand: the loss at most 5% at each of them and the project in plus at each of them
    const byKey = new Map()
    for (const c of cells) { if (!byKey.has(keyOf(c))) byKey.set(keyOf(c), []); byKey.get(keyOf(c)).push(c) }
    const sets = [...byKey.values()].map((cs) => ({ cs, maxLoss: Math.max(...cs.map((c) => c.loss25)), minRev: Math.min(...cs.map((c) => c.revDay)), sumRev: cs.reduce((s, c) => s + c.revDay, 0) }))
    const robust = sets.filter((s) => s.maxLoss <= 0.05 && s.minRev > 0).sort((a, b) => b.sumRev - a.sumRev)
    const showSet = (s) => say(`${padE(label(s.cs[0]), 58)} ` + s.cs.map((c) => `${c.betsPerHour}/ч: потеря ${pct(c.loss25)} ${se1(c.loss25Se)} (половины недели ${pct(c.loss25H1)} / ${pct(c.loss25H2)}), монополист ${pct(c.optLoss)} (${pct(c.optShare, 0)}), доход ${usd(c.revDay)} ± ${usd(c.revDaySe).slice(1)}/сут`).join('; '))
    say()
    say(`### Один набор на весь спрос ${SD.join(' / ')}: потеря при доле бота до 25% не больше 5% при каждом и доход после газа больше нуля при каждом - ${robust.length} наборов из ${sets.length}`)
    for (const s of robust.slice(0, 12)) showSet(s)
    const closest = [...sets].sort((a, b) => a.maxLoss - b.maxLoss || b.sumRev - a.sumRev)[0]
    say(`наименьшая наибольшая по спросу потеря: ${pct(closest.maxLoss)}`)
    showSet(closest)
    const byCap = GRID.cap.map((cap) => { const s = sets.filter((x) => x.cs[0].capRatio === cap).sort((a, b) => a.maxLoss - b.maxLoss)[0]; return { cap: capName(cap), maxLoss: s.maxLoss, set: label(s.cs[0]) } })
    say(`лучшая наибольшая потеря по капу: ${byCap.map((x) => `${x.cap} ${pct(x.maxLoss)}`).join(', ')}`)
    say()
    const byDemand = (s) => s.cs.map((c) => ({ betsPerHour: c.betsPerHour, loss25: c.loss25, loss25Se: c.loss25Se, loss25H1: c.loss25H1, loss25H2: c.loss25H2, optLoss: c.optLoss, optShare: c.optShare, revDay: c.revDay, revDaySe: c.revDaySe }))
    stage4.searchGrid = { ...GRID, betsPerHour: SD }
    stage4.searchCellColumns = Object.keys(cells[0]) // searchCells: one row per cell, values in this order
    stage4.searchCells = cells.map((c) => stage4.searchCellColumns.map((k) => c[k]))
    stage4.searchFrontier = SD.map((h) => ({ betsPerHour: h, sets: frontier[h].map((c) => ({ set: label(c), loss25: c.loss25, loss25Se: c.loss25Se, revDay: c.revDay, revDaySe: c.revDaySe })) }))
    stage4.searchRobust = robust.map((s) => ({ set: label(s.cs[0]), maxLoss: s.maxLoss, minRevDay: s.minRev, byDemand: byDemand(s) }))
    stage4.searchClosest = { set: label(closest.cs[0]), maxLoss: closest.maxLoss, byDemand: byDemand(closest) }
    stage4.searchBestByCap = byCap

    // ════════════════════════════════════════════════════════════════════════════
    // section 14: the candidates against the selective bot and the player scenarios
    const cand = robust.length ? robust.slice(0, 3) : [closest]
    say('## 14. Проверка кандидатов: выборочное нераскрытие и поведение игроков')
    say(robust.length ? 'Кандидаты - первые три набора из списка раздела 13.' : 'Наборов, проходящих раздел 13, нет; проверяется ближайший (наименьшая наибольшая потеря).')
    const checks = []
    for (const s of cand) {
      const c0 = s.cs[0]
      say()
      say(`### ${label(c0)}`)
      for (const perHour of SD) {
        const lam = perHour / 3600, level = 1000 + perHour
        for (const fate of FATES) {
          const ru = { c: c0.capRatio, f: c0.fee, ft: c0.tieFee, bmin: c0.bmin, phi: 1, fate }
          const sel = selectiveOf(passCR(c0.T, c0.R, ru, flowsFor(c0.T, lam, level, 'uniform'), POL_SPECS), c0.T)
          checks.push({ set: label(c0), betsPerHour: perHour, kind: 'selective', fate, phi: 1, ...sel })
          const ch = sel.chosen, u = sel.upTo25, bb = sel.burn
          say(`${perHour}/ч, сгоревшее ${FATE_LABEL[fate]}, φ 100%: выбрана ${ch ? `${ch.policy}, обычн. ${pct(ch.ordRet)} ${se1(ch.ordSe)}, доля бота ${pct(ch.botShare, 0)}` : 'не участвует'}; с долей до 25%: ${u ? `${u.policy}, обычн. ${pct(u.ordRet)} ${se1(u.ordSe)}, доля ${pct(u.botShare, 0)}` : 'нет'}${bb ? `; со сжиганием ${bb.policy}: Δ к лучшей без ${mEth(bb.deltaVsNoBurn)} ± ${mEth(bb.deltaVsNoBurnSe)} мETH/сут` : ''}`)
        }
        for (const key of ['trendHalf', 'trendAll', 'late', 'bunchLate', 'trendBunchLate', 'noReveal']) {
          const ru = { c: c0.capRatio, f: c0.fee, ft: c0.tieFee, bmin: c0.bmin, phi: REC.phi, fate: REC.fate }
          const cv = crCurve(c0.T, c0.R, ru, flowsFor(c0.T, lam, level, key))
          const w = worstUpTo25(cv)
          checks.push({ set: label(c0), betsPerHour: perHour, kind: 'behavior', scenario: key, ...cvJson(cv) })
          if (SCN[key].nu) say(`${perHour}/ч, ${SCN[key].label}: на поставленную ставку (сгоревшие включены) без бота ${pct(cv.none.ordRetPerCommitted)}, с монополистом ${pct(cv.opt.ordRetPerCommitted)} (${pct(cv.opt.botShare, 0)}); нераспределённые сгоревшие ставки ${mEth((cv.none.unallocated / cv.none.rounds) * (86400 / c0.T), 2)} мETH на пул в сутки; доход ${usd(cv.none.revDay)} ± ${usd(cv.none.revDaySe).slice(1)}/сут`)
          else say(`${perHour}/ч, ${SCN[key].label}: при 25% ${pct(w.ordRet)} ${se1(w.ordSe)} (${w.src}), монополист ${pct(cv.opt.ordRet)} (${pct(cv.opt.botShare, 0)}), без бота ${pct(cv.none.ordRet)}, доход ${usd(cv.none.revDay)} ± ${usd(cv.none.revDaySe).slice(1)}/сут (${pct(cv.none.retainedPct, 3)} банка; с монополистом ${pct(cv.opt.retainedPct, 3)})`)
          dropFlows(key)
        }
      }
    }
    say()
    stage4.candidates = checks
    console.error(`[section 14] ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Stage 5 (sections 15-17): the cap 1:1 (50:50). The visible book against commit-reveal, the strike window, 1800 s,
// and configurations chosen on the FIRST week and reported on the second.
// ════════════════════════════════════════════════════════════════════════════
const stage5 = {}
if (!ONLY_OLD) {
  const RU1 = { c: 1, f: FEE, ft: FEE_TIE, bmin: MIN_BANK, phi: 1, fate: 'win' }
  const I_OPT = 3, I_B25 = 6 // indexes in CURVE_SPECS: the monopolist in every round, bots at 25%
  // paired difference of the ordinary return between two results on the same rounds, with its error by pool x day
  function pairedOrd(a, b) {
    const keys = new Set([...a.cl.keys(), ...b.cl.keys()])
    let Na = 0, Da = 0, Nb = 0, Db = 0
    for (const k of keys) { const x = a.cl.get(k), y = b.cl.get(k); if (x) { Na += x[1]; Da += x[2] } if (y) { Nb += y[1]; Db += y[2] } }
    const ra = Na / Da, rb = Nb / Db
    let s2 = 0, C = 0
    for (const k of keys) {
      const x = a.cl.get(k), y = b.cl.get(k)
      const z = (x ? x[1] - ra * x[2] : 0) / Da - (y ? y[1] - rb * y[2] : 0) / Db
      s2 += z * z; C++
    }
    return { d: ra - rb, se: C > 1 ? Math.sqrt((s2 * C) / (C - 1)) : NaN }
  }
  const lossPm = (r, se) => `${pct(-r)} ${se1(se)}`
  const dLoss = (p) => `${p.d <= 0 ? '+' : '-'}${(100 * Math.abs(p.d)).toFixed(1)} ± ${(100 * p.se).toFixed(1)}` // loss of the first minus the second

  // ════════════════════════════════════════════════════════════════════════════
  say('## 15. Кап 1:1 (50:50): видимая книга против commit-reveal (E2, S6, комиссия 2% / 1%, банк от 0.01 ETH)')
  say('Кап 1:1: с каждой стороны принимается min(UP, DOWN), лишнее возвращается пропорционально, выплата всем 1.96x.')
  say('Видимая книга: без commit-reveal, бот ставит в последнюю секунду окна и видит стороны всех ставок; страйк E2 сразу после закрытия или через паузу 120 / 300 с (без шага раскрытия).')
  say('Commit-reveal: сторона скрыта до окна раскрытия R, страйк после него. Бот с прогнозом - S6, выученный на первой неделе для своего момента и страйка; без прогноза - одинаковые вероятности обеих сторон; двусторонний - по k видимых обязательств на каждую сторону.')
  say('Потеря обычного игрока на принятую ставку, «при 25%» - худшее из семейств при доле бота до 25% (раздел 10). Δ - потеря в режиме минус потеря при видимой книге без паузы, на тех же раундах, ошибка парная; минус - игроку лучше.')
  const REG = [
    { key: 'vis', label: 'видимая книга', R: 0, vis: true },
    { key: 'vis120', label: 'видимая книга, пауза 120 с до страйка', R: 120, vis: true },
    { key: 'vis300', label: 'видимая книга, пауза 300 с до страйка', R: 300, vis: true },
    { key: 'cr120', label: 'commit-reveal, R 120 с', R: 120, vis: false },
    { key: 'cr300', label: 'commit-reveal, R 300 с', R: 300, vis: false },
    { key: 'visT', label: 'видимая книга, очередь по времени', R: 0, vis: true, fill: 'time' },
    { key: 'vis300T', label: 'видимая, пауза 300 с, очередь по времени', R: 300, vis: true, fill: 'time' },
    { key: 'cr300T', label: 'commit-reveal R 300 с, очередь по времени', R: 300, vis: false, fill: 'time' },
  ]
  const HEAD5 = `${padE('режим', 40)} ${pad('без бота', 8)} ${pad('прогноз: монополист', 22)} ${pad('прогноз: при 25%', 17)} ${pad('без прогноза: монопол.', 22)} ${pad('без прогн.: при 25%', 19)} ${pad('двустор. k0.25 / k1', 24)} ${pad('Δ монопол.', 13)} ${pad('Δ боты 25%', 13)}`
  const capOneBook = []
  for (const T of [300, 900]) for (const perHour of DEMAND) {
    const lam = perHour / 3600, level = 1000 + perHour
    let base = null
    const rows = []
    for (const g of REG) {
      const fl = g.vis ? flowsVisible(T, lam, level, 'uniform') : flowsFor(T, lam, level, 'uniform')
      const ru = { ...RU1, fill: g.fill ?? 'prorata' }
      const cvF = crCurve(T, g.R, ru, fl), cvB = crCurve(T, g.R, ru, fl, [], true)
      if (!base) base = cvF
      rows.push({ g, cvF, cvB })
    }
    const s0 = base.none
    say()
    say(`${T} с, ${perHour} ставок в час на пул: без бота активных раундов ${s0.activeRoundsPerDay.toFixed(1)} в сутки, принятый банк активного ${s0.meanBank.toFixed(4)} ETH, доход проекта после газа ${usd(s0.revDay)} ± ${usd(s0.revDaySe).slice(1)} на пул в сутки`)
    say(HEAD5)
    for (const { g, cvF, cvB } of rows) {
      const wF = worstUpTo25(cvF), wB = worstUpTo25(cvB)
      const dM = g.key === 'vis' ? null : pairedOrd(cvF.acc[I_OPT], base.acc[I_OPT]), dB = g.key === 'vis' ? null : pairedOrd(cvF.acc[I_B25], base.acc[I_B25])
      const t1 = cvF.two[0.25][2], t2 = cvF.two[1][2]
      say(`${padE(g.label, 40)} ${pad(pct(-cvF.none.ordRet), 8)} ${pad(`${pct(cvF.opt.botShare, 0)} ${lossPm(cvF.opt.ordRet, cvF.opt.ordSe)}`, 22)} ${pad(lossPm(wF.ordRet, wF.ordSe), 17)} ${pad(`${pct(cvB.opt.botShare, 0)} ${lossPm(cvB.opt.ordRet, cvB.opt.ordSe)}`, 22)} ${pad(lossPm(wB.ordRet, wB.ordSe), 19)} ${pad(`${pct(t1.botShare, 0)} ${pct(-t1.ordRet)} / ${pct(t2.botShare, 0)} ${pct(-t2.ordRet)}`, 24)} ${pad(dM ? dLoss(dM) : '-', 13)} ${pad(dB ? dLoss(dB) : '-', 13)}`)
      capOneBook.push({ T, betsPerHour: perHour, regime: g.key, label: g.label, R: g.R, visible: g.vis, fill: g.fill ?? 'prorata',
        none: strip(cvF.none), forecast: { opt: strip(cvF.opt), bots25: strip(cvF.forced[2]), worst25: wF }, blind: { opt: strip(cvB.opt), worst25: wB },
        twoSided: { k025: strip(t1), k1: strip(t2) },
        deltaVsVisible: dM ? { monopolistLoss: -dM.d, monopolistLossSe: dM.se, bots25Loss: -dB.d, bots25LossSe: dB.se } : null })
    }
  }
  say()
  stage5.capOneBook = capOneBook
  console.error(`[section 15] ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)

  // ════════════════════════════════════════════════════════════════════════════
  say('## 16. Кап 1:1, видимая книга: окно страйка и длительность (E2 с окном W после закрытия, комиссия 2% / 1%, банк от 0.01)')
  say('Страйк - средний тик за W секунд после закрытия, расчёт через W + T после закрытия; бот S6 выучен на первой неделе заново для каждой пары (T, W). Доход - без бота, после газа.')
  say(`${padE('T, W, спрос', 22)} ${pad('без бота', 8)} ${pad('ничьи', 6)} ${pad('раундов', 7)} ${pad('банк', 6)} ${pad('доход/сут', 16)} ${pad('монополист (доля)', 20)} ${pad('при 25%', 13)} ${pad('половины недели при 25%', 26)}`)
  const strikeWindow = []
  for (const fill of ['prorata', 'time']) {
    say(fill === 'prorata' ? '### Излишек стороны возвращается пропорционально (правило POSITIVE-EV.md)' : '### Очередь по времени внутри стороны: бот исполняется последним')
    for (const T of [300, 900, 1800]) for (const W of [60, 180, 300]) {
      for (const perHour of DEMAND) {
        const lam = perHour / 3600, level = 1000 + perHour
        const cv = crCurve(T, 0, { ...RU1, fill }, flowsVisible(T, lam, level, 'uniform'), [], false, { W })
        const w = worstUpTo25(cv)
        say(`${padE(`${T} с, W ${W} с, ${perHour}/ч`, 22)} ${pad(pct(-cv.none.ordRet), 8)} ${pad(pct(cv.none.tieShare, 0), 6)} ${pad(cv.none.activeRoundsPerDay.toFixed(1), 7)} ${pad(cv.none.meanBank.toFixed(3), 6)} ${pad(`${usd(cv.none.revDay)} ± ${usd(cv.none.revDaySe).slice(1)}`, 16)} ${pad(`${lossPm(cv.opt.ordRet, cv.opt.ordSe)} (${pct(cv.opt.botShare, 0)})`, 20)} ${pad(lossPm(w.ordRet, w.ordSe), 13)} ${pad(`${lossPm(w.H1, w.H1se)} / ${lossPm(w.H2, w.H2se)}`, 26)}`)
        strikeWindow.push({ fill, T, W, betsPerHour: perHour, none: strip(cv.none), opt: strip(cv.opt), worst25: w })
      }
    }
  }
  say()
  stage5.strikeWindow = strikeWindow
  console.error(`[section 16] ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)

  if (!NO_SEARCH) {
    // ════════════════════════════════════════════════════════════════════════════
    const MODES = { vis: { label: 'видимая', R: 0, vis: true }, visGap: { label: 'видимая, пауза 300 с', R: 300, vis: true }, cr: { label: 'commit-reveal R 300', R: 300, vis: false },
      visT: { label: 'видимая, очередь', R: 0, vis: true, fill: 'time' }, visGapT: { label: 'видимая, пауза 300 с, очередь', R: 300, vis: true, fill: 'time' } }
    const G5 = QUICK ? { mode: ['vis', 'cr', 'visT'], T: [900], W: [60, 300], f: [0.02], bmin: [0.01] }
      : { mode: ['vis', 'visGap', 'cr', 'visT', 'visGapT'], T: [300, 900, 1800], W: [60, 180, 300], f: [0.02, 0.03], bmin: [0.01, 0.02] }
    const SD5 = QUICK ? [5, 10] : [2, 5, 10]
    say('## 17. Кап 1:1: выбор конфигурации на первой неделе, отчёт на второй')
    say(`Сетка: режим ${G5.mode.map((m) => MODES[m].label).join(' / ')}; длительность ${G5.T.join(' / ')} с; окно страйка ${G5.W.join(' / ')} с; комиссия ${G5.f.map((x) => pct(x, 0)).join(' / ')}, ничья 1%; минимальный банк ${G5.bmin.join(' / ')} ETH; спрос ${SD5.join(' / ')} ставок в час.`)
    say('Выбор - только по первой неделе (на ней бот обучен, поэтому там он сильнее): (1) три набора с наименьшей наибольшей по спросу потерей при доле бота до 25%; (2) набор с наибольшим доходом среди тех, у кого эта потеря на первой неделе не больше 5%. Числа ниже - вторая неделя.')
    const cells5 = []
    for (const mode of G5.mode) for (const T of G5.T) for (const W of G5.W) for (const f of G5.f) for (const bmin of G5.bmin) for (const perHour of SD5) {
      const M = MODES[mode], lam = perHour / 3600, level = 1000 + perHour
      const fl = M.vis ? flowsVisible(T, lam, level, 'uniform') : flowsFor(T, lam, level, 'uniform')
      const cv = crCurve(T, M.R, { ...RU1, f, bmin, fill: M.fill ?? 'prorata' }, fl, [], false, { W, bothWeeks: true })
      const w1 = worstUpTo25(cv.week1), w2 = worstUpTo25(cv)
      cells5.push({ mode, T, W, fee: f, bmin, betsPerHour: perHour, loss1: -w1.ordRet, loss1Se: w1.ordSe, loss2: -w2.ordRet, loss2Se: w2.ordSe,
        loss2H1: -w2.H1, loss2H1Se: w2.H1se, loss2H2: -w2.H2, loss2H2Se: w2.H2se, loss2Src: w2.src,
        mono1: -cv.week1.opt.ordRet, mono2: -cv.opt.ordRet, mono2Se: cv.opt.ordSe, mono2Share: cv.opt.botShare,
        rev1: cv.week1.none.revDay, rev2: cv.none.revDay, rev2Se: cv.none.revDaySe, activeRoundsPerDay: cv.none.activeRoundsPerDay, meanBank: cv.none.meanBank, tieShare: cv.none.tieShare })
    }
    console.error(`[section 17 grid] ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)
    const key5 = (c) => `${c.mode}|${c.T}|${c.W}|${c.fee}|${c.bmin}`
    const label5 = (c) => `${MODES[c.mode].label}, ${c.T} с, W ${c.W} с, комиссия ${pct(c.fee, 0)}, банк от ${c.bmin}`
    const groups = new Map()
    for (const c of cells5) { if (!groups.has(key5(c))) groups.set(key5(c), []); groups.get(key5(c)).push(c) }
    const sets5 = [...groups.values()].map((cs) => ({ cs, max1: Math.max(...cs.map((c) => c.loss1)), max2: Math.max(...cs.map((c) => c.loss2)), rev1: cs.reduce((s, c) => s + c.rev1, 0) }))
    const byLoss = [...sets5].sort((a, b) => a.max1 - b.max1 || b.rev1 - a.rev1)
    const chosen = byLoss.slice(0, 3).map((s) => ({ s, rule: 'наименьшая потеря на первой неделе' }))
    const ok1 = sets5.filter((s) => s.max1 <= 0.05).sort((a, b) => b.rev1 - a.rev1)
    if (ok1.length && !chosen.some((x) => x.s === ok1[0])) chosen.push({ s: ok1[0], rule: 'наибольший доход при потере на первой неделе до 5%' })
    say(`Наборов: ${sets5.length}; наибольшая по спросу потеря не больше 5% на первой неделе у ${ok1.length}, на второй у ${sets5.filter((s) => s.max2 <= 0.05).length}, на обеих у ${sets5.filter((s) => s.max1 <= 0.05 && s.max2 <= 0.05).length}.`)
    const w2best = [...sets5].sort((a, b) => a.max2 - b.max2)[0]
    say(`Для сравнения, лучший по второй неделе (для выбора не использовался): ${label5(w2best.cs[0])}, ${pct(w2best.max2)} на второй, ${pct(w2best.max1)} на первой.`)
    const selected = []
    for (const { s, rule } of chosen) {
      say()
      say(`### ${label5(s.cs[0])} (${rule}): наибольшая потеря ${pct(s.max1)} на первой неделе, ${pct(s.max2)} на второй`)
      for (const c of s.cs) {
        const margin = (0.05 - c.loss2) / c.loss2Se
        say(`${c.betsPerHour}/ч: при 25% ${pct(c.loss2)} ${se1(c.loss2Se)} (${c.loss2Src}), запас до 5% ${Number.isFinite(margin) ? margin.toFixed(1) : '-'} ошибки; половины недели ${pct(c.loss2H1)} ${se1(c.loss2H1Se)} / ${pct(c.loss2H2)} ${se1(c.loss2H2Se)}; первая неделя ${pct(c.loss1)} ${se1(c.loss1Se)}; монополист ${pct(c.mono2)} ${se1(c.mono2Se)} (${pct(c.mono2Share, 0)}); ` +
          `доход ${mEth(c.rev2, 2)} ± ${mEth(c.rev2Se, 2)} мETH = ${usd(c.rev2)} ± ${usd(c.rev2Se).slice(1)} на пул в сутки, ${usd(30 * c.rev2, 0)} за 30 суток; активных раундов ${c.activeRoundsPerDay.toFixed(1)} в сутки, принятый банк ${c.meanBank.toFixed(4)} ETH`)
      }
      selected.push({ set: label5(s.cs[0]), rule, max1: s.max1, max2: s.max2, cells: s.cs })
    }
    say()
    stage5.capOneSearchGrid = { ...G5, betsPerHour: SD5, tieFee: FEE_TIE }
    stage5.capOneSearchColumns = Object.keys(cells5[0])
    stage5.capOneSearchCells = cells5.map((c) => stage5.capOneSearchColumns.map((k) => c[k]))
    stage5.capOneSelected = selected
    console.error(`[section 17] ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)
  }
}
console.error(`[done] ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)
if (argv.includes('--json')) {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const f = arg('json', 'docs/rhc/measurements/pool-toxicity/summary.json')
  mkdirSync(join(f, '..'), { recursive: true })
  // schema stays 1 and the first-pass fields are written exactly as before (scripts/rhc/positive-ev.mts reads
  // them); the second pass is in added fields, one record per line, numbers to 6 significant digits
  const oldTxt = JSON.stringify({ schema: 1, head: HEAD, days: DAYS,
    source: 'Historical price series; synthetic ordinary flow; no commit-reveal phase.',
    results, lambdas, demandScenarios }, null, 2)
  const extra = {
    stage4Source: 'Sections 10-14: historical price series; synthetic ordinary flow set in bets per hour per pool; commit-reveal modeled (sizes visible, sides hidden, reveal window R, burned share phi, fate of burned stakes); player scenarios; parameter search. Bot S6 trained on the first week, scored on the second; errors by pool x day blocks. Returns are per unit of accepted stake, ETH per pool per day after the gas budget.',
    stage4Constants: { ethUsd: ETH_USD, gasGwei: GAS_GWEI, costEthPerActivatedRound: COST, referralShareOfFee: REF_SHARE, minStake: MIN_STAKE,
      stakeMix: MIX, revealWindowsSec: RS, burnedShares: PHIS, fates: FATES, recommendedReveal: REC, botSharesUpTo25: SHARES, halfDay: new Date(HALF_DAY * 86400000).toISOString().slice(0, 10),
      trendLookbackSec: TREND_LOOK, lateWindowShare: LATE_FRAC, scenarios: SCN, policies: POLS.map((p) => p.id) },
    ...stage4,
    stage5Source: 'Sections 15-17: cap 1:1 (accepted min(UP, DOWN) per side, 1.96x for everyone). Visible book (bot sees every side at the last second; strike right after the close or after a pause R) against commit-reveal R; strike window W after the close; 1800 s rounds; a grid where configurations are chosen on the first week and reported on the second. Worst25 carries H1/H2 (halves of the scoring week) with their errors.',
    ...stage5,
  }
  const r6 = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? Number(v.toPrecision(6)) : null)
    : Array.isArray(v) ? v.map(r6) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, r6(x)])) : v)
  const field = ([k, v]) => (Array.isArray(v) ? `  ${JSON.stringify(k)}: [\n${v.map((x) => '    ' + JSON.stringify(r6(x))).join(',\n')}\n  ]` : `  ${JSON.stringify(k)}: ${JSON.stringify(r6(v))}`)
  writeFileSync(f, oldTxt.slice(0, -2) + ',\n' + Object.entries(extra).map(field).join(',\n') + '\n}\n')
}
