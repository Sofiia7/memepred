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
import { useRoundsClient, type MyBet, type MyBets } from './useRoundsData'
import { createRoundsClient } from './roundsClient'
import { PREVIOUS_ROUNDS } from './legacyRounds'
import { ROUNDS_CONFIG } from './roundsAbi'
import { GAS_RESERVE_WEI } from '../lib/rules'

/**
 * The player's transactions: direct ETH staking and collection on the current
 * RHC deployment, or exact-stake WETH approval, betting and collection on an
 * older deployment.
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

        if (ROUNDS_CONFIG.nativeEth) {
          const balance = await client.getBalance({ address: snap.player })
          if (balance < snap.stake + GAS_RESERVE_WEI) throw new Error('Not enough ETH for this stake and gas. Get test ETH from the faucet.')
        } else {
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
        }

        setState({ step: 'betting' })
        const req = ROUNDS_CONFIG.nativeEth
          ? rounds.betWithEthRequest(snap.roundId, snap.side, snap.stake, safeReferrer(snap.player))
          : rounds.betRequest(snap.roundId, snap.side, snap.stake, safeReferrer(snap.player))
        const hash = await writeContractAsync({ ...req, account: snap.player, chainId: snap.chainId } as never)
        setState({ step: 'betting', hash })
        await waitOk(hash, 'The bet')
        // A full Bet-log history scan can lag behind the receipt. Read this
        // ticket directly so "Your bets" appears as soon as the chain has it.
        void Promise.all([rounds.round(snap.roundId), rounds.ticket(snap.roundId, snap.player)])
          .then(([round, ticket]) => {
            queryClient.setQueryData<MyBets>(['rounds', 'mine', rounds.address, snap.player.toLowerCase()], (old) => ({
              bets: [{ contract: snap.contract, roundId: snap.roundId, round, ticket }, ...(old?.bets ?? []).filter((b) => b.contract.toLowerCase() !== snap.contract.toLowerCase() || b.roundId !== snap.roundId)],
              scanError: old?.scanError,
            }))
          })
          .catch(() => { /* The normal event scan still picks it up. */ })
        return { step: 'done', hash, note: 'Bet placed. It is listed under Your bets.' }
      }),
    [address, client, rounds, ensureChain, run, waitOk, writeContractAsync, queryClient],
  )

  const claim = useCallback(
    (b: MyBet) =>
      run(async () => {
        if (!address || !rounds || !client) throw new Error('Connect a wallet first.')
        const roundId = b.roundId
        const chain = await ensureChain()
        if (!chain.ok) throw new Error(chain.error)
        setState({ step: 'claiming' })
        const source = b.contract.toLowerCase() === rounds.address.toLowerCase()
          ? rounds
          : createRoundsClient(client, b.contract, PREVIOUS_ROUNDS.deployBlock)
        const req = ROUNDS_CONFIG.nativeEth ? source.claimAsEthRequest(roundId) : source.claimRequest(roundId)
        const hash = await writeContractAsync({ ...req, account: address, chainId: TARGET_CHAIN_ID } as never)
        setState({ step: 'claiming', hash })
        await waitOk(hash, 'Collecting')
        return { step: 'done', hash, note: ROUNDS_CONFIG.nativeEth ? 'Collected as ETH.' : 'Collected.' }
      }),
    [address, rounds, client, ensureChain, run, waitOk, writeContractAsync],
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
