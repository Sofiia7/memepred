import { FastifyInstance } from 'fastify'
import { createPublicClient, http, type Address } from 'viem'
import { base, baseSepolia } from 'viem/chains'
const chain = process.env.CHAIN_ID === '8453' ? base : baseSepolia

const LIQUIDITY_POOL_ABI = [
  {
    name: 'getPoolStats',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'totalAssetsOut',  type: 'uint256' },
      { name: 'available',       type: 'uint256' },
      { name: 'providerExposure',type: 'uint256' },
      { name: 'genesisLeft',     type: 'uint256' }
    ]
  },
  {
    name: 'genesisCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  }
] as const

export default async function poolRoutes(app: FastifyInstance) {
  const client = createPublicClient({
    chain,
    transport: http(process.env.BASE_RPC_URL)
  })

  const poolAddress = process.env.LIQUIDITY_POOL as Address

  app.get('/api/pool/stats', async (_req, reply) => {
    try {
      const [stats, genesisCount, totalSupply] = await Promise.all([
        client.readContract({ address: poolAddress, abi: LIQUIDITY_POOL_ABI, functionName: 'getPoolStats' }),
        client.readContract({ address: poolAddress, abi: LIQUIDITY_POOL_ABI, functionName: 'genesisCount' }),
        client.readContract({ address: poolAddress, abi: LIQUIDITY_POOL_ABI, functionName: 'totalSupply' })
      ])

      reply.send({
        totalAssets:    stats[0].toString(),
        available:      stats[1].toString(),
        totalExposure:  stats[2].toString(),
        genesisLeft:    Number(stats[3]),
        genesisCount:   Number(genesisCount),
        totalShares:    totalSupply.toString()
      })
    } catch (err) {
      app.log.error(err, 'Failed to read pool stats')
      reply.status(500).send({ error: 'Failed to read pool stats' })
    }
  })
}
