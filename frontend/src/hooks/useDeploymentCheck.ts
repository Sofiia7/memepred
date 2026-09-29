import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { CONTRACTS } from '../lib/contracts'
import { TARGET_CHAIN_ID } from '../lib/chain'
import { DEPLOYMENT_TIMEOUT_MS, evaluateDeployment, fetchDeployment, type DeploymentVerdict } from '../lib/deployment'

const CHECKING: DeploymentVerdict = { status: 'checking', rpc: 'unknown', api: 'unknown', reasons: [] }

/** eth_chainId of the configured RPC, or null when it cannot be read in time. */
async function readRpcChainId(client: { getChainId: () => Promise<number> } | undefined): Promise<number | null> {
  if (!client) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      client.getChainId(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('rpc timeout')), DEPLOYMENT_TIMEOUT_MS)
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The runtime handshake between this build and what it is talking to (audit
 * U11): the configured RPC's chain id, and the backend's /api/deployment, each
 * compared with what the build was made for. See lib/deployment for the rules;
 * in short, only a definite disagreement is `mismatch`, and a source that could
 * not be asked is `unverified`, never a mismatch.
 *
 * One request per five minutes per page load, shared by everything that asks
 * (the shell banner and the Composer read the same query).
 */
export function useDeploymentCheck(): DeploymentVerdict {
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID })
  const api = import.meta.env.VITE_API_URL as string

  const { data } = useQuery<DeploymentVerdict>({
    queryKey: ['deployment-check', TARGET_CHAIN_ID, CONTRACTS.MARKET_FACTORY, api],
    queryFn: async () => {
      const [rpcChainId, apiDeployment] = await Promise.all([readRpcChainId(publicClient), fetchDeployment(api)])
      return evaluateDeployment({
        expectedChainId: TARGET_CHAIN_ID,
        expectedFactory: CONTRACTS.MARKET_FACTORY,
        rpcChainId,
        api: apiDeployment,
      })
    },
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  })

  return data ?? CHECKING
}
