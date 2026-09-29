/**
 * FlipTheMeme on Robinhood Chain: the economics model behind docs/rhc/ECONOMICS.md.
 *
 *   node scripts/rhc/economics.mts          frozen inputs of 2026-09-29, reproduces every table of the document
 *   node scripts/rhc/economics.mts --live   the same tables with gas, L1 price, ETH price, balances, pool sizes read now
 *
 * Node 22.6+ strips the types itself (checked on 24.11.1); scripts\node_modules\.bin\tsx gives the same output
 * (checked). `npx tsx` from the repo root was not checked: the root has no tsx installed.
 *
 * Read-only. No keys, no .env, no transactions. --live makes JSON-RPC reads (eth_gasPrice, eth_call,
 * eth_getBalance, eth_estimateGas) against the public endpoints and one GET to RedStone's public gateway.
 *
 * Every input carries its source: a contract file and line, a transaction hash from docs/rhc/DEPLOYMENTS.md,
 * a measurement document, or "замер 2026-09-29" for what was read for this model. "оценка" marks numbers not
 * measured on chain. The forge estimates and the raw logs behind them are in docs/rhc/measurements/economics/.
 * Plain erasable TypeScript on purpose (no enums, no namespaces), so `node` 24 runs it too.
 */

// ── units ───────────────────────────────────────────────────────────────────
const E18 = 10n ** 18n

/** '0.013' -> 13000000000000000n. Parsed as a decimal string so no float ever touches a wei amount. */
function eth(s: string): bigint {
  const [w, f = ''] = s.split('.')
  return BigInt(w || '0') * E18 + BigInt((f + '0'.repeat(18)).slice(0, 18) || '0')
}
/** gwei (a float from a table) -> wei. Rounded to the wei; inputs have at most 9 decimals. */
const weiPerGas = (gwei: number): bigint => BigInt(Math.round(gwei * 1e9))
const toEth = (wei: bigint): number => Number(wei) / 1e18
/** Millionths of an ETH, the unit of the per-match tables: 1 = 0.000001 ETH. */
const micro = (wei: bigint): string => (Number(wei) / 1e12).toFixed(1)
const signedMicro = (wei: bigint): string => (wei >= 0n ? '+' : '') + micro(wei)
const fmtEth = (wei: bigint, digits = 6): string => toEth(wei).toFixed(digits)
/** Thousands separated by a space, integer part only. */
const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const usdNum = (v: number): string => {
  if (Math.abs(v) < 0.005) return '$0'
  const a = Math.abs(v)
  const [ip, fp] = (a >= 100 ? a.toFixed(0) : a >= 1 ? a.toFixed(2) : a.toFixed(4)).split('.')
  return (v < 0 ? '-' : '') + '$' + group(ip) + (fp ? '.' + fp : '')
}
const usd = (wei: bigint, ethUsd: number): string => usdNum(toEth(wei) * ethUsd)
const int = (n: number): string => (n < 0 ? '-' : '') + group(Math.abs(Math.round(n)).toString())
const pct = (x: number, d = 2): string => (x * 100).toFixed(d) + '%'

// ── contract parameters (contracts/src) ─────────────────────────────────────
const P = {
  /** Protocol fee of every live market. PoolMarketFactory.sol:170 sets FEE_MAX at construction and
   *  every market snapshots it (PoolMarketFactory.sol:203); feeBps() = 100 on the 29.09 markets. */
  feeBps: 100n,
  /** Hard ceiling. PoolMarketFactory.sol:117, a constant: above 100 needs a new factory. */
  feeMax: 100n,
  /** Extra 1% of the bank taken from a user's win against the vault, paid to the vault. OrderbookMarket.sol:185, constant. */
  lpTakerFeeBps: 100n,
  /** Winner's registry referrer gets 10% of the fee, the rest goes to the treasury. RhcFeeDistributor.sol:20-21, 31-41. */
  refShareBps: 1000n,
  /** Part of the vault's STAKE moved into the LP fee stream on a vault win. LiquidityPool.sol:46, 471. */
  lpFeeStreamBps: 100n,
  /** PoolOrderbookMarket.sol:104. Also the smallest match: MIN_MATCH_AMOUNT = MIN_BET (OrderbookMarket.sol:127-129). */
  minBet: eth('0.005'),
  /** PoolOrderbookMarket.sol:111. */
  maxBet: eth('0.04'),
  /** Vault caps: per price source (all durations) 5% of assets (PoolLiquidityPool.sol:44), per market 5%,
   *  all markets 10% (LiquidityPool.sol:44-45). */
  feedCapBps: 500n,
  globalCapBps: 1000n,
}

// ── gas per operation ───────────────────────────────────────────────────────
/**
 * l2: execution gas, receipt gasUsed minus gasUsedForL1 (measured) or an estimate built on it.
 * l1: gasUsedForL1 of the testnet receipt (what the testnet charged for posting the data to L1).
 * bytes: size the L1 part is billed for on 4663: the signed settle transaction is 177 bytes, 181 after brotli
 *   (level 0 and 1; 166 at level 11), cancelOrder 144 / 148 (замер 2026-09-29, raw transaction re-serialized
 *   with viem and compressed with node zlib; the level ArbOS uses on this chain was not checked).
 * Mainnet cost = l2 * L2 price + bytes * perL1CalldataByte; testnet cost = (l2 + l1) * testnet price.
 *
 * Estimates: the measured L2 part of the same match type plus the difference forge measured between the two
 * outcomes with `forge test --isolate` (vm.lastCallGas().gasTotalUsed, which is already net of the gas refund:
 * RefundSemantics.t.sol). forge's PvP settlement, 278 061, is within 0.7% of the live L2 part 280 017; the vault
 * refund against the vault win is -63 858 in forge and -71 962 on chain, so the estimates carry ~10k of error.
 */
