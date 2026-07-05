import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia
import { pg }   from '../db/pg.js'
import { BADGE_NFT_ABI, BADGE_NFT_ADDRESS, BASE_RPC_URL } from '../config.js'

const account = process.env.BADGE_MINTER_KEY
  ? privateKeyToAccount(process.env.BADGE_MINTER_KEY as `0x${string}`)
  : null

const client = account
  ? createWalletClient({ account, chain, transport: http(BASE_RPC_URL) })
  : null

interface TraderStats {
  address:          string
  totalBets:        number
  wonBets:          number
  currentStreak:    number
  maxStreak:        number
  totalVolume:      number
  pepeBets:         number
  brettBets:        number
  hasFiveMinBet:    boolean // Sprint 5.5: badge 5 "Speed"
  hasBigMoveWin:    boolean // Sprint 5.5: badge 7 "To The Moon"
  isWeeklyChampion: boolean // Sprint 5.5: badge 10 "Champion"
  activeReferrals:  number  // Sprint 5.5: badges 15/16 "Connector"/"Network"
}

// Conditions for each badge
const BADGE_CONDITIONS: Record<number, (s: TraderStats) => boolean> = {
  1:  s => s.totalBets >= 1,                                 // Beginner
  2:  s => s.currentStreak >= 7,                             // On Fire
  3:  s => s.currentStreak >= 30,                            // Diamond
  4:  s => s.currentStreak >= 10,                            // Sniper — 10 correct in a row
  5:  s => s.hasFiveMinBet,                                  // Speed — played the fastest (5-min) market
  6:  s => s.totalVolume >= 500,                             // Whale
  7:  s => s.hasBigMoveWin,                                  // To The Moon — won a bet on a 10%+ price move
  8:  s => s.totalBets >= 100 && s.wonBets / s.totalBets >= 0.80, // Oracle
  9:  s => s.currentStreak >= 100,                           // Legend
  10: s => s.isWeeklyChampion,                               // Champion — #1 on the weekly leaderboard
  11: s => s.pepeBets >= 50,                                 // Pepe Master
  12: s => s.brettBets >= 50,                                // Brett Fan
  13: s => s.totalVolume >= 10_000,                          // Pro
  14: s => s.totalVolume >= 100_000,                         // Institutional
  15: s => s.activeReferrals >= 5,                           // Connector — 5 active referrals
  16: s => s.activeReferrals >= 20,                          // Network — 20 active referrals
}

/**
 * Check and mint badges for a trader.
 * Called after each market settlement event.
 */
export async function checkAndMintBadges(traderAddress: string) {
  if (!client) {
    console.warn('Badge minter key not configured, skipping badge check')
    return
  }

  const stats = await getTraderStats(traderAddress)

  for (const [badgeIdStr, condition] of Object.entries(BADGE_CONDITIONS)) {
    const badgeId = parseInt(badgeIdStr)
    if (!condition(stats)) continue

    // Check if badge already minted (off-chain cache)
    const existing = await pg.query(
      'SELECT 1 FROM minted_badges WHERE trader_address = $1 AND badge_id = $2',
      [traderAddress, badgeId]
    )
    if (existing.rows.length > 0) continue

    try {
      const hash = await client.writeContract({
        address: BADGE_NFT_ADDRESS,
        abi:     BADGE_NFT_ABI,
        functionName: 'mintBadge',
        args: [traderAddress as `0x${string}`, BigInt(badgeId)]
      })

      await pg.query(
        'INSERT INTO minted_badges (trader_address, badge_id, tx_hash, minted_at) VALUES ($1, $2, $3, NOW())',
        [traderAddress, badgeId, hash]
      )

      console.log(`Minted badge ${badgeId} for ${traderAddress}, tx: ${hash}`)
    } catch (err) {
      console.error(`Failed to mint badge ${badgeId} for ${traderAddress}:`, err)
    }
  }
}

