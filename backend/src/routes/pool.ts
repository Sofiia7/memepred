import { FastifyInstance } from 'fastify'
import { createPublicClient, http, type Address } from 'viem'
import { base } from 'viem/chains'

const LIQUIDITY_POOL_ABI = [
  {
    name: 'getPoolStats',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'total',          type: 'uint256' },
      { name: 'available',      type: 'uint256' },
      { name: 'providerCount',  type: 'uint256' },
      { name: 'genesisLeft',    type: 'uint256' }
    ]
  }
] as const

export default async function poolRoutes(app: FastifyInstance) {
  const client = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL)
  })

  const poolAddress = process.env.LIQUIDITY_POOL as Address

  app.get('/api/pool/stats', async (_req, reply) => {
    try {
      const stats = await client.readContract({
        address:      poolAddress,
        abi:          LIQUIDITY_POOL_ABI,
        functionName: 'getPoolStats'
      })

      reply.send({
        total:         stats[0].toString(),
        available:     stats[1].toString(),
        providerCount: Number(stats[2]),
        genesisLeft:   Number(stats[3])
      })
    } catch (err) {
      app.log.error(err, 'Failed to read pool stats')
      reply.status(500).send({ error: 'Failed to read pool stats' })
    }
  })
}
