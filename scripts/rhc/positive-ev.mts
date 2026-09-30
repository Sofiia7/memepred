/**
 * Outcome-independent economics for a proposed funded round, not deployed code.
 * Run: node scripts/rhc/positive-ev.mts [--json path] [--self-test]
 * No network, keys or transactions. All money mechanics are bigint wei.
 * The gas allowance is a DESIGN BUDGET, not a measurement of the proposed contract.
 * Demand, tie share and simulated revenue are READ from the cap-1:1 cells of
 * docs/rhc/measurements/pool-toxicity/summary.json (real price series, modeled player flow), so there is one
 * source and no copied constants. The money rules below are the cap 1:1 design: accepted = min(UP, DOWN) per
 * side, excess returned free, every accepted unit pays 1.96x. The same code is tested at cap 4 too.
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const WEI = 10n ** 18n
const BPS = 10_000n
const eth = (s: string) => {
  const [whole, frac = ''] = s.split('.')
  return BigInt(whole) * WEI + BigInt(frac.padEnd(18, '0'))
}
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b
const max = (a: bigint, b: bigint) => a > b ? a : b
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n)
const asEth = (x: bigint) => Number(x) / 1e18
const ETH_USD = 2713.80
const usd = (x: bigint) => asEth(x) * ETH_USD

// Chosen from product constraints, not from the historical price outcomes:
// balanced normal round pays 1.96x, as the present user-vs-LP product does.
const NORMAL_FEE_BPS = 200n
const VOID_FEE_BPS = 100n // explicitly disclosed execution fee on an ACTIVATED tie/refund
const REFERRAL_BPS = 1000n // conservative: every unit of fee has a referrer
const MIN_BANK = eth('0.02') // chosen on the FIRST week of prices: 0.01 fails the 5% player-loss bar there
const BANK_STEP = eth('0.005')
const MAX_SIDE_RATIO = 1n // accepted = min(UP, DOWN): a fixed 1.96x for everyone (cap 4 gave 15-22% player loss)
const GAS_ALLOWANCE = 1_000_000n // TOTAL allowance over the round lifecycle, includes L1 gas units
const COVER = 2n // retained void fee must be at least twice the lifecycle gas allowance
const GAS_FLOOR_GWEI = 0.020142 // chain floor on 2026-09-29 (ECONOMICS.md)

type Side = 'up' | 'down'
type Outcome = Side | 'tie' | 'oracle-refund'
type Ticket = { side: Side; stake: bigint }
type Policy = {
  normalFeeBps: bigint; voidFeeBps: bigint; referralBps: bigint;
  minimumBank: bigint; maxSideRatio: bigint; costAllowance: bigint; cover: bigint
}
function fees(bank: bigint, bps: bigint, refBps: bigint) {
  const gross = bank * bps / BPS
  const referral = gross * refBps / BPS
  return { gross, referral, retained: gross - referral }
}
function policy(gasGwei: number): Policy {
  return {
    normalFeeBps: NORMAL_FEE_BPS, voidFeeBps: VOID_FEE_BPS, referralBps: REFERRAL_BPS,
    minimumBank: MIN_BANK, maxSideRatio: MAX_SIDE_RATIO,
    costAllowance: GAS_ALLOWANCE * BigInt(Math.round(gasGwei * 1e9)), cover: COVER,
  }
}
function validate(p: Policy) {
  assert(p.voidFeeBps > 0n && p.normalFeeBps >= p.voidFeeBps && p.normalFeeBps < BPS)
  assert(p.referralBps >= 0n && p.referralBps < BPS)
  assert(p.minimumBank > 0n && p.maxSideRatio >= 1n && p.costAllowance > 0n && p.cover >= 1n)
}

/** Excess on the larger side is returned pro rata, before applying fees.
 * Integer remainders belong to the unallocated user dust, not the treasury.
 */
function clear(tickets: Ticket[], p: Policy) {
  validate(p)
  assert(tickets.length > 0 && tickets.every(t => t.stake > 0n))
  const rawUp = sum(tickets.filter(t => t.side === 'up').map(t => t.stake))
  const rawDown = sum(tickets.filter(t => t.side === 'down').map(t => t.stake))
  const raw = rawUp + rawDown
  if (rawUp === 0n || rawDown === 0n) return { active: false, raw, reason: 'one-sided book' }
  const up = rawUp > p.maxSideRatio * rawDown ? p.maxSideRatio * rawDown : rawUp
  const down = rawDown > p.maxSideRatio * rawUp ? p.maxSideRatio * rawUp : rawDown
  const bank = up + down
  const voidFees = fees(bank, p.voidFeeBps, p.referralBps)
  if (bank < p.minimumBank || voidFees.retained < p.cover * p.costAllowance) {
    return { active: false, raw, reason: 'insufficient funded bank' }
  }
  return { active: true, raw, rawUp, rawDown, up, down, bank, voidFees }
}

