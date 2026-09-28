import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

const pgQuery = vi.fn()

vi.mock('../db/pg.js', () => ({ pg: { query: (...args: unknown[]) => pgQuery(...args) } }))
vi.mock('../db/redis.js', () => ({
  redis: { get: vi.fn(async () => null), setEx: vi.fn(async () => {}) },
}))

const { marketsRoutes } = await import('./markets.js')

async function build() {
  const app = Fastify()
  await app.register(marketsRoutes, { prefix: '/api/markets' })
  await app.ready()
  return app
}

const MARKET = '0x00000000000000000000000000000000000000aa'

const orderRow = (over: Record<string, unknown> = {}) => ({
  order_id: '5',
  trader_address: '0x00000000000000000000000000000000000000bb',
  direction: 'UP',
  amount_usdc: '0.020000000000000000',
  filled_amount: '0.020000000000000000',
  status: 'REFUNDED',
  payout_usdc: '0.020000000000000000',
  unmatched_refunded: false,
  placed_at: new Date('2026-09-28T00:00:00Z'),
  ...over,
})

const matchRow = (over: Record<string, unknown> = {}) => ({
  match_id: '1',
  is_lp_match: false,
  matched_amount: '0.010000000000000000',
  entry_price: '1000000000000000000',
  exit_price: '2000000000000000000',
  settled: true,
  tied: false,
  up_won: true,
  emergency_refunded: false,
  settle_at: new Date('2026-09-28T00:05:00Z'),
  settled_at: new Date('2026-09-28T00:05:01Z'),
  ...over,
})

beforeEach(() => {
  pgQuery.mockReset()
})

describe('GET /api/markets/:address/orders/:orderId (audit A04, 2026-09-28)', () => {
  it('404s when the order does not exist', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [] })
    const app = await build()
    const res = await app.inject({ url: `/api/markets/${MARKET}/orders/999` })
    expect(res.statusCode).toBe(404)
  })

  it('rejects a non-numeric order id before touching the database', async () => {
    const app = await build()
    const res = await app.inject({ url: `/api/markets/${MARKET}/orders/not-a-number` })
    expect(res.statusCode).toBe(400)
    expect(pgQuery).not.toHaveBeenCalled()
  })

  /**
   * The exact shape AuditCases.t.sol's test_Audit_RefundedOrderCanStillHaveClaimableWinnings
   * proves on chain: one match won, a later one was emergency-refunded, and the
   * contract forces order.status to REFUNDED regardless. The old UI's single-enum
   * switch rendered the REFUNDED branch and never offered the win. This endpoint's
   * job is to expose both outcomes so the frontend can.
   */
  it('reports one win and one emergency refund as two distinct match outcomes, not one REFUNDED order', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [orderRow()] })
    pgQuery.mockResolvedValueOnce({
      rows: [
        matchRow({ match_id: '1', up_won: true, exit_price: '2000000000000000000' }),
        matchRow({ match_id: '2', emergency_refunded: true, up_won: false, exit_price: '0' }),
      ],
    })

    const app = await build()
    const res = await app.inject({ url: `/api/markets/${MARKET}/orders/5` })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.status).toBe('REFUNDED')
    expect(body.payout).toBe(0.02) // still claimable - see claim()'s real conditions
    expect(body.matches).toHaveLength(2)
    expect(body.matches[0].outcome).toBe('won')
    expect(body.matches[1].outcome).toBe('emergency_refunded')
  })

  it('labels a tie distinctly from a loss, for a DOWN order', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [orderRow({ direction: 'DOWN' })] })
    pgQuery.mockResolvedValueOnce({ rows: [matchRow({ tied: true, up_won: false })] })

    const app = await build()
    const res = await app.inject({ url: `/api/markets/${MARKET}/orders/5` })
    expect(res.json().matches[0].outcome).toBe('tied')
  })

  it('labels a genuine loss correctly for a DOWN order beaten by an UP win', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [orderRow({ direction: 'DOWN' })] })
    pgQuery.mockResolvedValueOnce({ rows: [matchRow({ tied: false, up_won: true })] })

    const app = await build()
    const res = await app.inject({ url: `/api/markets/${MARKET}/orders/5` })
    expect(res.json().matches[0].outcome).toBe('lost')
  })

  it('labels an unsettled match as pending regardless of up_won', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [orderRow({ status: 'MATCHED' })] })
    pgQuery.mockResolvedValueOnce({ rows: [matchRow({ settled: false, up_won: false })] })

    const app = await build()
    const res = await app.inject({ url: `/api/markets/${MARKET}/orders/5` })
    expect(res.json().matches[0].outcome).toBe('pending')
  })
})
