import { useState } from 'react'
import { useReadContract, useWriteContract, useAccount } from 'wagmi'
import { parseUnits, maxUint256 } from 'viem'
import { CONTRACTS, LIQUIDITY_POOL_ABI, ERC20_ABI } from '../lib/contracts'

export function GenesisPage() {
  const { address, isConnected } = useAccount()
  const [depositAmount, setDepositAmount] = useState('50')

  // Pool stats: (totalAssetsOut, available, providerExposure, genesisLeft)
  const { data: stats } = useReadContract({
    address:      CONTRACTS.LIQUIDITY_POOL,
    abi:          LIQUIDITY_POOL_ABI,
    functionName: 'getPoolStats',
  })

  // LP share balance
  const { data: shareBalance } = useReadContract({
    address:      CONTRACTS.LIQUIDITY_POOL,
    abi:          LIQUIDITY_POOL_ABI,
    functionName: 'balanceOf',
    args:         [address!],
    query:        { enabled: !!address }
  })

  // LP equivalent USDC value
  const { data: myAssets } = useReadContract({
    address:      CONTRACTS.LIQUIDITY_POOL,
    abi:          LIQUIDITY_POOL_ABI,
    functionName: 'previewRedeem',
    args:         [shareBalance ?? 0n],
    query:        { enabled: !!shareBalance && shareBalance > 0n }
  })

  // Earned fees pending claim
  const { data: pendingFees } = useReadContract({
    address:      CONTRACTS.LIQUIDITY_POOL,
    abi:          LIQUIDITY_POOL_ABI,
    functionName: 'earnedFees',
    args:         [address!],
    query:        { enabled: !!address }
  })

  // Genesis status
  const { data: isGenesisAddr } = useReadContract({
    address:      CONTRACTS.LIQUIDITY_POOL,
    abi:          LIQUIDITY_POOL_ABI,
    functionName: 'isGenesis',
    args:         [address!],
    query:        { enabled: !!address }
  })

  const { writeContractAsync: approve }   = useWriteContract()
  const { writeContractAsync: deposit }   = useWriteContract()
  const { writeContractAsync: claimFees } = useWriteContract()

  const [isLoading, setIsLoading] = useState(false)

  async function handleDeposit() {
    if (!address) return
    setIsLoading(true)
    try {
      const amount = parseUnits(depositAmount, 6)

      await approve({
        address: CONTRACTS.USDC,
        abi:     ERC20_ABI,
        functionName: 'approve',
        args: [CONTRACTS.LIQUIDITY_POOL, maxUint256]
      })

      await deposit({
        address:      CONTRACTS.LIQUIDITY_POOL,
        abi:          LIQUIDITY_POOL_ABI,
        functionName: 'deposit',
        args:         [amount, address]
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
        address:      CONTRACTS.LIQUIDITY_POOL,
        abi:          LIQUIDITY_POOL_ABI,
        functionName: 'claimFees',
      })
    } catch (err) {
      console.error('Claim fees failed:', err)
    }
  }

  const totalPool        = stats ? Number(stats[0]) / 1e6 : 0
  const available        = stats ? Number(stats[1]) / 1e6 : 0
  const totalExposureUsd = stats ? Number(stats[2]) / 1e6 : 0
  const genesisLeft      = stats ? Number(stats[3]) : 20

  const mySharesValue = myAssets    ? Number(myAssets)    / 1e6 : 0
  const myPending     = pendingFees ? Number(pendingFees) / 1e6 : 0
  const isGenesis     = !!isGenesisAddr
  const hasPosition   = (shareBalance ?? 0n) > 0n

  return (
    <div className="genesis-page">
      <div className="genesis-hero">
        <h1>🎴 Genesis LP Program</h1>
        <p>First 20 liquidity providers earn 1.5x fee share forever</p>
      </div>

      <div className="genesis-counter">
        <div className="counter-number">{genesisLeft}</div>
        <div className="counter-label">Genesis spots remaining</div>
        <div className="counter-bar">
          <div
            className="counter-fill"
            style={{ width: `${((20 - genesisLeft) / 20) * 100}%` }}
          />
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">${totalPool.toLocaleString()}</div>
          <div className="stat-label">Total Vault Assets</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">${available.toLocaleString()}</div>
          <div className="stat-label">Available for Matching</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">${totalExposureUsd.toLocaleString()}</div>
          <div className="stat-label">Locked in Active Matches</div>
        </div>
      </div>

      {isConnected && (
        <div className="deposit-section">
          <h2>Provide Liquidity</h2>
          <div className="deposit-input-group">
            <input
              id="deposit-amount"
              type="number"
              min="50"
              value={depositAmount}
              onChange={e => setDepositAmount(e.target.value)}
              placeholder="50"
            />
            <span>USDC</span>
          </div>

          {genesisLeft > 0 && !hasPosition && (
            <div className="genesis-badge">
              🎴 You'll receive Genesis NFT #{21 - genesisLeft} with 1.5x fee weight!
            </div>
          )}

          <button
            id="btn-deposit"
            className="btn-primary"
            onClick={handleDeposit}
            disabled={isLoading}
          >
            {isLoading ? 'Processing...' : `Deposit $${depositAmount} USDC`}
          </button>
        </div>
      )}

      {hasPosition && (
        <div className="my-position">
          <h2>Your Position {isGenesis && <span className="badge">🎴 Genesis</span>}</h2>
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-value">${mySharesValue.toLocaleString()}</div>
              <div className="stat-label">Current Value (USDC)</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{(Number(shareBalance ?? 0n) / 1e12).toLocaleString()}</div>
              <div className="stat-label">mpLP Shares</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">${myPending.toLocaleString()}</div>
              <div className="stat-label">Claimable Fees</div>
            </div>
          </div>
          <button
            id="btn-claim-fees"
            className="btn-secondary"
            onClick={handleClaimFees}
            disabled={myPending === 0}
          >
            Claim Fees
          </button>
        </div>
      )}

      <div className="benefits-table">
        <h2>Genesis Benefits</h2>
        <table>
          <thead>
            <tr>
              <th>Benefit</th>
              <th>Genesis LP</th>
              <th>Regular LP</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Fee-stream Weight</td>
              <td className="highlight">1.5x</td>
              <td>1.0x</td>
            </tr>
            <tr>
              <td>Share-price Growth</td>
              <td className="highlight">✅ Yes</td>
              <td>✅ Yes</td>
            </tr>
            <tr>
              <td>Genesis NFT</td>
              <td className="highlight">✅ Soulbound</td>
              <td>—</td>
            </tr>
            <tr>
              <td>Hall of Fame</td>
              <td className="highlight">✅ Forever</td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
