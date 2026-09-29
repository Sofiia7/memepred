import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Portfolio } from './Portfolio'

/**
 * The portfolio: which orders are "Ready to claim", what each row calls its
 * result, and what a claim or cancel started from a row does and says.
 *
 * Two rules of the old page were wrong: "WON" was printed as soon as ONE match
 * of an order won, and only a SETTLED order could be listed as claimable, so a
 * REFUNDED order that still held the winnings of another match never was. The
 * page also started claims that ended at the transaction hash and threw their
 * errors away.
 */

const TRADER = '0x00000000000000000000000000000000000000bb'
const MARKET = '0x00000000000000000000000000000000000000aa'
const MARKET_2 = '0x00000000000000000000000000000000000000dd'

let connected: boolean
let profileBody: any
let claimCalls: any[]
let cancelCalls: any[]
let actions: any
let capturedOptions: any
let fetchMock: ReturnType<typeof vi.fn>

// Robinhood-style amounts (18 decimals, four shown), whatever network the test
// environment is built for: the row texts below are asserted digit for digit.
vi.mock('../lib/chain', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/chain')>()
  return {
    ...real,
    IS_POOL_BACKED: true,
    CURRENCY: { decimals: 18, symbol: 'WETH', minBet: '0.005', maxBet: '0.04', displayDecimals: 4 },
  }
})
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: connected ? TRADER : undefined, isConnected: connected }),
}))
vi.mock('../hooks/useReferral', () => ({
  useReferral: () => ({
    myCode: null, myReferralCount: 0n, claimableRewards: 0n, busy: false,
    generateMyCode: vi.fn(), claimRewards: vi.fn(),
  }),
}))
vi.mock('../hooks/useConnectWallet', () => ({ useConnectWallet: () => ({ connectWallet: vi.fn() }) }))
vi.mock('../components/BadgeGrid', () => ({ BadgeGrid: () => null }))
vi.mock('../components/ui/AppShell', () => ({
  ScreenTitle: ({ title }: { title: string }) => <h2>{title}</h2>,
  StatStrip: ({ items }: { items: { k: string; v: unknown; u?: string }[] }) => (
    <div data-testid="stats">{items.map((i) => `${i.k}: ${String(i.v)}${i.u ? ` (${i.u})` : ''}`).join(' | ')}</div>
  ),
}))
vi.mock('../hooks/useOrderActions', () => ({
  useOrderActions: (_market: unknown, opts: unknown) => {
    capturedOptions = opts
    return actions
  },
}))

const row = (over: Record<string, unknown> = {}) => ({
  market_address: MARKET, order_id: '5', match_id: '1', direction: 'UP',
  amount_usdc: '0.01', filled_amount: '0.01', payout_usdc: '0.0196',
  won: true, tied: false, claimed: false, status: 'SETTLED',
  placed_at: '2026-09-29T00:00:00Z', settled_at: '2026-09-29T00:05:00Z', feed_symbol: 'PEPE',
  ...over,
})

const profile = (rows: unknown[]) => ({
  address: TRADER, totalBets: 3, wonBets: 1, accuracy: 33.3, totalVolume: 0.03, profit: 0.0096,
  currentStreak: 1, maxStreak: 2, badges: [], recentBets: rows,
})

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

function renderPortfolio() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/portfolio']}>
        <Where />
        <Portfolio />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The list under a heading such as "Ready to claim (1)". */
const listUnder = (heading: RegExp) => {
  const title = screen.getByText(heading)
  return title.nextElementSibling as HTMLElement
}

