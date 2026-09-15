import { useConnect } from 'wagmi'
import { useWalletPickerStore } from '../../hooks/useConnectWallet'

/**
 * The connector picker useConnectWallet() opens instead of blindly connecting
 * to connectors[0]. Rendered once, near the root (see AppShell) - only ever
 * visible outside a Farcaster/Base App host, since that path connects
 * directly and never sets `open`.
 */
export function WalletPicker() {
  const open = useWalletPickerStore((s) => s.open)
  const setOpen = useWalletPickerStore((s) => s.setOpen)
  const { connect, connectors } = useConnect()

  if (!open) return null

  // Not a real choice for anyone seeing this picker: useConnectWallet only
  // opens it once isInMiniApp() has already come back false, and Farcaster's
  // own connector fails silently outside its host either way.
  const choices = connectors.filter((c) => c.id !== 'farcasterMiniApp')

  function close() {
    setOpen(false)
  }

  return (
    <div className="wallet-picker" onClick={close}>
      <div className="wallet-picker-card" onClick={(e) => e.stopPropagation()}>
        <div className="wallet-picker-title">Connect a wallet</div>
        <div className="wallet-picker-choices">
          {choices.map((c) => (
            <button
              key={c.uid}
              className="cta"
              onClick={() => {
                connect({ connector: c })
                close()
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
        <button className="clear wallet-picker-cancel" onClick={close}>CANCEL</button>
      </div>
    </div>
  )
}
