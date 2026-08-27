/**
 * RedStone price payloads for the keeper.
 *
 * Pyth's Core upgrade put every memecoin feed behind a $500/month plan on
 * 2026-08-26; their free key answers 403 "not entitled" for PEPE, BRETT, DEGEN
 * and everything else this protocol prices. RedStone serves them all from a
 * public gateway with no credential at all, which is why there is no API key
 * anywhere in this file and should never be one.
 *
 * Note what this deliberately does NOT use: RedStone's own SDK. It now refuses
 * to run without an authenticated gateway - "Empty authenticatedGateways array
 * provided" - the same direction Pyth went. The public gateway still serves the
 * signed packages to anyone, and @redstone-finance/protocol turns them into a
 * calldata payload without the SDK's gateway logic. If that stops being true,
 * the migration's premise has changed and this is where it will show first.
 */
import proto from '@redstone-finance/protocol'
import { stringToHex } from 'viem'

const { SignedDataPackage, RedstonePayload, recoverDeserializedSignerAddress } = proto as {
  SignedDataPackage: { fromObj(o: unknown): unknown }
  RedstonePayload: { prepare(pkgs: unknown[], meta: string): string }
  recoverDeserializedSignerAddress(o: unknown): string
}

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

/** The symbol back out of a bytes32 feed id, trailing padding removed. */
export function bytes32ToFeedId(feedId: string): string {
  return Buffer.from(feedId.replace(/^0x/, ''), 'hex')
    .toString('utf8')
    .replace(/\u0000+$/, '')
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

  const all = (await res.json()) as Record<string, unknown[]>
  const packages = all[symbol]
  if (!packages || packages.length === 0) {
    throw new Error(`RedStone gateway served no packages for ${symbol}`)
  }

  // Recover the signer from the signature rather than trusting the gateway's
  // own signerAddress field: the contract will do exactly that on-chain, so a
  // package we cannot attribute ourselves would only fail later and cost gas.
  const chosen = selectAuthorisedPackages(packages, (p) => recoverDeserializedSignerAddress(p))

  const payload = RedstonePayload.prepare(chosen.map((p) => SignedDataPackage.fromObj(p)), '')
  return (payload.startsWith('0x') ? payload : `0x${payload}`) as `0x${string}`
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
