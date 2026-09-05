/**
 * The PoolMarketFactory surface the keeper reads.
 *
 * Its own module rather than an export from poolWatcher: oracleWatchdog needs
 * canServeWindow to tell whether a pool can still price its markets, and
 * importing the watcher for a constant would drag a wallet, a gas guard and a
 * database connection into a health check.
 */
export const POOL_MARKET_FACTORY_ABI = [
  { name: 'createMarket', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'pool', type: 'address' }, { name: 'duration', type: 'uint256' }],
    outputs: [{ name: 'market', type: 'address' }] },
  { name: 'wethDepth', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'pool', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'canServeWindow', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'pool', type: 'address' }, { name: 'window', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
  { name: 'twapWindowFor', type: 'function', stateMutability: 'pure',
    inputs: [{ name: 'duration', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { name: 'feedIdFor', type: 'function', stateMutability: 'pure',
    inputs: [{ name: 'pool', type: 'address' }], outputs: [{ type: 'bytes32' }] },
  { name: 'getActiveMarkets', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'feedId', type: 'bytes32' }], outputs: [{ type: 'address[]' }] },
] as const
