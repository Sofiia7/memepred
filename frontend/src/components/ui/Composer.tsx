import { useState, useMemo, useEffect } from 'react'
import { useAccount, useReadContract, useWriteContract, usePublicClient } from 'wagmi'
import { useNavigate } from 'react-router-dom'
import { parseUnits, formatUnits } from 'viem'
import { usePlaceBet } from '../../hooks/usePlaceBet'
import { usePythPrice } from '../../hooks/usePythPrice'
import { useConnectWallet } from '../../hooks/useConnectWallet'
import { useEnsureChain } from '../../hooks/useEnsureChain'
import { formatDuration } from '../../lib/symbols'
import { CONTRACTS, MIN_BET, MAX_BET, CURRENCY_SYMBOL, CURRENCY_DECIMALS, LP_TAKER_FEE_BPS, ORDERBOOK_MARKET_ABI, WETH_ABI } from '../../lib/contracts'
import { IS_POOL_BACKED } from '../../lib/chain'
import { Chev } from './icons'
import type { PickedBet } from './MarketCard'

const STAKE_CHIPS = IS_POOL_BACKED ? [0.005, 0.01, 0.02, 0.04] : [5, 10, 25, 100]

/**
 * Never throws: a bad stake should fail the button, not the render.
 *
 * Takes the raw typed string directly rather than a number. Round-tripping a
 * tiny stake through Number(...).toString() is exactly how "0.0000001"
 * becomes "1e-7" - a form parseUnits rejects outright - so the input's own
 * text is kept as the source of truth throughout and never reconstructed
 * from a parsed float.
 */
function safeParseStake(raw: string): bigint {
  try {
    return parseUnits(raw || '0', CURRENCY_DECIMALS)
  } catch {
    return 0n
  }
}

