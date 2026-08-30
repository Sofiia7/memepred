import { describe, it, expect } from 'vitest'
import { earnedBadges, isMintable, BADGE_IDS, type TraderStats } from './badgeRules.js'

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

/**
 * The sweep found this the hard way on its first production tick.
 *
 * config.ts falls back to the literal '0x' when BADGE_NFT is unset, which is a
 * valid-looking nothing, and docker-compose had never passed that variable to
 * the keeper - correctly, until the badge sweep made it a read path. Every mint
 * then failed with `Address "0x" is invalid`, once per earned badge per address
 * per tick: 138 error lines in ten minutes, each a full viem error object, on a
 * box whose logs filled the disk once already.
 *
 * A missing address is a configuration fault. It should be said once and stop,
 * not rediscovered per badge.
 */
describe('isMintable', () => {
  it('refuses the placeholder config.ts falls back to', () => {
    expect(isMintable('0x')).toBe(false)
  })

  it('refuses an unset or empty address', () => {
    expect(isMintable(undefined)).toBe(false)
    expect(isMintable('')).toBe(false)
  })

  it('refuses the zero address', () => {
    expect(isMintable('0x0000000000000000000000000000000000000000')).toBe(false)
  })

  it('accepts a real contract address', () => {
    expect(isMintable('0xa044D7D8B3361aB8799f0055D81310A5C8e96483')).toBe(true)
  })
})
