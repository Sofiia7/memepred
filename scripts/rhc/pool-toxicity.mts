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
// Usage, from the repository root:
//   node scripts/rhc/pool-toxicity.mts                  all tables of the document (a few minutes)
//   node scripts/rhc/pool-toxicity.mts --quick          fewer bot sizes, for a smoke run
// Options: --cache DIR (default <os tmp>/flipthememe-sharp-edge), --head BLOCK, --days N
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
  if (rule === 'E2') {
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
    gS1: share(g.s1), gS3: share(g.s3),
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
  const { T, rule, cap, mode, hidden, kap, strategy, lambda, bank } = cfg
  const acc = { rounds: 0, active: 0, ties: 0, bank: 0, fee: 0, rev: 0, ordAcc: 0, ordNet: 0, ordRaw: 0, botAcc: 0, botNet: 0, botRounds: 0, cons: 0, mMajor: [] }
  const clNet = new Map(), clAcc = new Map() // clusters pool x day, for the error of the ordinary return
  const level = LEVELS[bank]
  const expSide = (lambda * T * MIX_MEAN) / 2
  for (const rd of rounds) {
    if (rd.train) continue
    const P = pools[rd.pi]
    const tm = timing(rd, T, mode)
    const oc = outcome(P, tm.close, T, rule)
    if (oc === 3) continue
    acc.rounds++
    const fl = ordinaryFlow(rd.pi, rd.k, T, lambda, level)
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
    if (spec && strategy) {
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
    // split each side between ordinary players and the bot, pro rata to raw stake
    const ordU = U > 0 ? uO / U : 0, ordD = D > 0 ? dO / D : 0
    acc.ordAcc += aU * ordU + aD * ordD
    const on = recU * ordU + recD * ordD - (uO + dO), oa = aU * ordU + aD * ordD
    acc.ordNet += on
    const ck = rd.pi * 1000 + Math.floor((T0 + rd.s) / 86400)
    clNet.set(ck, (clNet.get(ck) ?? 0) + on); clAcc.set(ck, (clAcc.get(ck) ?? 0) + oa)
    if (bSide !== 0) {
      const own = bSide > 0 ? U : D, rec = bSide > 0 ? recU : recD, aOwn = bSide > 0 ? aU : aD
      acc.botAcc += (aOwn * X) / own
      acc.botNet += (rec * X) / own - X
      acc.botRounds++
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
  }
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
for (const perHour of [2, 5, 10, 30, 100, 300]) {
  const cells = [60, 300, 900, 1800, 3600, 7200].map((T) => {
    const f = flowOnly(T, perHour / 3600, 5, 4000, 4)
    return pad(`${f.meanActive.toFixed(3)} x ${(86400 / T * f.active).toFixed(0)}`, 18)
  })
  say(`${padE(perHour, 20)} ${cells.join(' ')}`)
}
say('ячейка: средний принятый банк активного раунда (ETH) x активных раундов в сутки на пул')
say()
console.error(`[done] ${((Date.now() - t0Run) / 1000).toFixed(0)} s`)
if (argv.includes('--json')) {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const f = arg('json', 'docs/rhc/measurements/pool-toxicity/summary.json')
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify({ results: results.map((r) => ({ ...r, pts: r.pts.map(({ phi, botShare, ordRet, botRet, activeShare, meanBank, revPerRound, m10, m50, m90 }) => ({ phi, botShare, ordRet, botRet, activeShare, meanBank, revPerRound, m10, m50, m90 })) })), lambdas }))
}