beforeEach(() => {
  connected = true
  profileBody = profile([])
  claimCalls = []
  cancelCalls = []
  capturedOptions = undefined
  actions = {
    state: { phase: 'idle' },
    isPending: false,
    claim: vi.fn(async (...args: unknown[]) => { claimCalls.push(args); return true }),
    cancel: vi.fn(async (...args: unknown[]) => { cancelCalls.push(args); return true }),
    refundExpired: vi.fn(),
    recover: vi.fn(),
    reset: vi.fn(),
  }
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => profileBody }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('Portfolio: Ready to claim', () => {
  it('lists a REFUNDED order that still has a payout (audit A04) - only SETTLED used to be listed', async () => {
    profileBody = profile([
      row({ order_id: '1', status: 'REFUNDED', payout_usdc: '0.0196' }),
      row({ order_id: '2', status: 'SETTLED', payout_usdc: '0.0196' }),
    ])
    renderPortfolio()

    await screen.findByText('Ready to claim (2)')
    const list = listUnder(/Ready to claim/)
    expect(within(list).getAllByRole('button', { name: 'CLAIM' })).toHaveLength(2)
  })

  it('does not list a loss, a refund with nothing left, a claimed order or a running one', async () => {
    profileBody = profile([
      row({ order_id: '1', won: false, payout_usdc: '0' }),
      row({ order_id: '2', status: 'REFUNDED', won: false, payout_usdc: '0' }),
      row({ order_id: '3', status: 'CLAIMED', claimed: true }),
      row({ order_id: '4', status: 'MATCHED', won: null, payout_usdc: null }),
    ])
    renderPortfolio()

    await screen.findByText('Recent bets')
    expect(screen.queryByText(/Ready to claim/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'CLAIM' })).toBeNull()
  })

  it('claiming from a row claims that order on that market, and does not navigate', async () => {
    profileBody = profile([row({ order_id: '7', market_address: MARKET_2 })])
    renderPortfolio()

    const button = await screen.findAllByRole('button', { name: 'CLAIM' })
    fireEvent.click(button[0])

    expect(claimCalls).toEqual([[7n, MARKET_2]])
    // The row itself is a link to the order page; the button must not follow it.
    expect(screen.getByTestId('where').textContent).toBe('/portfolio')
  })

  it('drops a row from the list once its claim is confirmed, and reloads the profile', async () => {
    profileBody = profile([row({ order_id: '7' })])
    renderPortfolio()
    await screen.findByText('Ready to claim (1)')
    const before = fetchMock.mock.calls.length

    await act(async () => {
      capturedOptions.onConfirmed({ action: 'claim', hash: '0xh', market: MARKET, id: 7n })
    })

    // The API is behind the chain for a while; the row must not come back.
    await waitFor(() => expect(screen.queryByText(/Ready to claim/)).toBeNull())
    expect(screen.queryByRole('button', { name: 'CLAIM' })).toBeNull()
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before))
  })

  it('disables every action while one transaction is in flight', async () => {
    profileBody = profile([row({ order_id: '1' }), row({ order_id: '2' })])
    actions.isPending = true
    renderPortfolio()

    const buttons = await screen.findAllByRole('button', { name: 'CLAIM' })
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a claim\'s error under its row instead of dropping it', async () => {
    profileBody = profile([row({ order_id: '7' })])
    actions.state = { phase: 'failed', label: 'Claim', error: 'There is nothing to claim on this order.', market: MARKET, id: 7n }
    renderPortfolio()

    const alerts = await screen.findAllByRole('alert')
    expect(alerts[0].textContent).toBe('Claim failed: There is nothing to claim on this order.')
  })

  it('does not show one row\'s transaction under another row', async () => {
    profileBody = profile([row({ order_id: '7' }), row({ order_id: '8', status: 'REFUNDED' })])
    actions.state = { phase: 'submitted', label: 'Claim', hash: '0xh', market: MARKET, id: 7n }
    renderPortfolio()

    await screen.findByText('Ready to claim (2)')
    // Row 7 appears twice (Ready to claim, Recent bets), row 8 never shows a status.
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })
})