/** Winner claims and unmatched portions are paid by callers; the protocol does
 * not sponsor an unbounded number of claims. A failed-to-activate book has no
 * protocol-funded oracle work. Its users can reclaim their entire deposit.
 */
function settle(tickets: Ticket[], outcome: Outcome, p: Policy, cost: bigint) {
  assert(cost >= 0n && cost <= p.costAllowance, 'lifecycle spending exceeds its admitted budget')
  const c = clear(tickets, p)
  if (!c.active) {
    assert(cost === 0n, 'inactive book must not trigger protocol-funded work')
    return { active: false, reason: c.reason, payouts: tickets.map(t => t.stake),
      bank: 0n, grossFee: 0n, referral: 0n, treasury: 0n, contribution: 0n, dust: 0n }
  }
  const isVoid = outcome === 'tie' || outcome === 'oracle-refund'
  const fee = fees(c.bank!, isVoid ? p.voidFeeBps : p.normalFeeBps, p.referralBps)
  const prize = c.bank! - fee.gross
  const payouts = tickets.map(t => {
    const sideRaw = t.side === 'up' ? c.rawUp! : c.rawDown!
    const sideAccepted = t.side === 'up' ? c.up! : c.down!
    const unmatched = t.stake * (sideRaw - sideAccepted) / sideRaw
    const award = isVoid
      ? t.stake * sideAccepted * prize / (sideRaw * c.bank!)
      : t.side === outcome ? t.stake * prize / sideRaw : 0n
    return unmatched + award
  })
  const dust = c.raw - sum(payouts) - fee.gross
  assert(dust >= 0n)
  return { active: true, reason: '', payouts, bank: c.bank!, grossFee: fee.gross,
    referral: fee.referral, treasury: fee.retained, contribution: fee.retained - cost, dust }
}

function minimumFundedBank(p: Policy) {
  // Align the analytic estimate, then check actual integer fee arithmetic.
  let bank = max(p.minimumBank, ceilDiv(p.cover * p.costAllowance * BPS * BPS,
    p.voidFeeBps * (BPS - p.referralBps)))
  bank = ceilDiv(bank, BANK_STEP) * BANK_STEP
  while (fees(bank, p.voidFeeBps, p.referralBps).retained < p.cover * p.costAllowance) bank += BANK_STEP
  return bank
}

