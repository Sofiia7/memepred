import { TARGET_CHAIN } from '../../lib/chain'
import { useWalletNetwork } from '../../hooks/useWalletNetwork'
import { useDeploymentCheck } from '../../hooks/useDeploymentCheck'
import { DEPLOYMENT_MISMATCH_MESSAGE } from '../../lib/deployment'

/**
 * Whether the wallet and the deployment agree with the network this build is
 * for. Two banners, both rendered by AppShell above the page (the pill that
 * says which network it is lives in NetworkPill.tsx):
 *
 *   WrongNetworkBanner a connected wallet on another network, with a Switch button
 *   DeploymentBanner   this build and its API describe different deployments
 */

export function WrongNetworkBanner() {
  const { wrong, walletChainId, switching, error, switchNow } = useWalletNetwork()
  if (!wrong) return null
  return (
    <div className="net-banner" role="alert">
      <div className="net-banner-txt">
        Your wallet is on another network{walletChainId !== undefined ? ` (chain ${walletChainId})` : ''}.
        Switch to {TARGET_CHAIN.name} to trade.
        {error ? <div className="net-banner-err">{error}</div> : null}
      </div>
      <button className="net-banner-btn" disabled={switching} onClick={() => void switchNow()}>
        {switching ? 'SWITCHING…' : 'SWITCH'}
      </button>
    </div>
  )
}

export function DeploymentBanner() {
  const verdict = useDeploymentCheck()
  if (verdict.status !== 'mismatch') return null
  return (
    <div className="net-banner net-banner-bad" role="alert">
      <div className="net-banner-txt">
        {DEPLOYMENT_MISMATCH_MESSAGE}. Signing is turned off until they match.
        {verdict.reasons.map((r) => (
          <div key={r} className="net-banner-err">{r}</div>
        ))}
      </div>
    </div>
  )
}