type GasItem = { l2: number; l1: number; bytes: number; how: 'измерено' | 'оценка'; src: string }
const SETTLE_BYTES = 181
const SHORT_BYTES = 148
const G: Record<string, GasItem> = {
  settlePvp: { l2: 280_017, l1: 13_021, bytes: SETTLE_BYTES, how: 'измерено', src: 'tx 0xe475de28..., gasUsed 293 038, gasUsedForL1 13 021' },
  settleVaultWin: { l2: 277_616, l1: 10_255, bytes: SETTLE_BYTES, how: 'измерено', src: 'tx 0x728a54f7..., gasUsed 287 871, gasUsedForL1 10 255' },
  settleVaultLoss: { l2: 293_213, l1: 10_255, bytes: SETTLE_BYTES, how: 'оценка', src: '277 616 + (310 296 - 294 699) forge' },
  tiePvp: { l2: 241_441, l1: 13_021, bytes: SETTLE_BYTES, how: 'оценка', src: '280 017 + (239 485 - 278 061) forge' },
  tieVault: { l2: 225_182, l1: 10_255, bytes: SETTLE_BYTES, how: 'оценка', src: '277 616 + (242 265 - 294 699) forge' },
  refundVault: { l2: 205_654, l1: 10_255, bytes: SETTLE_BYTES, how: 'измерено', src: 'tx 0x4ea099e2..., gasUsed 215 909, gasUsedForL1 10 255' },
  refundPvp: { l2: 277_291, l1: 13_021, bytes: SETTLE_BYTES, how: 'оценка', src: '280 017 + (275 335 - 278 061) forge; от возврата хранилища 250 148' },
  emergencyRefund: { l2: 135_490, l1: 8_385, bytes: SHORT_BYTES, how: 'измерено', src: 'gasUsed 143 875 (11.09, прежний код); L1-часть принята как у cancelOrder' },
  refundExpired: { l2: 103_551, l1: 8_385, bytes: SHORT_BYTES, how: 'оценка', src: 'cancelOrder 79 293 + (117 282 - 93 024) forge' },
  cancelOrder: { l2: 79_293, l1: 8_385, bytes: SHORT_BYTES, how: 'измерено', src: 'tx 0xceda4118..., gasUsed 87 678, gasUsedForL1 8 385' },
  cardinality300: { l2: 6_732_246, l1: 0, bytes: SHORT_BYTES, how: 'измерено', src: 'eth_estimateGas на живом пуле 4663, measurements/README.md:220' },
  createMarket: { l2: 418_519, l1: 0, bytes: SHORT_BYTES, how: 'измерено', src: 'measurements/README.md:139 (L1-часть не выделена)' },
}
/** Referral credit on top of a settlement, forge --isolate, all against a PvP win at 278 061. */
const REF_GAS = {
  firstEver: 66_004, // 344 065: the distributor has never credited anyone (two new slots, and its WETH balance no longer returns to zero)
  newReferrer: 31_804, // 309 865: a referrer's first credit once the distributor already holds referral WETH
  repeat: 14_704, // 292 765: the same referrer again; a settlement with no referrer in that state stays 278 061
}
/** Marginal match in one batch, forge --isolate: 5 PvP matches 965 507 against one at 278 061. */
const BATCH_MARGINAL = 171_862
/** Testnet-only operations, receipt gasUsed. */
const BADGE_MINT_GAS = 70_449 // explorer, minter 0xb183..., 29.09, 65 401-70 449
const PUSH_TICK_GAS = 62_308 // tx 0x7fa70d17...
const VAULT_BET_GAS_AT_6 = 705_031 // tx 0x29e65073..., placeBet matched by the vault, MOONCAT at 6 records
/** Stand-in pools: eth_estimateGas of observe([180,60,0]) and of spotPriceWad on two pools of the same code,
 *  замер 2026-09-29: MOONCAT 16 records 172 438 / 164 708, FROGGO 4 records 72 171 / 79 956. forge: 8 240 per record. */
const PER_RECORD_SETTLE = 8_356
const PER_RECORD_BET = 7_063
const G2 = (i: GasItem): number => i.l2 + i.l1 // testnet gasUsed

// ── gas prices ──────────────────────────────────────────────────────────────
type Level = { key: string; label: string; gwei: number; l1: number; src: string }
const P50 = 0.398
/** Frozen "now": chain 4663 on 2026-09-29 10:58 UTC, eth_gasPrice = perArbGasTotal 0.020142 gwei (the 0.020 base is the
 *  chain's floor) and perL1CalldataByte 0.163694592 gwei. Later readings: L1 4.4772472 at 11:18, 0 at 11:32 and in six
 *  readings 14:25-14:27 (L2 0.0204-0.0212). The 04-05.09 sample had perL1CalldataByte = 0 (measurements/README.md:366). */
const NOW_MAINNET_GWEI = 0.020142
const NOW_L1_GWEI = 0.163694592
const L1_READINGS: [string, number][] = [['10:58', 0.163694592], ['11:18', 4.4772472], ['11:32', 0], ['14:25-14:27', 0]]
const LEVELS: Level[] = [
  { key: 'now', label: 'сейчас, 4663', gwei: NOW_MAINNET_GWEI, l1: NOW_L1_GWEI, src: 'eth_gasPrice и perL1CalldataByte, замер 2026-09-29 10:58 UTC' },
  { key: 'd14p99', label: '15-29.09, p99', gwei: 0.069692, l1: NOW_L1_GWEI, src: 'baseFeePerGas блоков 4663 раз в час, 336 точек; L1 как сейчас (допущение)' },
  { key: 'p50', label: 'выборка 04-05.09, p50', gwei: P50, l1: 0, src: 'measurements/README.md:306' },
  { key: 'p90', label: 'выборка, p90', gwei: 0.453, l1: 0, src: 'measurements/README.md:307' },
  { key: 'p95', label: 'выборка, p95', gwei: 0.605, l1: 0, src: 'measurements/README.md:308' },
  { key: 'p99', label: 'выборка, p99', gwei: 1.039, l1: 0, src: 'measurements/README.md:309' },
  { key: 'x5', label: '5 x p50', gwei: P50 * 5, l1: 0, src: 'стресс' },
  { key: 'x10', label: '10 x p50', gwei: P50 * 10, l1: 0, src: 'стресс' },
  { key: 'x50', label: '50 x p50', gwei: P50 * 50, l1: 0, src: 'стресс' },
]
/** Weekly median of 4663 gas: baseFeePerGas of one block an hour, 03.09-29.09, 625 blocks (headers survive on the
 *  non-archive public RPC), замер 2026-09-29. Raw data: docs/rhc/measurements/economics/basefee-26d.json. */
