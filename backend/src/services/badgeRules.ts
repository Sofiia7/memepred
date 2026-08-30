/**
 * Which badges an address has earned, as a pure function of its stats.
 *
 * Split out of badgeService.ts so the rules can be read and tested without a
 * database, a wallet or an RPC - and so the thresholds sit in one place rather
 * than being inferred from a map of closures.
 */

export interface TraderStats {
  totalBets:        number
  wonBets:          number
  currentStreak:    number
  maxStreak:        number
  /** Settled volume in USDC, filled amounts only. */
  totalVolume:      number
  pepeBets:         number
  brettBets:        number
  hasFiveMinBet:    boolean
  hasBigMoveWin:    boolean
  isWeeklyChampion: boolean
  activeReferrals:  number
}

/** Named ids, matching BadgeGrid in the frontend and the on-chain badge ids. */
export const BADGE_IDS = {
  BEGINNER:      1,
  ON_FIRE:       2,
  DIAMOND:       3,
  SNIPER:        4,
  SPEED:         5,
  WHALE:         6,
  TO_THE_MOON:   7,
  ORACLE:        8,
  LEGEND:        9,
  CHAMPION:      10,
  PEPE_MASTER:   11,
  BRETT_FAN:     12,
  PRO:           13,
  INSTITUTIONAL: 14,
  CONNECTOR:     15,
  NETWORK:       16,
} as const

const CONDITIONS: Record<number, (s: TraderStats) => boolean> = {
  [BADGE_IDS.BEGINNER]:      s => s.totalBets >= 1,
  [BADGE_IDS.ON_FIRE]:       s => s.currentStreak >= 7,
  [BADGE_IDS.DIAMOND]:       s => s.currentStreak >= 30,
  [BADGE_IDS.SNIPER]:        s => s.currentStreak >= 10,
  [BADGE_IDS.SPEED]:         s => s.hasFiveMinBet,
  [BADGE_IDS.WHALE]:         s => s.totalVolume >= 500,
  [BADGE_IDS.TO_THE_MOON]:   s => s.hasBigMoveWin,
  // Guarded against a zero denominator: 0/0 is NaN, and NaN >= 0.8 is false,
  // so the count check is what actually carries it - but relying on that is
  // the kind of thing that stops being true when somebody rewrites the line.
  [BADGE_IDS.ORACLE]:        s => s.totalBets >= 100 && s.wonBets / Math.max(s.totalBets, 1) >= 0.8,
  [BADGE_IDS.LEGEND]:        s => s.currentStreak >= 100,
  [BADGE_IDS.CHAMPION]:      s => s.isWeeklyChampion,
  [BADGE_IDS.PEPE_MASTER]:   s => s.pepeBets >= 50,
  [BADGE_IDS.BRETT_FAN]:     s => s.brettBets >= 50,
  [BADGE_IDS.PRO]:           s => s.totalVolume >= 10_000,
  [BADGE_IDS.INSTITUTIONAL]: s => s.totalVolume >= 100_000,
  [BADGE_IDS.CONNECTOR]:     s => s.activeReferrals >= 5,
  [BADGE_IDS.NETWORK]:       s => s.activeReferrals >= 20,
}

/**
 * Every badge the stats qualify for, ascending.
 *
 * Tiers are cumulative on purpose: a 30-long streak earns On Fire and Sniper
 * as well as Diamond. Awarding only the highest would leave the lower ones
 * permanently unearnable, since the streak resets on the next loss.
 *
 * Ascending order so a minting run is deterministic and a partial failure
 * resumes at the same place.
 */
export function earnedBadges(stats: TraderStats): number[] {
  return Object.entries(CONDITIONS)
    .filter(([, meets]) => meets(stats))
    .map(([id]) => Number(id))
    .sort((a, b) => a - b)
}
