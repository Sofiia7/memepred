/**
 * Outcome-independent economics for a proposed funded round, not deployed code.
 * Run: node scripts/rhc/positive-ev.mts [--json path] [--self-test]
 * No network, keys, transactions or fitted probabilities. All money is bigint.
 * The gas allowance is a DESIGN BUDGET, not a measurement of the proposed contract.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
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
const usd = (x: bigint) => asEth(x) * 2713.80

// Chosen from product constraints, not from the historical price outcomes:
// balanced normal round pays 1.96x, as the present user-vs-LP product does.
const NORMAL_FEE_BPS = 200n
const VOID_FEE_BPS = 100n // explicitly disclosed execution fee on an ACTIVATED tie/refund
const REFERRAL_BPS = 1000n // conservative: every unit of fee has a referrer
const MIN_BANK = eth('0.01')
const BANK_STEP = eth('0.005')
const MAX_SIDE_RATIO = 4n // clear excess stakes: final split is between 20:80 and 80:20
const GAS_ALLOWANCE = 1_000_000n // TOTAL allowance over the round lifecycle, includes L1 gas units
const COVER = 2n // retained void fee must be at least twice the lifecycle gas allowance

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
  const skew: Ticket[] = [{ side: 'up', stake: eth('0.4') }, { side: 'down', stake: eth('0.02') }]
  const s = settle(skew, 'down', p, p.costAllowance)
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
  for (let n = 0; n < 10_000; n++) {
    const tickets: Ticket[] = Array.from({ length: 1 + random() % 20 }, () => ({
      side: random() % 2 ? 'up' : 'down', stake: BigInt(1 + random() % 8) * eth('0.005') + BigInt(random() % 17),
    }))
    const pp = policy([0.020142, 0.069692, 0.398, 1.039][random() % 4])
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
  return { generatedBooks: 10_000, outcomeChecks: 40_000, activated, cancelled,
    note: 'Random books are invariant tests, NOT a forecast of customer demand or fill rate.' }
}

const tests = selfTest()
if (process.argv.includes('--self-test')) {
  console.log(JSON.stringify({ ok: true, ...tests }, null, 2))
} else {
  const gasLevels = [0.020142, 0.069692, 0.398, 1.039]
  const rows = gasLevels.map(gwei => {
    const p = policy(gwei), bank = minimumFundedBank(p)
    const f = fees(bank, p.normalFeeBps, p.referralBps)
    const v = fees(bank, p.voidFeeBps, p.referralBps)
    return { gasGwei: gwei, totalGasBudget: Number(GAS_ALLOWANCE), costEth: asEth(p.costAllowance),
      minimumBankEth: asEth(bank), normalNetEth: asEth(f.retained - p.costAllowance),
      voidNetEth: asEth(v.retained - p.costAllowance), normalNetUsd: usd(f.retained - p.costAllowance),
      voidNetUsd: usd(v.retained - p.costAllowance) }
  })
  const examples = [eth('0.01'), eth('0.026'), eth('0.1')].map(bank => {
    const p = policy(gasLevels[0]), normal = fees(bank, p.normalFeeBps, p.referralBps).retained
    const voidFee = fees(bank, p.voidFeeBps, p.referralBps).retained
    const average = (normal * 97n + voidFee * 3n) / 100n - p.costAllowance
    const month = average * 100n * 30n
    return { bankEth: asEth(bank), assumedVoidPct: 3, fundedRoundsPerDay: 100,
      monthlyDepositedEth: asEth(bank * 3000n), netPerRoundEth: asEth(average),
      monthlyContributionUsd: usd(month), illustrativeFixedUsd: 100, afterIllustrativeFixedUsd: usd(month) - 100 }
  })
  const p = policy(0.398), b = eth('0.1')
  const normal = fees(b, p.normalFeeBps, p.referralBps).retained - p.costAllowance
  const comparisons = [0.5, 0.6, 0.75, 0.9, 1].map(botWinProbability => ({
    botWinProbability,
    currentDirectionalLpPctOfStake: 100 * .98 * (1 - 2 * botWinProbability),
    fundedRoundNetEth: asEth(normal),
    note: 'Different denominators: LP row per one user stake; funded round row per 0.1 ETH total bank.',
  }))
  const result = {
    schema: 1, date: '2026-09-29', implementedOnChain: false,
    statement: 'Outcome-independent positive contribution for activated externally funded books, conditional on the enforced total lifecycle cost allowance; no demand/volume claim.',
    calibration: 'No fitted win probabilities and no historical parameter search.',
    assumptions: { normalFeeBps: Number(NORMAL_FEE_BPS), activatedVoidFeeBps: Number(VOID_FEE_BPS),
      maximumReferralShareOfFeeBps: Number(REFERRAL_BPS), maximumSideRatio: Number(MAX_SIDE_RATIO),
      gasBudgetMeasured: false, totalLifecycleGasAllowance: Number(GAS_ALLOWANCE),
      minimumRetainedVoidFeeCostMultiple: Number(COVER), ethUsdFrozen: 2713.80,
      userPaysPlacementAndClaimGas: true, operatorSuppliesDirectionalStake: false,
      fixedCostsIncludedInUnitContribution: false },
    tests, gasScenarios: rows, monthlyScenarios: examples, botComparison: comparisons,
  }
  console.log('Funded rounds: proposed mechanics, not deployed. No fitted probabilities.')
  console.log('Normal fee 2% of bank; activated tie/oracle refund 1%; up to 10% of fees to referrals.')
  console.log('Full refund of unmatched/never-activated deposits; user pays placement and claim gas.')
  console.log('Total lifecycle gas allowance 1,000,000 is a design budget, NOT a gas measurement.')
  console.log('L1 is included in this TOTAL gas allowance; do not add it a second time.')
  console.log('\ngwei | max lifecycle ETH | min bank ETH | normal net ETH | void net ETH')
  for (const r of rows) console.log(`${r.gasGwei} | ${r.costEth.toFixed(8)} | ${r.minimumBankEth.toFixed(3)} | ${r.normalNetEth.toFixed(8)} | ${r.voidNetEth.toFixed(8)}`)
  console.log('\nAt frozen 0.020142 gwei and $2713.80/ETH: 100 FUNDED rounds/day, 3% voids, all fees referred.')
  console.log('bank ETH | monthly user deposits ETH | monthly contribution USD | after assumed $100 fixed USD')
  for (const r of examples) console.log(`${r.bankEth.toFixed(3)} | ${r.monthlyDepositedEth.toFixed(1)} | ${r.monthlyContributionUsd.toFixed(2)} | ${r.afterIllustrativeFixedUsd.toFixed(2)}`)
  console.log(`\nTests: ${tests.generatedBooks} books, ${tests.outcomeChecks} outcomes; conservation, no uncovered payout, clearing, referral fees, funding gate, gas cap.`)
  const at = process.argv.indexOf('--json')
  if (at >= 0) {
    const path = process.argv[at + 1]
    if (!path || path.startsWith('--')) throw new Error('--json requires a file path')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(result, null, 2) + '\n')
  }
}
