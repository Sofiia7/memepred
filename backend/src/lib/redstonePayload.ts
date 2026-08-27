/**
 * RedStone's payload format, assembled with viem.
 *
 * Written rather than imported. @redstone-finance/protocol does exactly this,
 * but it depends on ethers v5, which drags in @ethersproject/providers and a
 * `ws` carrying four high-severity advisories - into the production image of a
 * service that never opens a websocket. It also carries the same BUSL/MIT
 * licence contradiction as their contracts.
 *
 * The format is small and fully determined, and we already implement it in
 * Solidity for the contract tests, so the cost of owning it is one file:
 *
 *   package = feedId(32) value(32) timestamp(6) valueByteSize(4) count(3) sig(65)
 *   payload = package... packagesCount(2) metadataSize(3) marker(9)
 *
 * The signed message is the package without its signature, hashed with a plain
 * keccak256 - no EIP-191 prefix, matching what RedstoneConsumerBase recovers
 * against on-chain.
 *
 * Nothing here re-derives a value the signer did not sign: if our reconstruction
 * of the bytes differs from theirs anywhere, recovery lands on a stranger and
 * the contract rejects the package. redstonePayload.test.ts checks exactly that
 * against a real captured package, which makes it a test of the encoding rather
 * than of ecrecover.
 */
import { keccak256, recoverAddress, type Hex } from 'viem'

export interface GatewayPackage {
  dataPackageId: string
  timestampMilliseconds: number
  /** base64, 65 bytes: r || s || v */
  signature: string
  dataPoints: { dataFeedId: string; value: number }[]
  /** What the gateway claims. Never trusted - we recover instead. */
  signerAddress?: string
}

/** RedStone publishes prices scaled by 1e8. */
const PRICE_DECIMALS = 8

/** Marks the end of a payload; the parser walks backwards from it. */
const MARKER = '000002ed57011e0000'

const hex = (n: number | bigint, bytes: number) => n.toString(16).padStart(bytes * 2, '0')

/** A symbol right-padded into a bytes32, which is how RedStone names a feed. */
function feedIdHex(symbol: string): string {
  return Buffer.from(symbol, 'utf8').toString('hex').padEnd(64, '0')
}

/**
 * The bytes a signer signed, plus their signature.
 *
 * Value scaling uses Math.round on purpose: the gateway serves the price as a
 * JSON number and this has to land on the same integer the signer used, or the
 * signature covers different bytes than we present.
 */
export function packageBytes(pkg: GatewayPackage): Hex {
  return `0x${signedMessageHex(pkg)}${signatureHex(pkg.signature)}` as Hex
}

function signedMessageHex(pkg: GatewayPackage): string {
  if (pkg.dataPoints.length !== 1) {
    throw new Error(`RedStone: expected one data point per package, got ${pkg.dataPoints.length}`)
  }
  const point = pkg.dataPoints[0]
  const value = BigInt(Math.round(point.value * 10 ** PRICE_DECIMALS))

  return (
    feedIdHex(point.dataFeedId) +
    hex(value, 32) +
    hex(pkg.timestampMilliseconds, 6) +
    hex(32, 4) + // each data point value occupies a full word
    hex(1, 3)    // one data point
  )
}

function signatureHex(base64: string): string {
  const raw = Buffer.from(base64, 'base64')
  if (raw.length !== 65) throw new Error(`RedStone: signature is ${raw.length} bytes, expected 65`)
  return raw.toString('hex')
}

/** The address that signed this package, recovered rather than taken on trust. */
export async function recoverPackageSigner(pkg: GatewayPackage): Promise<string> {
  const message = signedMessageHex(pkg)
  const raw = Buffer.from(pkg.signature, 'base64')
  // v is 27/28 on the wire; viem wants it as part of the 65-byte signature.
  return recoverAddress({
    hash: keccak256(`0x${message}` as Hex),
    signature: `0x${raw.toString('hex')}` as Hex,
  })
}

/**
 * The calldata suffix carrying `packages`.
 *
 * Tail order is packagesCount then metadataSize, which is not what the field
 * names suggest: RedstoneConsumerBase finds the metadata size by loading 32
 * bytes at calldatasize()-41 and taking the low three, landing on [len-12,
 * len-9), so the count sits before it. Reversing them keeps the payload exactly
 * the right length and makes every offset after it wrong.
 */
export function buildPayload(packages: GatewayPackage[]): Hex {
  if (packages.length === 0) throw new Error('RedStone: cannot build a payload from no packages')

  const body = packages.map((p) => packageBytes(p).slice(2)).join('')
  return `0x${body}${hex(packages.length, 2)}${hex(0, 3)}${MARKER}` as Hex
}
