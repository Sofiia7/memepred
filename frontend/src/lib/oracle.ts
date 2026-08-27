/**
 * Oracle data, fetched through our own API.
 *
 * Prices come from RedStone. Pyth's Core upgrade put every memecoin feed behind
 * a $500/month plan on 2026-08-26 - their free key answers 403 "not entitled"
 * for PEPE, BRETT, DEGEN and everything else this product prices - and
 * RedStone serves them all from a public gateway with no credential.
 *
 * There is therefore no secret being hidden by going through the backend, which
 * is why this file has no key in it and needs none. It goes through the backend
 * because building a payload in the browser would mean bundling
 * @redstone-finance/protocol and its ethers v5 dependency into a viem app just
 * to concatenate bytes, and because one cache there keeps our gateway request
 * rate flat instead of scaling with however many people have the page open.
 */

/**
 * A market stores its feed as a RedStone symbol right-padded into a bytes32.
 * The gateway is keyed by the symbol, so the padding comes back off.
 */
export function feedSymbolFromBytes32(feedId: string): string {
  const hex = feedId.replace(/^0x/, '')
  let out = ''
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16)
    if (code === 0) break
    out += String.fromCharCode(code)
  }
  return out
}

const api = () => import.meta.env.VITE_API_URL

/**
 * A signed price to submit with a bet.
 *
 * Fresh on purpose: OrderbookMarket rejects anything older than
 * ENTRY_MAX_PRICE_AGE (20s), and the clock starts when the payload is signed,
 * not when the user presses the button. Fetch it immediately before sending.
 */
export async function fetchBetPayload(feedId: string): Promise<`0x${string}`> {
  const symbol = feedSymbolFromBytes32(feedId)
  const r = await fetch(`${api()}/api/oracle/payload?feed=${encodeURIComponent(symbol)}`)
  if (!r.ok) throw new Error(`Price feed responded ${r.status}`)

  const { payload } = (await r.json()) as { payload?: string }
  if (!payload || payload.length <= 2) throw new Error('Price feed returned no signed price')
  return (payload.startsWith('0x') ? payload : `0x${payload}`) as `0x${string}`
}

/** The current price of a feed, for display. */
export async function fetchDisplayPrice(feedId: string): Promise<number> {
  const symbol = feedSymbolFromBytes32(feedId)
  const r = await fetch(`${api()}/api/oracle/price?feed=${encodeURIComponent(symbol)}`)
  if (!r.ok) throw new Error(`price feed ${r.status}`)

  const { price } = (await r.json()) as { price?: number }
  if (typeof price !== 'number') throw new Error('price feed returned no price')
  return price
}

/**
 * Append a signed payload to an encoded call.
 *
 * This is RedStone's whole calling convention: the contract reads the price
 * from the tail of the calldata, so it has to ride on the same transaction that
 * needs it. Which also means the call cannot go through wagmi's writeContract -
 * that encodes the call itself and leaves nowhere to append.
 */
export function withPayload(callData: `0x${string}`, payload: `0x${string}`): `0x${string}` {
  return `${callData}${payload.slice(2)}` as `0x${string}`
}
