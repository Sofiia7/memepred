import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type Log
} from 'viem'
import { base } from 'viem/chains'
import { pg }   from '../db/pg.js'

const RPC = process.env.BASE_RPC_URL

const client = createPublicClient({ chain: base, transport: http(RPC) })

const FACTORY = process.env.MARKET_FACTORY as Address

// ── ABI fragments (events only) ────────────────────────────
const E_MARKET_CREATED  = parseAbiItem('event MarketCreated(address indexed market, bytes32 indexed feedId, uint256 duration, uint256 timestamp)')
const E_ORDER_PLACED    = parseAbiItem('event OrderPlaced(uint256 indexed orderId, address indexed trader, uint8 dir, uint256 amount)')
const E_ORDER_MATCHED   = parseAbiItem('event OrderMatched(uint256 indexed matchId, uint256 upId, uint256 downId, uint256 entryPrice)')
const E_LP_MATCHED      = parseAbiItem('event LPMatched(uint256 indexed matchId, uint256 orderId, uint256 entryPrice)')
const E_MATCH_SETTLED   = parseAbiItem('event MatchSettled(uint256 indexed matchId, bool upWon, uint256 entry, uint256 exit)')
const E_CLAIMED         = parseAbiItem('event Claimed(uint256 indexed orderId, address trader, uint256 payout)')
const E_REFERRAL_REGD   = parseAbiItem('event ReferralRegistered(address indexed referee, address indexed referrer)')

const CHUNK = 5_000n  // RPC log-window

async function getCursor(stream: string): Promise<bigint> {
  const r = await pg.query('SELECT last_block FROM _indexer_cursor WHERE stream = $1', [stream])
  if (r.rowCount === 0) return 0n
  return BigInt(r.rows[0].last_block)
}

async function setCursor(stream: string, block: bigint) {
  await pg.query(`
    INSERT INTO _indexer_cursor(stream, last_block, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (stream) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = NOW()
  `, [stream, block.toString()])
}

async function activeMarkets(): Promise<Address[]> {
  const r = await pg.query("SELECT market_address FROM markets WHERE status = 'OPEN' OR status = 'RESOLVED'")
  return r.rows.map(x => x.market_address as Address)
}

/// Scan MarketFactory.MarketCreated and create rows in `markets` table.
async function indexFactory(toBlock: bigint) {
  const stream = 'factory'
  const from   = (await getCursor(stream)) + 1n
  if (from > toBlock) return

  for (let start = from; start <= toBlock; start += CHUNK) {
    const end = start + CHUNK - 1n > toBlock ? toBlock : start + CHUNK - 1n
    const logs = await client.getLogs({
      address: FACTORY,
      event:   E_MARKET_CREATED,
      fromBlock: start,
      toBlock:   end
    })
    for (const log of logs) {
      const { market, feedId, duration, timestamp } = (log as any).args
      const closeTs = Number(timestamp) + Number(duration)
      await pg.query(`
        INSERT INTO markets(market_address, feed_id, feed_symbol, duration_secs, open_time, close_time, status)
        VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6), 'OPEN')
        ON CONFLICT (market_address) DO NOTHING
      `, [market.toLowerCase(), feedId, feedSymbolFromId(feedId), Number(duration), Number(timestamp), closeTs])
    }
    await setCursor(stream, end)
  }
}

function feedSymbolFromId(feedId: string): string {
  // Map known Pyth feed IDs → human symbol. Extend when adding coins.
  const map: Record<string, string> = {
    '0xd69731a2e74ac1ce884fc3890f7ee324b6deb66147055249568869ed700882e4': 'PEPE',
    '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c': 'DOGE'
  }
  return map[feedId.toLowerCase()] ?? 'UNKNOWN'
}

