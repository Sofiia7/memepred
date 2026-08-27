/**
 * Prints a live RedStone payload as hex, for scripts that must append one to
 * their calldata by hand.
 *
 *   node scripts/print-redstone-payload.mjs PEPE
 *
 * The entry window on OrderbookMarket is 20 seconds, so use it immediately.
 */
import proto from '@redstone-finance/protocol'

const { SignedDataPackage, RedstonePayload, recoverDeserializedSignerAddress } = proto

const AUTHORISED_SIGNERS = [
  '0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774',
  '0xdEB22f54738d54976C4c0fe5ce6d408E40d88499',
  '0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202',
  '0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE',
  '0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de',
].map((a) => a.toLowerCase())

const feed = process.argv[2]
if (!feed) {
  console.error('usage: node scripts/print-redstone-payload.mjs <FEED>   e.g. PEPE')
  process.exit(1)
}

const res = await fetch(
  'https://oracle-gateway-1.a.redstone.finance/v2/data-packages/latest/redstone-primary-prod',
)
if (!res.ok) throw new Error(`gateway responded ${res.status}`)

const packages = (await res.json())[feed]
if (!packages) throw new Error(`gateway served no packages for ${feed}`)

const authorised = packages.filter((p) =>
  AUTHORISED_SIGNERS.includes(recoverDeserializedSignerAddress(p).toLowerCase()),
)
if (authorised.length < 3) throw new Error(`${feed}: only ${authorised.length} authorised signers`)

const payload = RedstonePayload.prepare(
  authorised.slice(0, 3).map((p) => SignedDataPackage.fromObj(p)),
  '',
)
process.stdout.write(payload.startsWith('0x') ? payload : `0x${payload}`)
