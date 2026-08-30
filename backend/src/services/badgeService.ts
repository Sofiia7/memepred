import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia
import { pg }   from '../db/pg.js'
import { BADGE_NFT_ABI, BADGE_NFT_ADDRESS, BASE_RPC_URL } from '../config.js'
import { gasGuard, recordReceipt } from '../keeper/gasGuardInstance.js'
import { earnedBadges, isMintable, type TraderStats } from './badgeRules.js'
import { streaksFrom } from './streaks.js'

const account = process.env.BADGE_MINTER_KEY
  ? privateKeyToAccount(process.env.BADGE_MINTER_KEY as `0x${string}`)
  : null

const client = account
  ? createWalletClient({ account, chain, transport: http(BASE_RPC_URL) })
  : null

const publicClient = createPublicClient({ chain, transport: http(BASE_RPC_URL) })

/** So a misconfiguration is reported once per process, not once per tick. */
let warnedAboutAddress = false

/**
 * Check and mint badges for a trader.
 * Called after each market settlement event.
 */
export async function checkAndMintBadges(traderAddress: string) {
  if (!client) {
    console.warn('Badge minter key not configured, skipping badge check')
    return
  }

  // Once, not once per badge per address per tick. config.ts falls back to the
  // literal '0x' when BADGE_NFT is unset, and viem only rejects that at send
  // time - so a variable missing from the container surfaced as a wall of
  // `Address "0x" is invalid` instead of as the configuration fault it is.
  if (!isMintable(BADGE_NFT_ADDRESS)) {
    if (!warnedAboutAddress) {
      console.error(
        `BADGE_NFT is not a contract address (${BADGE_NFT_ADDRESS || 'unset'}) - ` +
        'badge minting is disabled. Check the keeper container environment.',
      )
      warnedAboutAddress = true
    }
    return
  }

  // Cosmetic. A badge that waits for cheaper gas costs nothing, so unlike a
  // settlement this is routine work and the ceiling and daily budget apply.
  if (await gasGuard.check('routine')) return

  const stats = await getTraderStats(traderAddress)

  for (const badgeId of earnedBadges(stats)) {
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

      // Recorded only once it is actually on-chain. This used to INSERT right
      // after submission, so a mint that reverted - out of gas, minter role
      // revoked, supply exhausted - still left a row saying the badge existed,
      // and the profile page would show a badge the wallet does not own.
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      await recordReceipt(receipt, 'routine')
      if (receipt.status !== 'success') {
        console.error(`badge ${badgeId} for ${traderAddress}: mint reverted, tx ${hash}`)
        continue
      }

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

  // Derived from the settled orders, not read from a counter. trader_streaks
  // was maintained by an updateStreak() that nothing ever called, so every
  // streak read zero and the four streak badges were unreachable. Bounded to
  // the most recent 500: the longest streak badge needs 100 in a row, so
  // anything older cannot change a verdict.
  const settled = await pg.query(
    `SELECT COALESCE(payout_usdc, 0) > 0 AS won
       FROM orders
      WHERE trader_address = $1 AND status IN ('SETTLED', 'CLAIMED')
      ORDER BY settled_at DESC NULLS LAST, order_id DESC
      LIMIT 500`,
    [addr]
  )
  // The query returns newest first for the LIMIT to mean "most recent";
  // streaksFrom wants them in the order they happened.
  const streak = streaksFrom(settled.rows.map((r: { won: boolean }) => r.won).reverse())

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

  return {
    totalBets:        parseInt(r.total_bets),
    wonBets:          parseInt(r.won_bets),
    currentStreak:    streak.current,
    maxStreak:        streak.max,
    totalVolume:      parseFloat(r.total_volume),
    pepeBets:         parseInt(r.pepe_bets),
    brettBets:        parseInt(r.brett_bets),
    hasFiveMinBet:    speed.rows.length > 0,
    hasBigMoveWin:    bigMove.rows.length > 0,
    isWeeklyChampion: champion.rows.length > 0,
    activeReferrals:  parseInt(activeRefs.rows[0].n)
  }
}