function selfTest() {
  const p = policy(0.398)
  const book: Ticket[] = [{ side: 'up', stake: eth('0.05') }, { side: 'down', stake: eth('0.05') }]
  const u = settle(book, 'up', p, p.costAllowance), d = settle(book, 'down', p, p.costAllowance)
  assert.equal(u.contribution, d.contribution)
  assert.equal(u.payouts[0], eth('0.098'))
  assert.equal(u.treasury, eth('0.0018'))
  assert.equal(u.contribution, eth('0.001402'))
  for (const outcome of ['tie', 'oracle-refund'] as Outcome[]) {
    const r = settle(book, outcome, p, p.costAllowance)
    assert.equal(r.payouts[0], eth('0.0495'))
    assert.equal(r.contribution, eth('0.000502'))
  }
  // Cap 1:1 (the design): the larger side's excess comes back free, every accepted unit pays 1.96x.
  const skew1: Ticket[] = [{ side: 'up', stake: eth('0.4') }, { side: 'down', stake: eth('0.1') }]
  const s1 = settle(skew1, 'down', p, p.costAllowance)
  assert.equal(s1.bank, eth('0.2'))
  assert.equal(s1.payouts[0], eth('0.3'))
  assert.equal(s1.payouts[1], eth('0.196'))
  assert.equal(s1.contribution, eth('0.003202'))
  // The same code at cap 4 (the earlier variable-multiplier proposal), kept as a regression check.
  const p4 = { ...p, maxSideRatio: 4n }
  const skew: Ticket[] = [{ side: 'up', stake: eth('0.4') }, { side: 'down', stake: eth('0.02') }]
  const s = settle(skew, 'down', p4, p.costAllowance)
  assert.equal(s.bank, eth('0.1'))
  assert.equal(s.payouts[0], eth('0.32'))
  assert.equal(s.payouts[1], eth('0.098'))
  const under = [{ side: 'up' as Side, stake: eth('0.005') }, { side: 'down' as Side, stake: eth('0.005') }]
  assert.equal(settle(under, 'up', p, 0n).active, false)
  assert.throws(() => settle(under, 'up', p, 1n))
  assert.throws(() => settle(book, 'up', p, p.costAllowance + 1n))
  const one = settle([{ side: 'up', stake: eth('1') }], 'down', p, 0n)
  assert.equal(one.payouts[0], eth('1'))
  // Under the NEW entry rule, free voids are deliberately not assumed.
  assert.throws(() => clear(book, { ...p, voidFeeBps: 0n }))
  let seed = 0x5eed1234
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  let activated = 0, cancelled = 0
  for (let n = 0; n < 20_000; n++) { // 10 000 books at cap 1 (the design) and 10 000 at cap 4
    const tickets: Ticket[] = Array.from({ length: 1 + random() % 20 }, () => ({
      side: random() % 2 ? 'up' : 'down', stake: BigInt(1 + random() % 8) * eth('0.005') + BigInt(random() % 17),
    }))
    const pp = { ...policy([0.020142, 0.069692, 0.398, 1.039][random() % 4]), maxSideRatio: n < 10_000 ? 1n : 4n }
    const c = clear(tickets, pp)
    const cost = c.active ? pp.costAllowance * BigInt(random() % 101) / 100n : 0n
    const raw = sum(tickets.map(t => t.stake))
    for (const outcome of ['up', 'down', 'tie', 'oracle-refund'] as Outcome[]) {
      const r = settle(tickets, outcome, pp, cost)
      assert.equal(raw, sum(r.payouts) + r.treasury + r.referral + r.dust)
      assert(r.dust < BigInt(2 * tickets.length), 'claim rounding is bounded')
      if (c.active) assert(r.contribution >= (pp.cover - 1n) * pp.costAllowance)
      else assert.deepEqual(r.payouts, tickets.map(t => t.stake))
    }
    if (c.active) activated++; else cancelled++
  }
  return { generatedBooks: 20_000, outcomeChecks: 80_000, activated, cancelled,
    note: 'Random books are invariant tests, NOT a forecast of customer demand or fill rate.' }
}

// ---- inputs from the simulation: ONE configuration, read from the cap-1:1 cells ------------------
// The configuration was chosen on the FIRST week of prices and is reported on the SECOND (see
// POOL-TOXICITY.md). Visible bets, a pause between the close and the strike, strike window W, no reveal.
const CHOSEN = { mode: 'visGap', T: 300, W: 300, fee: 0.02, bmin: 0.02 }
const DEMAND_LEVELS = [2, 5, 10]
type Cell = Record<string, number | string>
function readChosenCells() {
  const data = JSON.parse(readFileSync(new URL('../../docs/rhc/measurements/pool-toxicity/summary.json', import.meta.url), 'utf8'))
  assert.equal(data.schema, 1, 'unsupported pool-toxicity data schema')
  const cols: string[] = data.capOneSearchColumns
  const cells = new Map<number, Cell>()
  for (const row of data.capOneSearchCells) {
    const r: Cell = Object.fromEntries(cols.map((c, i) => [c, row[i]]))
    if (r.mode === CHOSEN.mode && r.T === CHOSEN.T && r.W === CHOSEN.W && r.fee === CHOSEN.fee && r.bmin === CHOSEN.bmin) {
      assert(!cells.has(r.betsPerHour as number), 'duplicate cell')
      cells.set(r.betsPerHour as number, r)
    }
  }
  for (const h of DEMAND_LEVELS) {
    const r = cells.get(h)
    assert(r, `chosen configuration has no cell for ${h} bets/hour`)
    for (const f of ['activeRoundsPerDay', 'meanBank', 'tieShare', 'rev2', 'rev2Se', 'loss2', 'loss2Se', 'loss2H1', 'loss2H2', 'mono2Share']) {
      assert(Number.isFinite(r[f] as number), `cell ${h}/h has no finite ${f}`)
    }
  }
  return cells
}

/** Expected retained result of ONE activated round, in ETH, after referrals and the full gas allowance.
 * v is the share of activated rounds ending as tie/oracle refund. With chargeVoid = false the refund is
 * free (the current product rule) and the round earns nothing on those v.
 */
