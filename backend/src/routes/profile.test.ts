import { describe, it, expect, vi, beforeAll } from 'vitest'
import Fastify from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')

function stripTimescale(sql: string): string {
  return sql
    .replace(/CREATE EXTENSION IF NOT EXISTS timescaledb;/g, '')
    .replace(/SELECT create_hypertable\([^;]*\);/g, '')
}

const db = new PGlite()

vi.mock('../db/pg.js', () => ({ pg: { query: (sql: string, params?: any[]) => db.query(sql, params) } }))
vi.mock('../db/redis.js', () => ({
  redis: { get: vi.fn(async () => null), setEx: vi.fn(async () => {}) },
}))

const { profileRoutes } = await import('./profile.js')

async function build() {
  const app = Fastify()
  await app.register(profileRoutes, { prefix: '/api/profile' })
  await app.ready()
  return app
}

const TRADER = '0x00000000000000000000000000000000000000bb'
const MARKET = '0x00000000000000000000000000000000000000aa'

beforeAll(async () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    await db.exec(stripTimescale(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')))
  }
})

describe('GET /api/profile/:address, PNL/WON vs. emergency-refunded matches (audit A03/A04, 2026-09-28)', () => {
  /**
   * Before A03, an emergency-refunded match's `settled` column stayed FALSE
   * forever, so WON_EXPR/PNL_EXPR's `m.settled` guard excluded it from this
   * math entirely - dormant, not correct. A03 makes `settled` correctly read
   * TRUE, which would have exposed up_won's meaningless default (never set
   * by emergencyRefundMatch) as a phantom win for every DOWN order and a
   * phantom loss for every UP one, had WON_EXPR/PNL_EXPR not been updated to
   * exclude emergency_refunded matches explicitly alongside tied ones.
   */
  it('counts an emergency-refunded match as PnL-neutral for a DOWN order, not a phantom win', async () => {
    await db.query(
      `INSERT INTO orders (market_address, order_id, trader_address, direction, amount_usdc, filled_amount, status, placed_at, feed_symbol)
       VALUES ($1, 1, $2, 'DOWN', 0.01, 0.01, 'REFUNDED', NOW(), 'TEST')`,
      [MARKET, TRADER],
    )
    await db.query(
      `INSERT INTO matches (market_address, match_id, is_lp_match, amount_usdc, entry_price, matched_at, settle_at, settled, tied, up_won, emergency_refunded)
       VALUES ($1, 1, FALSE, 0.01, 1, NOW(), NOW(), TRUE, FALSE, FALSE, TRUE)`,
      [MARKET],
    )
    await db.query(
      `INSERT INTO order_matches (market_address, order_id, match_id, matched_amount) VALUES ($1, 1, 1, 0.01)`,
      [MARKET],
    )

    const app = await build()
    const res = await app.inject({ url: `/api/profile/${TRADER}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    // (direction='UP')=false vs up_won's default false would read as "won"
    // without the emergency_refunded exclusion - the bug this test pins.
    expect(body.profit).toBe(0)
    expect(body.wonBets).toBe(0)
  })
})
