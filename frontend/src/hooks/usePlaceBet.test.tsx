import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { usePlaceBet } from './usePlaceBet'

/**
 * The approval has to be mined before the bet is sent.
 *
 * `writeContractAsync` resolves as soon as the wallet submits, not when the
 * transaction lands. The bet went out immediately after, so the wallet
 * estimated gas for a placeBet whose allowance did not exist yet - which reads
 * to the user as "transfer amount exceeds allowance" on a bet they were told
 * had been approved. Nonce ordering means it would eventually have executed in
 * the right order; the estimation happens first and does not care.
 *
 * The receipt wait existed in this file already, as a
 * useWaitForTransactionReceipt nobody awaited.
 */

const MARKET = '0x00000000000000000000000000000000000000aa' as const
const MARKET_2 = '0x00000000000000000000000000000000000000cc' as const
const calls: string[] = []

let approvalMined!: () => void
let approveCallArgs: any

/**
 * Controls what useWaitForTransactionReceipt reports for the BET transaction
 * once it has a hash to watch. 'pending' mirrors the old static mock (no
 * receipt yet); tests that care about the outcome switch this before
 * rendering.
 */
let mockBetReceipt: 'pending' | 'success' | 'reverted' = 'pending'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x00000000000000000000000000000000000000bb' }),
  usePublicClient: () => ({
    waitForTransactionReceipt: async () => {
      calls.push('approval-receipt')
      // Held open until the test releases it, so "the bet went out early" is
      // observable rather than a race the test might win by accident.
      await new Promise<void>((resolve) => { approvalMined = resolve })
      return { status: 'success' }
    },
  }),
  useReadContract: ({ functionName }: any) => {
    if (functionName === 'feedId') return { data: '0x5045504500000000000000000000000000000000000000000000000000000000' }
    if (functionName === 'allowance') return { data: 0n, refetch: async () => {} } // forces an approve
    return { data: undefined, refetch: async () => {} }
  },
  useWriteContract: () => ({
    writeContractAsync: async (args: any) => {
      calls.push('approve')
      approveCallArgs = args
      return '0xapprovehash'
    },
    data: undefined,
  }),
  useSendTransaction: () => ({
    sendTransactionAsync: async () => { calls.push('bet'); return '0xbethash' },
    data: undefined,
  }),
  useWaitForTransactionReceipt: ({ hash, query }: any) => {
    if (!hash || query?.enabled === false || mockBetReceipt === 'pending') {
      return { data: undefined, isSuccess: false, isError: false, error: undefined }
    }
    return {
      data: { status: mockBetReceipt, transactionHash: hash, logs: [] },
      isSuccess: true,
      isError: false,
      error: undefined,
    }
  },
}))

vi.mock('../hooks/useEnsureChain', () => ({ useEnsureChain: () => async () => ({ ok: true }) }))
vi.mock('./useEnsureChain',        () => ({ useEnsureChain: () => async () => ({ ok: true }) }))
vi.mock('../lib/oracle', () => ({
  fetchBetPayload: async () => '0xdeadbeef',
  withPayload: (d: string, p: string) => d + p.slice(2),
}))
vi.mock('../lib/referral', () => ({ getPendingReferrer: () => '0x0000000000000000000000000000000000000000' }))

function Probe({ amountUsd = '10' }: { amountUsd?: string } = {}) {
  const [market, setMarket] = useState<string>(MARKET)
  const [direction, setDirection] = useState<0 | 1>(0)
  const bet = usePlaceBet({
    marketAddress: market as `0x${string}`,
    direction,
    amountUsd,
    expectedPrice: 1_000_000_000_000_000_000n,
    slippageBps: 100,
  })
  return (
    <>
      <button onClick={() => { void bet.execute() }}>go</button>
      <button onClick={() => setMarket(MARKET_2)}>switch market</button>
      <button onClick={() => setDirection(1)}>switch direction</button>
      <div data-testid="step">{bet.step}</div>
      <div data-testid="error">{bet.error ?? ''}</div>
    </>
  )
}

beforeEach(() => { calls.length = 0; approveCallArgs = undefined; mockBetReceipt = 'pending' })
afterEach(cleanup)

