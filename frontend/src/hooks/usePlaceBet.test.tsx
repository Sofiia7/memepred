import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
const calls: string[] = []

let approvalMined!: () => void
let approveCallArgs: any

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
  useWaitForTransactionReceipt: () => ({ data: undefined, isSuccess: false }),
}))

vi.mock('../hooks/useEnsureChain', () => ({ useEnsureChain: () => async () => ({ ok: true }) }))
vi.mock('./useEnsureChain',        () => ({ useEnsureChain: () => async () => ({ ok: true }) }))
vi.mock('../lib/oracle', () => ({
  fetchBetPayload: async () => '0xdeadbeef',
  withPayload: (d: string, p: string) => d + p.slice(2),
}))
vi.mock('../lib/referral', () => ({ getPendingReferrer: () => '0x0000000000000000000000000000000000000000' }))

function Probe() {
  const bet = usePlaceBet({
    marketAddress: MARKET,
    direction: 0,
    amountUsd: '10',
    expectedPrice: 1_000_000_000_000_000_000n,
    slippageBps: 100,
  })
  return <button onClick={() => { void bet.execute() }}>go</button>
}

beforeEach(() => { calls.length = 0; approveCallArgs = undefined })
afterEach(cleanup)

describe('usePlaceBet, approval ordering', () => {
  it('does not send the bet until the approval has been mined', async () => {
    render(<Probe />)
    screen.getByRole('button').click()

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
    screen.getByRole('button').click()

    await waitFor(() => expect(approveCallArgs).toBeDefined())

    // Probe bets amountUsd: '10' at the default (6-decimal) test currency.
    expect(approveCallArgs.args[1]).toBe(10_000_000n)
    expect(approveCallArgs.args[1]).not.toBe(2n ** 256n - 1n) // maxUint256
  })
})
