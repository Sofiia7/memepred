/**
 * FlipTheMeme on Robinhood Chain: the economics model behind docs/rhc/ECONOMICS.md.
 *
 *   node scripts/rhc/economics.mts          frozen inputs of 2026-09-29, reproduces every table of the document
 *   node scripts/rhc/economics.mts --live   the same tables with gas, ETH price, balances and pool sizes read now
 *
 * Node 22.6+ strips the types itself (checked on 24.11.1); scripts\node_modules\.bin\tsx gives the same output
 * (checked). `npx tsx` from the repo root was not checked: the root has no tsx installed.
 *
 * Read-only. No keys, no .env, no transactions. --live makes JSON-RPC reads (eth_gasPrice, eth_call,
 * eth_getBalance, eth_estimateGas) against the public endpoints and one GET to RedStone's public gateway.
 *
 * Every input below carries its source: a contract file and line, a transaction hash from
 * docs/rhc/DEPLOYMENTS.md, a measurement document, or "замер 2026-09-29" for what was read for this
 * model. "оценка" marks numbers that were not measured on chain; the comment says how they were derived.
 * Plain erasable TypeScript on purpose (no enums, no namespaces), so `node` 24 runs it too.
 */

// ── units ───────────────────────────────────────────────────────────────────
const E18 = 10n ** 18n

/** '0.013' -> 13000000000000000n. Parsed as a decimal string so no float ever touches a wei amount. */
function eth(s: string): bigint {
  const [w, f = ''] = s.split('.')
  return BigInt(w || '0') * E18 + BigInt((f + '0'.repeat(18)).slice(0, 18) || '0')
}
/** gwei per gas (a float from a table) -> wei per gas. Rounded to the wei; inputs have at most 6 decimals. */
const weiPerGas = (gwei: number): bigint => BigInt(Math.round(gwei * 1e9))
const toEth = (wei: bigint): number => Number(wei) / 1e18
/** Millionths of an ETH, the unit of the per-match tables: 1 = 0.000001 ETH. */
const micro = (wei: bigint): string => (Number(wei) / 1e12).toFixed(1)
const signedMicro = (wei: bigint): string => (wei >= 0n ? '+' : '') + micro(wei)
const fmtEth = (wei: bigint, digits = 6): string => toEth(wei).toFixed(digits)
/** Thousands separated by a space, integer part only. */
const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const usd = (wei: bigint, ethUsd: number): string => {
  const v = toEth(wei) * ethUsd
  const a = Math.abs(v)
  const [ip, fp] = (a >= 100 ? a.toFixed(0) : a >= 1 ? a.toFixed(2) : a.toFixed(4)).split('.')
  return (v < 0 ? '-' : '') + '$' + group(ip) + (fp ? '.' + fp : '')
}
const int = (n: number): string => (n < 0 ? '-' : '') + group(Math.abs(Math.round(n)).toString())

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
}

// ── gas per operation ───────────────────────────────────────────────────────
type GasItem = { gas: number; how: 'измерено' | 'оценка'; src: string }
/**
 * Settlement gas is receipt gasUsed, which on this chain includes the L1 data part (gasUsedForL1,
 * 10-13 thousand on testnet). Estimates: the nearest measured outcome of the same match type plus the
 * difference forge measured between the two in --isolate mode (gas before refund minus refund, so every
 * call is a separate transaction with cold storage, like on chain). The scratch test is described in
 * docs/rhc/ECONOMICS.md; cross-checking it against the measured vault refund showed +-25k of noise.
 */
