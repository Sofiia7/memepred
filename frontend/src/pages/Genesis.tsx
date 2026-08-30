import { useState } from 'react'
import { useReadContract, useWriteContract, useAccount } from 'wagmi'
import { parseUnits, maxUint256 } from 'viem'
import { CONTRACTS, LIQUIDITY_POOL_ABI, ERC20_ABI } from '../lib/contracts'
import { ScreenTitle } from '../components/ui/AppShell'
import { StarIcon } from '../components/ui/icons'
import { useConnectWallet } from '../hooks/useConnectWallet'
import { useEnsureChain } from '../hooks/useEnsureChain'
import { TARGET_CHAIN } from '../wagmi.config'

const NETWORK_LABEL = TARGET_CHAIN.name // "Base" or "Base Sepolia" - derived from the actual configured chain, not hardcoded

export function GenesisPage() {
  const { address, isConnected } = useAccount()
  const { connectWallet } = useConnectWallet()
  const ensureChain = useEnsureChain()
  const [depositAmount, setDepositAmount] = useState('50')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isWithdrawing, setIsWithdrawing] = useState(false)
  const [isClaiming, setIsClaiming] = useState(false)
  const [actionError, setActionError] = useState<string>()

  const { data: stats, refetch: refetchStats } = useReadContract({
    address: CONTRACTS.LIQUIDITY_POOL,
    abi: LIQUIDITY_POOL_ABI,
    functionName: 'getPoolStats',
  })

  const { data: shareBalance, refetch: refetchShareBalance } = useReadContract({
    address: CONTRACTS.LIQUIDITY_POOL,
    abi: LIQUIDITY_POOL_ABI,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: !!address },
  })

  const { data: myAssets, refetch: refetchMyAssets } = useReadContract({
    address: CONTRACTS.LIQUIDITY_POOL,
    abi: LIQUIDITY_POOL_ABI,
    functionName: 'previewRedeem',
    args: [shareBalance ?? 0n],
    query: { enabled: !!shareBalance && shareBalance > 0n },
  })

  const { data: maxWithdrawable, refetch: refetchMaxWithdrawable } = useReadContract({
    address: CONTRACTS.LIQUIDITY_POOL,
    abi: LIQUIDITY_POOL_ABI,
    functionName: 'maxWithdraw',
    args: [address!],
    query: { enabled: !!address },
  })

  const { data: pendingFees, refetch: refetchPendingFees } = useReadContract({
    address: CONTRACTS.LIQUIDITY_POOL,
    abi: LIQUIDITY_POOL_ABI,
    functionName: 'earnedFees',
    args: [address!],
    query: { enabled: !!address },
  })

  const { data: isGenesisAddr } = useReadContract({
    address: CONTRACTS.LIQUIDITY_POOL,
    abi: LIQUIDITY_POOL_ABI,
    functionName: 'isGenesis',
    args: [address!],
    query: { enabled: !!address },
  })

  function refetchAll() {
    refetchStats()
    refetchShareBalance()
    refetchMyAssets()
    refetchMaxWithdrawable()
    refetchPendingFees()
  }

  const { writeContractAsync: approve } = useWriteContract()
  const { writeContractAsync: deposit } = useWriteContract()
  const { writeContractAsync: withdraw } = useWriteContract()
  const { writeContractAsync: claimFees } = useWriteContract()

  const totalPool = stats ? Number(stats[0]) / 1e6 : 0
  const locked = stats ? Number(stats[2]) / 1e6 : 0
  const genesisLeft = stats ? Number(stats[3]) : 20
  const filled = 20 - genesisLeft
  const pct = (filled / 20) * 100

  const mySharesValue = myAssets ? Number(myAssets) / 1e6 : 0
  const myPending = pendingFees ? Number(pendingFees) / 1e6 : 0
  const isGenesis = !!isGenesisAddr
  const hasPosition = (shareBalance ?? 0n) > 0n
  const maxWithdrawUsd = maxWithdrawable ? Number(maxWithdrawable) / 1e6 : 0

  async function handleDeposit() {
    if (!address) {
      connectWallet()
      return
    }
    setActionError(undefined)
    setIsLoading(true)
    try {
      const chainCheck = await ensureChain()
      if (!chainCheck.ok) { setActionError(chainCheck.error); return }
      const amount = parseUnits(depositAmount, 6)
      await approve({
        address: CONTRACTS.USDC,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [CONTRACTS.LIQUIDITY_POOL, maxUint256],
      })
      await deposit({
        address: CONTRACTS.LIQUIDITY_POOL,
        abi: LIQUIDITY_POOL_ABI,
        functionName: 'deposit',
        args: [amount, address],
      })
      refetchAll()
    } catch (err: any) {
      setActionError(err?.shortMessage || err?.message || 'Deposit failed')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleWithdraw() {
    if (!address || !withdrawAmount) return
    setActionError(undefined)
    setIsWithdrawing(true)
    try {
      const chainCheck = await ensureChain()
      if (!chainCheck.ok) { setActionError(chainCheck.error); return }
      const assets = parseUnits(withdrawAmount, 6)
      await withdraw({
        address: CONTRACTS.LIQUIDITY_POOL,
        abi: LIQUIDITY_POOL_ABI,
        functionName: 'withdraw',
        args: [assets, address, address],
      })
      setWithdrawAmount('')
      refetchAll()
    } catch (err: any) {
      setActionError(err?.shortMessage || err?.message || 'Withdraw failed')
    } finally {
      setIsWithdrawing(false)
    }
  }

  async function handleClaimFees() {
    setActionError(undefined)
    // Guarded like deposit and withdraw already are. Without it a second click
    // while the wallet prompt is open sends a second claim, and the second one
    // reverts on "nothing to claim" after the first lands - a confusing error
    // for a user who did nothing wrong, and a wasted fee.
    if (isClaiming) return
    setIsClaiming(true)
    try {
      const chainCheck = await ensureChain()
      if (!chainCheck.ok) { setActionError(chainCheck.error); return }
      await claimFees({
        address: CONTRACTS.LIQUIDITY_POOL,
        abi: LIQUIDITY_POOL_ABI,
        functionName: 'claimFees',
      })
      refetchAll()
    } catch (err: any) {
      setActionError(err?.shortMessage || err?.message || 'Claim fees failed')
    } finally {
      setIsClaiming(false)
    }
  }

  return (
    <>
      <ScreenTitle title="Genesis LP" icon={<StarIcon color="#4d8dff" />} />

      <div className="genesis-hero">
        <div className="gh-eyebrow">
          <span className="basesq" />
          Limited program · {NETWORK_LABEL}
        </div>
        <h3 className="gh-title">
          First 20 LPs earn <em>1.5×</em> fee share <em>forever</em>.
        </h3>
        <div className="gh-sub">
          Provide USDC to the matching vault, mint a soulbound Genesis NFT, and accrue boosted fees on every market settlement - for as long as flipthememe exists.
        </div>
        <div className="spots">
          <div className="big">{genesisLeft}</div>
          <div className="of">/ 20 spots</div>
        </div>
        <div className="spots-bar">
          <div className="spots-fill" style={{ width: pct + '%' }} />
        </div>
        <div className="spots-meta">
          <span>{filled} CLAIMED</span>
          <span>{genesisLeft} REMAINING</span>
        </div>
      </div>

      <div className="g-stats">
        <div className="g-stat">
          <div className="k">Total Vault Assets</div>
          <div className="v">
            ${totalPool.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)', fontWeight: 500, marginLeft: 4 }}>USDC</span>
          </div>
        </div>
        <div className="g-stat">
          <div className="k">Locked in Matches</div>
          <div className="v">${locked.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        </div>
      </div>

      {hasPosition && (
        <>
          <div className="b-title">Your position {isGenesis && <span className="pick-pill up" style={{ marginLeft: 6 }}>GENESIS</span>}</div>
          <div className="g-stats">
            <div className="g-stat">
              <div className="k">Value</div>
              <div className="v">${mySharesValue.toFixed(2)}<span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-faint)', fontWeight: 500, marginLeft: 4 }}>USDC</span></div>
            </div>
            <div className="g-stat">
              <div className="k">Claimable Fees</div>
              <div className="v">${myPending.toFixed(2)}</div>
            </div>
          </div>
          {myPending > 0 && (
            <button
              className={'cta' + (isClaiming ? ' disabled' : '')}
              style={{ marginBottom: 8 }}
              disabled={isClaiming}
              onClick={handleClaimFees}
            >
              {isClaiming ? <span className="spinner" /> : <span className="basesq" />}
              {isClaiming ? 'CLAIMING…' : `CLAIM $${myPending.toFixed(2)}`}
            </button>
          )}

          <div className="b-title">Withdraw</div>
          <div className="stake-row">
            <div className="stake-input">
              <span className="ccy">$</span>
              <input
                type="number"
                min={0}
                max={maxWithdrawUsd}
                placeholder="0.00"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
              />
            </div>
            <button
              className="chip"
              style={{ flex: '0 0 auto', padding: '0 12px', height: 40 }}
              onClick={() => setWithdrawAmount(maxWithdrawUsd.toFixed(2))}
              disabled={maxWithdrawUsd <= 0}
            >
              MAX
            </button>
          </div>
          <div className="stake-hint">
            Available: ${maxWithdrawUsd.toFixed(2)}{maxWithdrawUsd < mySharesValue ? ' (rest is locked, currently backing open matches)' : ''}
          </div>
          <button
            className="cta"
            style={{ marginBottom: 8 }}
            disabled={isWithdrawing || !withdrawAmount || Number(withdrawAmount) <= 0 || Number(withdrawAmount) > maxWithdrawUsd}
            onClick={handleWithdraw}
          >
            {isWithdrawing ? <span className="spinner" /> : <span className="basesq" />}
            {isWithdrawing ? 'PROCESSING…' : `WITHDRAW $${withdrawAmount || '0'}`}
          </button>
          {actionError && <div className="osc-error">{actionError}</div>}
        </>
      )}

      <div className="b-title">Genesis benefits</div>
      <div className="benefits">
        <div className="b-head">
          <span>Benefit</span>
          <span>Genesis LP</span>
          <span>Regular LP</span>
        </div>
        <div className="b-row"><span className="k">Fee-stream weight</span><span className="glp">1.5×</span><span className="reg">1.0×</span></div>
        <div className="b-row"><span className="k">Share-price growth</span><span className="check">✓ yes</span><span className="reg">✓ yes</span></div>
        {/* Sprint 4.7: NFT is transferable; boost follows the NFT, not the address. */}
        <div className="b-row"><span className="k">Genesis NFT</span><span className="check">transferable*</span><span className="dash">-</span></div>
        <div className="b-row"><span className="k">LP vault shares</span><span className="check">soulbound</span><span className="reg">soulbound</span></div>
        <div className="b-row"><span className="k">Hall of Fame</span><span className="check">forever</span><span className="dash">-</span></div>
        <div className="b-row"><span className="k">Min deposit</span><span className="glp">50 USDC</span><span className="reg">50 USDC</span></div>
      </div>

      <div className="b-title">Become an LP</div>
      <div className="stake-row">
        <div className="stake-input">
          <span className="ccy">$</span>
          <input
            type="number"
            min={50}
            value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)}
          />
        </div>
      </div>

      <button className="g-cta" onClick={handleDeposit} disabled={isLoading}>
        {isLoading ? <span className="spinner" /> : <span className="basesq" />}
        {!isConnected ? 'CONNECT WALLET' : isLoading ? 'PROCESSING…' : genesisLeft > 0 && !hasPosition ? `BECOME GENESIS LP · $${depositAmount}` : `DEPOSIT $${depositAmount}`}
      </button>
      {!hasPosition && actionError && <div className="osc-error">{actionError}</div>}
      <div className="g-foot">
        {NETWORK_LABEL} · {genesisLeft > 0 && !hasPosition ? `You'll receive Genesis NFT #${21 - genesisLeft}` : 'LP funds are at risk - not principal-protected'}
      </div>
      {/* Sprint 4.7: clarify that the boost rides on the NFT, not the address. */}
      <div className="g-foot" style={{ marginTop: 6, fontSize: 10, opacity: 0.6 }}>
        * Genesis NFT is transferable. The 1.5× fee boost follows whoever owns the NFT.
        Selling the NFT sells the boost.
      </div>
      <div className="g-foot" style={{ marginTop: 6, fontSize: 10, opacity: 0.6 }}>
        Contracts are open-source but have not undergone an external security audit yet.
      </div>

      <div style={{ height: 24 }} />
    </>
  )
}
