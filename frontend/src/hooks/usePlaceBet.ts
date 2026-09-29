/**
 * usePlaceBet - Sprint 4.1 + 4.2
 *
 * 4.1: Decodes OrderPlaced from the receipt logs and exposes `orderId`. UI
 *      can redirect to /order/:address/:orderId immediately after confirm.
 * 4.2: Reads `market.feedId()` on-chain instead of using a global
 *      VITE_PYTH_FEED_ID. Per-market feeds are correct for multi-coin.
 * 2026-09-29 (audit U01): a bet is the intent frozen when execute() starts.
 *      Nothing that happens to the props, the picked market or the connected
 *      wallet while the wallet is open can change what gets approved, sent,
 *      decoded or redirected to.
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import {
  useWriteContract,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useReadContract,
  useAccount,
  usePublicClient,
} from 'wagmi'
import { parseUnits, decodeEventLog, type Address, type Hash, encodeFunctionData } from 'viem'
import { CONTRACTS, ORDERBOOK_MARKET_ABI, ERC20_ABI, MARKET_FACTORY_ABI, CURRENCY_DECIMALS, CURRENCY_SYMBOL, IS_POOL_BACKED } from '../lib/contracts'
import { TARGET_CHAIN_ID } from '../lib/chain'
import { getPendingReferrer } from '../lib/referral'
import { fetchBetPayload, withPayload } from '../lib/oracle'
import { useEnsureChain } from './useEnsureChain'

export type Direction = 0 | 1  // 0=UP, 1=DOWN

/**
 * Minimal ABI for quoting Pyth's update fee.
 *
 * Sprint 5.6: bets used to attach a flat 0.0001 ETH and rely on the contract
 * refunding the excess. Refunded or not, the wallet still had to be holding it
 * at send time - so a user with exactly enough ETH for gas simply could not
 * bet, and everyone else was asked to park ~$0.19 for no reason. Pyth's actual
 * fee on Base is 1 wei per update. Now we ask what it costs and send that.
 */
/** OracleResolver.pyth is immutable, so this is safe to resolve once. */
interface UsePlaceBetArgs {
  marketAddress: Address
  direction:     Direction
  amountUsd:     string
  referrer?:     Address
  expectedPrice: bigint
  slippageBps?:  number
}

type BetStep = 'idle' | 'approving' | 'approved' | 'betting' | 'confirmed' | 'error'

/**
 * Everything one bet is about, captured once when execute() starts.
 *
 * The approval and the bet are separated by wallet prompts that can sit open
 * for as long as the user likes, and the props this hook is given are live: a
 * click on the other side, another market, a new stake, or an account switch in
 * the wallet all arrive as new props while the old execute() is still awaiting.
 * Before this existed the continuation read those newer values - the approval
 * was for one market and the order went to another - and a second click during
 * the approval started a second, different bet. Now the flow reads this object
 * and nothing else, including for the event it decodes and the order page the
 * user is sent to.
 */
export interface BetIntent {
  marketAddress: Address
  direction:     Direction
  amountWei:     bigint
  expectedPrice: bigint
  slippageBps:   number
  /** The wallet the bet was started from. The wallet is asked to sign as this account. */
  account:       Address
  /** The chain the bet is for. The wallet is asked to sign on this chain and refuses on any other. */
  chainId:       number
  referrer:      Address
}

