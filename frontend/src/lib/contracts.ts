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
  {
    name: 'placeBet',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'dir',          type: 'uint8'   },
      { name: 'amount',       type: 'uint256' },
      { name: 'referrer',     type: 'address' },
      { name: 'currentPrice', type: 'uint256' }
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
    name: 'refundExpired',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: []
  },
  {
    name: 'getOrder',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'trader',    type: 'address' },
        { name: 'direction', type: 'uint8'   },
        { name: 'amount',    type: 'uint256' },
        { name: 'referrer',  type: 'address' },
        { name: 'status',    type: 'uint8'   },
        { name: 'placedAt',  type: 'uint256' },
        { name: 'matchId',   type: 'uint256' },
        { name: 'payout',    type: 'uint256' }
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

// LiquidityPool ABI
export const LIQUIDITY_POOL_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: []
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: []
  },
  {
    name: 'claimFees',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  },
  {
    name: 'getPoolStats',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'total',          type: 'uint256' },
      { name: 'available',      type: 'uint256' },
      { name: 'providerCount',  type: 'uint256' },
      { name: 'genesisLeft',    type: 'uint256' }
    ]
  },
  {
    name: 'getProvider',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'lp', type: 'address' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'deposit',     type: 'uint256' },
        { name: 'exposure',    type: 'uint256' },
        { name: 'totalEarned', type: 'uint256' },
        { name: 'isGenesis',   type: 'bool'    },
        { name: 'joinedAt',    type: 'uint256' }
      ]
    }]
  },
  // Events
  {
    name: 'Deposited',
    type: 'event',
    inputs: [
      { name: 'lp',        type: 'address', indexed: true  },
      { name: 'amount',    type: 'uint256', indexed: false },
      { name: 'isGenesis', type: 'bool',    indexed: false }
    ]
  },
  {
    name: 'Withdrawn',
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
