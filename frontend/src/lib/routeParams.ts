import { isAddress, type Address } from 'viem'
import { ZERO_ADDRESS } from './orderModel'

/**
 * Route parameters are untrusted input: a link can carry anything, and a market
 * address that only looks like one used to travel all the way to a
 * verification error with a Retry button that could never succeed.
 *
 * `isAddress` runs in its default strict mode, so a mixed-case address whose
 * EIP-55 checksum is wrong (the usual sign of a typo) is rejected, while an
 * all-lowercase one, which is what the API serves, passes.
 */

/** The market address from `/market/:address` or `/order/:address/:orderId`. */
export function parseMarketParam(value: string | undefined): Address | null {
  if (!value || !isAddress(value)) return null
  if (value.toLowerCase() === ZERO_ADDRESS) return null
  return value
}

/** A positive decimal integer; an order id starts at 1 and is never hex. */
export function parseOrderIdParam(value: string | undefined): bigint | null {
  if (!value || !/^[0-9]+$/.test(value)) return null
  const id = BigInt(value)
  return id > 0n ? id : null
}