const WEEKLY_MEDIAN_GWEI: [string, number][] = [['03-09.09', 0.3512], ['10-16.09', 0.0852], ['17-23.09', 0.0555], ['24-29.09', 0.0277]]

/** ETH/USD, RedStone public gateway (redstone-primary-prod, the one backend/src/lib/redstone.ts uses),
 *  package of 2026-09-29 11:00:10 UTC. The /prices API suggested for this returned an empty array. */
const ETH_USD = 2713.80

// ── testnet (chain 46630) ───────────────────────────────────────────────────
const TESTNET_GWEI = 0.01 // eth_gasPrice 29.09; every e2e receipt of 29.09 has effectiveGasPrice 0.01 gwei
/** Snapshots read with eth_getBalance and segments(): the current one at 14:25 UTC, the first one at 10:58 UTC. */
const SNAP_NOW = { at: '29.09 14:25 UTC', keeper: eth('0.01129536'), deployer: eth('0.0058344'), minter: eth('0.0102911'), records: { MOONCAT: 36, PEPE: 21, FROGGO: 25 } as Record<string, number> }
const SNAP_FIRST = { at: '29.09 10:58 UTC', keeper: eth('0.01141846'), records: 16 }
const WALLETS = [
  { key: 'keeper', addr: '0xbFa008e5A8d46d2014b83551ce6209108416eea4' },
  { key: 'deployer', addr: '0x12f9B9De75ccEa7be573F643A99AAA63b9448BD2' },
  { key: 'minter', addr: '0xb183b09f0D41314EA597598B741b41bcddd875e6' },
]
/** Testnet overrides of oracleWatchdog.ts:80-81 (code defaults 0.003 / 0.0005), DEPLOYMENTS.md 29.09. */
const KEEPER_WARN = eth('0.0006')
const KEEPER_CRIT = eth('0.0002')
/** Stand-in pools of the demo. PEPE's checksummed address is the one the mover logs use; DEPLOYMENTS.md's table has a mis-cased copy. */
const DEMO_POOLS = [
  { name: 'MOONCAT', addr: '0xfC5FB7d3B1DDFFc0b50b0CDDFFe3B016d4FF57cb' },
  { name: 'PEPE', addr: '0xEFd4618F36268CE8c1c8Ad3783bdCa6185221dBd' },
  { name: 'FROGGO', addr: '0x779E9B50837478FcCD7DB50592eDB16ed45D8A18' },
]
const VAULT = '0x3695D11A79D7625a7126588Ad94b5878139409E2'
const VAULT_ASSETS = eth('1.9607') // totalAssets(), read 29.09 ~11:05 UTC
/** Price steps: soak-traders.mts pushes once per pool per burst (SOAK_CYCLE_MIN 60) under SOAK_MAX_PUSHES 150 for the
 *  whole run (soak-traders.mts:32, 64-65, 390-392). price-mover.mts stopped 29.09 11:37:47 UTC (last deployer pushTick,
 *  explorer); while it ran it pushed each pool every ~53 s (11:30:37, 11:31:31, 11:32:23 on MOONCAT); 20 s is the runbook. */
const FROZEN_NOW = Date.parse('2026-09-29T14:25:00Z')
/** Buildathon submission closes 4 October 15:59, zone not shown on the page (audit-2026-09-28-followup.md §6). */
const DEMO_END = Date.parse('2026-10-04T16:00:00Z')

// ── mainnet scenario assumptions (NOT measurements; see the document) ───────
const MIX = {
  vaultShare: 0.5, // share of matches taken by the vault
  tieShare: 0.02, // ties: no fee, keeper still pays; unmeasured on real pools (LAUNCH-GATES.md, before mainnet, item 6)
  refundShare: 0.01, // resolver refunds: no fee
  refundExpiredPerMatch: 0.1, // keeper-paid refundExpired calls per match (orders whose tail found nobody in 5 minutes)
}
const STAKE_MIXES = [
  { key: 'min', label: 'все матчи по 0.005', parts: [['0.005', 1]] as [string, number][] },
  { key: 'mix', label: '40% по 0.005, 30% по 0.01, 20% по 0.02, 10% по 0.04', parts: [['0.005', 0.4], ['0.01', 0.3], ['0.02', 0.2], ['0.04', 0.1]] as [string, number][] },
  { key: 'big', label: 'половина по 0.02, половина по 0.04', parts: [['0.02', 0.5], ['0.04', 0.5]] as [string, number][] },
]
const MATCHES_PER_DAY = [10, 100, 1_000, 10_000]
/** LAUNCH-GATES.md, «До mainnet-пилота» item 2: 3-5 tokens. One market duration each (poolWatcher.ts:67 default '300'). */
const PILOT_POOLS = 5

// ── fee arithmetic, exactly as the contracts do it ──────────────────────────
/** OrderbookMarket.sol:722-723 and 676-677: fee = (2 * stake) * feeBps / 10 000, floor. */
const feeOf = (stake: bigint, feeBps: bigint): bigint => (stake * 2n * feeBps) / 10_000n
/** RhcFeeDistributor.sol:31: referrer share, floor; the treasury keeps the remainder including dust. */
const refPart = (fee: bigint): bigint => (fee * P.refShareBps) / 10_000n
/** Mainnet cost of one operation at a price level: L2 execution plus the L1 data part. */
const costMain = (i: GasItem, l: Level, extraL2 = 0): bigint => BigInt(i.l2 + extraL2) * weiPerGas(l.gwei) + BigInt(i.bytes) * weiPerGas(l.l1)
const costL2 = (gas: number, gwei: number): bigint => BigInt(Math.round(gas)) * weiPerGas(gwei)
/** L2 price at which revenue pays for the operation, given the L1 price of the level. */
const breakEvenGwei = (revWei: bigint, i: GasItem, l1Gwei: number, extraL2 = 0): number =>
  (Number(revWei) - i.bytes * l1Gwei * 1e9) / (i.l2 + extraL2) / 1e9
