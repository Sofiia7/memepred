import { useReadContract, useWriteContract, useAccount } from 'wagmi'
import { useState } from 'react'
import { CONTRACTS } from '../lib/contracts'
import { useEnsureChain } from './useEnsureChain'

const REFERRAL_REGISTRY_ABI = [
  {
    name: 'getReferrer',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'referee', type: 'address' }],
    outputs: [{ type: 'address' }]
  },
  {
    name: 'getReferralCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'referrer', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'referrerToCode',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'referrer', type: 'address' }],
    outputs: [{ type: 'bytes6' }]
  },
  {
    name: 'resolveCode',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'code', type: 'bytes6' }],
    outputs: [{ type: 'address' }]
  },
  {
    name: 'generateCode',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'referrer', type: 'address' }],
    outputs: [{ name: 'code', type: 'bytes6' }]
  }
] as const

const FEE_DIST_ABI = [
  {
    name: 'referralBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'claimReferralRewards',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  }
] as const

export function useReferral() {
  const { address } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const ensureChain = useEnsureChain()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const { data: myReferrer } = useReadContract({
    address:      CONTRACTS.REFERRAL_REGISTRY,
    abi:          REFERRAL_REGISTRY_ABI,
    functionName: 'getReferrer',
    args:         [address!],
    query:        { enabled: !!address }
  })

  const { data: myCode } = useReadContract({
    address:      CONTRACTS.REFERRAL_REGISTRY,
    abi:          REFERRAL_REGISTRY_ABI,
    functionName: 'referrerToCode',
    args:         [address!],
    query:        { enabled: !!address }
  })

  const { data: myReferralCount } = useReadContract({
    address:      CONTRACTS.REFERRAL_REGISTRY,
    abi:          REFERRAL_REGISTRY_ABI,
    functionName: 'getReferralCount',
    args:         [address!],
    query:        { enabled: !!address }
  })

  const { data: claimableRewards } = useReadContract({
    address:      CONTRACTS.FEE_DISTRIBUTOR,
    abi:          FEE_DIST_ABI,
    functionName: 'referralBalance',
    args:         [address!],
    query:        { enabled: !!address }
  })

  async function generateMyCode() {
    if (!address) return
    setError(undefined)
    setBusy(true)
    try {
      const chainCheck = await ensureChain()
      if (!chainCheck.ok) { setError(chainCheck.error); return }
      await writeContractAsync({
        address:      CONTRACTS.REFERRAL_REGISTRY,
        abi:          REFERRAL_REGISTRY_ABI,
        functionName: 'generateCode',
        args:         [address]
      })
    } catch (err: any) {
      setError(err?.shortMessage || err?.message || 'Failed to generate code')
    } finally { setBusy(false) }
  }

  async function claimRewards() {
    setError(undefined)
    setBusy(true)
    try {
      const chainCheck = await ensureChain()
      if (!chainCheck.ok) { setError(chainCheck.error); return }
      await writeContractAsync({
        address:      CONTRACTS.FEE_DISTRIBUTOR,
        abi:          FEE_DIST_ABI,
        functionName: 'claimReferralRewards'
      })
    } catch (err: any) {
      setError(err?.shortMessage || err?.message || 'Failed to claim rewards')
    } finally { setBusy(false) }
  }

  return {
    myReferrer,
    myCode,
    myReferralCount,
    claimableRewards,
    generateMyCode,
    claimRewards,
    busy,
    error
  }
}
