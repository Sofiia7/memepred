import { Link } from 'react-router-dom'
import { useAccount, useDisconnect } from 'wagmi'
import { useConnectWallet } from '../../hooks/useConnectWallet'

export function AppHead() {
  const { address, isConnected } = useAccount()
  const { connectWallet } = useConnectWallet()
  const { disconnect } = useDisconnect()

  const shortAddr = address ? `${address.slice(0, 4)}…${address.slice(-4)}` : ''

  return (
    <div className="app-head">
      <div className="app-head-left">
        <div className="logo">
          <span className="sq" />
          <span className="name">flipthememe</span>
        </div>
        <Link to="/how-it-works" className="how-link" aria-label="How it works">?</Link>
      </div>
      {isConnected ? (
        <button className="connect ghost" onClick={() => disconnect()}>
          {shortAddr}
        </button>
      ) : (
        <button className="connect" onClick={connectWallet}>
          <span className="basesq" />
          Sign in
        </button>
      )}
    </div>
  )
}