const G: Record<string, GasItem> = {
  settlePvp: { gas: 293_038, how: 'измерено', src: 'tx 0xe475de28... (DEPLOYMENTS.md, e2e 29.09, пул FROGGO, 4 записи)' },
  settleVaultWin: { gas: 287_871, how: 'измерено', src: 'tx 0x728a54f7... (DEPLOYMENTS.md, e2e 29.09, пул MOONCAT, 6 записей)' },
  settleVaultLoss: { gas: 298_668, how: 'оценка', src: '287 871 + (253 196 - 242 399), forge --isolate' },
  tiePvp: { gas: 272_362, how: 'оценка', src: '293 038 + (222 285 - 242 961), forge --isolate' },
  tieVault: { gas: 253_337, how: 'оценка', src: '287 871 + (207 865 - 242 399), forge --isolate' },
  refundVault: { gas: 215_909, how: 'измерено', src: 'tx 0x4ea099e2... (возврат резолвером, причина 2)' },
  refundPvp: { gas: 290_312, how: 'оценка', src: '293 038 + (240 235 - 242 961); от возврата хранилища выходит 259 703' },
  emergencyRefund: { gas: 143_875, how: 'измерено', src: 'DEPLOYMENTS.md, 11.09, прежний код; forge --isolate на текущем 143 095' },
  refundExpired: { gas: 111_936, how: 'оценка', src: 'cancelOrder 87 678 + (117 282 - 93 024), forge --isolate' },
  cancelOrder: { gas: 87_678, how: 'измерено', src: 'tx 0xceda4118...' },
  batchMarginal: { gas: 136_762, how: 'оценка', src: 'forge --isolate: пачка 5 PvP 790 007, один матч 242 961' },
  referralExtra: { gas: 85_904, how: 'оценка', src: 'forge --isolate: PvP с рефералом 328 865 против 242 961, первое начисление' },
  badgeMint: { gas: 70_449, how: 'измерено', src: 'обозреватель, минтер 0xb183..., 29.09, 65 401-70 449' },
  pushTick: { gas: 62_308, how: 'измерено', src: 'tx 0x7fa70d17...' },
  cardinality300: { gas: 6_732_246, how: 'измерено', src: 'eth_estimateGas на живом пуле 4663, measurements/README.md:220' },
  createMarket: { gas: 418_519, how: 'измерено', src: 'measurements/README.md:139' },
  /** eth_estimateGas of observe([180,60,0]) on two stand-ins of the same code, замер 2026-09-29:
   *  MOONCAT 16 records 172 438, FROGGO 4 records 72 171, so (172 438 - 72 171) / 12 per record. */
  perRecordSettle: { gas: 8_356, how: 'измерено', src: 'eth_estimateGas observe 3 точки: 172 438 (16 записей) против 72 171 (4)' },
  /** Same for spotPriceWad, which every placeBet calls: 164 708 against 79 956. */
  perRecordBet: { gas: 7_063, how: 'измерено', src: 'eth_estimateGas spotPriceWad: 164 708 (16 записей) против 79 956 (4)' },
}

// ── gas prices ──────────────────────────────────────────────────────────────
type Level = { key: string; label: string; gwei: number; src: string }
const P50 = 0.398
/** Frozen "now": eth_gasPrice of chain 4663 on 2026-09-29 10:58 UTC. Equal to perArbGasTotal of
 *  ArbGasInfo (0x6c) at that moment; its base part 0.020 is the chain's floor, congestion was 0.000142. */
const NOW_MAINNET_GWEI = 0.020142
const LEVELS: Level[] = [
  { key: 'now', label: 'сейчас, 4663', gwei: NOW_MAINNET_GWEI, src: 'eth_gasPrice, замер 2026-09-29 10:58 UTC' },
  { key: 'd14p99', label: '15-29.09, p99', gwei: 0.069692, src: 'baseFeePerGas блоков 4663 раз в час, 336 точек, замер 2026-09-29' },
  { key: 'p50', label: 'выборка 04-05.09, p50', gwei: P50, src: 'measurements/README.md:306' },
  { key: 'p90', label: 'выборка, p90', gwei: 0.453, src: 'measurements/README.md:307' },
  { key: 'p95', label: 'выборка, p95', gwei: 0.605, src: 'measurements/README.md:308' },
  { key: 'p99', label: 'выборка, p99', gwei: 1.039, src: 'measurements/README.md:309' },
  { key: 'x5', label: '5 x p50', gwei: P50 * 5, src: 'стресс' },
  { key: 'x10', label: '10 x p50', gwei: P50 * 10, src: 'стресс' },
  { key: 'x50', label: '50 x p50', gwei: P50 * 50, src: 'стресс' },
]