function expectedNet(bank: bigint, v: number, p: Policy, chargeVoid: boolean) {
  const normal = Number(fees(bank, p.normalFeeBps, p.referralBps).retained)
  const voidFee = chargeVoid ? Number(fees(bank, p.voidFeeBps, p.referralBps).retained) : 0
  return ((1 - v) * normal + v * voidFee - Number(p.costAllowance)) / 1e18
}
const ethOf = (x: number) => BigInt(Math.round(x * 1e6)) * (WEI / 1_000_000n)

const tests = selfTest()
if (process.argv.includes('--self-test')) {
  console.log(JSON.stringify({ ok: true, ...tests }, null, 2))
} else {
  const cells = readChosenCells()
  const gasLevels = [0.020142, 0.069692, 0.398, 1.039]
  const gasScenarios = gasLevels.map(gwei => {
    const p = policy(gwei), bank = minimumFundedBank(p)
    const f = fees(bank, p.normalFeeBps, p.referralBps)
    const v = fees(bank, p.voidFeeBps, p.referralBps)
    return { gasGwei: gwei, totalGasBudget: Number(GAS_ALLOWANCE), costEth: asEth(p.costAllowance),
      minimumBankEth: asEth(bank), normalNetEth: asEth(f.retained - p.costAllowance),
      voidNetEth: asEth(v.retained - p.costAllowance), normalNetUsd: usd(f.retained - p.costAllowance),
      voidNetUsd: usd(v.retained - p.costAllowance) }
  })

  const floor = policy(GAS_FLOOR_GWEI)
  const demandScenarios = DEMAND_LEVELS.map(h => {
    const c = cells.get(h)!
    const rounds = c.activeRoundsPerDay as number, bankEth = c.meanBank as number, v = c.tieShare as number
    const bank = ethOf(bankEth)
    const withFee = expectedNet(bank, v, floor, true), freeRefunds = expectedNet(bank, v, floor, false)
    const allVoids = expectedNet(bank, 1, floor, true), noVoids = expectedNet(bank, 0, floor, true)
    const day = (perRound: number) => perRound * rounds
    const month = (perRound: number) => day(perRound) * ETH_USD * 30
    const simulatedDay = c.rev2 as number
    return { betsPerHourPerPool: h, activeRoundsPerDay: rounds, avgActiveBankEth: bankEth, tieShare: v,
      simulatedNetEthPerPoolPerDay: simulatedDay, simulatedNetEthPerPoolPerDaySe: c.rev2Se as number,
      simulatedNetUsdPerPoolPerDay: simulatedDay * ETH_USD, simulatedNetUsdPerPoolPer30Days: simulatedDay * ETH_USD * 30,
      formulaNetEthPerPoolPerDay: day(withFee), formulaMatchesSimulationPct: 100 * (day(withFee) / simulatedDay - 1),
      // Bounds for the SAME realized accepted bank and activated count, conditional on the cost cap.
      // They do not bound customer demand or revenue on an arbitrary calendar month.
      netUsdPerPoolPer30DaysFreeRefunds: month(freeRefunds),
      netUsdPerPoolPer30DaysAllVoids: month(allVoids), netUsdPerPoolPer30DaysNoVoids: month(noVoids) }
  })
  const playerLoss = DEMAND_LEVELS.map(h => {
    const c = cells.get(h)!
    return { betsPerHourPerPool: h, worstLossWeek2: c.loss2 as number, worstLossWeek2Se: c.loss2Se as number,
      worstLossHalf1: c.loss2H1 as number, worstLossHalf2: c.loss2H2 as number, worstLossWeek1: c.loss1 as number,
      worstCaseBotBank: c.mono2Share as number, marginTo5PctInSe: (0.05 - (c.loss2 as number)) / (c.loss2Se as number) }
  })

  // Free refunds: the tie share at which an activated round stops paying for its own gas allowance.
  const freeRefundBreakEven = [{ bank: '0.02', gwei: 0.020142 }, { bank: '0.03', gwei: 0.020142 }, { bank: '0.09', gwei: 0.398 }].map(x => {
    const p = policy(x.gwei), normal = fees(eth(x.bank), p.normalFeeBps, p.referralBps).retained
    return { bankEth: Number(x.bank), gasGwei: x.gwei, breakEvenTieShare: 1 - Number(p.costAllowance) / Number(normal) }
  })

  const result = {
    schema: 4, date: '2026-09-29', implementedOnChain: false,
    statement: 'Outcome-independent positive contribution for activated externally funded books, conditional on the enforced total lifecycle cost allowance; no demand/volume claim.',
    calibration: 'Mechanics use no fitted probabilities. The chosen configuration and its demand, tie share, revenue and player loss are read at full precision from the cap-1:1 cells of measurements/pool-toxicity/summary.json (historical price series, modeled player flow); the configuration was chosen on the first week and reported on the second.',
    chosenConfiguration: CHOSEN,
    assumptions: { normalFeeBps: Number(NORMAL_FEE_BPS), activatedVoidFeeBps: Number(VOID_FEE_BPS),
      maximumReferralShareOfFeeBps: Number(REFERRAL_BPS), maximumSideRatio: Number(MAX_SIDE_RATIO),
      minimumBankEth: asEth(MIN_BANK), gasBudgetMeasured: false, totalLifecycleGasAllowance: Number(GAS_ALLOWANCE),
      minimumRetainedVoidFeeCostMultiple: Number(COVER), ethUsdFrozen: ETH_USD,
      userPaysPlacementAndClaimGas: true, operatorSuppliesDirectionalStake: false, fixedCostsIncluded: false,
      revealPhase: false, demandIsModeled: true },
    tests, gasScenarios, demandScenarios, playerLoss, freeRefundBreakEven,
  }
  console.log('Matched rounds (cap 1:1, fixed 1.96x): proposed mechanics, not deployed.')
  console.log('Normal fee 2% of accepted bank; activated tie/oracle refund 1%; up to 10% of fees to referrals.')
  console.log('Full refund of the excess and of never-activated deposits; user pays bet and claim gas.')
  console.log('Total lifecycle gas allowance 1,000,000 is a design budget, NOT a gas measurement.')
  console.log('L1 is included in this TOTAL gas allowance; do not add it a second time.')
  console.log('\nA. minimum funded bank by gas price (never below 0.02 ETH)')
  console.log('gwei | max lifecycle ETH | min bank ETH | normal net ETH | void net ETH')
  for (const r of gasScenarios) console.log(`${r.gasGwei} | ${r.costEth.toFixed(8)} | ${r.minimumBankEth.toFixed(3)} | ${r.normalNetEth.toFixed(8)} | ${r.voidNetEth.toFixed(8)}`)
  console.log(`\nB. chosen configuration ${JSON.stringify(CHOSEN)}, ${GAS_FLOOR_GWEI} gwei, $${ETH_USD}/ETH, before fixed costs`)
  console.log('bets/h | active rounds/day | avg bank ETH | tie share | simulated USD/day | simulated USD/30 d | formula vs simulation | free refunds USD/30 d | all voids USD/30 d')
  for (const r of demandScenarios) console.log(`${r.betsPerHourPerPool} | ${r.activeRoundsPerDay.toFixed(3)} | ${r.avgActiveBankEth.toFixed(4)} | ${(100 * r.tieShare).toFixed(1)}% | ${r.simulatedNetUsdPerPoolPerDay.toFixed(2)} | ${r.simulatedNetUsdPerPoolPer30Days.toFixed(0)} | ${r.formulaMatchesSimulationPct.toFixed(1)}% | ${r.netUsdPerPoolPer30DaysFreeRefunds.toFixed(0)} | ${r.netUsdPerPoolPer30DaysAllVoids.toFixed(0)}`)
  console.log('\nC. player loss, worst case over bot types at bot share up to 25% (second week)')
  console.log('bets/h | loss % +- se | halves % | margin to 5% in se')
  for (const r of playerLoss) console.log(`${r.betsPerHourPerPool} | ${(100 * r.worstLossWeek2).toFixed(1)} +- ${(100 * r.worstLossWeek2Se).toFixed(1)} | ${(100 * r.worstLossHalf1).toFixed(1)} / ${(100 * r.worstLossHalf2).toFixed(1)} | ${r.marginTo5PctInSe.toFixed(1)}`)
  console.log('\nD. free refunds: tie share above which an activated round no longer pays its own gas allowance')
  for (const r of freeRefundBreakEven) console.log(`bank ${r.bankEth} ETH, ${r.gasGwei} gwei: ${(100 * r.breakEvenTieShare).toFixed(2)}%`)
  console.log(`\nTests: ${tests.generatedBooks} books, ${tests.outcomeChecks} outcomes (half at cap 1, half at cap 4); conservation, no uncovered payout, clearing, referral fees, funding gate, gas cap.`)
  const at = process.argv.indexOf('--json')
  if (at >= 0) {
    const path = process.argv[at + 1]
    if (!path || path.startsWith('--')) throw new Error('--json requires a file path')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(result, null, 2) + '\n')
  }
}
