/**
 * Which markets this deployment serves and acts on.
 *
 * Robinhood Chain is redeployed as the contracts change. Each factory leaves
 * its markets behind: they hold real balances and their ledger must stay
 * consistent with the chain, so the indexer and the invariant monitor keep
 * reading every market ever created. But nobody should be SHOWN a market
 * from a factory the product has moved off, and the keeper should not spend
 * gas or RPC calls on it - the current resolver would answer `only resolver`,
 * and a stake placed there would sit for 24 hours before it came back.
 *
 * `markets.factory_address` (migration 008) records which factory created a
 * row. Rows written before that column existed hold NULL, and NULL counts as
 * "old": on RHC it is safer to hide a market that is in fact current, which is
 * visible at once and fixed with one UPDATE, than to show a dead one.
 *
 * This is the ONE place the predicate lives, so that every call site (the
 * markets API, the pools feed, the price recorder, the resolve loop, the
 * refund sweep, the watchdog) draws the line in the same spot.
 *
 * Base never filters. It has one long-lived factory per deployment, its rows
 * are not stamped by anything that predates this, and its behaviour is meant
 * to be byte-for-byte what it was.
 */
import { CHAIN_PROFILE } from '../chainProfile.js'
import { CONTRACTS } from '../config.js'

const ADDRESS = /^0x[0-9a-f]{40}$/
/** Column names are interpolated into SQL, so only plain identifiers get through. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i

let warnedUnset = false

/**
 * The factory whose markets are current, lower-cased, or null when every
 * market is in scope.
 *
 * A configured value that is not a well-formed address is treated as unset,
 * and never reaches SQL. Failing OPEN on an unset factory is deliberate: the
 * whole product is misconfigured in that state (the indexer would scan every
 * address), and blanking the site on top of that would hide the real cause.
 */
export function resolveFactoryScope(profileName: string, configured: string | undefined | null): string | null {
  if (profileName !== 'rhc') return null
  const factory = (configured ?? '').trim().toLowerCase()
  if (!ADDRESS.test(factory)) {
    if (!warnedUnset) {
      warnedUnset = true
      console.warn(
        '[marketScope] MARKET_FACTORY is not a valid address on the rhc profile - ' +
        'markets of every factory are in scope until it is set',
      )
    }
    return null
  }
  return factory
}

/** The current factory for this process, from the environment. */
export function currentFactory(): string | null {
  return resolveFactoryScope(CHAIN_PROFILE.name, CONTRACTS.MARKET_FACTORY)
}

function checked(column: string): string {
  if (!IDENTIFIER.test(column)) throw new Error(`marketScope: not a plain column name: ${JSON.stringify(column)}`)
  return column
}

/**
 * ` AND <column> = '<factory>'`, or '' when nothing is scoped.
 *
 * `column` is the factory_address column of a `markets` row in the calling
 * query (`m.factory_address`, `factory_address`). The address is inlined
 * rather than bound: it is validated above to be 0x plus forty hex digits, and
 * inlining is what lets every caller use this without renumbering its own
 * placeholders.
 */
export function andFactory(column: string, factory: string | null = currentFactory()): string {
  return factory === null ? '' : ` AND ${checked(column)} = '${factory}'`
}

/**
 * The same scope for a table that only references a market by address
 * (`matches`, `orders`): ` AND <column> IN (SELECT market_address FROM markets
 * WHERE factory_address = '<factory>')`, or '' when nothing is scoped.
 */
export function andMarketInFactory(marketAddressColumn: string, factory: string | null = currentFactory()): string {
  return factory === null
    ? ''
    : ` AND ${checked(marketAddressColumn)} IN (SELECT market_address FROM markets WHERE factory_address = '${factory}')`
}