/** Expected result of the vault per match with stake X on its side: user wins with probability p. */
const vaultEdge = (p: number, fPr: number, fLp: number): number => (1 - p) * (1 - 2 * fPr) - p * (1 - 2 * fLp)
/** Win share of users at which the vault breaks even: (1 - 2 f_pr) / (2 (1 - f_pr - f_lp)). */
const vaultBreakEven = (fPr: number, fLp: number): number => (1 - 2 * fPr) / (2 * (1 - fPr - fLp))

// ── tiny table printer ──────────────────────────────────────────────────────
function table(title: string, head: string[], rows: string[][]): void {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ')
  console.log('\n' + title)
  console.log(line(head))
  console.log(w.map((n) => '-'.repeat(n)).join('  '))
  for (const r of rows) console.log(line(r))
}

// ── live reads (--live) ─────────────────────────────────────────────────────
const RPC_MAINNET = 'https://rpc.mainnet.chain.robinhood.com' // foundry.toml [rpc_endpoints], measurements/README.md:452
const RPC_TESTNET = 'https://rpc.testnet.chain.robinhood.com'
const REDSTONE = 'https://oracle-gateway-1.a.redstone.finance/v2/data-packages/latest/redstone-primary-prod'
let rpcId = 1
/** Retries transport failures and rate limits only; a JSON-RPC error (a revert included) is final. */
async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let body: any
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      body = await res.json()
    } catch (e) {
      if (attempt >= 3) throw e
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
      continue
    }
    if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
    return body.result
  }
}
/** Selectors computed once with viem: segments(uint256), totalAssets(), and observe([180,60,0]) fully encoded. */
const SEL_SEGMENTS = '0x31560626'
const SEL_TOTAL_ASSETS = '0x01e1d114'
const OBSERVE_3 = '0x883bdbfd' + [0x20, 3, 180, 60, 0].map((n) => n.toString(16).padStart(64, '0')).join('')

async function recordCount(pool: string): Promise<number> {
  const has = async (i: number) => {
    try {
      await rpc(RPC_TESTNET, 'eth_call', [{ to: pool, data: SEL_SEGMENTS + i.toString(16).padStart(64, '0') }, 'latest'])
      return true
    } catch {
      return false
    }
  }
  if (!(await has(0))) return 0
  let lo = 0
  let hi = 1
  while (await has(hi)) { lo = hi; hi *= 2 }
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await has(mid)) lo = mid; else hi = mid }
  return lo + 1
}

type Live = {
  mainnetGwei?: number; l1Gwei?: number; testnetGwei?: number; ethUsd?: number; ethUsdAt?: string
  balances?: Record<string, bigint>; pools?: { name: string; records: number; observeGas?: number }[]; vaultAssets?: bigint
}

async function readLive(): Promise<Live> {
  const live: Live = {}
  const tries: [string, () => Promise<void>][] = [
    ['mainnet gas', async () => {
      live.mainnetGwei = Number(BigInt(await rpc(RPC_MAINNET, 'eth_gasPrice'))) / 1e9
      const r: string = await rpc(RPC_MAINNET, 'eth_call', [{ to: '0x000000000000000000000000000000000000006c', data: '0x41b247a8' }, 'latest'])
      live.l1Gwei = Number(BigInt('0x' + r.slice(2 + 64, 2 + 128))) / 1e9
    }],
    ['testnet gas', async () => { live.testnetGwei = Number(BigInt(await rpc(RPC_TESTNET, 'eth_gasPrice'))) / 1e9 }],
    ['ETH/USD', async () => {
      const res = await fetch(REDSTONE, { signal: AbortSignal.timeout(30_000) })
      const j: any = await res.json()
      const pk = j.ETH?.[0]
      if (!pk) throw new Error('no ETH package')
      live.ethUsd = Number(pk.dataPoints[0].value)
      live.ethUsdAt = new Date(pk.timestampMilliseconds).toISOString()
    }],
    ['balances', async () => {
      live.balances = {}
      for (const w of WALLETS) live.balances[w.key] = BigInt(await rpc(RPC_TESTNET, 'eth_getBalance', [w.addr, 'latest']))
    }],
    ['stand-in pools', async () => {
      live.pools = []
      for (const p of DEMO_POOLS) {
        const records = await recordCount(p.addr)
        let observeGas: number | undefined
        try { observeGas = Number(BigInt(await rpc(RPC_TESTNET, 'eth_estimateGas', [{ to: p.addr, data: OBSERVE_3 }]))) } catch { /* reported as missing */ }
        live.pools.push({ name: p.name, records, observeGas })
      }
    }],
    ['vault', async () => { live.vaultAssets = BigInt(await rpc(RPC_TESTNET, 'eth_call', [{ to: VAULT, data: SEL_TOTAL_ASSETS }, 'latest'])) }],
  ]
  for (const [what, fn] of tries) {
    try { await fn() } catch (e) { console.log(`[live] ${what}: не прочитано (${String(e).split('\n')[0].slice(0, 120)}), беру замороженное значение`) }
  }
  return live
}

