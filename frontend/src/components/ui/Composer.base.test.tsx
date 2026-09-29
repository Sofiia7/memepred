import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * The same Composer on a Base build. The Robinhood-only pieces (balances, the
 * faucet, the wrap hints, the pre-sign rules, the neutral mark) must not appear
 * there, and what changed for everyone (the price and fee gates, the label,
 * the busy lock) must still work.
 */

const h = vi.hoisted(() => ({
  reads: {} as Record<string, unknown>,
  bet: {} as any,
  price: {} as any,
  execute: undefined as any,
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x00000000000000000000000000000000000000bb', isConnected: true }),
  usePublicClient: () => undefined,
  useReadContract: ({ functionName }: any) => ({ data: h.reads[functionName], isError: false, refetch: async () => ({}) }),
  useWriteContract: () => ({ writeContractAsync: async () => '0xhash' }),
  useBalance: () => ({ data: undefined, refetch: async () => ({}) }),
}))
vi.mock('../../lib/chain', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/chain')>()
  const d = orig.resolveDeployment('sepolia')
  return { ...orig, DEPLOYMENT: d, TARGET_CHAIN: d.chain, TARGET_CHAIN_ID: d.chain.id, CURRENCY: d.currency, IS_POOL_BACKED: false }
})
vi.mock('../../hooks/usePlaceBet', () => ({ usePlaceBet: () => h.bet }))
vi.mock('../../hooks/usePythPrice', () => ({ usePythPrice: () => h.price }))
vi.mock('../../hooks/useConnectWallet', () => ({ useConnectWallet: () => ({ connectWallet: vi.fn() }) }))
vi.mock('../../hooks/useEnsureChain', () => ({ useEnsureChain: () => async () => ({ ok: true }) }))
vi.mock('../../hooks/useDeploymentCheck', () => ({
  useDeploymentCheck: () => ({ status: 'verified', rpc: 'match', api: 'match', reasons: [] }),
}))

import { Composer } from './Composer'
import type { PickedBet } from './MarketCard'

const picked: PickedBet = {
  marketAddress: '0x00000000000000000000000000000000000000a1',
  feedId: '',
  symbol: 'PEPE',
  durationSec: 300,
  side: 'down',
  oddsPct: 0,
}

const live = { raw: 10n ** 18n, display: 1, loading: false, stale: false, unavailable: false, status: 'live' }
const idle = () => ({
  execute: h.execute,
  step: 'idle',
  error: undefined,
  betTxHash: undefined,
  orderId: undefined,
  intent: undefined,
  busy: false,
  isLoading: false,
  isConfirmed: false,
})

const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

function renderIt() {
  return render(
    <MemoryRouter>
      <Composer picked={picked} onClear={vi.fn()} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  h.reads = { feedId: '0x5045504500000000000000000000000000000000000000000000000000000000', feeBps: 100n }
  h.execute = vi.fn() // before idle(), which captures it
  h.bet = idle()
  h.price = { ...live }
})
afterEach(cleanup)

describe('Composer on Base', () => {
  it('keeps its own copy and chips, and none of the Robinhood-only pieces', () => {
    renderIt()
    expect(text()).toContain('· waits for an opposite order')
    expect(text()).toContain('1-100 USDC per bet')
    expect(screen.getByRole('button', { name: '100 USDC' })).toBeTruthy()

    expect(screen.queryByRole('button', { name: /What you are agreeing to/ })).toBeNull()
    expect(text()).not.toContain('Wrap ETH to WETH')
    expect(text()).not.toContain('Get test ETH')
    expect(text()).not.toMatch(/ETH \d/)
  })

  it('still shows the Base mark, not the neutral one', () => {
    const { container } = renderIt()
    expect(container.querySelector('.cta .basesq')).toBeTruthy()
    expect(container.querySelector('.chainmark')).toBeNull()
  })

  it('places a bet only with a live price and a read fee', () => {
    renderIt()
    const cta = screen.getByRole('button', { name: /^BUY DOWN/ }) as HTMLButtonElement
    expect(cta.textContent).toContain('BUY DOWN · 10 USDC')
    expect(cta.disabled).toBe(false)
    fireEvent.click(cta)
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('waits for the price on Base too', () => {
    h.price = { ...live, status: 'loading', raw: 0n, loading: true }
    renderIt()
    expect((screen.getByRole('button', { name: /^PRICE LOADING/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the fee as loading, not 0.00%, on Base too', () => {
    h.reads.feeBps = undefined
    renderIt()
    expect(text()).toContain('Protocol fee: loading…')
    expect(text()).not.toContain('0.00%')
  })

  it('locks the stake while a bet is in flight', () => {
    h.bet = { ...idle(), busy: true, isLoading: true, step: 'betting' }
    renderIt()
    expect((screen.getByLabelText(/stake in/i) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'CLEAR' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
