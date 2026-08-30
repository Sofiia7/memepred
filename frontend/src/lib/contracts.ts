import { type Address } from 'viem'

// ── ADDRESSES ──────────────────────────────────────────────
export const CONTRACTS = {
  USDC:              import.meta.env.VITE_USDC_ADDRESS             as Address,
  MARKET_FACTORY:    import.meta.env.VITE_MARKET_FACTORY           as Address,
  ORACLE_RESOLVER:   import.meta.env.VITE_ORACLE_RESOLVER          as Address,
  FEE_DISTRIBUTOR:   import.meta.env.VITE_FEE_DISTRIBUTOR          as Address,
  REFERRAL_REGISTRY: import.meta.env.VITE_REFERRAL_REGISTRY        as Address,
  BADGE_NFT:         import.meta.env.VITE_BADGE_NFT                as Address,
  LIQUIDITY_POOL:    import.meta.env.VITE_LIQUIDITY_POOL           as Address,
  GENESIS_NFT:       import.meta.env.VITE_GENESIS_NFT              as Address,
} as const

// Mirrors OrderbookMarket.sol's MIN_BET/MAX_BET (1 USDC / 100 USDC). Not
// read on-chain because it's a compile-time constant on the contract, not
// per-market state - keeping it here lets the UI clamp/validate client-side
// instead of letting users submit a tx that's guaranteed to revert.
export const MIN_BET_USD = 1
export const MAX_BET_USD = 100

// Mirrors OrderbookMarket.SETTLE_GRACE (24 hours). Past settleAt + this, the
// contract refuses to settle ("settlement window expired") and the only way to
// get a stake back is the permissionless emergencyRefundMatch. The UI needs the
// number to know when to offer that.
export const SETTLE_GRACE_SEC = 24 * 60 * 60

// Mirrors OrderbookMarket.LP_TAKER_FEE_BPS (1%). Charged on the whole matched
// pool when the LP pool took the other side and the user won - so a winning
// LP-matched bet pays 1.98x the stake, not 2x. A peer match pays the full 2x.
// The user cannot tell which they will get before placing the bet, which is why
// the payout preview shows both ends rather than the flattering one.
export const LP_TAKER_FEE_BPS = 100

// ── ABIs ───────────────────────────────────────────────────