/**
 * The L1 data part of a settlement. Receipt gasUsed above already contains the testnet's L1 part
 * (gasUsedForL1 13 021 on the PvP settlement at 0.01 gwei and 0.5019 gwei per L1 byte on 46630, so about
 * 260 bytes). On 4663 it is billed from perL1CalldataByte of ArbGasInfo (0x6c), which read 0.1637 gwei at
 * 10:58 and 4.4772 gwei at 11:18 UTC on 2026-09-29 (замер); it was 0 in the 04.09 sample.
 */
const SETTLE_L1_BYTES = 260
const L1_PER_BYTE_GWEI = [0.163694592, 4.4772472]

/**
 * Gas of 4663 by week: baseFeePerGas of one block an hour from 2026-09-03 to 2026-09-29 11:00 UTC,
 * 625 blocks read by eth_getBlockByNumber (headers survive on the non-archive public RPC), замер 2026-09-29.
 * 14-day window 15-29.09: 336 blocks, p50 0.050526, p99 0.069692, max 1.510872 on 22.09.
 */
const WEEKLY_MEDIAN_GWEI: [string, number][] = [['03-09.09', 0.3512], ['10-16.09', 0.0852], ['17-23.09', 0.0555], ['24-29.09', 0.0277]]

/** ETH/USD, RedStone public gateway (redstone-primary-prod, the one backend/src/lib/redstone.ts uses),
 *  package of 2026-09-29 11:00:10 UTC. The /prices API suggested for this returned an empty array. */
const ETH_USD = 2713.80

// ── testnet (chain 46630) ───────────────────────────────────────────────────
const TESTNET_GWEI = 0.01 // eth_gasPrice 29.09 10:58 UTC; every e2e receipt of 29.09 has effectiveGasPrice 0.01 gwei
const WALLETS = [
  { key: 'keeper', label: 'кипер', addr: '0xbFa008e5A8d46d2014b83551ce6209108416eea4', bal: eth('0.01141846') },
  { key: 'deployer', label: 'деплойер, казна, ценодвигатель', addr: '0x12f9B9De75ccEa7be573F643A99AAA63b9448BD2', bal: eth('0.01036487') },
  { key: 'minter', label: 'минтер бейджей', addr: '0xb183b09f0D41314EA597598B741b41bcddd875e6', bal: eth('0.01029586') },
]
/** Testnet overrides of oracleWatchdog.ts:80-81 (code defaults 0.003 / 0.0005), DEPLOYMENTS.md 29.09. */
const KEEPER_WARN = eth('0.0006')
const KEEPER_CRIT = eth('0.0002')
/** Stand-in pools of the demo and their record counts, замер 2026-09-29 (segments() binary search). */
const DEMO_POOLS = [
  { name: 'MOONCAT', addr: '0xfC5FB7d3B1DDFFc0b50b0CDDFFe3B016d4FF57cb', records: 16 },
  { name: 'FROGGO', addr: '0x779E9B50837478FcCD7DB50592eDB16ed45D8A18', records: 4 },
]
/**
 * Price-mover cadence. 20 s is the runbook's setting; the loop also waits for each pool's receipt in turn
 * (price-mover.mts:72-93), so the real cycle is longer. The instance running on 2026-09-29 from 11:23 UTC
 * pushed each pool every ~53 s (explorer: 11:30:37, 11:31:31, 11:32:23 on MOONCAT); its setting is not known.
 */
const MOVER_CYCLES_SEC: [string, number][] = [['номинально 20 с', 20], ['замер 29.09: ~53 с', 53]]
const FROZEN_NOW = Date.parse('2026-09-29T11:00:00Z')
/** Buildathon submission closes 4 October 15:59, zone not shown on the page (audit-2026-09-28-followup.md §6). */
const DEMO_END = Date.parse('2026-10-04T16:00:00Z')

