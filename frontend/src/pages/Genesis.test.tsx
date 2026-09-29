import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { GenesisPage } from './Genesis'

/**
 * Genesis divided every vault figure by a literal 1e6: right for six-decimal
 * USDC, a million million times wrong for eighteen-decimal WETH. The page is
 * unreachable on Robinhood Chain today (App.tsx sends /genesis to /pools), but
 * a hard-coded width is a trap. Here the stake currency is 18 decimals.
 */

const TRADER = '0x00000000000000000000000000000000000000bb'
const E18 = 10n ** 18n

vi.mock('../lib/chain', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/chain')>()
  return {
    ...real,
    IS_POOL_BACKED: true,
    CURRENCY: { decimals: 18, symbol: 'WETH', minBet: '0.005', maxBet: '0.04', displayDecimals: 4 },
  }
})
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: TRADER, isConnected: true }),
  usePublicClient: () => ({}),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  useReadContract: ({ functionName }: { functionName: string }) => {
    const answers: Record<string, unknown> = {
      // totalAssetsOut, available, providerExposure (locked), genesisLeft
      getPoolStats: [5n * E18, 3n * E18, 2n * E18, 15n],
      balanceOf: 1n * E18,
      previewRedeem: 1n * E18,
      maxWithdraw: E18 / 2n,
      earnedFees: E18 / 4n,
      isGenesis: false,
      allowance: 0n,
    }
    return { data: answers[functionName], refetch: vi.fn() }
  },
}))
vi.mock('../hooks/useEnsureChain', () => ({ useEnsureChain: () => async () => ({ ok: true }) }))
vi.mock('../hooks/useConnectWallet', () => ({ useConnectWallet: () => ({ connectWallet: vi.fn() }) }))
vi.mock('../components/ui/AppShell', () => ({ ScreenTitle: ({ title }: { title: string }) => <h2>{title}</h2> }))

afterEach(cleanup)

describe('GenesisPage on an 18-decimal stake currency', () => {
  it('reads every vault figure in the currency\'s own width, not as USDC', () => {
    const { container } = render(<GenesisPage />)
    const text = (container.textContent ?? '').replace(/\s+/g, ' ')

    // 5 WETH in the vault, 2 locked in matches: not 5,000,000,000,000.
    expect(text).toMatch(/Total Vault Assets\$5(?![\d,])/)
    expect(text).toMatch(/Locked in Matches\$2(?![\d,])/)
    // My position: 1 WETH of shares, 0.25 in fees, 0.5 withdrawable.
    expect(text).toContain('$1.00')
    expect(text).toContain('$0.25')
    expect(text).toContain('Available: $0.50')
    expect(text).not.toMatch(/000,000/)
  })
})
