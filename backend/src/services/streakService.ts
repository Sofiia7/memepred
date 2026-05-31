import { pg } from '../db/pg.js'

/**
 * Update trader's win/loss streak after a bet settles.
 */
export async function updateStreak(traderAddress: string, won: boolean) {
  const addr = traderAddress.toLowerCase()

  const existing = await pg.query(
    'SELECT current_streak, max_streak FROM trader_streaks WHERE trader_address = $1',
    [addr]
  )

  let currentStreak: number
  let maxStreak: number

  if (existing.rows.length === 0) {
    currentStreak = won ? 1 : 0
    maxStreak = currentStreak

    await pg.query(
      `INSERT INTO trader_streaks (trader_address, current_streak, max_streak, last_bet_date, updated_at)
       VALUES ($1, $2, $3, CURRENT_DATE, NOW())`,
      [addr, currentStreak, maxStreak]
    )
  } else {
    const row = existing.rows[0]
    currentStreak = won ? parseInt(row.current_streak) + 1 : 0
    maxStreak = Math.max(currentStreak, parseInt(row.max_streak))

    await pg.query(
      `UPDATE trader_streaks
       SET current_streak = $1, max_streak = $2, last_bet_date = CURRENT_DATE, updated_at = NOW()
       WHERE trader_address = $3`,
      [currentStreak, maxStreak, addr]
    )
  }

  // Sprint 3.3: the orders table doesn't carry per-row streak — keep streak
  // only on trader_streaks. The leaderboard/profile already JOIN this table.
  return { currentStreak, maxStreak }
}
