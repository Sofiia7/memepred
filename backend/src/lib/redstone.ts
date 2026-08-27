/**
 * RedStone price payloads for the keeper.
 *
 * Pyth's Core upgrade put every memecoin feed behind a $500/month plan on
 * 2026-08-26; their free key answers 403 "not entitled" for PEPE, BRETT, DEGEN
 * and everything else this protocol prices. RedStone serves them all from a
 * public gateway with no credential at all, which is why there is no API key
 * anywhere in this file and should never be one.
 *
 * Note what this deliberately does NOT use: any RedStone package at all.
 *
 * Their SDK now refuses to run without an authenticated gateway - "Empty
 * authenticatedGateways array provided" - the same direction Pyth went. The
 * public gateway still serves the signed packages to anyone, so only the
 * payload assembly was ever needed from them, and @redstone-finance/protocol
 * brought ethers v5 with it: @ethersproject/providers and a `ws` carrying four
 * high-severity advisories, in the image of a service that opens no websocket.
 * redstonePayload.ts does that assembly with viem instead.
 *
 * If the public gateway ever starts demanding a credential, the migration's
 * premise has changed and this is where it will show first.
 */
import { stringToHex } from 'viem'
import { buildPayload, recoverPackageSigner, type GatewayPackage } from './redstonePayload.js'

export const REDSTONE_GATEWAY =
  process.env.REDSTONE_GATEWAY_URL || 'https://oracle-gateway-1.a.redstone.finance'

export const REDSTONE_DATA_SERVICE =
  process.env.REDSTONE_DATA_SERVICE || 'redstone-primary-prod'

/**
 * The five signers hardcoded in PrimaryProdDataServiceConsumerBase, which both
 * OracleResolver and OrderbookMarket inherit. Drift between this list and the
 * contracts means every transaction we send is rejected on-chain, so the
 * contract-side npm dependency is pinned exactly rather than caret-ranged.
 */
export const AUTHORISED_SIGNERS = [
  '0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774',
  '0xdEB22f54738d54976C4c0fe5ce6d408E40d88499',
  '0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202',
  '0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE',
  '0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de',
] as const

/** Threshold the contracts enforce. */
export const SIGNERS_REQUIRED = 3

const AUTHORISED_LOWER = new Set(AUTHORISED_SIGNERS.map((a) => a.toLowerCase()))

/**
 * RedStone identifies a feed by its symbol right-padded into a bytes32, not by
 * a hash as Pyth did. A wrong id does not fail loudly - the contract just finds
 * no matching data point and reverts with nothing useful in it.
 */
export function feedIdToBytes32(symbol: string): `0x${string}` {
  return stringToHex(symbol, { size: 32 })
}

/**
 * The symbol back out of a bytes32 feed id, trailing padding removed.
 *
 * Returns '' for anything that is not a plain symbol. The factory still carries
 * feeds whitelisted for the old oracle, whose bytes32 is a hash - decoding one
 * yields mojibake, and that string reached users as a market named after
 * garbage. Callers are expected to show UNKNOWN rather than pass it through.
 */
export function bytes32ToFeedId(feedId: string): string {
  const raw = Buffer.from(feedId.replace(/^0x/, ''), 'hex')

  // Everything after the first NUL has to be padding, or this was never a
  // symbol in the first place.
  const end = raw.indexOf(0)
  const body = end === -1 ? raw : raw.subarray(0, end)
  if (end !== -1 && raw.subarray(end).some((x) => x !== 0)) return ''

  const symbol = body.toString('latin1')
  return /^[A-Za-z0-9_.-]+$/.test(symbol) ? symbol : ''
}

/**
 * Keep only packages signed by an authorised signer, and only as many as the
 * contract needs.
 *
 * `signerOf` is supplied by the caller so the gateway's own claimed
 * signerAddress can be used where it is trustworthy and a recovered address
 * where it is not - see fetchPayload, which recovers.
 */
export function selectAuthorisedPackages<T>(
  packages: readonly T[],
  signerOf: (p: T) => string,
  required: number = SIGNERS_REQUIRED,
): T[] {
  const authorised = packages.filter((p) => AUTHORISED_LOWER.has(signerOf(p).toLowerCase()))
  if (authorised.length < required) {
    throw new Error(
      `RedStone: only ${authorised.length} authorised signers available, need ${required}`,
    )
  }
  return authorised.slice(0, required)
}

/**
 * Append a signed payload to an encoded call.
 *
 * This is the whole calling convention: RedStone reads the price from the tail
 * of the calldata, so the payload has to ride on the same call that needs it.
 * The selector and arguments stay at the front untouched.
 */
export function withPayload(callData: `0x${string}`, payload: string): `0x${string}` {
  return `${callData}${payload.startsWith('0x') ? payload.slice(2) : payload}` as `0x${string}`
}

/** Fetch signed packages for one feed and build the calldata payload. */
export async function fetchPayload(
  symbol: string,
  timeoutMs = 8_000,
): Promise<`0x${string}`> {
  const url = `${REDSTONE_GATEWAY}/v2/data-packages/latest/${REDSTONE_DATA_SERVICE}`
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`redstone gateway ${res.status}`)

  const all = (await res.json()) as Record<string, GatewayPackage[]>
  const packages = all[symbol]
  if (!packages || packages.length === 0) {
    throw new Error(`RedStone gateway served no packages for ${symbol}`)
  }

  // Recover the signer from the signature rather than trusting the gateway's
  // own signerAddress field: the contract will do exactly that on-chain, so a
  // package we cannot attribute ourselves would only fail later and cost gas.
  const recovered = await Promise.all(
    (packages as GatewayPackage[]).map(async (p) => ({ pkg: p, signer: await recoverPackageSigner(p) })),
  )
  const chosen = selectAuthorisedPackages(recovered, (r) => r.signer).map((r) => r.pkg)

  return buildPayload(chosen)
}

/** Latest price for a feed as a plain number, for the off-chain price history. */
export async function fetchPrice(symbol: string, timeoutMs = 8_000): Promise<number> {
  const url = `${REDSTONE_GATEWAY}/v2/data-packages/latest/${REDSTONE_DATA_SERVICE}`
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`redstone gateway ${res.status}`)

  const all = (await res.json()) as Record<
    string,
    { dataPoints: { value: number }[]; signerAddress: string }[]
  >
  const packages = all[symbol]
  if (!packages || packages.length === 0) {
    throw new Error(`RedStone gateway served no packages for ${symbol}`)
  }

  // Median across authorised signers rather than whichever package came first:
  // a single node disagreeing should not move what we record as history.
  const values = selectAuthorisedPackages(packages, (p) => p.signerAddress)
    .map((p) => p.dataPoints[0]?.value)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b)

  if (values.length === 0) throw new Error(`RedStone: no usable price for ${symbol}`)
  return values[Math.floor(values.length / 2)]
}
