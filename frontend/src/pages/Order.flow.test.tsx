import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { OrderPage } from './Order'

/**
 * The order page and its real status card together, through a cancel.
 *
 * Each piece has its own suite; this one is about the wiring between them: the
 * card offers Cancel to the trader, the page sends cancelOrder and follows it to
 * its receipt, and once the receipt is in the card re-reads the order and shows
 * what is left - a matched order with no remainder and nothing more to cancel.
 * Only wagmi, the backend and the app shell are stubbed.
 */

const MARKET = '0x00000000000000000000000000000000000000aa'
const TRADER = '0x00000000000000000000000000000000000000bb'
const STRANGER = '0x00000000000000000000000000000000000000cc'
const ZERO = '0x0000000000000000000000000000000000000000'

const nowSec = () => Math.floor(Date.now() / 1000)

let order: any
let account: string | undefined
let writeCalls: any[]
let mineReceipt: (() => void) | undefined
const refetchSpy = vi.fn()
/** Held open until the test mines it, so the "submitted" state can be looked at. */
const holdReceipt = () =>
  new Promise((resolve) => {
    mineReceipt = () => resolve({ status: 'success' })
  })
const publicClient = {
  waitForTransactionReceipt: holdReceipt as () => Promise<unknown>,
  getLogs: async () => [],
}

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: account }),
  useWatchContractEvent: () => undefined,
  useWriteContract: () => ({
    writeContractAsync: async (args: any) => {
      writeCalls.push(args)
      return '0xcancelhash'
    },
  }),
  usePublicClient: () => publicClient,
  useReadContract: ({ functionName, query }: any) => {
    if (query?.enabled === false) return { data: undefined, refetch: refetchSpy }
    if (functionName === 'getOrder') return { data: order, isLoading: false, isError: false, refetch: refetchSpy }
    if (functionName === 'getMatch') {
      return {
        data: {
          upOrderId: 1n, downOrderId: 0n, amount: 4_000_000n, entryPrice: 1n, settleAt: BigInt(nowSec() + 200),
          exitPrice: 0n, settled: false, upWon: false, lpMatch: true,
        },
        refetch: refetchSpy,
      }
    }
    return { data: undefined, refetch: refetchSpy }
  },
}))
vi.mock('../hooks/useEnsureChain', () => ({ useEnsureChain: () => async () => ({ ok: true }) }))
vi.mock('../components/ui/AppShell', () => ({
  ScreenTitle: ({ title }: { title: string }) => <h2>{title}</h2>,
}))

/** 4 of 10 matched, 6 still waiting in the book; the matched part settles in ~200s. */
const partlyFilled = () => ({
  trader: TRADER, direction: 0, amount: 10_000_000n, filledAmount: 4_000_000n, referrer: ZERO, status: 0,
  placedAt: BigInt(nowSec() - 60), matchId: 3n, pendingSettlements: 1n, payout: 0n, unmatchedRefunded: false,
  expectedPrice: 1n, slippageBps: 100n,
})

function renderOrder() {
  return render(
    <MemoryRouter initialEntries={[`/order/${MARKET}/1`]}>
      <Routes>
        <Route path="/order/:address/:orderId" element={<OrderPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  order = partlyFilled()
  account = TRADER
  writeCalls = []
  mineReceipt = undefined
  publicClient.waitForTransactionReceipt = holdReceipt
  refetchSpy.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('Order page with the real status card: cancelling the unmatched rest', () => {
  it('offers Cancel to the trader, sends cancelOrder, and shows what is left once it is mined', async () => {
    renderOrder()

    // A partly matched order: the matched part has a countdown, the rest can be cancelled.
    expect(screen.getByText(/partly matched/i)).toBeDefined()
    const cancel = await screen.findByRole('button', { name: /cancel remaining 6 usdc/i })

    fireEvent.click(cancel)

    // Awaiting the receipt: the transaction was sent to the right place, and
    // every action on the card is held while it is in flight.
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/cancel submitted/i))
    expect(writeCalls).toHaveLength(1)
    expect(writeCalls[0]).toMatchObject({ functionName: 'cancelOrder', args: [1n], address: MARKET })
    expect((screen.getByRole('button', { name: /processing/i }) as HTMLButtonElement).disabled).toBe(true)

    // The chain has the remainder back, then the receipt arrives.
    order = { ...order, unmatchedRefunded: true }
    refetchSpy.mockClear()
    await act(async () => {
      mineReceipt!()
    })

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/cancel confirmed/i))
    expect(screen.getByRole('link', { name: /view transaction/i }).getAttribute('href')).toMatch(/\/tx\/0xcancelhash$/)
    // The page told the card to re-read the order...
    expect(refetchSpy).toHaveBeenCalled()
    // ...and the card now shows an order with nothing left to cancel, still running.
    await waitFor(() => expect(screen.queryByText(/partly matched/i)).toBeNull())
    expect(screen.queryByRole('button', { name: /cancel remaining/i })).toBeNull()
    expect(screen.getByText(/matched with lp vault/i)).toBeDefined()
    expect(screen.getByText(/^Result in /)).toBeDefined()
  })

  it('does not offer Cancel to somebody else who opened the link', async () => {
    account = STRANGER
    renderOrder()

    expect(await screen.findByText(/partly matched/i)).toBeDefined()
    expect(screen.queryByRole('button', { name: /cancel remaining/i })).toBeNull()
    expect(screen.getByText(/only that wallet can claim or cancel/i)).toBeDefined()
  })

  it('shows why a cancel failed instead of leaving the button spinning', async () => {
    renderOrder()
    const cancel = await screen.findByRole('button', { name: /cancel remaining 6 usdc/i })

    // The RPC cannot say whether it was mined.
    publicClient.waitForTransactionReceipt = () => Promise.reject(new Error('rpc down'))
    fireEvent.click(cancel)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Cancel failed: .*may still go through/))
    expect(screen.getByRole('button', { name: /cancel remaining 6 usdc/i })).toBeDefined()
  })
})