// ── mainnet scenario assumptions (NOT measurements; see the document) ───────
const MIX = {
  vaultShare: 0.5, // share of matches taken by the vault
  tieShare: 0.02, // ties: no fee, keeper still pays; unmeasured on real pools (LAUNCH-GATES.md, before mainnet, item 6)
  refundShare: 0.01, // resolver refunds: no fee
  refundExpiredPerMatch: 0.1, // keeper-paid refundExpired calls per match (orders whose tail found nobody in 5 minutes)
  referredWinnerShare: 0, // winners with a registry referrer; 1.0 costs 10% of PvP and user-win revenue
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
const costWei = (gas: number, gwei: number): bigint => BigInt(gas) * weiPerGas(gwei)

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
/** Selectors computed once with viem: segments(uint256), and observe([180,60,0]) fully encoded. */
const SEL_SEGMENTS = '0x31560626'
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

type Live = { mainnetGwei?: number; l1PerByteGwei?: number; testnetGwei?: number; ethUsd?: number; ethUsdAt?: string; balances?: Record<string, bigint>; pools?: { name: string; records: number; observeGas?: number }[] }

async function readLive(): Promise<Live> {
  const live: Live = {}
  const tries: [string, () => Promise<void>][] = [
    ['mainnet gas', async () => {
      live.mainnetGwei = Number(BigInt(await rpc(RPC_MAINNET, 'eth_gasPrice'))) / 1e9
      const r: string = await rpc(RPC_MAINNET, 'eth_call', [{ to: '0x000000000000000000000000000000000000006c', data: '0x41b247a8' }, 'latest'])
      live.l1PerByteGwei = Number(BigInt('0x' + r.slice(2 + 64, 2 + 128))) / 1e9
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
  const levels = LEVELS.map((l) => (l.key === 'now' ? { ...l, gwei: nowGwei } : l))
  const ethUsd = live.ethUsd ?? ETH_USD
  const testGwei = live.testnetGwei ?? TESTNET_GWEI
  const nowMs = isLive ? Date.now() : FROZEN_NOW

  console.log('FlipTheMeme на Robinhood Chain: модель экономики (docs/rhc/ECONOMICS.md)')
  console.log(isLive ? `Режим --live, ${new Date(nowMs).toISOString()}` : 'Замороженные входные данные 2026-09-29 (для живых чисел: --live)')
  console.log(`ETH/USD ${ethUsd}${live.ethUsdAt ? ' (RedStone ' + live.ethUsdAt + ')' : ' (RedStone, 2026-09-29 11:00 UTC)'}; газ 4663 сейчас ${nowGwei} gwei; тестнет ${testGwei} gwei`)
  if (live.l1PerByteGwei !== undefined) console.log(`4663 perL1CalldataByte ${live.l1PerByteGwei} gwei (на 04.09 был 0)`)
  console.log('Медиана газа 4663 по неделям, gwei: ' + WEEKLY_MEDIAN_GWEI.map(([w, g]) => `${w} ${g}`).join(', ') + '; с 27.09 пол 0.020')
  // Calibration of the forge estimates against the one refund measured on chain (see G above).
  console.log(`Сверка оценок: forge --isolate даёт возврат хранилища дешевле его выигрыша на ${int(242_399 - 196_441)} газа, ` +
    `цепочка на ${int(G.settleVaultWin.gas - G.refundVault.gas)}; отсюда точность оценок около ±25 тыс.`)

  // A. One match at MIN_BET, per outcome, per gas level.
  const X = P.minBet
  const fee = feeOf(X, P.feeBps)
  const outcomes = [
    { label: 'PvP, есть победитель', rev: fee, gas: G.settlePvp },
    { label: 'хранилище, игрок выиграл', rev: fee, gas: G.settleVaultWin },
    { label: 'хранилище, игрок проиграл', rev: fee, gas: G.settleVaultLoss },
    { label: 'ничья PvP', rev: 0n, gas: G.tiePvp },
    { label: 'ничья с хранилищем', rev: 0n, gas: G.tieVault },
    { label: 'возврат резолвером, хранилище', rev: 0n, gas: G.refundVault },
    { label: 'возврат резолвером, PvP', rev: 0n, gas: G.refundPvp },
    { label: 'emergencyRefundMatch', rev: 0n, gas: G.emergencyRefund },
  ]
  table(
    `A1. Исходы одного матча при ставке ${fmtEth(X, 3)} с каждой стороны, feeBps ${P.feeBps} (доход казны без реферала)`,
    ['исход', 'доход казны, мкETH', 'газ кипера', 'как получен газ'],
    outcomes.map((o) => [o.label, micro(o.rev), int(o.gas.gas), o.gas.how]),
  )
  table(
    'A2. Результат казны за матч: доход минус газ кипера, мкETH (1 мкETH = 0.000001 ETH)',
    ['цена газа', 'gwei', 'газ PvP', 'PvP', 'хран.: игрок выиграл', 'хран.: игрок проиграл', 'ничья PvP', 'возврат (хран.)', 'PvP, $'],
    levels.map((l) => [
      l.label,
      l.gwei.toFixed(l.gwei < 0.1 ? 4 : 3),
      micro(costWei(G.settlePvp.gas, l.gwei)),
      signedMicro(fee - costWei(G.settlePvp.gas, l.gwei)),
      signedMicro(fee - costWei(G.settleVaultWin.gas, l.gwei)),
      signedMicro(fee - costWei(G.settleVaultLoss.gas, l.gwei)),
      signedMicro(-costWei(G.tiePvp.gas, l.gwei)),
      signedMicro(-costWei(G.refundVault.gas, l.gwei)),
      usd(fee - costWei(G.settlePvp.gas, l.gwei), ethUsd),
    ]),
  )
  const referredFee = fee - refPart(fee)
  console.log(`\nС рефералом у победителя казна получает ${micro(referredFee)} вместо ${micro(fee)} мкETH, а расчёт дороже на ~${int(G.referralExtra.gas)} газа (оценка, первое начисление).`)
  const l1Readings = live.l1PerByteGwei !== undefined ? [...L1_PER_BYTE_GWEI, live.l1PerByteGwei] : L1_PER_BYTE_GWEI
  console.log(`L1-часть расчёта на 4663 (~${SETTLE_L1_BYTES} байт): ` +
    l1Readings.map((g) => `${(SETTLE_L1_BYTES * g / 1e3).toFixed(2)} мкETH при ${g.toFixed(4)} gwei/байт`).join(', ') +
    `; в строке «сейчас» она учтена как ${(Number(costWei(13_021, nowGwei)) / 1e12).toFixed(2)} мкETH (13 021 газа из квитанции тестнета).`)

  // B. Break-even stake per match: fee(X) * (1 - ref) = gas * price.
  const feeGrid = [50n, 100n, 150n, 200n, 300n]
  table(
    `B1. Безубыточная ставка с каждой стороны, ETH (газ PvP-расчёта ${int(G.settlePvp.gas)}, без реферала; > ${fmtEth(P.maxBet, 2)} = выше MAX_BET)`,
    ['цена газа', 'gwei', ...feeGrid.map((b) => `${b} bps${b > P.feeMax ? ' *' : ''}`)],
    levels.map((l) => [
      l.label,
      l.gwei.toFixed(l.gwei < 0.1 ? 4 : 3),
      ...feeGrid.map((b) => {
        const be = (costWei(G.settlePvp.gas, l.gwei) * 10_000n) / (2n * b)
        return be > P.maxBet ? `> MAX (${toEth(be).toFixed(3)})` : toEth(be).toFixed(5)
      }),
    ]),
  )
  console.log('* выше FEE_MAX = 100 (PoolMarketFactory.sol:117): только новой фабрикой, то есть новым деплоем всего стека.')
  const gStar = (gas: number, feeWei: bigint) => Number(feeWei) / gas / 1e9
  console.log(`MIN_BET ${fmtEth(P.minBet, 3)} при 100 bps окупает PvP-расчёт до ${gStar(G.settlePvp.gas, fee).toFixed(4)} gwei, ` +
    `с рефералом до ${gStar(G.settlePvp.gas, referredFee).toFixed(4)}, проигрыш игрока хранилищу до ${gStar(G.settleVaultLoss.gas, fee).toFixed(4)}.`)
  console.log(`Пачка из 5 матчей: ${int((G.settlePvp.gas + 4 * G.batchMarginal.gas) / 5)} газа на матч (оценка), порог MIN_BET поднимается до ` +
    `${gStar((G.settlePvp.gas + 4 * G.batchMarginal.gas) / 5, fee).toFixed(4)} gwei.`)
  console.log(`Матч минимальной ставки с рефералом (первое начисление, +${int(G.referralExtra.gas)} газа) окупается до ` +
    `${gStar(G.settlePvp.gas + G.referralExtra.gas, referredFee).toFixed(4)} gwei.`)
  console.log('Другой MIN_BET при 100 bps, порог окупаемости PvP-расчёта: ' +
    ['0.002', '0.005', '0.01'].map((s) => `${s} -> ${gStar(G.settlePvp.gas, feeOf(eth(s), P.feeBps)).toFixed(4)} gwei ($${(Number(s) * ethUsd).toFixed(2)})`).join(', '))
  const nowLevel = levels.find((l) => l.key === 'now')!
  console.log(`Возвраты без комиссии, мкETH при ${nowLevel.gwei} / ${P50} gwei: refundExpired ${micro(costWei(G.cancelOrder.gas, nowLevel.gwei))}-${micro(costWei(G.refundExpired.gas, nowLevel.gwei))} / ` +
    `${micro(costWei(G.cancelOrder.gas, P50))}-${micro(costWei(G.refundExpired.gas, P50))}, emergencyRefundMatch ${micro(costWei(G.emergencyRefund.gas, nowLevel.gwei))} / ${micro(costWei(G.emergencyRefund.gas, P50))}.`)

  // Average keeper gas per match under the scenario mix (used by C and E).
  const paid = 1 - MIX.tieShare - MIX.refundShare
  const v = MIX.vaultShare
  const gasPerMatch =
    paid * ((1 - v) * G.settlePvp.gas + v * (G.settleVaultWin.gas + G.settleVaultLoss.gas) / 2) +
    MIX.tieShare * ((1 - v) * G.tiePvp.gas + v * G.tieVault.gas) +
    MIX.refundShare * ((1 - v) * G.refundPvp.gas + v * G.refundVault.gas) +
    MIX.refundExpiredPerMatch * G.refundExpired.gas
  console.log(`\nСредний газ кипера на матч при допущениях E: ${int(gasPerMatch)} (расчёты ${int(paid * 100)}%, ничьи ${MIX.tieShare * 100}%, возвраты ${MIX.refundShare * 100}%, refundExpired ${MIX.refundExpiredPerMatch} на матч)`)

  // C. Keeper reserve.
  const cLevels = levels.filter((l) => ['now', 'd14p99', 'p50', 'p99'].includes(l.key))
  table(
    'C1. Газ кипера в сутки, ETH (средний газ на матч из допущений E, без пачек)',
    ['матчей в сутки', ...cLevels.map((l) => `${l.label} (${l.gwei.toFixed(l.gwei < 0.1 ? 4 : 3)})`)],
    MATCHES_PER_DAY.map((n) => [int(n), ...cLevels.map((l) => (toEth(costWei(Math.round(gasPerMatch * n), l.gwei))).toFixed(5))]),
  )
  const reserveDays = 7
  const reserveLevel = levels.find((l) => l.key === 'p50')!
  console.log(`Резерв на ${reserveDays} суток по ${reserveLevel.label} (${reserveLevel.gwei} gwei): ` +
    MATCHES_PER_DAY.map((n) => `${int(n)}/сут -> ${toEth(costWei(Math.round(gasPerMatch * n * reserveDays), reserveLevel.gwei)).toFixed(4)} ETH`).join('; '))
  // oracleWatchdog.ts:80-81 defaults, used on mainnet unless overridden: 0.003 warn, 0.0005 critical.
  const warnDefault = eth('0.003')
  const critDefault = eth('0.0005')
  console.log('Пороги вотчдога по умолчанию (0.003 / 0.0005 ETH) в расчётах матча: ' +
    cLevels.map((l) => `${l.gwei.toFixed(l.gwei < 0.1 ? 4 : 3)} gwei -> ${int(Number(warnDefault / costWei(G.settlePvp.gas, l.gwei)))} / ${int(Number(critDefault / costWei(G.settlePvp.gas, l.gwei)))}`).join('; '))

  // E. Monthly mainnet scenarios.
  const avgStake = (parts: [string, number][]) => parts.reduce((a, [s, w]) => a + Number(eth(s)) * w, 0)
  const revPerMatch = (stakeWei: number) => {
    const f = (stakeWei * 2 * Number(P.feeBps)) / 10_000
    const refCut = f * (Number(P.refShareBps) / 10_000) * MIX.referredWinnerShare
    // A vault win pays no referral (OrderbookMarket.sol:682); PvP and user wins do.
    const refCutAvg = refCut * ((1 - v) + v * 0.5)
    return paid * (f - refCutAvg)
  }
  const onboardGas = PILOT_POOLS * (G.cardinality300.gas + G.createMarket.gas)
  const eLevels = levels.filter((l) => ['now', 'd14p99', 'p50'].includes(l.key))
  for (const l of eLevels) {
    const rows: string[][] = []
    for (const n of MATCHES_PER_DAY) {
      const gasMonth = BigInt(Math.round(gasPerMatch * n * 30)) * weiPerGas(l.gwei)
      const cells = [int(n), usd(gasMonth, ethUsd)]
      for (const m of STAKE_MIXES) {
        const rev = BigInt(Math.round(revPerMatch(avgStake(m.parts)) * n * 30))
        cells.push(`${usd(rev, ethUsd)} / ${usd(rev - gasMonth, ethUsd)}`)
      }
      rows.push(cells)
    }
    table(
      `E. Месяц на мейннете при ${l.label} (${l.gwei.toFixed(l.gwei < 0.1 ? 4 : 3)} gwei), ETH = $${ethUsd}: доход казны / после газа кипера`,
      ['матчей/сут', 'газ кипера', ...STAKE_MIXES.map((m) => `${m.key}: ${fmtEth(BigInt(Math.round(avgStake(m.parts))), 4)}`)],
      rows,
    )
    const perMatchNet = STAKE_MIXES.map((m) => (revPerMatch(avgStake(m.parts)) - gasPerMatch * l.gwei * 1e9) / 1e18 * ethUsd)
    // measurements/README.md §4: 7 pools a day pass the keeper's 20 ETH depth threshold.
    const steadyOnboard = BigInt(7 * 30 * (G.cardinality300.gas + G.createMarket.gas)) * weiPerGas(l.gwei)
    console.log(`  чистыми на матч: ${STAKE_MIXES.map((m, i) => `${m.key} $${perMatchNet[i].toFixed(4)}`).join(', ')}; ` +
      `на каждые $100/мес инфраструктуры нужно матчей в сутки: ${perMatchNet.map((x, i) => `${STAKE_MIXES[i].key} ${x > 0 ? Math.ceil(100 / 30 / x) : 'никогда'}`).join(', ')}; ` +
      `разовый онбординг ${PILOT_POOLS} пулов ${usd(BigInt(onboardGas) * weiPerGas(l.gwei), ethUsd)}, постоянный 7 пулов в сутки ${usd(steadyOnboard, ethUsd)}/мес`)
  }
  console.log('Распределения ставок (на матч, не на заявку): ' + STAKE_MIXES.map((m) => `${m.key} = ${m.label}`).join('; '))
  console.log(`Если реферал есть у каждого победителя, доход казны меньше на ${(Number(P.refShareBps) / 100 * ((1 - v) + v * 0.5)).toFixed(1)}% ` +
    `(10% комиссии PvP и выигрышей игроков у хранилища; выигрыш хранилища реферала не платит, OrderbookMarket.sol:682).`)

  // F. Testnet until the demo ends.
  const hours = Math.max(0, (DEMO_END - nowMs) / 3_600_000)
  const bal = (k: string) => live.balances?.[k] ?? WALLETS.find((w) => w.key === k)!.bal
  const pools = live.pools ?? DEMO_POOLS.map((p) => ({ name: p.name, records: p.records, observeGas: undefined as number | undefined }))
  const mooncat = pools.find((p) => p.name === 'MOONCAT')!
  // A MOONCAT settlement was 287 871 at 6 records; each record adds perRecordSettle.
  const settleNow = G.settleVaultWin.gas + (mooncat.records - 6) * G.perRecordSettle.gas
  const perSettle = costWei(settleNow, testGwei)
  const perBadge = costWei(G.badgeMint.gas, testGwei)
  const perPush = costWei(G.pushTick.gas, testGwei)
  const moverPerDay = (everySec: number, nPools = 3) => perPush * BigInt(Math.round((86_400 / everySec) * nPools))
  table(
    `F1. Тестнет 46630 при ${testGwei} gwei: на сколько хватит баланса (до конца демо ${hours.toFixed(0)} ч)`,
    ['кошелёк', 'баланс, ETH', 'единица', 'газ единицы', 'цена единицы, мкETH', 'хватит на'],
    [
      ['кипер', fmtEth(bal('keeper')), `расчёт на MOONCAT (${mooncat.records} записей)`, int(settleNow), micro(perSettle),
        `${int(Number(bal('keeper') / perSettle))} расчётов, до порога ${fmtEth(KEEPER_WARN, 4)}: ${int(Number((bal('keeper') - KEEPER_WARN) / perSettle))}`],
      ['минтер бейджей', fmtEth(bal('minter')), 'mintBadge', int(G.badgeMint.gas), micro(perBadge), `${int(Number(bal('minter') / perBadge))} бейджей`],
      ['деплойер', fmtEth(bal('deployer')), 'pushTick ценодвигателя', int(G.pushTick.gas), micro(perPush),
        `${int(Number(bal('deployer') / perPush))} толчков: ` + MOVER_CYCLES_SEC.map(([l, s]) => `${(toEth(bal('deployer')) / toEth(moverPerDay(s))).toFixed(2)} сут (${l})`).join(', ')],
    ],
  )
  console.log('Ценодвигатель на 3 пула, ETH/сутки: ' + MOVER_CYCLES_SEC.map(([l, s]) => `${fmtEth(moverPerDay(s), 5)} (${l})`).join(', ') +
    '; DEMO-RUNBOOK пишет ~0.006 при 20 с, price-mover.mts:19 ~0.002 при 30 с.')
  console.log(`Порог тревоги кипера: предупреждение ${fmtEth(KEEPER_WARN, 4)} = ${int(Number(KEEPER_WARN / perSettle))} расчётов, критично ${fmtEth(KEEPER_CRIT, 4)} = ${int(Number(KEEPER_CRIT / perSettle))}.`)
  console.log(`Для иллюстрации: 300 матчей до конца демо стоят кипер ${fmtEth(perSettle * 300n, 4)} ETH; ` +
    `ценодвигатель полчаса с шагом 120 с добавляет ${int(30 * 60 / 120)} записей на пул, +${int((30 * 60 / 120) * G.perRecordSettle.gas)} газа к расчёту.`)
  const moverHours = [1, 4, 8, 24]
  const [nominal, observed] = MOVER_CYCLES_SEC
  table(
    `F2. Цена чтения стенд-ин пула растёт с каждым толчком: газ расчёта и ставки на MOONCAT после N часов ценодвигателя (от ${mooncat.records} записей)`,
    ['часов', `записей (${observed[0]})`, 'газ расчёта', 'газ ставки против хранилища', 'расчёт, мкETH', `записей (${nominal[0]})`, 'газ расчёта'],
    moverHours.map((h) => {
      const addObs = Math.round((3600 / observed[1]) * h)
      const addNom = Math.round((3600 / nominal[1]) * h)
      const settle = settleNow + addObs * G.perRecordSettle.gas
      const bet = 705_031 + (mooncat.records - 6 + addObs) * G.perRecordBet.gas // 705 031: tx 0x29e65073..., MOONCAT at 6 records
      return [String(h), int(addObs), int(settle), int(bet), micro(costWei(settle, testGwei)), int(addNom), int(settleNow + addNom * G.perRecordSettle.gas)]
    }),
  )
  if (live.pools) console.log('Живой замер пулов: ' + live.pools.map((p) => `${p.name} ${p.records} записей, observe(3 точки) ${p.observeGas ?? '?'} газа`).join('; '))

  // G. The vault, per match of stake X on its side.
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
  console.log(`Из выигрыша хранилища ${P.lpFeeStreamBps / 100n}% его ставки (${micro((eth('0.01') * P.lpFeeStreamBps) / 10_000n)} мкETH) переходит в поток комиссий LP (LiquidityPool.sol:471): это перераспределение внутри хранилища, не доход.`)

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
