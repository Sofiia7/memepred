import { useCallback, useRef, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import type { Address, Hash, PublicClient } from 'viem'
import { TARGET_CHAIN_ID } from '../lib/chain'
import { ERC20_ABI, WETH_ABI } from '../lib/contracts'
import { getPendingReferrer } from '../lib/referral'
import { useEnsureChain } from '../hooks/useEnsureChain'
import { TICKET_NONE } from './roundsClient'
import type { RoundSide } from './roundMath'
import { explainRoundError } from './roundErrors'
import { useRoundsClient, type MyBet } from './useRoundsData'

/**
 * The player's transactions: a bet (with an approval of exactly its stake),
 * collecting, and wrapping ETH into the WETH a stake is made of.
 *
 * Every flow freezes what it is about before its first await, as usePlaceBet
 * does (audit U01): a prop that changes while the wallet is open cannot change
 * the round, the side or the stake that gets signed. One flow at a time per
 * instance; a second click while one is running is ignored.
 */

const ZERO: Address = '0x0000000000000000000000000000000000000000'

/**
 * A bet sent this close to the close may land after it and revert, costing
 * the player gas for nothing, so the button refuses it. Not a contract rule.
 */
export const MIN_SECONDS_TO_BET = 8

export type TxStep = 'idle' | 'approving' | 'betting' | 'claiming' | 'wrapping' | 'done' | 'error'

export interface TxState {
  step: TxStep
  error?: string
  note?: string
  hash?: Hash
}

export interface BetIntent {
  roundId: bigint
  side: RoundSide
  stake: bigint
  closeAt: number
  nowSec: number
  minStake: bigint
  maxStake: bigint
  weth: Address
}

function safeReferrer(player: Address): Address {
  try {
    return getPendingReferrer(player)
  } catch {
    // localStorage can throw in a private window; a bet without a referrer is fine.
    return ZERO
  }
}

export function useRoundTx() {
  const { address } = useAccount()
  const rounds = useRoundsClient()
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as PublicClient | undefined
  const ensureChain = useEnsureChain()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [state, setState] = useState<TxState>({ step: 'idle' })
  const running = useRef(false)

  const run = useCallback(
    async (fn: () => Promise<TxState>) => {
      if (running.current) return
      running.current = true
      setState({ step: 'idle' })
      try {
        setState(await fn())
      } catch (e) {
        setState({ step: 'error', error: explainRoundError(e) })
      } finally {
        running.current = false
        void queryClient.invalidateQueries({ queryKey: ['rounds'] })
      }
    },
    [queryClient],
  )

  const waitOk = useCallback(
    async (hash: Hash, what: string) => {
      if (!client) throw new Error('No connection to the chain')
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`${what} reverted on-chain.`)
    },
    [client],
  )

  const bet = useCallback(
    (intent: BetIntent) =>
      run(async () => {
        if (!address || !client || !rounds) throw new Error('Connect a wallet first.')
        const snap = { ...intent, player: address, chainId: TARGET_CHAIN_ID, contract: rounds.address }
        if (snap.stake < snap.minStake || snap.stake > snap.maxStake) throw new Error("The stake is outside the contract's limits.")
        if (snap.closeAt - snap.nowSec < MIN_SECONDS_TO_BET) throw new Error('Bets on this round close in a few seconds. Wait for the next one.')
        const chain = await ensureChain()
        if (!chain.ok) throw new Error(chain.error)

        const ticket = await rounds.ticket(snap.roundId, snap.player)
        if (ticket.status !== TICKET_NONE) throw new Error('You already have a bet in this round: one per wallet per round.')

        const balance = (await client.readContract({ address: snap.weth, abi: ERC20_ABI, functionName: 'balanceOf', args: [snap.player] })) as bigint
        if (balance < snap.stake) throw new Error('Not enough WETH for this stake. Wrap some ETH first.')
        const allowance = (await client.readContract({
          address: snap.weth,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [snap.player, snap.contract],
        })) as bigint
        if (allowance < snap.stake) {
          setState({ step: 'approving' })
          // Exactly this stake, never an unlimited approval (as usePlaceBet).
          const approveHash = await writeContractAsync({
            address: snap.weth,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [snap.contract, snap.stake],
            account: snap.player,
            chainId: snap.chainId,
          })
          await waitOk(approveHash, 'The WETH approval')
        }

        setState({ step: 'betting' })
        const req = rounds.betRequest(snap.roundId, snap.side, snap.stake, safeReferrer(snap.player))
        const hash = await writeContractAsync({ ...req, account: snap.player, chainId: snap.chainId } as never)
        setState({ step: 'betting', hash })
        await waitOk(hash, 'The bet')
        return { step: 'done', hash, note: 'Bet placed. It is listed under Your bets.' }
      }),
    [address, client, rounds, ensureChain, run, waitOk, writeContractAsync],
  )

  const claim = useCallback(
    (b: MyBet) =>
      run(async () => {
        if (!address || !rounds) throw new Error('Connect a wallet first.')
        const roundId = b.roundId
        const chain = await ensureChain()
        if (!chain.ok) throw new Error(chain.error)
        setState({ step: 'claiming' })
        const hash = await writeContractAsync({ ...rounds.claimRequest(roundId), account: address, chainId: TARGET_CHAIN_ID } as never)
        setState({ step: 'claiming', hash })
        await waitOk(hash, 'Collecting')
        return { step: 'done', hash, note: 'Collected.' }
      }),
    [address, rounds, ensureChain, run, waitOk, writeContractAsync],
  )

  const wrap = useCallback(
    (weth: Address, amount: bigint) =>
      run(async () => {
        if (!address) throw new Error('Connect a wallet first.')
        const chain = await ensureChain()
        if (!chain.ok) throw new Error(chain.error)
        setState({ step: 'wrapping' })
        const hash = await writeContractAsync({
          address: weth,
          abi: WETH_ABI,
          functionName: 'deposit',
          value: amount,
          account: address,
          chainId: TARGET_CHAIN_ID,
        })
        await waitOk(hash, 'Wrapping')
        return { step: 'idle' }
      }),
    [address, ensureChain, run, waitOk, writeContractAsync],
  )

  const busy = state.step === 'approving' || state.step === 'betting' || state.step === 'claiming' || state.step === 'wrapping'
  return { state, busy, bet, claim, wrap }
}
