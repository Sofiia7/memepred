/**
 * Simulates a bet against a live market, without placing one.
 *
 *   cd backend && MARKET=0x… npx tsx scripts/simulate-bet.mts
 *
 * eth_call, so nothing moves and no position is taken. The point is *where* it
 * stops: reaching the USDC transfer means the RedStone payload verified, the
 * strike was read at the right scale, the freshness window accepted it and the
 * slippage guard passed - the whole path the oracle migration changed. A revert
 * before that names which of them failed.
 *
 * Uses the keeper's own fetchPayload rather than a copy, so a break in the real
 * path cannot pass here.
 */
import { createPublicClient, http, encodeFunctionData, parseAbi } from 'viem'
import { baseSepolia } from 'viem/chains'
import { fetchPayload, fetchPrice, bytes32ToFeedId } from '../src/lib/redstone.js'

const MARKET = process.env.MARKET as `0x${string}`
const FROM   = (process.env.FROM ?? '0x12f9B9De75ccEa7be573F643A99AAA63b9448BD2') as `0x${string}`
const RPC    = process.env.BASE_RPC_URL ?? 'https://sepolia.base.org'
if (!MARKET) throw new Error('set MARKET')

const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) })

const ABI = parseAbi([
  'function feedId() view returns (bytes32)',
  'function paused() view returns (bool)',
  'function placeBet(uint8 dir, uint256 amount, address referrer, uint256 expectedPrice, uint256 slippageBps) returns (uint256)',
])

const feedId = await client.readContract({ address: MARKET, abi: ABI, functionName: 'feedId' })
const paused = await client.readContract({ address: MARKET, abi: ABI, functionName: 'paused' })
const symbol = bytes32ToFeedId(feedId)
console.log(`market ${MARKET}`)
console.log(`  feed ${symbol || '(unrecognised)'}, paused=${paused}`)

const payload = await fetchPayload(symbol)
const price   = await fetchPrice(symbol)
const expectedPrice = BigInt(Math.round(price * 1e8)) * 10n ** 10n
console.log(`  live price $${price} -> expectedPrice ${expectedPrice}`)

const data = encodeFunctionData({
  abi: ABI,
  functionName: 'placeBet',
  // UP, 1 USDC, no referrer, 1% slippage
  args: [0, 1_000_000n, '0x0000000000000000000000000000000000000000', expectedPrice, 100n],
})

try {
  await client.call({ account: FROM, to: MARKET, data: `${data}${payload.slice(2)}` as `0x${string}` })
  console.log('  RESULT: would succeed outright')
} catch (e: any) {
  const msg = String(e?.shortMessage ?? e?.details ?? e?.message ?? e).split(String.fromCharCode(10))[0]
  const reachedTransfer = /allowance|balance|transfer/i.test(msg)
  console.log(`  RESULT: reverted with "${msg}"`)
  console.log(reachedTransfer
    ? '  -> reached the USDC transfer, so the oracle path, strike scaling,' +
      ' freshness window and slippage guard all passed.'
    : '  -> stopped BEFORE the token transfer: an oracle or bet-path failure.')
  process.exit(reachedTransfer ? 0 : 1)
}
