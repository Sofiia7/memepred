import { describe, it, expect } from 'vitest'
import {
  acceptedBank,
  acceptedIfPlaced,
  acceptedOf,
  activationFloor,
  depthAllows,
  largestStakeWithinDepth,
  bpsToPct,
  currentIndex,
  decodeRoundId,
  durationLabel,
  durationWords,
  formatMultiplier,
  payoutIfWin,
  percentOf,
  phaseAt,
  roundIdOf,
  roundTimes,
  SIDE_DOWN,
  SIDE_UP,
  winMultiplier,
} from './roundMath'

const POOL = '0x52908400098527886E0F7030069857D2E4169EE7' as const
const E = 10n ** 18n
const m = (n: number) => (BigInt(n) * E) / 1000n

describe('roundIdOf / decodeRoundId (pool << 96 | T << 64 | k)', () => {
  it('packs and unpacks', () => {
    const id = roundIdOf(POOL, 300, 5966666n)
    expect(id).toBe(37344990592676294723008695098726592924025138620336884146089917158630998346570n)
    expect(decodeRoundId(id)).toEqual({ pool: POOL, duration: 300, index: 5966666n })
  })

  it('refuses a duration or index that does not fit', () => {
    expect(() => roundIdOf(POOL, 2 ** 32, 1n)).toThrow()
    expect(() => roundIdOf(POOL, 300, 1n << 64n)).toThrow()
  })
})

describe('the timeline: bets, pause, strike, exit', () => {
  const t = roundTimes(300, 5966666n, 300, 300)

  it('lays out a 5 minute round over 20 minutes from the opening of bets to the result', () => {
    expect(t.closeAt - t.openAt).toBe(300)
    expect(t.strikeStart - t.closeAt).toBe(300)
    expect(t.strikeEnd - t.strikeStart).toBe(300)
    expect(t.settleAt - t.strikeEnd).toBe(300)
    expect(t.settleAt - t.openAt).toBe(1200)
  })

  it('switches phase on exactly the boundary seconds', () => {
    expect(phaseAt(t, t.openAt - 1)).toBe('upcoming')
    expect(phaseAt(t, t.openAt)).toBe('betting')
    expect(phaseAt(t, t.closeAt - 1)).toBe('betting')
    expect(phaseAt(t, t.closeAt)).toBe('pause')
    expect(phaseAt(t, t.strikeStart)).toBe('strike')
    expect(phaseAt(t, t.strikeEnd)).toBe('exit')
    expect(phaseAt(t, t.settleAt)).toBe('result')
  })

  it('names the round that takes bets now', () => {
    expect(currentIndex(t.openAt, 300)).toBe(5966666n)
    expect(currentIndex(t.closeAt - 1, 300)).toBe(5966666n)
    expect(currentIndex(t.closeAt, 300)).toBe(5966667n)
  })
})

describe('sides matched 1:1', () => {
  it('plays the whole stake when the other side is bigger', () => {
    expect(acceptedOf(m(20), SIDE_DOWN, m(30), m(20))).toEqual({ accepted: m(20), returned: 0n })
  })

  it('plays the smaller side\'s total, shared pro rata, and returns the rest', () => {
    // UP 0.03 (this 0.02 inside), DOWN 0.02: UP plays 0.02 of 0.03, so 2/3 of this stake.
    const { accepted, returned } = acceptedOf(m(20), SIDE_UP, m(30), m(20))
    expect(accepted).toBe((m(20) * m(20)) / m(30))
    expect(accepted + returned).toBe(m(20))
  })

  it('plays nothing while the other side is empty', () => {
    expect(acceptedOf(m(10), SIDE_UP, m(10), 0n)).toEqual({ accepted: 0n, returned: m(10) })
  })

  it('estimates a stake not placed yet by adding it to its side first', () => {
    expect(acceptedIfPlaced(m(10), SIDE_UP, m(20), m(20))).toEqual({ accepted: (m(10) * m(20)) / m(30), returned: m(10) - (m(10) * m(20)) / m(30) })
    expect(acceptedIfPlaced(m(10), SIDE_DOWN, m(30), m(10))).toEqual({ accepted: m(10), returned: 0n })
  })

  it('pays 1.96x on the part that plays at a 2% fee, plus the part returned', () => {
    expect(winMultiplier(200)).toBeCloseTo(1.96)
    expect(formatMultiplier(winMultiplier(200))).toBe('1.96x')
    expect(payoutIfWin(m(20), 0n, 200)).toBe(39_200_000_000_000_000n)
    expect(payoutIfWin(m(10), m(5), 200)).toBe(19_600_000_000_000_000n + m(5))
  })
})

