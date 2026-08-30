/**
 * Win streaks, computed from settled results rather than kept in a counter.
 *
 * There was a `trader_streaks` table and an updateStreak() to maintain it, and
 * nothing in the codebase ever called that function - so every streak read
 * zero and the four streak badges (On Fire, Sniper, Diamond, Legend) could
 * never be earned by anyone.
 *
 * Deriving it instead of fixing the caller is deliberate, and the same choice
 * as settleAt on the frontend. A stored counter has to be advanced exactly
 * once per settlement and in order: replay an event and it double-counts, miss
 * one and the run is lost, and neither shows up as an error. Recomputing from
 * the orders that actually settled cannot drift, and running it twice gives
 * the same answer.
 */

export interface Streaks {
  /** The run still going: wins since the last loss. */
  current: number
  /** The longest run of wins in the history given. */
  max: number
}

/**
 * @param results Whether each settled bet won, oldest first.
 */
export function streaksFrom(results: boolean[]): Streaks {
  let current = 0
  let max = 0
  for (const won of results) {
    current = won ? current + 1 : 0
    if (current > max) max = current
  }
  return { current, max }
}
