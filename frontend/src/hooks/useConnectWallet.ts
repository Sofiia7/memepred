import { create } from 'zustand'
import { useConnect } from 'wagmi'
import { MINIAPP_ENABLED, isInMiniApp } from '../lib/miniapp'

/**
 * Whether the wallet-connector picker is open.
 *
 * A tiny external store rather than component state, because connectWallet()
 * is called from half a dozen unrelated leaf components (Composer, Genesis,
 * Refer, Portfolio, AppHead) while the picker itself renders once, near the
 * root, in AppShell - a store needs no provider wiring or prop drilling to
 * connect the two.
 */
export const useWalletPickerStore = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/**
 * connectors[0] used to be connected to blindly outside a Farcaster host.
 *
 * On Base that happened to be Coinbase Smart Wallet, by the connector order
 * wagmi.config.ts documents as deliberate. On Robinhood Chain's shorter list
 * ([metaMask(), injected()]) it is MetaMask's SDK connector - which opens a
 * "scan with MetaMask mobile" QR flow for anyone who does not have the
 * MetaMask browser extension itself installed, including a desktop user
 * running a completely different injected wallet (Rabby, Coinbase's
 * extension, a Robinhood Wallet extension) or no wallet extension at all.
 *
 * Inside a Farcaster/Base App host there is only ever one real choice - the
 * host's own injected provider - and connecting immediately is still
 * correct, so that path is unchanged. Outside one, this now opens a picker
 * instead of guessing.
 *
 * On a Robinhood Chain build there is no Mini App host to ask: the check is
 * skipped rather than loading the Farcaster SDK just to be told no.
 */
export function useConnectWallet() {
  const { connect, connectors } = useConnect()
  const setOpen = useWalletPickerStore((s) => s.setOpen)

  async function connectWallet() {
    const inMiniApp = MINIAPP_ENABLED ? await isInMiniApp() : false
    if (inMiniApp) {
      const target = connectors.find((c) => c.id === 'farcasterMiniApp')
      if (target) connect({ connector: target })
      return
    }
    setOpen(true)
  }

  return { connectWallet }
}
