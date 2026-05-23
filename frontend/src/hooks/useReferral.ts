import { useReadContract, useWriteContract, useAccount } from 'wagmi'
import { useState } from 'react'
import { CONTRACTS } from '../lib/contracts'

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
  const [busy, setBusy] = useState(false)

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
    setBusy(true)
    try {
      await writeContractAsync({
        address:      CONTRACTS.REFERRAL_REGISTRY,
        abi:          REFERRAL_REGISTRY_ABI,
        functionName: 'generateCode',
        args:         [address]
      })
    } finally { setBusy(false) }
  }

  async function claimRewards() {
    setBusy(true)
    try {
      await writeContractAsync({
        address:      CONTRACTS.FEE_DISTRIBUTOR,
        abi:          FEE_DIST_ABI,
        functionName: 'claimReferralRewards'
      })
    } finally { setBusy(false) }
  }

  return {
    myReferrer,
    myCode,
    myReferralCount,
    claimableRewards,
    generateMyCode,
    claimRewards,
    busy
  }
}