export function usePlaceBet({
  marketAddress,
  direction,
  amountUsd,
  referrer,
  expectedPrice,
  slippageBps = 100,
}: UsePlaceBetArgs) {

  const { address } = useAccount()

  // Resolved here rather than as a default parameter: the stored referrer has
  // to be compared against the connected wallet, and `address` doesn't exist
  // until useAccount() has run. Passing your own address as referrer is a hard
  // revert in the contract.
  const effectiveReferrer = referrer ?? getPendingReferrer(address)
  const publicClient = usePublicClient()
  const ensureChain = useEnsureChain()
  const [step, setStepState] = useState<BetStep>('idle')
  const [error, setError] = useState<string>()
  const [orderId, setOrderId] = useState<bigint>()
  const [submittedHash, setSubmittedHash] = useState<Hash>()
  // The frozen intent of the bet in flight, or of the last one placed. Kept in
  // state as well as a ref: effects and the caller need to see it change, the
  // async continuation needs to read it without waiting for a render.
  const [intent, setIntent] = useState<BetIntent>()
  const intentRef = useRef<BetIntent | undefined>(undefined)
  // True from the first line of execute() until it finishes. `step` alone is
  // not enough: it stays 'idle' while the market is being verified and while
  // the wallet is prompting for a network switch, and a second click in that
  // window used to start a second bet.
  const [inFlight, setInFlight] = useState(false)
  const inFlightRef = useRef(false)
  // Mirrors `step` synchronously. A click handler that fires twice before React
  // has re-rendered would otherwise see the old value both times.
  const stepRef = useRef<BetStep>('idle')
  const setStep = useCallback((s: BetStep) => {
    stepRef.current = s
    setStepState(s)
  }, [])

  // Computed on every render, not inside execute()'s try/catch - so it must
  // never throw on its own. parseUnits rejects anything that isn't plain
  // decimal digits: exponential notation (a tiny stake like 0.0000001
  // round-tripped through Number().toString() becomes "1e-7"), a bare ".",
  // a trailing "-", or any other malformed in-progress input. Falling back to
  // 0n is the same "nothing to bet" state amountUsd === '' already produces,
  // not a crash during render with no error boundary to catch it.
  let amountWei: bigint
  try {
    amountWei = parseUnits(amountUsd || '0', CURRENCY_DECIMALS)
  } catch {
    amountWei = 0n
  }

  // ── 4.2: per-market feedId from the market contract ───
  const { data: marketFeedId } = useReadContract({
    address: marketAddress,
    abi: ORDERBOOK_MARKET_ABI,
    functionName: 'feedId',
  })

  // ── Audit A05 (2026-09-28): re-verify the address here too ───
  // Market.tsx already gates its own UI on PoolMarketFactory.isMarket, but
  // that protects only that one page - Markets.tsx mounts this same hook
  // behind its own Composer with no such check, and any future caller would
  // be equally unprotected. This is the one place every bet actually goes
  // through, so it is the one place that can guarantee the check always runs
  // before an approval or a signature, no matter which page got here wrong.
  const { data: isRealMarket } = useReadContract({
    address: CONTRACTS.MARKET_FACTORY,
    abi: MARKET_FACTORY_ABI,
    functionName: 'isMarket',
    args: [marketAddress],
  })

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACTS.USDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [address!, marketAddress],
    query: { enabled: !!address },
  })

  // The approval receipt is awaited inline in execute(), where the bet
  // actually has to stop and wait for it. A useWaitForTransactionReceipt here
  // watched the same hash and blocked nothing, which is how the bet came to be
  // sent against an allowance that had not landed.
  const { writeContractAsync: approve } = useWriteContract()
  const { writeContractAsync: placeBet } = useWriteContract()

  const { sendTransactionAsync: sendBet } = useSendTransaction()
  // Only the hash this hook recorded for the current bet. useSendTransaction's
  // own `data` keeps the PREVIOUS send's hash until the next one is made, which
  // during a retry's approval would have reported the old bet's receipt (a
  // revert, typically) as this bet's, and flipped a bet in progress to "error".
  // Every send sets submittedHash right after it returns, so nothing is lost.
  const finalBetHash = submittedHash
  const {
    data: betReceipt,
    isSuccess: betReceiptOk,
    isError: betReceiptErrored,
    error: betReceiptError,
  } = useWaitForTransactionReceipt({
    hash: finalBetHash,
    query: { enabled: !!finalBetHash },
  })

  // A bet is in progress from the click until the receipt has come back with a
  // verdict. Between the wallet accepting the bet and the receipt, `step` is
  // still 'betting', which is what keeps this true through that wait.
  const busy = inFlight || step === 'approving' || step === 'betting'

  // ── step, driven by what the receipt actually says ────────
  // Submitting a transaction only means the wallet accepted it - it does not
  // mean it landed, and it says nothing about whether it reverted. Before
  // this, `step` was set to 'betting' at submission and nothing ever moved it
  // off that: a reverted or dropped bet left the CTA reading "PLACING BET…"
  // forever, because the Composer button renders `step`, not `isConfirmed`.
  useEffect(() => {
    if (!finalBetHash) return
    if (betReceiptOk && betReceipt) {
      if (betReceipt.status === 'success') {
        setStep('confirmed')
      } else {
        // 'reverted' - landed on chain but the call itself failed (stale
        // price, slippage, expired allowance, and so on).
        setStep('error')
        setError('Transaction reverted on-chain - nothing was bet.')
      }
    } else if (betReceiptErrored) {
      // The receipt never resolved at all - dropped, replaced, or the RPC
      // gave up waiting. Distinct from a revert: the chain never gave a
      // final answer, so say so rather than implying the bet was rejected.
      setStep('error')
      setError(betReceiptError?.message || 'Could not confirm the transaction - it may have been dropped. Please retry.')
    }
  }, [finalBetHash, betReceiptOk, betReceipt, betReceiptErrored, betReceiptError, setStep])

  // ── a different market or direction is a different bet ────
  // marketAddress/direction arrive as plain props, not a remount (Composer
  // keeps this hook mounted across picks), so nothing else clears a stale
  // 'error'/'confirmed' status, error message or orderId from the last pick
  // when the user switches to a new one. Deliberately narrow: the stake or
  // expected price changing should not wipe an in-flight or just-finished bet.
  //
  // And never while a bet is in flight: that bet belongs to its own frozen
  // intent, not to whatever the props say now, so a prop change must not reset
  // it (this reset is what used to unlock the button mid-approval). Read from
  // the refs rather than `busy`, so the check sees the current state of the
  // flow and the effect does not re-run when `busy` flips. The outcome of a bet
  // whose props changed underneath it therefore stays available, together with
  // its `intent`, until the props change again - which is what lets the
  // redirect after a confirmed bet still go to the market that bet was for.
  useEffect(() => {
    if (inFlightRef.current || stepRef.current === 'approving' || stepRef.current === 'betting') return
    setStep('idle')
    setError(undefined)
    setOrderId(undefined)
    setSubmittedHash(undefined)
    intentRef.current = undefined
    setIntent(undefined)
  }, [marketAddress, direction, setStep])

  // ── 4.1: decode OrderPlaced log → orderId state ───────────
  // Against the market the bet was sent to, from the frozen intent - the
  // market currently picked may be a different one by the time the receipt
  // arrives.
  useEffect(() => {
    if (!betReceiptOk || !betReceipt || !intent) return
    const market = intent.marketAddress.toLowerCase()
    for (const log of betReceipt.logs) {
      // We only care about logs emitted by the market we just called.
      if (log.address.toLowerCase() !== market) continue
      try {
        const decoded = decodeEventLog({
          abi: ORDERBOOK_MARKET_ABI,
          data: log.data,
          topics: log.topics,
        }) as any
        if (decoded.eventName === 'OrderPlaced') {
          setOrderId(decoded.args.orderId as bigint)
          break
        }
        // Anything else - LPMatched, MatchTied, a settle/refund event that
        // happened to land in the same block - is simply not what this
        // effect is looking for. Falling through here (rather than treating
        // an unrecognised eventName as an error) is what keeps this loop from
        // ever throwing on a log shape it does not know about.
      } catch {
        // Not decodable against this ABI at all - skip. decodeEventLog throws
        // on a log this ABI has no matching event for, which is expected and
        // frequent: a bet's receipt can carry logs from other contracts
        // (fee transfers, LP bookkeeping) that were never going to be OrderPlaced.
      }
    }
  }, [betReceiptOk, betReceipt, intent])

  const execute = useCallback(async () => {
    // One bet at a time. Refuses outright rather than queueing: a second click
    // during an approval is not a request for a second bet.
    if (inFlightRef.current || stepRef.current === 'approving' || stepRef.current === 'betting') return
    if (!address || amountWei === 0n) return

    // Freeze the intent before anything is awaited. From here to the end of
    // this function, `marketAddress`, `direction`, `amountWei`, `address` and
    // the rest are not read again - only `snap` is.
    const snap: BetIntent = {
      marketAddress,
      direction,
      amountWei,
      expectedPrice,
      slippageBps,
      account: address,
      chainId: TARGET_CHAIN_ID,
      referrer: effectiveReferrer,
    }
    inFlightRef.current = true
    setInFlight(true)
    intentRef.current = snap
    setIntent(snap)
    setError(undefined)
    setOrderId(undefined)
    setSubmittedHash(undefined)

    try {
      // Refuse before the user pays for an approval: a zero price is rejected
      // by the contract ("expectedPrice zero") only at placeBet, after it.
      if (snap.expectedPrice <= 0n) {
        setStep('error')
        setError('Price unavailable - cannot price this bet right now. Please retry in a moment.')
        return
      }

      // Only a confirmed `true` is trusted - `undefined` (still loading, or
      // the read errored) and `false` both refuse. Treating "not yet
      // confirmed" as "confirmed fine" is the exact bug this mirrors from
      // Market.tsx's old `notAMarket = isRealMarket === false`: an RPC
      // hiccup left isRealMarket undefined, which made that check false too,
      // and opened the door to approving an unverified contract. Asked of
      // the chain directly, for the frozen market, if it has not resolved yet
      // - wagmi's automatic refetch triggers (focus, reconnect) are not a
      // guarantee this has run recently for a tab that has been open a while,
      // and a refetch through the hook would answer for whatever market is
      // picked by the time it returns, not the one this bet is for.
      let marketConfirmed: boolean | undefined = isRealMarket
      if (marketConfirmed === undefined && publicClient) {
        try {
          marketConfirmed = (await publicClient.readContract({
            address: CONTRACTS.MARKET_FACTORY,
            abi: MARKET_FACTORY_ABI,
            functionName: 'isMarket',
            args: [snap.marketAddress],
          })) as boolean
        } catch {
          marketConfirmed = undefined
        }
      }
      if (marketConfirmed !== true) {
        setStep('error')
        setError('Could not verify this is a real market. Please retry.')
        return
      }

      const chainCheck = await ensureChain()
      if (!chainCheck.ok) {
        setStep('error')
        setError(chainCheck.error)
        return
      }

      if (!allowance || allowance < snap.amountWei) {
        setStep('approving')
        // Bounded to this bet's own stake, not maxUint256. marketAddress comes
        // from a URL param one hop up the call chain (Market.tsx reads
        // /market/:address) - Market.tsx now refuses to render the Composer
        // for an address that fails PoolMarketFactory.isMarket, but this hook
        // is the last line of defence and must never ask for more allowance
        // than it is about to spend. The cost is re-approving on every bet
        // whose stake exceeds the existing allowance, which is the correct
        // trade against a wallet-draining approval to an unverified contract.
        const approveHash = await approve({
          address: CONTRACTS.USDC,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [snap.marketAddress, snap.amountWei],
          account: snap.account,
          chainId: snap.chainId,
        })
        // Wait for it to land, not merely to be submitted.
        //
        // writeContractAsync resolves the moment the wallet accepts, so the
        // bet used to go out while the approval was still pending. Nonce
        // ordering would have executed them in the right order, but the
        // wallet estimates gas for the bet first and does not care about the
        // queue - the user gets "transfer amount exceeds allowance" on a bet
        // they were just told had been approved.
        if (publicClient) {
          const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
          if (receipt.status !== 'success') {
            throw new Error(`${CURRENCY_SYMBOL} approval failed on-chain - nothing was bet.`)
          }
        }
        await refetchAllowance()
      }

      setStep('betting')

      // The strike has to come from a freshly signed oracle price, fetched
      // right now.
      //
      // This is not best-effort and has no fallback. Pricing a bet off the
      // keeper's last push meant the strike could be seconds stale - long
      // enough for anyone watching the oracle live to enter against a price
      // they already knew had moved - so the contract has no entry point that
      // accepts anything else. Failing here and asking the user to retry is
      // the correct outcome; placing their bet at a strike we know may be
      // wrong is worse.
      if (!marketFeedId) {
        throw new Error('Market price feed unavailable - cannot price this bet.')
      }

      if (IS_POOL_BACKED) {
        // PoolOrderbookMarket obtains its 60s TWAP on-chain. It is an ordinary
        // contract call: no RedStone payload and no hand-built calldata.
        const hash = await placeBet({
          address: snap.marketAddress,
          abi: ORDERBOOK_MARKET_ABI,
          functionName: 'placeBet',
          args: [snap.direction, snap.amountWei, snap.referrer, snap.expectedPrice, BigInt(snap.slippageBps)],
          account: snap.account,
          chainId: snap.chainId,
        })
        setSubmittedHash(hash)
      } else {
        let payload: `0x${string}`
        try {
          payload = await fetchBetPayload(marketFeedId)
        } catch (e: any) {
          throw new Error(`Couldn't fetch a live price (${e?.message ?? 'network error'}). Please try again.`)
        }
        const hash = await sendBet({
          to: snap.marketAddress,
          data: withPayload(encodeFunctionData({
            abi: ORDERBOOK_MARKET_ABI,
            functionName: 'placeBet',
            args: [snap.direction, snap.amountWei, snap.referrer, snap.expectedPrice, BigInt(snap.slippageBps)],
          }), payload),
          account: snap.account,
          chainId: snap.chainId,
        })
        setSubmittedHash(hash)
      }

      // Confirmation is derived from the receipt below. Wallet acceptance only
      // means the transaction was submitted; redirecting before inclusion can
      // hide a reverted RHC bet.
    } catch (err: any) {
      setStep('error')
      setError(err?.shortMessage || err?.message || 'Transaction failed')
    } finally {
      // The bet may still be waiting on its receipt (step 'betting'), which
      // keeps `busy` true; this only ends the part that is execute()'s own.
      inFlightRef.current = false
      setInFlight(false)
    }
  }, [address, amountWei, allowance, direction, marketAddress, effectiveReferrer, expectedPrice, slippageBps, marketFeedId, isRealMarket, approve, placeBet, refetchAllowance, sendBet, ensureChain, publicClient, setStep])

  return {
    execute,
    step,
    error,
    betTxHash: finalBetHash,
    orderId, // Sprint 4.1: now populated after confirmation
    /**
     * The frozen intent of the bet in flight or last placed. Anything that
     * acts on "the bet" (the redirect to its order page, above all) reads its
     * market from here, not from whatever is picked now.
     */
    intent,
    /**
     * True from the click until the bet has a verdict. Callers lock the stake,
     * the amount chips, CLEAR and the UP/DOWN pick while it is true: none of
     * them can change a bet already in flight, and letting them look as if
     * they could is what made a second bet possible.
     */
    busy,
    isLoading: step === 'approving' || step === 'betting',
    // Derived from `step`, not from the receipt query directly: a fetched
    // receipt for a REVERTED transaction used to read as "confirmed" here
    // too (isSuccess only means the fetch succeeded, not that the call did),
    // which is exactly the class of bug this hook's step machine now closes.
    isConfirmed: step === 'confirmed',
  }
}
