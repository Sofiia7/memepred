import { describe, it, expect } from 'vitest'
import { earnedBadges, BADGE_IDS, type TraderStats } from './badgeRules.js'

const stats = (over: Partial<TraderStats> = {}): TraderStats => ({
  totalBets:        0,
  wonBets:          0,
  currentStreak:    0,
  maxStreak:        0,
  totalVolume:      0,
  pepeBets:         0,
  brettBets:        0,
  hasFiveMinBet:    false,
  hasBigMoveWin:    false,
  isWeeklyChampion: false,
  activeReferrals:  0,
  ...over,
})

describe('earnedBadges', () => {
  it('gives a brand new address nothing', () => {
    expect(earnedBadges(stats())).toEqual([])
  })

  it('awards Beginner on the first settled bet', () => {
    expect(earnedBadges(stats({ totalBets: 1 }))).toContain(BADGE_IDS.BEGINNER)
  })

  it('awards every streak badge the streak has passed, not only the highest', () => {
    // A 30-long streak has been through 7 and 10 on the way. Awarding only
    // Diamond would leave two badges that can never be earned afterwards,
    // since the streak resets on the next loss.
    const earned = earnedBadges(stats({ totalBets: 30, currentStreak: 30 }))
    expect(earned).toEqual(expect.arrayContaining([
      BADGE_IDS.ON_FIRE, BADGE_IDS.SNIPER, BADGE_IDS.DIAMOND,
    ]))
    expect(earned).not.toContain(BADGE_IDS.LEGEND)
  })

  it('needs a hundred bets before accuracy counts for Oracle', () => {
    // 4 of 5 is 80%, but on five bets it is noise.
    expect(earnedBadges(stats({ totalBets: 5, wonBets: 4 }))).not.toContain(BADGE_IDS.ORACLE)
    expect(earnedBadges(stats({ totalBets: 100, wonBets: 80 }))).toContain(BADGE_IDS.ORACLE)
  })

  it('does not divide by zero on an address with no bets', () => {
    expect(() => earnedBadges(stats({ totalBets: 0, wonBets: 0 }))).not.toThrow()
  })

  it('awards volume tiers cumulatively', () => {
    const earned = earnedBadges(stats({ totalBets: 1, totalVolume: 100_000 }))
    expect(earned).toEqual(expect.arrayContaining([
      BADGE_IDS.WHALE, BADGE_IDS.PRO, BADGE_IDS.INSTITUTIONAL,
    ]))
  })

  it('awards the referral tiers at their thresholds', () => {
    expect(earnedBadges(stats({ activeReferrals: 5 }))).toContain(BADGE_IDS.CONNECTOR)
    expect(earnedBadges(stats({ activeReferrals: 5 }))).not.toContain(BADGE_IDS.NETWORK)
    expect(earnedBadges(stats({ activeReferrals: 20 }))).toContain(BADGE_IDS.NETWORK)
  })

  it('returns ids in ascending order so minting is deterministic', () => {
    const earned = earnedBadges(stats({
      totalBets: 100, wonBets: 90, currentStreak: 30, totalVolume: 100_000,
      hasFiveMinBet: true, hasBigMoveWin: true, activeReferrals: 20,
    }))
    expect(earned).toEqual([...earned].sort((a, b) => a - b))
  })
})