async function getTraderStats(address: string): Promise<TraderStats> {
  const addr = address.toLowerCase()

  // Sprint 3.3: rewritten against orders. "Won" derives from payout > 0.
  // Volume uses filled_amount so a half-filled-then-refunded order doesn't
  // inflate stats.
  const result = await pg.query(`
    SELECT
      COUNT(*)                                                       AS total_bets,
      COUNT(*) FILTER (WHERE COALESCE(payout_usdc, 0) > 0)           AS won_bets,
      COALESCE(SUM(filled_amount), 0)                                 AS total_volume,
      COUNT(*) FILTER (WHERE feed_symbol = 'PEPE')                   AS pepe_bets,
      COUNT(*) FILTER (WHERE feed_symbol = 'BRETT')                  AS brett_bets
    FROM orders
    WHERE trader_address = $1 AND status IN ('SETTLED', 'CLAIMED')
  `, [addr])

  const streak = await pg.query(
    'SELECT current_streak, max_streak FROM trader_streaks WHERE trader_address = $1',
    [addr]
  )

  // Badge 5 "Speed": played on the fastest (5-minute) market.
  const speed = await pg.query(`
    SELECT 1 FROM orders o
    JOIN markets m ON m.market_address = o.market_address
    WHERE o.trader_address = $1 AND m.duration_secs = 300
      AND o.status IN ('SETTLED', 'CLAIMED')
    LIMIT 1
  `, [addr])

  // Badge 7 "To The Moon": won a match where price moved >= 10% from entry.
  const bigMove = await pg.query(`
    SELECT 1
    FROM orders o
    JOIN order_matches om ON om.market_address = o.market_address AND om.order_id = o.order_id
    JOIN matches m        ON m.market_address  = om.market_address AND m.match_id = om.match_id
    WHERE o.trader_address = $1
      AND COALESCE(o.payout_usdc, 0) > 0
      AND m.exit_price IS NOT NULL AND m.entry_price > 0
      AND ABS(m.exit_price - m.entry_price) / m.entry_price >= 0.10
    LIMIT 1
  `, [addr])

  // Badge 10 "Champion": rank 1 on the weekly leaderboard right now.
  // Mirrors routes/leaderboard.ts's weekly ranking (accuracy DESC, volume
  // DESC, min 5 settled bets in the window).
  const champion = await pg.query(`
    SELECT trader_address FROM (
      SELECT
        trader_address,
        ROUND(
          COUNT(*) FILTER (WHERE COALESCE(payout_usdc, 0) > 0)::numeric
          / NULLIF(COUNT(*), 0) * 100, 1
        ) AS accuracy_pct,
        COALESCE(SUM(filled_amount), 0) AS total_volume
      FROM orders
      WHERE status IN ('SETTLED', 'CLAIMED') AND settled_at > NOW() - INTERVAL '7 days'
      GROUP BY trader_address
      HAVING COUNT(*) >= 5
      ORDER BY accuracy_pct DESC, total_volume DESC
      LIMIT 1
    ) top
    WHERE trader_address = $1
  `, [addr])

  // Badges 15/16 "Connector"/"Network": referrals who've actually placed a bet.
  const activeRefs = await pg.query(`
    SELECT COUNT(*) AS n FROM referrals r
    WHERE r.referrer_address = $1
      AND EXISTS (SELECT 1 FROM orders o WHERE o.trader_address = r.referee_address)
  `, [addr])

  const r = result.rows[0]
  const s = streak.rows[0] || { current_streak: 0, max_streak: 0 }

  return {
    address,
    totalBets:        parseInt(r.total_bets),
    wonBets:          parseInt(r.won_bets),
    currentStreak:    parseInt(s.current_streak),
    maxStreak:        parseInt(s.max_streak),
    totalVolume:      parseFloat(r.total_volume),
    pepeBets:         parseInt(r.pepe_bets),
    brettBets:        parseInt(r.brett_bets),
    hasFiveMinBet:    speed.rows.length > 0,
    hasBigMoveWin:    bigMove.rows.length > 0,
    isWeeklyChampion: champion.rows.length > 0,
    activeReferrals:  parseInt(activeRefs.rows[0].n)
  }
}
