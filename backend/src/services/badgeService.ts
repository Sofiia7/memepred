import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { pg }   from '../db/pg.js'
import { BADGE_NFT_ABI, BADGE_NFT_ADDRESS, BASE_RPC_URL } from '../config.js'

const account = process.env.BADGE_MINTER_KEY
  ? privateKeyToAccount(process.env.BADGE_MINTER_KEY as `0x${string}`)
  : null

const client = account
  ? createWalletClient({ account, chain: base, transport: http(BASE_RPC_URL) })
  : null

interface TraderStats {
  address:       string
  totalBets:     number
  wonBets:       number
  currentStreak: number
  maxStreak:     number
  totalVolume:   number
  pepeBets:      number
  brettBets:     number
}

// Conditions for each badge
const BADGE_CONDITIONS: Record<number, (s: TraderStats) => boolean> = {
  1:  s => s.totalBets >= 1,                                 // Beginner
  2:  s => s.currentStreak >= 7,                             // On Fire
  3:  s => s.currentStreak >= 30,                            // Diamond
  4:  s => false,                                            // Sniper (TODO)
  5:  s => false,                                            // Speed (TODO)
  6:  s => s.totalVolume >= 500,                             // Whale
  7:  s => false,                                            // To The Moon (TODO)
  8:  s => s.totalBets >= 100 && s.wonBets / s.totalBets >= 0.80, // Oracle
  9:  s => s.currentStreak >= 100,                           // Legend
  10: s => false,                                            // Champion (TODO)
  11: s => s.pepeBets >= 50,                                 // Pepe Master
  12: s => s.brettBets >= 50,                                // Brett Fan
  13: s => s.totalVolume >= 10_000,                          // Pro
  14: s => s.totalVolume >= 100_000,                         // Institutional
  15: s => false,                                            // Connector (TODO)
  16: s => false,                                            // Network (TODO)
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
  const result = await pg.query(`
    SELECT
      COUNT(*)                                           AS total_bets,
      COUNT(*) FILTER (WHERE won = true)                AS won_bets,
      COALESCE(SUM(amount_usdc), 0)                     AS total_volume,
      COUNT(*) FILTER (WHERE feed_symbol = 'PEPE')      AS pepe_bets,
      COUNT(*) FILTER (WHERE feed_symbol = 'BRETT')     AS brett_bets
    FROM bets
    WHERE trader_address = $1 AND settled_at IS NOT NULL
  `, [address.toLowerCase()])

  const streak = await pg.query(
    'SELECT current_streak, max_streak FROM trader_streaks WHERE trader_address = $1',
    [address.toLowerCase()]
  )

  const r = result.rows[0]
  const s = streak.rows[0] || { current_streak: 0, max_streak: 0 }

  return {
    address,
    totalBets:     parseInt(r.total_bets),
    wonBets:       parseInt(r.won_bets),
    currentStreak: parseInt(s.current_streak),
    maxStreak:     parseInt(s.max_streak),
    totalVolume:   parseFloat(r.total_volume),
    pepeBets:      parseInt(r.pepe_bets),
    brettBets:     parseInt(r.brett_bets)
  }
}
