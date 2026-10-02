import { useState, useMemo, useEffect, useId, useRef } from 'react'
import { useAccount, useBalance, useReadContract, useWriteContract, usePublicClient } from 'wagmi'
import { useNavigate } from 'react-router-dom'
import { parseUnits } from 'viem'
import { usePlaceBet } from '../../hooks/usePlaceBet'
import { usePythPrice } from '../../hooks/usePythPrice'
import { useConnectWallet } from '../../hooks/useConnectWallet'
import { useEnsureChain } from '../../hooks/useEnsureChain'
import { useBetBusyStore } from '../../hooks/useBetBusy'
import { useDeploymentCheck } from '../../hooks/useDeploymentCheck'
import { formatDuration } from '../../lib/symbols'
import { friendlyRevertReason } from '../../lib/revertReasons'
import { CONTRACTS, MIN_BET, MAX_BET, CURRENCY_SYMBOL, CURRENCY_DECIMALS, LP_TAKER_FEE_BPS, ORDERBOOK_MARKET_ABI, WETH_ABI } from '../../lib/contracts'
import { IS_POOL_BACKED, TARGET_CHAIN, TARGET_CHAIN_ID } from '../../lib/chain'
import { FAUCET_URL } from '../../lib/env'
import { DEFAULT_SLIPPAGE_BPS, GAS_RESERVE_ETH, GAS_RESERVE_WEI } from '../../lib/rules'
import { composerGate } from '../../lib/composerGate'
import { DEPLOYMENT_MISMATCH_MESSAGE } from '../../lib/deployment'
import { formatAmount } from '../../lib/money'
import { Chev } from './icons'
import { ChainMark } from './ChainMark'
import { PreSignRules } from './PreSignRules'
import type { PickedBet } from './MarketCard'
import { ROUNDS_ENABLED } from '../../rounds/flag'

const LEGACY_TESTNET = IS_POOL_BACKED && !!TARGET_CHAIN.testnet && ROUNDS_ENABLED