/// Scan OrderbookMarket events for all known markets.
async function indexMarketEvents(toBlock: bigint) {
  const markets = await activeMarkets()
  if (markets.length === 0) return

  const stream = 'orderbook'
  const from   = (await getCursor(stream)) + 1n
  if (from > toBlock) return

  for (let start = from; start <= toBlock; start += CHUNK) {
    const end = start + CHUNK - 1n > toBlock ? toBlock : start + CHUNK - 1n

    const [placed, matched, lpMatched, settled, claimed] = await Promise.all([
      client.getLogs({ address: markets, event: E_ORDER_PLACED,  fromBlock: start, toBlock: end }),
      client.getLogs({ address: markets, event: E_ORDER_MATCHED, fromBlock: start, toBlock: end }),
      client.getLogs({ address: markets, event: E_LP_MATCHED,    fromBlock: start, toBlock: end }),
      client.getLogs({ address: markets, event: E_MATCH_SETTLED, fromBlock: start, toBlock: end }),
      client.getLogs({ address: markets, event: E_CLAIMED,       fromBlock: start, toBlock: end })
    ])

    for (const log of placed) {
      const a = (log as any).args
      await pg.query(`
        INSERT INTO bets(market_address, trader_address, direction, amount_usdc, placed_at, feed_symbol, order_id)
        SELECT $1, $2, $3, $4::numeric / 1e6, to_timestamp($5), m.feed_symbol, $6
        FROM markets m WHERE m.market_address = $1
        ON CONFLICT DO NOTHING
      `, [log.address.toLowerCase(), a.trader.toLowerCase(),
          a.dir === 0 ? 'UP' : 'DOWN', a.amount.toString(),
          await blockTs(log.blockNumber!), a.orderId.toString()])
    }
    for (const log of matched) {
      const a = (log as any).args
      await pg.query(`UPDATE bets SET match_id=$1 WHERE market_address=$2 AND order_id IN ($3,$4)`,
        [a.matchId.toString(), log.address.toLowerCase(), a.upId.toString(), a.downId.toString()])
    }
    for (const log of lpMatched) {
      const a = (log as any).args
      await pg.query(`UPDATE bets SET match_id=$1 WHERE market_address=$2 AND order_id=$3`,
        [a.matchId.toString(), log.address.toLowerCase(), a.orderId.toString()])
    }
    for (const log of settled) {
      const a = (log as any).args
      // Mark every bet of this match as won/lost.
      await pg.query(`
        UPDATE bets SET won = CASE WHEN direction='UP' THEN $2 ELSE NOT $2 END,
                       settled_at = to_timestamp($3)
        WHERE market_address=$4 AND match_id=$1
      `, [a.matchId.toString(), a.upWon, await blockTs(log.blockNumber!), log.address.toLowerCase()])
    }
    for (const log of claimed) {
      const a = (log as any).args
      await pg.query(`
        UPDATE bets SET claimed=true, payout_usdc=$1::numeric/1e6
        WHERE market_address=$2 AND order_id=$3
      `, [a.payout.toString(), log.address.toLowerCase(), a.orderId.toString()])
    }

    await setCursor(stream, end)
  }
}

async function indexReferrals(toBlock: bigint) {
  const reg = process.env.REFERRAL_REGISTRY as Address
  if (!reg) return
  const stream = 'referrals'
  const from   = (await getCursor(stream)) + 1n
  if (from > toBlock) return

  for (let start = from; start <= toBlock; start += CHUNK) {
    const end  = start + CHUNK - 1n > toBlock ? toBlock : start + CHUNK - 1n
    const logs = await client.getLogs({
      address: reg,
      event:   E_REFERRAL_REGD,
      fromBlock: start, toBlock: end
    })
    for (const log of logs) {
      const a = (log as any).args
      await pg.query(`
        INSERT INTO referrals(referrer_address, referee_address)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [a.referrer.toLowerCase(), a.referee.toLowerCase()])
    }
    await setCursor(stream, end)
  }
}

const tsCache = new Map<bigint, number>()
async function blockTs(bn: bigint): Promise<number> {
  if (tsCache.has(bn)) return tsCache.get(bn)!
  const b = await client.getBlock({ blockNumber: bn })
  const ts = Number(b.timestamp)
  tsCache.set(bn, ts)
  return ts
}

/// Single tick of the indexer — called by keeper main loop every N seconds.
export async function indexerTick() {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS _indexer_cursor (
      stream      TEXT PRIMARY KEY,
      last_block  TEXT NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  const head = await client.getBlockNumber()
  await indexFactory(head)
  await indexMarketEvents(head)
  await indexReferrals(head)
}