export function Composer({ picked, onClear }: { picked: PickedBet | null; onClear: () => void }) {
  const { address, isConnected } = useAccount()
  const { connectWallet } = useConnectWallet()
  const ensureChain = useEnsureChain()
  const publicClient = usePublicClient()
  const navigate = useNavigate()
  // The input's own text, kept as a string throughout - see safeParseStake's
  // comment for why. Number(stakeInput) below is derived, read-only, and
  // never written back into this state.
  const [stakeInput, setStakeInput] = useState<string>(String(STAKE_CHIPS[1]))
  const stakeNum = Number(stakeInput)
  const stake = Number.isFinite(stakeNum) ? stakeNum : 0
  const { raw: pythRaw } = usePythPrice(picked?.feedId)
  const { data: feeBps = 0n } = useReadContract({
    address: (picked?.marketAddress ?? '0x0000000000000000000000000000000000') as `0x${string}`,
    abi: ORDERBOOK_MARKET_ABI,
    functionName: 'feeBps',
    query: { enabled: !!picked },
  })

  // ── RHC only: the stake is WETH, and a fresh wallet holds only native ETH.
  // There is otherwise no path in this UI from "connected wallet" to "has
  // something to bet" on this chain.
  const { data: wethBalance, refetch: refetchWethBalance } = useReadContract({
    address: CONTRACTS.USDC,
    abi: WETH_ABI,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: IS_POOL_BACKED && !!address },
  })
  const { writeContractAsync: wrapEth } = useWriteContract()
  const [wrapping, setWrapping] = useState(false)
  const [wrapError, setWrapError] = useState<string>()

  const stakeWei = safeParseStake(stakeInput)
  const insufficientWeth = IS_POOL_BACKED && wethBalance !== undefined && wethBalance < stakeWei
  const wrapShortfall = insufficientWeth ? stakeWei - (wethBalance ?? 0n) : 0n

  async function handleWrap() {
    if (!address || wrapShortfall === 0n) return
    setWrapError(undefined)
    setWrapping(true)
    try {
      const chainCheck = await ensureChain()
      if (!chainCheck.ok) { setWrapError(chainCheck.error); return }
      const hash = await wrapEth({
        address: CONTRACTS.USDC,
        abi: WETH_ABI,
        functionName: 'deposit',
        value: wrapShortfall,
      })
      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('Wrap failed on-chain - nothing was bet.')
      }
      await refetchWethBalance()
    } catch (e: any) {
      setWrapError(e?.shortMessage || e?.message || 'Wrap failed')
    } finally {
      setWrapping(false)
    }
  }

  const bet = usePlaceBet({
    marketAddress: (picked?.marketAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
    direction: picked?.side === 'up' ? 0 : 1,
    amountUsd: stakeInput,
    expectedPrice: pythRaw,
    slippageBps: 100,
  })

  // Redirect to the order-status page once the tx confirms and the orderId
  // has been decoded from the receipt. If for some reason the decode never
  // resolves (e.g. logs shape changed), fall back to just clearing after a
  // few seconds instead of leaving the composer stuck on "PLACED".
  useEffect(() => {
    if (!bet.isConfirmed || !picked) return
    if (bet.orderId !== undefined) {
      const marketAddress = picked.marketAddress
      const orderId = bet.orderId
      onClear()
      navigate(`/order/${marketAddress}/${orderId.toString()}`)
      return
    }
    const t = setTimeout(() => onClear(), 4000)
    return () => clearTimeout(t)
  }, [bet.isConfirmed, bet.orderId, picked, navigate, onClear])

  // Payout is a function of the matched stake, never of the queue-depth "lean"
  // shown on the UP/DOWN buttons - an odds-implied preview here once had users
  // expecting 3.3x on a 30% lean and getting 2x.
  //
  // The market's protocol fee applies to either winning match. The LP taker
  // fee applies in addition only when the LP took the other side.
  const payout = useMemo(() => {
    if (!stake) return null
    const gross = stake * 2
    const protocolNet = gross * (1 - Number(feeBps) / 10_000)
    const net = protocolNet - gross * (LP_TAKER_FEE_BPS / 10_000)
    return { low: net.toFixed(4), high: protocolNet.toFixed(4) }
  }, [stake, feeBps])

  if (!picked) {
    return (
      <div className="composer empty">
        <div className="composer-empty-txt">↑ Tap UP or DOWN to place a bet</div>
      </div>
    )
  }

  const ctaText = !isConnected
    ? 'CONNECT WALLET'
    : insufficientWeth ? `INSUFFICIENT ${CURRENCY_SYMBOL} - WRAP ETH FIRST`
    : bet.step === 'approving' ? `APPROVING ${CURRENCY_SYMBOL}…`
    : bet.step === 'betting' ? 'PLACING BET…'
    : bet.step === 'confirmed' ? 'PLACED ✓'
    : bet.step === 'error' ? 'RETRY · ' + (bet.error?.slice(0, 30) ?? '')
    : `BUY ${picked.side.toUpperCase()} · ${stake} ${CURRENCY_SYMBOL}`

  return (
    <div className="composer">
      <div className="composer-head">
        <div className="composer-pick">
          <span className={'pick-pill ' + (picked.side === 'up' ? 'up' : 'dn')}>
            <Chev dir={picked.side === 'up' ? 'up' : 'down'} /> {picked.side.toUpperCase()}
          </span>
          <span className="pick-coin">{picked.symbol}</span>
          <span className="pick-tf">· {formatDuration(picked.durationSec)}</span>
          <span className="pick-tf">· waits for an opposite order</span>
        </div>
        <button className="clear" onClick={onClear}>CLEAR</button>
      </div>

      <div className="stake-row">
        <div className="stake-input">
          <span className="ccy">{CURRENCY_SYMBOL}</span>
          <input
            type="number"
            value={stakeInput}
            min={MIN_BET}
            max={MAX_BET}
            // Stored verbatim, not clamped-and-reformatted on every keystroke:
            // that round-trip (parse to a number, write it back as the input's
            // value) is what used to turn an in-progress "0.0000001" into a
            // silently-rewritten value and, at submit time, the exponential
            // notation that crashed the render. Out-of-range values are still
            // rejected - by the BUY button's disabled check below, not by
            // fighting what the user is typing.
            onChange={(e) => setStakeInput(e.target.value)}
          />
        </div>
      </div>
      <div className="stake-hint">{MIN_BET}-{MAX_BET} {CURRENCY_SYMBOL} per bet</div>

      {IS_POOL_BACKED && isConnected && (
        <div className="stake-hint" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span>
            {CURRENCY_SYMBOL} balance: {wethBalance !== undefined ? formatUnits(wethBalance, CURRENCY_DECIMALS) : '…'}
          </span>
          {insufficientWeth && (
            <button
              className="chip"
              style={{ flex: '0 0 auto', padding: '0 10px', height: 28 }}
              disabled={wrapping}
              onClick={handleWrap}
            >
              {wrapping ? 'WRAPPING…' : `WRAP ${formatUnits(wrapShortfall, CURRENCY_DECIMALS)} ETH`}
            </button>
          )}
        </div>
      )}
      {wrapError && <div className="osc-error">{wrapError}</div>}

      <div className="chips">
        {STAKE_CHIPS.map((c) => (
          <button key={c} className={'chip ' + (stake === c ? 'sel' : '')} onClick={() => setStakeInput(String(c))}>
            {c} {CURRENCY_SYMBOL}
          </button>
        ))}
      </div>

      <button
        className={'cta' + (bet.isLoading ? ' disabled' : '')}
        disabled={bet.isLoading || stake < MIN_BET || stake > MAX_BET || insufficientWeth}
        onClick={() => {
          if (!isConnected) {
            connectWallet()
            return
          }
          bet.execute()
        }}
      >
        {bet.isLoading ? <span className="spinner" /> : <span className="basesq" />}
        {ctaText}
      </button>

      <div className="payout">
        <span>Protocol fee: {(Number(feeBps) / 100).toFixed(2)}% on a win · LP match adds {(LP_TAKER_FEE_BPS / 100).toFixed(2)}%</span>
        <span>PAYOUT IF WON · <b>{payout ? `${payout.low}-${payout.high} ${CURRENCY_SYMBOL}` : '-'}</b></span>
      </div>
    </div>
  )
}
