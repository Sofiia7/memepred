import { useAccount, useConnect, useDisconnect } from 'wagmi'

export function AppHead() {
  const { address, isConnected } = useAccount()
  const { connect, connectors } = useConnect()
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
        <button
          className="connect"
          onClick={() => connectors[0] && connect({ connector: connectors[0] })}
        >
          <span className="basesq" />
          Sign in
        </button>
      )}
    </div>
  )
}
