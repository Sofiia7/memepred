import { describe, it, expect } from 'vitest'
import { roundRules, secondsToResult, sideCapMismatch, SIDE_RATIO, whatYouBetOn, type RulesInput } from './roundRules'

const INPUT: RulesInput = {
  feeBps: 200,
  voidFeeBps: 100,
  durationSec: 300,
  strikePause: 300,
  strikeWindow: 300,
  settleGraceSec: 86_400,
  minBank: '0.02',
  maxStake: '0.04',
  symbol: 'WETH',
  spreadGuardPct: 2,
  testnet: true,
  depthPerBank: 2500,
  gateDepth: '50',
}

const text = (rules: ReturnType<typeof roundRules>) => rules.map((r) => `${r.title}. ${r.text}`).join('\n')
const all = text(roundRules(INPUT))

describe('the misunderstanding that matters most: what the bet is on', () => {
  it('comes first, and says the price now does not count', () => {
    const first = roundRules(INPUT)[0]
    expect(first.id).toBe('what')
    expect(first.text).toMatch(/the price you see now does not count/)
    expect(first.text).toMatch(/a move that happens before the strike does not help you/)
    expect(first.text).toContain('The strike is the average price over 5 minutes that start 5 minutes after bets close')
    expect(first.text).toContain('the exit is read 5 minutes after the strike ends')
  })

  it('has a short form for next to the button', () => {
    expect(whatYouBetOn(INPUT)).toMatch(/^You bet on the price move from the strike to the exit, not from the price now\./)
  })

  it('says how long it takes: for a 5 minute round, about 15 minutes after bets close and 20 after they open', () => {
    expect(secondsToResult(300, 300, 300)).toBe(1200)
    expect(all).toContain('the result is due about 15 minutes after bets close, 20 minutes after the round opened')
    expect(text(roundRules({ ...INPUT, durationSec: 900 }))).toContain('about 25 minutes after bets close, 40 minutes after the round opened')
  })

  it('reads the pause and the strike window it is given, not a fixed number', () => {
    const r = text(roundRules({ ...INPUT, strikePause: 120, strikeWindow: 60 }))
    expect(r).toContain('nothing is priced for 2 minutes')
    expect(r).toContain('averaged over 1 minute')
  })
})

describe('money', () => {
  it('matching is 1:1, the rest comes back without a fee, and it is final only at the close', () => {
    expect(all).toContain('Sides are matched 1:1')
    expect(all).toMatch(/The rest of your stake comes back without a fee/)
    expect(all).toMatch(/change with every bet until the close/)
  })

  it('a winner gets 1.96x of the part that plays; a loser only the part returned', () => {
    expect(all).toContain('you receive 1.96x of the part that plays, plus the part returned')
    expect(all).toContain('If it loses you receive only the part returned')
  })

  it('states both fees, the minimum bank, the full refund from the close, and the gas', () => {
    expect(all).toContain('2% of the matched bank when there is a winner; 1% of it on a tie')
    expect(all).toContain('at least 0.02 WETH')
    expect(all).toMatch(/returned in full, without a fee, and can be collected as soon as bets close/)
    expect(all).toMatch(/Gas for the approval, the bet and collecting is yours/)
  })

  it('promises no return', () => {
    expect(all).not.toMatch(/guarantee|profit|earn|yield|APY/i)
  })
})

describe('the depth rule', () => {
  it('says the pool depth caps the bank, names K and the gate, and says a thin window is refunded minus 1%', () => {
    const depth = roundRules(INPUT).find((r) => r.id === 'depth')
    expect(depth?.title).toBe("The pool's depth limits the round")
    expect(depth?.text).toContain("at most the pool's WETH depth divided by 2500")
    expect(depth?.text).toContain('a pool needs 50 WETH of depth to take bets at all')
    expect(depth?.text).toContain('a bet on the bigger side is never limited')
    expect(depth?.text).toContain('than the bank needs, the round is refunded minus 1%')
  })
})

describe('what the old design said is gone', () => {
  it('mentions no reveal, secret, commitment, forfeit or variable multiplier range', () => {
    expect(all).not.toMatch(/reveal|secret|commit|forfeit|4\.90x|1\.225x|80:20/i)
  })
})

describe('risk', () => {
  it('unaudited, testnet when it is, the cap', () => {
    expect(all).toMatch(/has not been audited/)
    expect(all).toMatch(/testnet preview/)
    expect(all).toContain('capped at 0.04 WETH')
    expect(text(roundRules({ ...INPUT, testnet: false }))).not.toMatch(/testnet/)
  })
})

describe('side cap check', () => {
  it('describes 1:1 and flags a contract that reports anything else', () => {
    expect(SIDE_RATIO).toBe(1)
    expect(sideCapMismatch(1)).toBe(false)
    expect(sideCapMismatch(undefined)).toBe(false)
    expect(sideCapMismatch(4)).toBe(true)
  })
})
