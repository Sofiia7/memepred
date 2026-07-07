import { useState } from 'react'
import { useReadContract, useWriteContract, useAccount } from 'wagmi'
import { parseUnits, maxUint256 } from 'viem'
import { CONTRACTS, LIQUIDITY_POOL_ABI, ERC20_ABI } from '../lib/contracts'
import { ScreenTitle } from '../components/ui/AppShell'
import { StarIcon } from '../components/ui/icons'
import { useConnectWallet } from '../hooks/useConnectWallet'

export function GenesisPage() {
  const { address, isConnected } = useAccount()
  const { connectWallet } = useConnectWallet()
  const [depositAmount, setDepositAmount] = useState('50')
  const [isLoading, setIsLoading] = useState(false)

  const { data: stats } = useReadContract({
    address: CONTRACTS.LIQUIDITY_POOL,
    abi: LIQUIDITY_POOL_ABI,
    functionName: 'getPoolStats',
  })

  const { data: shareBalance } = useReadContract({
    address: CONTRACTS.LIQUIDITY_POOL,
    abi: LIQUIDITY_POOL_ABI,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: !!address },
  })

  const { data: myAssets } = useReadContract({
    address: CONTRACTS.LIQUIDITY_POOL,
    abi: LIQUIDITY_POOL_ABI,
    functionName: 'previewRedeem',
    args: [shareBalance ?? 0n],
    query: { enabled: !!shareBalance && shareBalance > 0n },
  })

  const { data: pendingFees } = useReadContract({
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

  const { writeContractAsync: approve } = useWriteContract()
  const { writeContractAsync: deposit } = useWriteContract()
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

  async function handleDeposit() {
    if (!address) {
      connectWallet()
      return
    }
    setIsLoading(true)
    try {
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
    } catch (err) {
      console.error('Deposit failed:', err)
    } finally {
      setIsLoading(false)
    }
  }

  async function handleClaimFees() {
    try {
      await claimFees({
        address: CONTRACTS.LIQUIDITY_POOL,
        abi: LIQUIDITY_POOL_ABI,
        functionName: 'claimFees',
      })
    } catch (err) {
      console.error('Claim fees failed:', err)
    }
  }

  return (
    <>
      <ScreenTitle title="Genesis LP" icon={<StarIcon color="#4d8dff" />} />

      <div className="genesis-hero">
        <div className="gh-eyebrow">
          <span className="basesq" />
          Limited program · Base mainnet
        </div>
        <h3 className="gh-title">
          First 20 LPs earn <em>1.5×</em> fee share <em>forever</em>.
        </h3>
        <div className="gh-sub">
          Provide USDC to the matching vault, mint a soulbound Genesis NFT, and accrue boosted fees on every market settlement — for as long as flipthememe exists.
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
            <button className="cta" style={{ marginBottom: 8 }} onClick={handleClaimFees}>
              <span className="basesq" />
              CLAIM ${myPending.toFixed(2)}
            </button>
          )}
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
        <div className="b-row"><span className="k">Genesis NFT</span><span className="check">transferable*</span><span className="dash">—</span></div>
        <div className="b-row"><span className="k">LP vault shares</span><span className="check">soulbound</span><span className="reg">soulbound</span></div>
        <div className="b-row"><span className="k">Hall of Fame</span><span className="check">forever</span><span className="dash">—</span></div>
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
      <div className="g-foot">
        Base Sepolia · {genesisLeft > 0 && !hasPosition ? `You'll receive Genesis NFT #${21 - genesisLeft}` : 'Smart-contract audited'}
      </div>
      {/* Sprint 4.7: clarify that the boost rides on the NFT, not the address. */}
      <div className="g-foot" style={{ marginTop: 6, fontSize: 10, opacity: 0.6 }}>
        * Genesis NFT is transferable. The 1.5× fee boost follows whoever owns the NFT.
        Selling the NFT sells the boost.
      </div>

      <div style={{ height: 24 }} />
    </>
  )
}
