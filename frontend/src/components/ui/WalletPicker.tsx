import { useConnect } from 'wagmi'
import { useWalletPickerStore } from '../../hooks/useConnectWallet'
import { TARGET_CHAIN_ID } from '../../lib/chain'
import { buildWalletChoices, detectInjected } from '../../lib/walletChoices'

/**
 * The connector picker useConnectWallet() opens instead of blindly connecting
 * to connectors[0]. Rendered once, near the root (see AppShell) - only ever
 * visible outside a Farcaster/Base App host, since that path connects
 * directly and never sets `open`.
 *
 * Rows say what was actually found (see lib/walletChoices): a wallet the
 * browser announced under its own name, the generic injected connector named
 * for what window.ethereum turned out to be, and a plain "none detected" rather
 * than an opaque "Injected".
 */
export function WalletPicker() {
  const open = useWalletPickerStore((s) => s.open)
  const setOpen = useWalletPickerStore((s) => s.setOpen)
  const { connect, connectors } = useConnect()

  if (!open) return null

  const choices = buildWalletChoices(connectors, detectInjected())

  function close() {
    setOpen(false)
  }

  return (
    <div className="wallet-picker" onClick={close}>
      <div className="wallet-picker-card" role="dialog" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
        <div className="wallet-picker-title">Connect a wallet</div>
        <div className="wallet-picker-choices">
          {choices.map(({ connector, label, hint, icon, disabled }) => (
            <button
              key={connector.uid}
              className="cta wallet-choice"
              disabled={disabled}
              onClick={() => {
                // The target chain rides along so the wallet is asked to switch
                // as it connects, instead of the user finding out at the first
                // signature that it was on another network.
                connect({ connector, chainId: TARGET_CHAIN_ID })
                close()
              }}
            >
              {icon ? <img className="wallet-choice-icon" src={icon} alt="" width={20} height={20} /> : null}
              <span className="wallet-choice-txt">
                <span>{label}</span>
                {hint ? <span className="wallet-hint">{hint}</span> : null}
              </span>
            </button>
          ))}
        </div>
        <button className="clear wallet-picker-cancel" onClick={close}>CANCEL</button>
      </div>
    </div>
  )
}
