import { useState } from 'react'
import { useReadContract, useWriteContract, useAccount } from 'wagmi'
import { parseUnits, maxUint256 } from 'viem'
import { CONTRACTS, LIQUIDITY_POOL_ABI, ERC20_ABI } from '../lib/contracts'

export function GenesisPage() {
  const { address, isConnected } = useAccount()
  const [depositAmount, setDepositAmount] = useState('50')

  // Pool stats
  const { data: stats } = useReadContract({
    address:      CONTRACTS.LIQUIDITY_POOL,
    abi:          LIQUIDITY_POOL_ABI,
    functionName: 'getPoolStats',
  })

  // Provider info
  const { data: provider } = useReadContract({
    address:      CONTRACTS.LIQUIDITY_POOL,
    abi:          LIQUIDITY_POOL_ABI,
    functionName: 'getProvider',
    args:         [address!],
    query:        { enabled: !!address }
  })

  const { writeContractAsync: approve } = useWriteContract()
  const { writeContractAsync: deposit } = useWriteContract()
  const { writeContractAsync: withdraw } = useWriteContract()
  const { writeContractAsync: claimFees } = useWriteContract()

  const [isLoading, setIsLoading] = useState(false)

  async function handleDeposit() {
    if (!address) return
    setIsLoading(true)
    try {
      const amount = parseUnits(depositAmount, 6)

      // Approve USDC
      await approve({
        address: CONTRACTS.USDC,
        abi:     ERC20_ABI,
        functionName: 'approve',
        args: [CONTRACTS.LIQUIDITY_POOL, maxUint256]
      })

      // Deposit
      await deposit({
        address:      CONTRACTS.LIQUIDITY_POOL,
        abi:          LIQUIDITY_POOL_ABI,
        functionName: 'deposit',
        args:         [amount]
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

  const totalPool     = stats ? Number(stats[0]) / 1e6 : 0
  const available     = stats ? Number(stats[1]) / 1e6 : 0
  const providerCount = stats ? Number(stats[2]) : 0
  const genesisLeft   = stats ? Number(stats[3]) : 20

  const myDeposit  = provider ? Number(provider.deposit) / 1e6 : 0
  const myExposure = provider ? Number(provider.exposure) / 1e6 : 0
  const myEarned   = provider ? Number(provider.totalEarned) / 1e6 : 0
  const isGenesis  = provider?.isGenesis ?? false

  return (
    <div className="genesis-page">
      <div className="genesis-hero">
        <h1>🎴 Genesis LP Program</h1>
        <p>First 20 liquidity providers earn boosted fees forever</p>
      </div>

      {/* Genesis Counter */}
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

      {/* Pool Stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">${totalPool.toLocaleString()}</div>
          <div className="stat-label">Total in Pool</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">${available.toLocaleString()}</div>
          <div className="stat-label">Available Liquidity</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{providerCount}</div>
          <div className="stat-label">Providers</div>
        </div>
      </div>

      {/* Deposit */}
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

          {genesisLeft > 0 && myDeposit === 0 && (
            <div className="genesis-badge">
              🎴 You'll receive Genesis NFT #{21 - genesisLeft} with 80% fee share!
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

      {/* My Position */}
      {myDeposit > 0 && (
        <div className="my-position">
          <h2>Your Position {isGenesis && <span className="badge">🎴 Genesis</span>}</h2>
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-value">${myDeposit.toLocaleString()}</div>
              <div className="stat-label">Deposited</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">${myExposure.toLocaleString()}</div>
              <div className="stat-label">At Risk</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">${myEarned.toLocaleString()}</div>
              <div className="stat-label">Total Earned</div>
            </div>
          </div>
          <button id="btn-claim-fees" className="btn-secondary" onClick={handleClaimFees}>
            Claim Fees
          </button>
        </div>
      )}

      {/* Benefits Table */}
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
              <td>Fee Share</td>
              <td className="highlight">80%</td>
              <td>50%</td>
            </tr>
            <tr>
              <td>Genesis NFT</td>
              <td className="highlight">✅ Tradeable</td>
              <td>—</td>
            </tr>
            <tr>
              <td>Governance</td>
              <td className="highlight">Priority Vote</td>
              <td>Standard</td>
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