describe('usePlaceBet, approval ordering', () => {
  it('does not send the bet until the approval has been mined', async () => {
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(calls).toContain('approval-receipt'))

    // The approval is submitted and being waited on. Nothing may have been bet.
    expect(calls).toEqual(['approve', 'approval-receipt'])

    approvalMined()

    await waitFor(() => expect(calls).toEqual(['approve', 'approval-receipt', 'bet']))
  })
})

describe('usePlaceBet, bounded approval', () => {
  /**
   * A link to /market/0xAttacker on the real domain used to get a connected
   * user to approve their ENTIRE balance (maxUint256) to whatever contract
   * the URL named, before anything had checked the address was a real
   * market. Market.tsx now refuses to render the Composer for an address
   * that fails PoolMarketFactory.isMarket - but this hook is the last line
   * of defence, so it must never ask for more allowance than the bet it is
   * actually about to place needs.
   */
  it('approves only the stake amount, never an unlimited allowance', async () => {
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(approveCallArgs).toBeDefined())

    // Probe bets amountUsd: '10' at the default (6-decimal) test currency.
    expect(approveCallArgs.args[1]).toBe(10_000_000n)
    expect(approveCallArgs.args[1]).not.toBe(2n ** 256n - 1n) // maxUint256
  })
})

describe('usePlaceBet, step tracks the actual receipt', () => {
  /**
   * Before this, `step` was set to 'betting' at submission and nothing ever
   * moved it off that based on what actually happened on chain - only
   * `isConfirmed` was derived from the receipt, and the Composer button reads
   * `step`, not `isConfirmed`. A reverted or dropped bet left the CTA reading
   * "PLACING BET..." forever, with no way to retell it apart from a slow
   * confirmation, and no way to retry.
   */
  it('moves to error, not stuck on betting, when the bet reverts on-chain', async () => {
    mockBetReceipt = 'reverted'
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(calls).toContain('approval-receipt'))
    approvalMined()
    await waitFor(() => expect(calls).toContain('bet'))

    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('error'))
    expect(screen.getByTestId('error').textContent?.toLowerCase()).toContain('revert')
  })

  it('moves to confirmed once the receipt reports success', async () => {
    mockBetReceipt = 'success'
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(calls).toContain('approval-receipt'))
    approvalMined()
    await waitFor(() => expect(calls).toContain('bet'))

    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('confirmed'))
  })
})

describe('usePlaceBet, stale status does not follow a new pick', () => {
  /**
   * marketAddress/direction come through as plain props, not a remount, so
   * nothing used to clear a previous bet's error/orderId/step when the user
   * picked a different market or flipped direction - an old "RETRY" banner
   * (or a stale orderId) could bleed into an unrelated new bet.
   */
  it('clears a stale error when the user switches to a different market', async () => {
    mockBetReceipt = 'reverted'
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(calls).toContain('approval-receipt'))
    approvalMined()
    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('error'))

    screen.getByRole('button', { name: 'switch market' }).click()

    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('idle'))
    expect(screen.getByTestId('error').textContent).toBe('')
  })

  it('clears a stale error when the user switches direction on the same market', async () => {
    mockBetReceipt = 'reverted'
    render(<Probe />)
    screen.getByRole('button', { name: 'go' }).click()

    await waitFor(() => expect(calls).toContain('approval-receipt'))
    approvalMined()
    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('error'))

    screen.getByRole('button', { name: 'switch direction' }).click()

    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('idle'))
    expect(screen.getByTestId('error').textContent).toBe('')
  })
})

describe('usePlaceBet, malformed stake does not crash the render', () => {
  /**
   * `Number(x).toString()` for a very small value (e.g. typing 0.0000001)
   * produces exponential notation ("1e-7"), and viem's parseUnits throws on
   * that rather than returning 0. The hook computed amountWei unconditionally
   * in its body - not inside execute()'s try/catch - so this threw during
   * render itself, on every render, with no error boundary anywhere in the
   * app to catch it: a white screen from typing one too many zeros.
   */
  it('does not throw when amountUsd is exponential notation', () => {
    expect(() => render(<Probe amountUsd="1e-7" />)).not.toThrow()
  })

  it('does not throw for other malformed amounts (empty, partial, garbage)', () => {
    for (const bad of ['', '.', '-', 'abc', '1.2.3']) {
      expect(() => render(<Probe amountUsd={bad} />)).not.toThrow()
      cleanup()
    }
  })
})