// Legacy PvPMarket ABI (kept for backward compatibility)
export const PVPMARKET_ABI = [
  {
    name: 'placeBet',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'dir',      type: 'uint8'   },
      { name: 'amount',   type: 'uint256' },
      { name: 'referrer', type: 'address' }
    ],
    outputs: []
  },
  {
    name: 'claim',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  },
  {
    name: 'emergencyRefund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  },
  {
    name: 'totalUpPool',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'totalDownPool',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'getOdds',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'upOdds',   type: 'uint256' },
      { name: 'downOdds', type: 'uint256' }
    ]
  },
  {
    name: 'status',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }]
  },
  {
    name: 'marketCloseTime',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'BetPlaced',
    type: 'event',
    inputs: [
      { name: 'trader',    type: 'address', indexed: true  },
      { name: 'direction', type: 'uint8',   indexed: false },
      { name: 'amount',    type: 'uint256', indexed: false },
      { name: 'referrer',  type: 'address', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'MarketSettled',
    type: 'event',
    inputs: [
      { name: 'upWon',          type: 'bool',    indexed: false },
      { name: 'entryPrice',     type: 'uint256', indexed: false },
      { name: 'exitPrice',      type: 'uint256', indexed: false },
      { name: 'totalUpPool',    type: 'uint256', indexed: false },
      { name: 'totalDownPool',  type: 'uint256', indexed: false }
    ]
  }
] as const

// OrderbookMarket ABI (new 3-layer matching)
export const ORDERBOOK_MARKET_ABI = [
  // Sprint 5.6: the bare `placeBet` entry is gone from this ABI because it is
  // gone from the contract. It priced a bet off the keeper's last on-chain
  // push, so the strike could be seconds old - enough for anyone watching
  // Hermes live to enter against a price they already knew had moved.
  // The only way to bet. The price is not an argument: it rides on the tail of
  // the calldata as a signed RedStone payload, so this cannot be called through
  // wagmi's writeContract - see lib/oracle.ts. Do not add an overload that
  // works without one; there is nothing to fall back to on-chain, and pricing a
  // bet off a stale value is the hole this design closes.
  {
    name: 'placeBet',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'dir',           type: 'uint8'   },
      { name: 'amount',        type: 'uint256' },
      { name: 'referrer',      type: 'address' },
      { name: 'expectedPrice', type: 'uint256' },
      { name: 'slippageBps',   type: 'uint256' }
    ],
    outputs: [{ name: 'orderId', type: 'uint256' }]
  },
  {
    name: 'claim',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: []
  },
  {
    name: 'emergencyRefundMatch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'matchId', type: 'uint256' }],
    outputs: []
  },
  {
    name: 'refundExpired',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: []
  },
  {
    // Sprint 1.1: Order struct expanded for multi-fill (filledAmount,
    // pendingSettlements, unmatchedRefunded). Old 8-field shape decoded
    // garbage after the refactor.
    name: 'getOrder',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'trader',             type: 'address' },
        { name: 'direction',          type: 'uint8'   },
        { name: 'amount',             type: 'uint256' },
        { name: 'filledAmount',       type: 'uint256' },
        { name: 'referrer',           type: 'address' },
        { name: 'status',             type: 'uint8'   },
        { name: 'placedAt',           type: 'uint256' },
        { name: 'matchId',            type: 'uint256' },
        { name: 'pendingSettlements', type: 'uint256' },
        { name: 'payout',             type: 'uint256' },
        { name: 'unmatchedRefunded',  type: 'bool'    }
      ]
    }]
  },
  {
    name: 'getMatch',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'matchId', type: 'uint256' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'upOrderId',   type: 'uint256' },
        { name: 'downOrderId', type: 'uint256' },
        { name: 'amount',      type: 'uint256' },
        { name: 'entryPrice',  type: 'uint256' },
        { name: 'settleAt',    type: 'uint256' },
        { name: 'exitPrice',   type: 'uint256' },
        { name: 'settled',     type: 'bool'    },
        { name: 'upWon',       type: 'bool'    },
        { name: 'lpMatch',     type: 'bool'    }
      ]
    }]
  },
  {
    name: 'feedId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }]
  },
  {
    name: 'duration',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'getPendingDepth',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'up',   type: 'uint256' },
      { name: 'down', type: 'uint256' }
    ]
  },
  {
    name: 'getTraderOrders',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'trader', type: 'address' }],
    outputs: [{ name: '', type: 'uint256[]' }]
  },
  // Events
  {
    name: 'OrderPlaced',
    type: 'event',
    inputs: [
      { name: 'orderId',  type: 'uint256', indexed: true  },
      { name: 'trader',   type: 'address', indexed: true  },
      { name: 'dir',      type: 'uint8',   indexed: false },
      { name: 'amount',   type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'OrderMatched',
    type: 'event',
    inputs: [
      { name: 'matchId',    type: 'uint256', indexed: true  },
      { name: 'upId',       type: 'uint256', indexed: false },
      { name: 'downId',     type: 'uint256', indexed: false },
      { name: 'entryPrice', type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'LPMatched',
    type: 'event',
    inputs: [
      { name: 'matchId',    type: 'uint256', indexed: true  },
      { name: 'orderId',    type: 'uint256', indexed: false },
      { name: 'entryPrice', type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'MatchSettled',
    type: 'event',
    inputs: [
      { name: 'matchId', type: 'uint256', indexed: true  },
      { name: 'upWon',   type: 'bool',    indexed: false },
      { name: 'entry',   type: 'uint256', indexed: false },
      { name: 'exit',    type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'OrderRefunded',
    type: 'event',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true  },
      { name: 'trader',  type: 'address', indexed: false },
      { name: 'amount',  type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'Claimed',
    type: 'event',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true  },
      { name: 'trader',  type: 'address', indexed: false },
      { name: 'payout',  type: 'uint256', indexed: false }
    ]
  }
] as const

// LiquidityPool ABI (ERC4626 vault - shares are soulbound)
export const LIQUIDITY_POOL_ABI = [
  // ── ERC4626 / actions ─────────────────────────────────────
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets',   type: 'uint256' },
      { name: 'receiver', type: 'address' }
    ],
    outputs: [{ name: 'shares', type: 'uint256' }]
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets',   type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner',    type: 'address' }
    ],
    outputs: [{ name: 'shares', type: 'uint256' }]
  },
  {
    name: 'redeem',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares',   type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner',    type: 'address' }
    ],
    outputs: [{ name: 'assets', type: 'uint256' }]
  },
  {
    name: 'claimFees',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'amount', type: 'uint256' }]
  },
  // ── views ─────────────────────────────────────────────────
  {
    name: 'asset',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  },
  {
    name: 'totalAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'convertToAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'convertToShares',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'assets', type: 'uint256' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'previewRedeem',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'maxWithdraw',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'maxRedeem',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'getPoolStats',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'totalAssetsOut',  type: 'uint256' },
      { name: 'available',       type: 'uint256' },
      { name: 'providerExposure',type: 'uint256' },
      { name: 'genesisLeft',     type: 'uint256' }
    ]
  },
  {
    name: 'availableForMatching',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'earnedFees',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'lp', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'isGenesis',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'lp', type: 'address' }],
    outputs: [{ type: 'bool' }]
  },
  {
    name: 'isAuthorizedMarket',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'market', type: 'address' }],
    outputs: [{ type: 'bool' }]
  },
  {
    name: 'marketExposure',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'market', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'totalExposure',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'totalPendingFees',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'genesisCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  // ── ERC4626 standard events ───────────────────────────────
  {
    name: 'Deposit',
    type: 'event',
    inputs: [
      { name: 'sender',   type: 'address', indexed: true  },
      { name: 'owner',    type: 'address', indexed: true  },
      { name: 'assets',   type: 'uint256', indexed: false },
      { name: 'shares',   type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'Withdraw',
    type: 'event',
    inputs: [
      { name: 'sender',   type: 'address', indexed: true  },
      { name: 'receiver', type: 'address', indexed: true  },
      { name: 'owner',    type: 'address', indexed: true  },
      { name: 'assets',   type: 'uint256', indexed: false },
      { name: 'shares',   type: 'uint256', indexed: false }
    ]
  },
  // ── custom events ─────────────────────────────────────────
  {
    name: 'GenesisMinted',
    type: 'event',
    inputs: [
      { name: 'lp',      type: 'address', indexed: true  },
      { name: 'tokenId', type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'MarketAuthorized',
    type: 'event',
    inputs: [{ name: 'market', type: 'address', indexed: true }]
  },
  {
    name: 'MarketDeauthorized',
    type: 'event',
    inputs: [{ name: 'market', type: 'address', indexed: true }]
  },
  {
    name: 'MatchTaken',
    type: 'event',
    inputs: [
      { name: 'market',  type: 'address', indexed: true  },
      { name: 'matchId', type: 'uint256', indexed: true  },
      { name: 'orderId', type: 'uint256', indexed: false },
      { name: 'amount',  type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'MatchResult',
    type: 'event',
    inputs: [
      { name: 'market',  type: 'address', indexed: true  },
      { name: 'matchId', type: 'uint256', indexed: true  },
      { name: 'lpWon',   type: 'bool',    indexed: false },
      { name: 'amount',  type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'FeeAccrued',
    type: 'event',
    inputs: [
      { name: 'market', type: 'address', indexed: true  },
      { name: 'amount', type: 'uint256', indexed: false }
    ]
  },
  {
    name: 'FeesClaimed',
    type: 'event',
    inputs: [
      { name: 'lp',     type: 'address', indexed: true  },
      { name: 'amount', type: 'uint256', indexed: false }
    ]
  }
] as const

// ERC20 ABI
export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner',   type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  }
] as const