describe('Portfolio: what each row calls its result (audit U08)', () => {
  it('WIN, MIXED, LOSS, TIE, REFUNDED and OPEN - and never "WON" for a single winning match', async () => {
    profileBody = profile([
      row({ order_id: '1' }), // won everything: 0.0196 for 0.01
      // Two matches of 0.01: one won (0.0196), one lost. One winning match, not a winning order.
      row({ order_id: '2', amount_usdc: '0.02', filled_amount: '0.02', payout_usdc: '0.0196' }),
      row({ order_id: '3', won: false, payout_usdc: '0' }),
      row({ order_id: '4', won: false, tied: true, payout_usdc: '0' }),
      row({ order_id: '5', status: 'REFUNDED', won: false, payout_usdc: '0' }),
      row({ order_id: '6', status: 'MATCHED', won: null, payout_usdc: null }),
    ])
    renderPortfolio()

    const list = await screen.findByText('Recent bets')
    const recent = list.nextElementSibling as HTMLElement
    const labels = within(recent).getAllByText(/^(WIN|MIXED|LOSS|TIE|REFUNDED|OPEN)$/).map((e) => e.textContent)
    expect(labels).toEqual(['WIN', 'MIXED', 'LOSS', 'TIE', 'REFUNDED', 'OPEN'])
    expect(screen.queryByText(/^WON$/)).toBeNull()
  })

  it('a row says the same things the order page does: at risk and payout', async () => {
    profileBody = profile([row({ order_id: '1' })])
    renderPortfolio()

    const list = await screen.findByText('Recent bets')
    const recent = list.nextElementSibling as HTMLElement
    expect(within(recent).getByText(/at risk .*0\.0100 .*payout .*0\.0196/)).toBeDefined()
  })

  it('a tie or a refund says the whole deposit came back, even for an order that never matched', async () => {
    profileBody = profile([
      row({ order_id: '1', won: false, tied: true, payout_usdc: '0' }),
      row({ order_id: '2', status: 'REFUNDED', won: false, payout_usdc: '0', filled_amount: '0' }),
    ])
    renderPortfolio()

    const list = await screen.findByText('Recent bets')
    const recent = list.nextElementSibling as HTMLElement
    expect(within(recent).getAllByText(/0\.0100 WETH returned/)).toHaveLength(2)
  })

  it('an open order says how much of it matched', async () => {
    profileBody = profile([row({ order_id: '1', status: 'PENDING', won: null, payout_usdc: null, filled_amount: '0.004' })])
    renderPortfolio()

    const list = await screen.findByText('Recent bets')
    const recent = list.nextElementSibling as HTMLElement
    expect(within(recent).getByText(/0\.0040.* of .*0\.0100.* matched/)).toBeDefined()
  })

  it('calls the headline number a win rate, like the leaderboard', async () => {
    profileBody = profile([row()])
    renderPortfolio()
    await screen.findByText('Recent bets')
    const stats = screen.getAllByTestId('stats').map((e) => e.textContent).join(' || ')
    expect(stats).toContain('Win rate: 33.3% (1/3 settled)')
  })
})

describe('Portfolio: cancelling what never found a match', () => {
  const openWithTail = (over: Record<string, unknown> = {}) =>
    row({ order_id: '9', status: 'PENDING', won: null, payout_usdc: null, filled_amount: '0.004', ...over })

  it('offers CANCEL REST on an order with an unmatched remainder, and cancels that order', async () => {
    profileBody = profile([openWithTail()])
    renderPortfolio()

    const button = await screen.findByRole('button', { name: 'CANCEL REST' })
    fireEvent.click(button)

    expect(cancelCalls).toEqual([[9n, MARKET]])
    expect(screen.getByTestId('where').textContent).toBe('/portfolio')
  })

  it('does not offer it on a fully matched order, or one whose tail was already returned', async () => {
    profileBody = profile([
      row({ order_id: '1', status: 'MATCHED', won: null, payout_usdc: null }),
      openWithTail({ order_id: '2', unmatched_refunded: true }),
    ])
    renderPortfolio()

    await screen.findByText('Recent bets')
    expect(screen.queryByRole('button', { name: 'CANCEL REST' })).toBeNull()
  })

  it('takes the row\'s cancel button away once the cancel is confirmed', async () => {
    profileBody = profile([openWithTail()])
    renderPortfolio()
    await screen.findByRole('button', { name: 'CANCEL REST' })

    await act(async () => {
      capturedOptions.onConfirmed({ action: 'cancelOrder', hash: '0xh', market: MARKET, id: 9n })
    })

    await waitFor(() => expect(screen.queryByRole('button', { name: 'CANCEL REST' })).toBeNull())
  })
})

describe('Portfolio: the other states', () => {
  it('asks a visitor without a wallet to connect', () => {
    connected = false
    renderPortfolio()
    expect(screen.getByText('Connect wallet to view your stats')).toBeDefined()
  })

  it('says so, with a Retry, when the profile cannot be loaded', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    renderPortfolio()
    // The page asks for two retries with backoff before it gives up.
    await screen.findByText(/Couldn't load your profile/, {}, { timeout: 8000 })
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined()
  }, 12_000)
})