// ── the model ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const isLive = process.argv.includes('--live')
  const live: Live = isLive ? await readLive() : {}
  const nowGwei = live.mainnetGwei ?? NOW_MAINNET_GWEI
  const nowL1 = live.l1Gwei ?? NOW_L1_GWEI
  const levels = LEVELS.map((l) => (l.key === 'now' || l.key === 'd14p99' ? { ...l, gwei: l.key === 'now' ? nowGwei : l.gwei, l1: nowL1 } : l))
  const lv = (k: string): Level => levels.find((l) => l.key === k)!
  const ethUsd = live.ethUsd ?? ETH_USD
  const testGwei = live.testnetGwei ?? TESTNET_GWEI
  const nowMs = isLive ? Date.now() : FROZEN_NOW
  const gw = (g: number) => g.toFixed(g < 0.1 ? 4 : 3)

  console.log('FlipTheMeme на Robinhood Chain: модель экономики (docs/rhc/ECONOMICS.md)')
  console.log(isLive ? `Режим --live, ${new Date(nowMs).toISOString()}` : 'Замороженные входные данные 2026-09-29 (для живых чисел: --live)')
  console.log(`ETH/USD ${ethUsd}${live.ethUsdAt ? ' (RedStone ' + live.ethUsdAt + ')' : ' (RedStone, 2026-09-29 11:00 UTC)'}; ` +
    `4663: L2 ${nowGwei} gwei, perL1CalldataByte ${nowL1} gwei; тестнет ${testGwei} gwei`)
  console.log('Показания perL1CalldataByte 29.09: ' + L1_READINGS.map(([t, g]) => `${t} ${g}`).join(', ') + ' gwei/байт; в выборке 04-05.09 ноль')
  console.log('Медиана газа 4663 по неделям, gwei: ' + WEEKLY_MEDIAN_GWEI.map(([w, g]) => `${w} ${g}`).join(', ') + '; с 27.09 пол 0.020')
  console.log(`Сверка оценок: forge --isolate даёт возврат хранилища дешевле его выигрыша на ${int(294_699 - 230_841)} газа, ` +
    `цепочка на ${int(G.settleVaultWin.l2 - G.refundVault.l2)}; PvP-расчёт в forge 278 061 против ${int(G.settlePvp.l2)} на цепочке без L1.`)

  // A. One match at MIN_BET, per outcome.
  const X = P.minBet
  const fee = feeOf(X, P.feeBps)
  const outcomes = [
    { label: 'PvP, есть победитель', rev: fee, g: G.settlePvp },
    { label: 'хранилище, игрок выиграл', rev: fee, g: G.settleVaultWin },
    { label: 'хранилище, игрок проиграл', rev: fee, g: G.settleVaultLoss },
    { label: 'ничья PvP', rev: 0n, g: G.tiePvp },
    { label: 'ничья с хранилищем', rev: 0n, g: G.tieVault },
    { label: 'возврат резолвером, хранилище', rev: 0n, g: G.refundVault },
    { label: 'возврат резолвером, PvP', rev: 0n, g: G.refundPvp },
    { label: 'emergencyRefundMatch', rev: 0n, g: G.emergencyRefund },
  ]
  table(
    `A1. Исходы одного матча при ставке ${fmtEth(X, 3)} с каждой стороны, feeBps ${P.feeBps} (доход казны без реферала)`,
    ['исход', 'доход казны, мкETH', 'газ тестнета', 'из них L1', 'L2-часть', 'как получен'],
    outcomes.map((o) => [o.label, micro(o.rev), int(G2(o.g)), int(o.g.l1), int(o.g.l2), o.g.how]),
  )
  table(
    'A2. Результат казны за матч: доход минус газ кипера (L2-часть x цена L2 + байты x perL1CalldataByte), мкETH',
    ['цена газа', 'gwei', 'L1 gwei/байт', 'газ PvP', 'PvP', 'хран.: игрок выиграл', 'хран.: игрок проиграл', 'ничья PvP', 'возврат (хран.)', 'PvP, $'],
    levels.map((l) => [
      l.label, gw(l.gwei), String(l.l1 === 0 ? 0 : l.l1.toFixed(4)),
      micro(costMain(G.settlePvp, l)),
      signedMicro(fee - costMain(G.settlePvp, l)),
      signedMicro(fee - costMain(G.settleVaultWin, l)),
      signedMicro(fee - costMain(G.settleVaultLoss, l)),
      signedMicro(-costMain(G.tiePvp, l)),
      signedMicro(-costMain(G.refundVault, l)),
      usd(fee - costMain(G.settlePvp, l), ethUsd),
    ]),
  )
  const referredFee = fee - refPart(fee)
  const now = lv('now')
  console.log(`\nРеферал победителя: казна получает ${micro(referredFee)} вместо ${micro(fee)} мкETH, газ расчёта больше (forge): ` +
    `первое начисление на новом распределителе +${int(REF_GAS.firstEver)}, первое начисление нового реферера +${int(REF_GAS.newReferrer)}, повторное +${int(REF_GAS.repeat)}.`)
  console.log(`L1-часть PvP-расчёта на 4663 (${SETTLE_BYTES} байт): ` + L1_READINGS.map(([t, g]) => `${(SETTLE_BYTES * g / 1e3).toFixed(2)} мкETH (${t})`).join(', ') +
    `; при 4.4772 gwei/байт это ${pct(SETTLE_BYTES * 4.4772472 / (G.settlePvp.l2 * now.gwei), 0)} к L2-части при текущей цене L2.`)

  // B. Break-even stake per match.
  const feeGrid = [50n, 100n, 150n, 200n, 300n]
  table(
    `B1. Безубыточная ставка с каждой стороны, ETH (PvP-расчёт, без реферала; > ${fmtEth(P.maxBet, 2)} = выше MAX_BET)`,
    ['цена газа', 'gwei', ...feeGrid.map((b) => `${b} bps${b > P.feeMax ? ' *' : ''}`)],
    levels.map((l) => [
      l.label, gw(l.gwei),
      ...feeGrid.map((b) => {
        const be = (costMain(G.settlePvp, l) * 10_000n) / (2n * b)
        return be > P.maxBet ? `> MAX (${toEth(be).toFixed(3)})` : toEth(be).toFixed(5)
      }),
    ]),
  )
  console.log('* выше FEE_MAX = 100 (PoolMarketFactory.sol:117): только новой фабрикой, то есть новым деплоем всего стека.')
  const thr = (rev: bigint, i: GasItem, extra = 0) => `${breakEvenGwei(rev, i, 0, extra).toFixed(4)} (при L1 ${now.l1}: ${breakEvenGwei(rev, i, now.l1, extra).toFixed(4)})`
  console.log(`Порог окупаемости MIN_BET ${fmtEth(P.minBet, 3)} при 100 bps, gwei L2 при L1 = 0: PvP ${thr(fee, G.settlePvp)}; проигрыш игрока хранилищу ${thr(fee, G.settleVaultLoss)}; ` +
    `с рефералом: первое начисление ${thr(referredFee, G.settlePvp, REF_GAS.firstEver)}, новый реферер ${thr(referredFee, G.settlePvp, REF_GAS.newReferrer)}, повторное ${thr(referredFee, G.settlePvp, REF_GAS.repeat)}.`)
  console.log(`  Прежний способ (весь газ тестнета как L2, первое начисление 66 004): ${(Number(referredFee) / (G2(G.settlePvp) + REF_GAS.firstEver) / 1e9).toFixed(4)} gwei.`)
  console.log('Другой MIN_BET при 100 bps, порог окупаемости PvP-расчёта (L1 = 0): ' +
    ['0.002', '0.005', '0.01'].map((s) => `${s} -> ${breakEvenGwei(feeOf(eth(s), P.feeBps), G.settlePvp, 0).toFixed(4)} gwei ($${(Number(s) * ethUsd).toFixed(2)})`).join(', '))
  const batchPerMatch = (G.settlePvp.l2 + 4 * BATCH_MARGINAL) / 5
  console.log(`Пачка из 5 матчей: ${int(batchPerMatch)} газа L2 на матч (оценка, маржинальный ${int(BATCH_MARGINAL)}), порог MIN_BET ${(Number(fee) / batchPerMatch / 1e9).toFixed(4)} gwei.`)
  console.log(`Возвраты без комиссии, мкETH при ${gw(now.gwei)} / ${P50} gwei: refundExpired ${micro(costMain(G.cancelOrder, now))}-${micro(costMain(G.refundExpired, now))} / ` +
    `${micro(costMain(G.cancelOrder, lv('p50')))}-${micro(costMain(G.refundExpired, lv('p50')))}, emergencyRefundMatch ${micro(costMain(G.emergencyRefund, now))} / ${micro(costMain(G.emergencyRefund, lv('p50')))}.`)

  // Per-match averages under the scenario mix: s = share of users with a registry referrer, p = users' win share vs the vault.
  const paid = 1 - MIX.tieShare - MIX.refundShare
  const v = MIX.vaultShare
  const creditsPerMatch = (s: number, p: number) => paid * s * ((1 - v) + v * p)
  const gasPerMatch = (s: number, p: number) =>
    paid * ((1 - v) * G.settlePvp.l2 + v * (p * G.settleVaultWin.l2 + (1 - p) * G.settleVaultLoss.l2)) +
    MIX.tieShare * ((1 - v) * G.tiePvp.l2 + v * G.tieVault.l2) +
    MIX.refundShare * ((1 - v) * G.refundPvp.l2 + v * G.refundVault.l2) +
    MIX.refundExpiredPerMatch * G.refundExpired.l2 +
    creditsPerMatch(s, p) * REF_GAS.repeat
  const bytesPerMatch = (paid + MIX.tieShare + MIX.refundShare) * SETTLE_BYTES + MIX.refundExpiredPerMatch * SHORT_BYTES
  const matchCostWei = (l: Level, s = 0, p = 0.5) => costL2(gasPerMatch(s, p), l.gwei) + BigInt(Math.round(bytesPerMatch)) * weiPerGas(l.l1)
  const avgStake = (parts: [string, number][]) => parts.reduce((a, [st, w]) => a + Number(eth(st)) * w, 0)
  const revPerMatch = (stakeWei: number, s = 0, p = 0.5) => {
    const f = (stakeWei * 2 * Number(P.feeBps)) / 10_000
    return paid * f - creditsPerMatch(s, p) * f * (Number(P.refShareBps) / 10_000)
  }
  console.log(`\nСредний газ кипера на матч при допущениях E: ${int(gasPerMatch(0, 0.5))} L2 + ${int(bytesPerMatch)} байт L1 ` +
    `(расчёты ${int(paid * 100)}%, ничьи ${MIX.tieShare * 100}%, возвраты ${MIX.refundShare * 100}%, refundExpired ${MIX.refundExpiredPerMatch} на матч)`)

  // C. Keeper reserve.
  const cLevels = ['now', 'd14p99', 'p50', 'p99'].map(lv)
  table(
    'C1. Газ кипера в сутки, ETH (средний газ на матч из допущений E, без пачек и рефералов)',
    ['матчей в сутки', ...cLevels.map((l) => `${l.label} (${gw(l.gwei)})`), 'резерв 7 сут. по p50 04-05.09'],
    MATCHES_PER_DAY.map((n) => [int(n), ...cLevels.map((l) => toEth(matchCostWei(l) * BigInt(n)).toFixed(5)), toEth(matchCostWei(lv('p50')) * BigInt(n * 7)).toFixed(4)]),
  )
  const warnDefault = eth('0.003')
  const critDefault = eth('0.0005')
  console.log('Пороги вотчдога по умолчанию (0.003 / 0.0005 ETH, oracleWatchdog.ts:80-81) в PvP-расчётах: ' +
    cLevels.map((l) => `${gw(l.gwei)} gwei -> ${int(Number(warnDefault / costMain(G.settlePvp, l)))} / ${int(Number(critDefault / costMain(G.settlePvp, l)))}`).join('; '))

  // E. Monthly mainnet scenarios.
  const onboardGas = PILOT_POOLS * (G.cardinality300.l2 + G.createMarket.l2)
  for (const l of ['now', 'd14p99', 'p50'].map(lv)) {
    const rows: string[][] = []
    for (const n of MATCHES_PER_DAY) {
      const gasMonth = matchCostWei(l) * BigInt(n * 30)
      const cells = [int(n), usd(gasMonth, ethUsd)]
      for (const m of STAKE_MIXES) {
        const rev = BigInt(Math.round(revPerMatch(avgStake(m.parts)) * n * 30))
        cells.push(`${usd(rev, ethUsd)} / ${usd(rev - gasMonth, ethUsd)}`)
      }
      rows.push(cells)
    }
    table(
      `E1. Месяц на мейннете при ${l.label} (${gw(l.gwei)} gwei), ETH = $${ethUsd}: доход казны / после газа кипера, без рефералов`,
      ['матчей/сут', 'газ кипера', ...STAKE_MIXES.map((m) => `${m.key}: ${fmtEth(BigInt(Math.round(avgStake(m.parts))), 4)}`)],
      rows,
    )
    const perMatchNet = STAKE_MIXES.map((m) => (revPerMatch(avgStake(m.parts)) - Number(matchCostWei(l))) / 1e18 * ethUsd)
    const steadyOnboard = costL2(7 * 30 * (G.cardinality300.l2 + G.createMarket.l2), l.gwei)
    console.log(`  чистыми на матч: ${STAKE_MIXES.map((m, i) => `${m.key} ${usdNum(perMatchNet[i])}`).join(', ')}; ` +
      `на каждые $100/мес инфраструктуры нужно матчей в сутки: ${perMatchNet.map((x, i) => `${STAKE_MIXES[i].key} ${x > 0 ? Math.ceil(100 / 30 / x) : 'никогда'}`).join(', ')}; ` +
      `разовый онбординг ${PILOT_POOLS} пулов ${usd(costL2(onboardGas, l.gwei), ethUsd)}, постоянный 7 пулов в сутки ${usd(steadyOnboard, ethUsd)}/мес`)
  }
  console.log('Распределения ставок (на матч, не на заявку): ' + STAKE_MIXES.map((m) => `${m.key} = ${m.label}`).join('; '))
  const mixStake = avgStake(STAKE_MIXES[1].parts)
  const refRows: string[][] = []
  for (const n of [100, 1_000]) {
    for (const s of [0, 0.5, 1]) {
      const cells = [int(n), pct(s, 0)]
      for (const l of [lv('now'), lv('p50')]) {
        const rev = revPerMatch(mixStake, s) * n * 30
        const gas = Number(matchCostWei(l, s)) * n * 30
        cells.push(`${usdNum(rev / 1e18 * ethUsd)} / ${usdNum(gas / 1e18 * ethUsd)} / ${usdNum((rev - gas) / 1e18 * ethUsd)}`)
      }
      refRows.push(cells)
    }
  }
  table(
    'E2. Рефералы в месячной модели, mix: доход казны / газ кипера / итог, $ в месяц (повторные начисления, +14 704 газа каждое)',
    ['матчей/сут', 'с рефералом', `при ${gw(lv('now').gwei)} gwei`, `при ${P50} gwei`],
    refRows,
  )

  // P. The project as a whole: treasury after gas plus the operator's vault.
  const ps = [0.5, 0.51, 0.52, 0.55]
  const fPr = Number(P.feeBps) / 10_000
  const fLp = Number(P.lpTakerFeeBps) / 10_000
  const projRows: string[][] = []
  for (const n of [100, 1_000]) {
    for (const m of STAKE_MIXES) {
      const st = avgStake(m.parts)
      const treasury = (revPerMatch(st) - Number(matchCostWei(now))) * n * 30 / 1e18 * ethUsd
      const lp = ps.map((p) => v * paid * st * vaultEdge(p, fPr, fLp) * n * 30 / 1e18 * ethUsd)
      projRows.push([int(n), m.key, usdNum(treasury), lp.map(usdNum).join(' / '), lp.map((x) => usdNum(treasury + x)).join(' / ')])
    }
  }
  table(
    `P1. Проект целиком при ${gw(now.gwei)} gwei, $ в месяц: казна после газа + хранилище оператора (E = 0.98 X (1 - 2p) на матч с хранилищем); инфраструктура не известна, в итог не входит`,
    ['матчей/сут', 'ставки', 'казна после газа', `LP при p = ${ps.map((p) => pct(p, 0)).join(' / ')}`, 'итог до инфраструктуры'],
    projRows,
  )
  {
    const st = mixStake
    const tr = (revPerMatch(st) - Number(matchCostWei(lv('p50')))) * 100 * 30 / 1e18 * ethUsd
    const lp52 = v * paid * st * vaultEdge(0.52, fPr, fLp) * 100 * 30 / 1e18 * ethUsd
    console.log(`При ${P50} gwei, mix, 100 матчей в сутки: казна после газа ${usdNum(tr)}, хранилище при 52% ${usdNum(lp52)}, итог ${usdNum(tr + lp52)}.`)
  }

  // G. The vault.
  const vaultRows: string[][] = []
  for (const [label, feeBps, lpWinTaxed] of [
    ['сейчас: 100 bps, L04 (091ce58)', 100n, true],
    ['feeBps 50 на новых рынках', 50n, true],
    ['до L04: выигрыш хранилища без комиссии', 100n, false],
  ] as [string, bigint, boolean][]) {
    const S = eth('0.01')
    const f = feeOf(S, feeBps)
    const lose = -S + (S * 2n * P.lpTakerFeeBps) / 10_000n
    const win = S * 2n - (lpWinTaxed ? f : 0n) - S
    const ev = (p: number) => (Number(lose) * p + Number(win) * (1 - p)) / 1e12
    vaultRows.push([label, signedMicro(lose), signedMicro(win), ...[0.45, 0.5, 0.52, 0.55].map((p) => (ev(p) >= 0 ? '+' : '') + ev(p).toFixed(0))])
  }
  table(
    'G1. Хранилище, матч 0.01 с его стороны: итог и ожидание, мкETH (p = доля выигрышей игроков)',
    ['режим', 'игрок выиграл', 'хранилище выиграло', 'E при p=0.45', 'p=0.50', 'p=0.52', 'p=0.55'],
    vaultRows,
  )
  table(
    'G2. Доля выигрышей игроков, при которой хранилище в нуле: (1 - 2 f_pr) / (2 (1 - f_pr - f_lp))',
    ['протокольная комиссия', 'LP 100 bps', 'LP 150 bps', 'LP 200 bps'],
    [100, 50].map((pr) => [`${pr} bps`, ...[100, 150, 200].map((lpb) => pct(vaultBreakEven(pr / 10_000, lpb / 10_000)))]),
  )
  const assets = live.vaultAssets ?? VAULT_ASSETS
  const need = (perPool: bigint, total: bigint) => {
    const a = (perPool * 10_000n) / P.feedCapBps
    const b = (total * 10_000n) / P.globalCapBps
    return a > b ? a : b
  }
  const full = P.maxBet
  table(
    'G3. Сколько активов нужно хранилищу, чтобы взять сторону полных матчей по 0.04 (кап 5% на пул, 10% всего; без уже открытых позиций)',
    ['сколько открыто одновременно', 'активов не меньше, WETH'],
    [
      ['1 матч на одном пуле', fmtEth(need(full, full), 2)],
      ['2 матча на одном пуле', fmtEth(need(full * 2n, full * 2n), 2)],
      ['по 1 матчу на 5 пулах', fmtEth(need(full, full * 5n), 2)],
      ['по 3 матча на 5 пулах', fmtEth(need(full * 3n, full * 15n), 2)],
    ],
  )
  console.log(`Хранилище тестнета ${fmtEth(assets, 4)} WETH: на пул ${fmtEth((assets * P.feedCapBps) / 10_000n, 4)} (полных матчей ${Number((assets * P.feedCapBps) / 10_000n / full)}), всего ${fmtEth((assets * P.globalCapBps) / 10_000n, 4)}.`)
  console.log(`Из выигрыша хранилища ${P.lpFeeStreamBps / 100n}% его ставки уходит в поток комиссий LP (LiquidityPool.sol:471): перераспределение внутри хранилища, не доход.`)

  // F. Testnet until the demo ends.
  const hours = Math.max(0, (DEMO_END - nowMs) / 3_600_000)
  const bal = (k: string): bigint => live.balances?.[k] ?? (SNAP_NOW as any)[k]
  const records = (name: string): number => live.pools?.find((p) => p.name === name)?.records ?? SNAP_NOW.records[name]
  const moon = records('MOONCAT')
  const settleAt = (recs: number) => G2(G.settleVaultWin) + (recs - 6) * PER_RECORD_SETTLE // 287 871 was measured at 6 records
  const betAt = (recs: number) => VAULT_BET_GAS_AT_6 + (recs - 6) * PER_RECORD_BET
  const perSettle = costL2(settleAt(moon), testGwei)
  const perBadge = costL2(BADGE_MINT_GAS, testGwei)
  const perPush = costL2(PUSH_TICK_GAS, testGwei)
  const firstSettle = costL2(settleAt(SNAP_FIRST.records), testGwei)
  table(
    `F1. Тестнет 46630 при ${testGwei} gwei (${isLive ? 'сейчас' : SNAP_NOW.at}; до конца демо ${hours.toFixed(0)} ч)`,
    ['кошелёк', 'баланс, ETH', 'единица', 'газ', 'мкETH', 'хватит на'],
    [
      ['кипер', fmtEth(bal('keeper')), `расчёт на MOONCAT (${moon} записей)`, int(settleAt(moon)), micro(perSettle),
        `${int(Number(bal('keeper') / perSettle))} расчётов, до порога ${fmtEth(KEEPER_WARN, 4)}: ${int(Number((bal('keeper') - KEEPER_WARN) / perSettle))}`],
      ['минтер бейджей', fmtEth(bal('minter')), 'mintBadge', int(BADGE_MINT_GAS), micro(perBadge), `${int(Number(bal('minter') / perBadge))} бейджей`],
      ['деплойер', fmtEth(bal('deployer')), 'pushTick', int(PUSH_TICK_GAS), micro(perPush), `${int(Number(bal('deployer') / perPush))} толчков`],
    ],
  )
  console.log(`Исторически (${SNAP_FIRST.at}, у MOONCAT ${SNAP_FIRST.records} записей): расчёт ${int(settleAt(SNAP_FIRST.records))} газа, ` +
    `кипер ${fmtEth(SNAP_FIRST.keeper)} ETH на ${int(Number(SNAP_FIRST.keeper / firstSettle))} расчётов.`)
  console.log(`Записи пулов: ${DEMO_POOLS.map((p) => `${p.name} ${records(p.name)}`).join(', ')}` +
    (live.pools ? '; eth_estimateGas observe(3 точки): ' + live.pools.map((p) => `${p.name} ${p.observeGas ?? '?'}`).join(', ') : ''))
  console.log(`Порог тревоги кипера: предупреждение ${fmtEth(KEEPER_WARN, 4)} = ${int(Number(KEEPER_WARN / perSettle))} расчётов, критично ${fmtEth(KEEPER_CRIT, 4)} = ${int(Number(KEEPER_CRIT / perSettle))}; ` +
    `300 матчей до конца демо - ${fmtEth(perSettle * 300n, 4)} ETH.`)
  console.log('Ценодвигатель на 3 пула, ETH/сутки, если снова запустить: ' + [['~53 с', 53], ['20 с', 20]].map(([l, s]) => `${fmtEth(perPush * BigInt(Math.round(86_400 / (s as number) * 3)), 5)} (${l})`).join(', '))
  const scen: [string, number][] = [
    ['сейчас', 0],
    ['soak 24 ч: шаг на пул раз в час', 24],
    ['soak до потолка 150 шагов на прогон', 50],
    ['ценодвигатель снова, ~53 с, 24 ч', Math.round(86_400 / 53)],
    ['ценодвигатель снова, 20 с, 24 ч', Math.round(86_400 / 20)],
  ]
  table(
    `F2. Газ на MOONCAT (сейчас ${moon} записей), если к пулу добавятся записи`,
    ['сценарий', 'добавлено записей', 'газ расчёта', 'газ ставки против хранилища', 'расчёт, мкETH', 'кипера хватит на'],
    scen.map(([l, add]) => [l, int(add), int(settleAt(moon + add)), int(betAt(moon + add)), micro(costL2(settleAt(moon + add), testGwei)),
      int(Number(bal('keeper') / costL2(settleAt(moon + add), testGwei)))]),
  )
  console.log(`За сутки ценодвигателя расчёт дорожает в ${(settleAt(moon + scen[3][1]) / settleAt(moon)).toFixed(1)}-${(settleAt(moon + scen[4][1]) / settleAt(moon)).toFixed(1)} раза.`)

  // D. Payout sanity: what the live e2e showed.
  const s = eth('0.01')
  const f1 = feeOf(s, 100n)
  console.log(`\nD. Проверка формул на живых выплатах 29.09 (ставка 0.01): PvP ${fmtEth(s * 2n - f1, 4)} (живое 0.0198), ` +
    `против хранилища ${fmtEth(s * 2n - f1 - (s * 2n * P.lpTakerFeeBps) / 10_000n, 4)} (живое 0.0196), казне ${fmtEth(f1, 4)} за матч, рефералу ${fmtEth(refPart(f1), 5)}.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