const STAKE_CHIPS = IS_POOL_BACKED ? [0.005, 0.01, 0.02, 0.04] : [5, 10, 25, 100]

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

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
  const deployment = useDeploymentCheck()
  const setBetBusy = useBetBusyStore((s) => s.setBusy)
  const stakeId = useId()
  const hintId = useId()

  // ── the pick, held still while a bet is in flight (audit U01) ──
  // The pages keep `picked` in their own state and hand it down, so a click on
  // the other side arrives as a new prop while the wallet is still open on the
  // old bet. While a bet is being placed, what this shows (and what it is
  // given to place) is the pick as it was when the bet began, whatever the page
  // does with its own state meanwhile. usePlaceBet freezes the bet itself; this
  // keeps the screen from describing a different one.
  const [locked, setLocked] = useState<PickedBet | null>(null)
  const shown = locked ?? picked
  const shownRef = useRef(shown)
  shownRef.current = shown

  // The input's own text, kept as a string throughout - see safeParseStake's
  // comment for why. Number(stakeInput) below is derived, read-only, and
  // never written back into this state.
  const [stakeInput, setStakeInput] = useState<string>(String(STAKE_CHIPS[1]))
  const stakeNum = Number(stakeInput)
  const stake = Number.isFinite(stakeNum) ? stakeNum : 0
  const stakeWei = safeParseStake(stakeInput)
  const stakeOk = stakeWei > 0n && stake >= MIN_BET && stake <= MAX_BET

  const marketAddress = (shown?.marketAddress ?? ZERO_ADDRESS) as `0x${string}`

  // ── the price, read for the feed the market itself reports (audit U02) ──
  // The feed id in `picked` came from the backend and is empty until the
  // markets list has loaded; the market contract's own feedId() is the one the
  // bet will actually be priced against. usePlaceBet reads the same value,
  // which react-query shares, so this costs no extra request.
  const { data: marketFeedId } = useReadContract({
    address: marketAddress,
    abi: ORDERBOOK_MARKET_ABI,
    functionName: 'feedId',
    query: { enabled: !!shown },
  })
  const price = usePythPrice(shown ? (marketFeedId as string | undefined) : undefined)

  // ── the fee, which is unknown until it has been read (audit U03) ──
  // `feeBps = 0n` as a default made "still loading" and "no fee" the same
  // thing, so a quote of 0.00% was shown, and could be signed against, while
  // the real number was on its way.
  const { data: feeBps, isError: feeFailed } = useReadContract({
    address: marketAddress,
    abi: ORDERBOOK_MARKET_ABI,
    functionName: 'feeBps',
    query: { enabled: !!shown },
  })
  const feeReady = feeBps !== undefined

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
  const { data: ethBalance, refetch: refetchEthBalance } = useBalance({
    address,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: IS_POOL_BACKED && !!address },
  })
  const ethWei = ethBalance?.value
  const { writeContractAsync: wrapEth } = useWriteContract()
  const [wrapping, setWrapping] = useState(false)
  const [wrapError, setWrapError] = useState<string>()

  const insufficientWeth = IS_POOL_BACKED && wethBalance !== undefined && wethBalance < stakeWei
  const wrapShortfall = insufficientWeth ? stakeWei - (wethBalance ?? 0n) : 0n
  // Wrapping spends native ETH, and the approval and the bet after it need some
  // left over for gas: warn before the wrap rather than after the bet cannot be sent.
  const notEnoughEth = wrapShortfall > 0n && ethWei !== undefined && ethWei < wrapShortfall
  const leavesLittleGas = wrapShortfall > 0n && ethWei !== undefined && ethWei >= wrapShortfall && ethWei - wrapShortfall < GAS_RESERVE_WEI
  const showFaucet = TARGET_CHAIN.testnet && ethWei !== undefined && (ethWei === 0n || notEnoughEth)

  const bet = usePlaceBet({
    marketAddress,
    direction: shown?.side === 'up' ? 0 : 1,
    amountUsd: stakeInput,
    expectedPrice: price.raw,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
  })

  // A wrap and a bet both hold the wallet open; neither may be interleaved
  // with a change to what they are for.
  const busy = bet.busy || wrapping

  async function handleWrap() {
    if (!address || wrapShortfall === 0n || busy) return
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
        account: address,
        chainId: TARGET_CHAIN_ID,
      })
      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('Wrap failed on-chain - nothing was bet.')
      }
      await Promise.all([refetchWethBalance(), refetchEthBalance()])
    } catch (e: any) {
      setWrapError(e?.shortMessage || e?.message || 'Wrap failed')
    } finally {
      setWrapping(false)
    }
  }

  // Tell everything that lets the user change the pick (the UP/DOWN buttons on
  // the pages) that it must not, and hold the pick still, for as long as this
  // is true. Released on unmount too: a Composer that goes away mid-flight must
  // not leave those buttons disabled for good.
  useEffect(() => {
    setBetBusy(busy)
    setLocked((cur) => (busy ? cur ?? shownRef.current : null))
  }, [busy, setBetBusy])
  useEffect(() => () => setBetBusy(false), [setBetBusy])

  // Redirect to the order-status page once the tx confirms and the orderId
  // has been decoded from the receipt. It goes to the market the bet was sent
  // to (bet.intent), not to whatever is picked by the time the receipt lands.
  // If for some reason the decode never resolves (e.g. logs shape changed),
  // fall back to just clearing after a few seconds instead of leaving the
  // composer stuck on "PLACED".
  const onClearRef = useRef(onClear)
  onClearRef.current = onClear
  useEffect(() => {
    if (!bet.isConfirmed) return
    const placed = bet.intent
    if (bet.orderId !== undefined && placed) {
      onClearRef.current()
      navigate(`/order/${placed.marketAddress}/${bet.orderId.toString()}`)
      return
    }
    const t = setTimeout(() => onClearRef.current(), 4000)
    return () => clearTimeout(t)
  }, [bet.isConfirmed, bet.orderId, bet.intent, navigate])

  // Payout is a function of the matched stake, never of the queue-depth "lean"
  // shown on the UP/DOWN buttons - an odds-implied preview here once had users
  // expecting 3.3x on a 30% lean and getting 2x.
  //
  // The market's protocol fee applies to either winning match. The LP taker
  // fee applies in addition only when the LP took the other side. Not shown at
  // all until the fee has been read.
  const payout = useMemo(() => {
    if (!stake || feeBps === undefined) return null
    const gross = stake * 2
    const protocolNet = gross * (1 - Number(feeBps) / 10_000)
    const net = protocolNet - gross * (LP_TAKER_FEE_BPS / 10_000)
    return { low: net.toFixed(4), high: protocolNet.toFixed(4) }
  }, [stake, feeBps])

  if (!shown) {
    return (
      <div className="composer empty">
        <div className="composer-empty-txt">↑ Tap UP or DOWN to place a bet</div>
      </div>
    )
  }

  const deploymentMismatch = deployment.status === 'mismatch'

  // Full message, never truncated: a ~30-char slice used to render
  // "price slippage exceeded", "expectedPrice zero" and an ERC20 balance
  // error as the same unhelpful prefix. Known contract revert reasons are
  // mapped to short plain English first; anything else is shown in full.
  const gate = composerGate({
    isConnected,
    busy,
    step: bet.step,
    stakeOk,
    insufficientBalance: insufficientWeth,
    price: { status: price.status, raw: price.raw },
    feeReady,
    feeFailed,
    deploymentMismatch,
    errorText: friendlyRevertReason(bet.error),
    symbol: CURRENCY_SYMBOL,
    side: shown.side,
    stake,
  })

  function onCta() {
    if (!isConnected) {
      connectWallet()
      return
    }
    // The button is disabled in these states; this is for a click that was
    // already on its way when the state changed.
    if (gate.disabled) return
    void bet.execute()
  }

  const feeText = feeReady
    ? `Protocol fee: ${(Number(feeBps) / 100).toFixed(2)}% on a win · LP match adds ${(LP_TAKER_FEE_BPS / 100).toFixed(2)}%`
    : feeFailed
      ? 'Protocol fee: unavailable, retrying'
      : 'Protocol fee: loading…'

  return (
    <div className="composer">
      <div className="composer-head">
        <div className="composer-pick">
          <span className={'pick-pill ' + (shown.side === 'up' ? 'up' : 'dn')}>
            <Chev dir={shown.side === 'up' ? 'up' : 'down'} /> {shown.side.toUpperCase()}
          </span>
          <span className="pick-coin">{shown.symbol}</span>
          <span className="pick-tf">· {formatDuration(shown.durationSec)}</span>
          {/* On Robinhood Chain an LP-enabled market fills from the vault
              first, so "waits for an opposite order" was not true there; the
              matching rules are in the block above the confirm button. */}
          {!IS_POOL_BACKED && <span className="pick-tf">· waits for an opposite order</span>}
        </div>
        <button className="clear" disabled={busy} onClick={() => { if (!busy) onClear() }}>CLEAR</button>
      </div>

      <div className="stake-row">
        <div className="stake-input">
          <label className="ccy" htmlFor={stakeId}>
            <span className="sr-only">Stake in </span>
            {CURRENCY_SYMBOL}
          </label>
          <input
            id={stakeId}
            type="number"
            inputMode="decimal"
            step="any"
            value={stakeInput}
            min={MIN_BET}
            max={MAX_BET}
            disabled={busy}
            aria-describedby={hintId}
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
      <div className="stake-hint" id={hintId}>{MIN_BET}-{MAX_BET} {CURRENCY_SYMBOL} per bet</div>

      {IS_POOL_BACKED && isConnected && (
        <div className="stake-hint wallet-lines">
          <span>
            {CURRENCY_SYMBOL} {wethBalance !== undefined ? formatAmount(wethBalance, CURRENCY_DECIMALS) : '…'}
            {' · '}ETH {ethWei !== undefined ? formatAmount(ethWei, 18) : '…'}
          </span>
          {showFaucet && (
            <a className="faucet-link" href={FAUCET_URL} target="_blank" rel="noopener noreferrer">
              Get test ETH
            </a>
          )}
          {insufficientWeth && !LEGACY_TESTNET && (
            <button className="chip wrap-btn" disabled={wrapping || notEnoughEth} onClick={handleWrap}>
              {wrapping ? 'WRAPPING…' : `WRAP ${formatAmount(wrapShortfall, 18)} ETH`}
            </button>
          )}
        </div>
      )}
      {notEnoughEth && (
        <div className="composer-note warn" role="status">
          Not enough ETH to wrap {formatAmount(wrapShortfall, 18)}: the wallet holds {formatAmount(ethWei ?? 0n, 18)} ETH.
        </div>
      )}
      {leavesLittleGas && (
        <div className="composer-note warn" role="status">
          Wrapping this leaves about {formatAmount((ethWei ?? 0n) - wrapShortfall, 18)} ETH for gas. Keep at
          least {GAS_RESERVE_ETH} ETH for the approval and the bet.
        </div>
      )}
      {wrapError && <div className="composer-note">{wrapError}</div>}
      {IS_POOL_BACKED && (
        <div className="stake-hint">{LEGACY_TESTNET ? 'This legacy fixture WETH cannot be unwrapped. Use Rounds for a direct ETH bet.' : 'Wrap ETH to WETH, approve, then bet: up to 3 wallet confirmations.'}</div>
      )}

      <div className="chips">
        {STAKE_CHIPS.map((c) => (
          <button key={c} className={'chip ' + (stake === c ? 'sel' : '')} disabled={busy} onClick={() => setStakeInput(String(c))}>
            {c} {CURRENCY_SYMBOL}
          </button>
        ))}
      </div>

      {IS_POOL_BACKED && <PreSignRules durationSec={shown.durationSec} slippageBps={DEFAULT_SLIPPAGE_BPS} />}

      {deploymentMismatch && (
        <div className="composer-note" role="alert">
          {DEPLOYMENT_MISMATCH_MESSAGE}. Signing is turned off.
        </div>
      )}

      <button className={'cta' + (gate.disabled ? ' disabled' : '')} disabled={gate.disabled} onClick={onCta}>
        {bet.isLoading || wrapping ? <span className="spinner" /> : <ChainMark />}
        {gate.label}
      </button>

      <div className="payout">
        <span>{feeText}</span>
        <span>PAYOUT IF WON · <b>{payout ? `${payout.low}-${payout.high} ${CURRENCY_SYMBOL}` : '-'}</b></span>
      </div>
    </div>
  )
}