describe('the smallest bank that plays (PoolRoundMath.isActive)', () => {
  // retained void fee: gross = floor(bank / 100), minus floor(gross / 10) for referrals
  const retained = (bank: bigint) => bank / 100n - bank / 100n / 10n

  it('is minBank when the fee cover is smaller', () => {
    expect(activationFloor(m(20), 69_692_000_000_000n)).toBe(m(20))
  })

  it('is the fee cover when that is bigger: the first bank whose retained 1% covers twice the allowance', () => {
    const c = 398_000_000_000_000n // 0.398 gwei x 1 000 000 gas, as the contract tests use
    const floor = activationFloor(m(20), c)
    expect(floor > m(20)).toBe(true)
    expect(retained(floor) >= 2n * c).toBe(true)
    expect(retained(floor - 100n) < 2n * c).toBe(true)
  })
})

describe('the depth rule (PoolRounds._addStake)', () => {
  // maxBank 0.04: a pool with 100 WETH of depth at K = 2500
  const maxBank = m(40)

  it('lets a bet raise the bank up to maxBank and refuses one that raises it past', () => {
    // UP 0.03, DOWN 0.01: bank 0.02. DOWN +0.01 -> bank 0.04 (allowed); DOWN +0.02 -> 0.06 (refused).
    expect(acceptedBank(m(30), m(10))).toBe(m(20))
    expect(depthAllows(m(30), m(10), SIDE_DOWN, m(10), maxBank)).toBe(true)
    expect(depthAllows(m(30), m(10), SIDE_DOWN, m(20), maxBank)).toBe(false)
  })

  it('never limits a bet on the bigger side: it does not raise the bank', () => {
    expect(depthAllows(m(30), m(10), SIDE_UP, m(40), 0n)).toBe(true)
  })

  it('finds the largest stake that still fits', () => {
    expect(largestStakeWithinDepth(m(30), m(10), SIDE_DOWN, maxBank, m(40))).toBe(m(10))
    expect(largestStakeWithinDepth(m(30), m(10), SIDE_UP, maxBank, m(40))).toBe(m(40))
    expect(largestStakeWithinDepth(m(20), m(20), SIDE_DOWN, maxBank, m(40))).toBe(m(40)) // bank already at 0.04, the other side is not raised
    expect(largestStakeWithinDepth(m(30), m(30), SIDE_UP, m(20), m(40))).toBe(m(40)) // UP is not the smaller side: bank does not grow
  })
})

describe('a side cap other than 1:1', () => {
  it('plays up to ratio times the other side', () => {
    // UP 0.05 against DOWN 0.01 with a 4:1 cap: UP plays 0.04 of 0.05.
    expect(acceptedOf(m(10), SIDE_UP, m(50), m(10), 4).accepted).toBe((m(10) * m(40)) / m(50))
    expect(acceptedOf(m(10), SIDE_DOWN, m(50), m(10), 4)).toEqual({ accepted: m(10), returned: 0n })
  })
})

describe('formatting', () => {
  it('formats fees, durations and shares', () => {
    expect(bpsToPct(200)).toBe('2%')
    expect(bpsToPct(150)).toBe('1.5%')
    expect(durationLabel(300)).toBe('5m')
    expect(durationLabel(3600)).toBe('1h')
    expect(durationWords(300)).toBe('5 minutes')
    expect(durationWords(60)).toBe('1 minute')
    expect(durationWords(90)).toBe('90 seconds')
    expect(percentOf(2n, 3n)).toBe(66)
    expect(percentOf(1n, 0n)).toBe(0)
  })
})
