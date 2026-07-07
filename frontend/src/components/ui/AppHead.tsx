import { useAccount, useDisconnect } from 'wagmi'
import { useConnectWallet } from '../../hooks/useConnectWallet'

export function AppHead() {
  const { address, isConnected } = useAccount()
  const { connectWallet } = useConnectWallet()
  const { disconnect } = useDisconnect()

  const shortAddr = address ? `${address.slice(0, 4)}…${address.slice(-4)}` : ''

  return (
    <div className="app-head">
      <div className="logo">
        <span className="sq" />
        <span className="name">flipthememe</span>
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
