import { TARGET_CHAIN } from '../../lib/chain'

/**
 * "ROBINHOOD CHAIN TESTNET", always, on a testnet build.
 *
 * Persistent, so nobody mistakes a test deployment for real money, or a
 * Robinhood Chain one for Base. Only shown for a testnet: a mainnet build is
 * what it says it is without a label. Rendered by AppShell above every page and
 * by the risk gate, which is the first screen a new visitor sees and covers the
 * shell.
 *
 * Deliberately free of wallet and query hooks, so the gate can show it without
 * pulling either in.
 */
export function NetworkPill() {
  if (!TARGET_CHAIN.testnet) return null
  const name = TARGET_CHAIN.name.toUpperCase()
  return (
    <div className="net-row">
      <span className="net-pill" role="status" aria-label={`Network: ${TARGET_CHAIN.name}. Test tokens only, no real money.`}>
        <span className="net-pill-dot" aria-hidden="true" />
        {name}
      </span>
    </div>
  )
}
