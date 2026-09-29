/**
 * What the connect dialog offers, described by what is actually there.
 *
 * The picker used to list wagmi's connectors by their configured names, which
 * on Robinhood Chain means "MetaMask" (the SDK connector, which opens a QR flow
 * for anyone without the extension) and "Injected" - a word that tells a user
 * nothing about whether their wallet was found. wagmi also discovers wallets on
 * its own through EIP-6963 and adds a connector for each, named by the wallet
 * itself ("Rabby Wallet", "MetaMask", "Brave Wallet"), so on a machine with an
 * extension the same wallet could be listed two or three times under different
 * names.
 *
 * This turns that raw list into rows a person can choose between: a wallet the
 * browser announced is listed by its own name, the generic injected connector is
 * named after what `window.ethereum` says it is (or says plainly that there is
 * none), and a connector that would duplicate an announced wallet is dropped.
 */

/** The parts of a wagmi Connector this needs; kept narrow so tests need no wagmi. */
export interface ConnectorLike {
  uid: string
  id: string
  name: string
  type: string
  icon?: string
  rdns?: string | readonly string[]
}

export interface WalletChoice<C extends ConnectorLike = ConnectorLike> {
  connector: C
  label: string
  /** One short line under the label: where it was found, or what it will do. */
  hint?: string
  icon?: string
  /** Not selectable: named so the user can see it was looked for and not found. */
  disabled?: boolean
}

export interface Detected {
  /** window.ethereum exists. */
  hasInjected: boolean
  /** A best guess at which wallet it is, from the flags wallets set on it. */
  injectedName?: string
}

/**
 * Which wallet an injected provider is, from the flags wallets put on it.
 * Wallets that imitate MetaMask set isMetaMask as well, so the specific flags
 * are checked first and isMetaMask last.
 */
export function describeInjected(provider: unknown): string | undefined {
  if (!provider || typeof provider !== 'object') return undefined
  const p = provider as Record<string, unknown>
  if (p.isRabby) return 'Rabby'
  if (p.isBraveWallet) return 'Brave Wallet'
  if (p.isCoinbaseWallet || p.isCoinbaseBrowser) return 'Coinbase Wallet'
  if (p.isPhantom) return 'Phantom'
  if (p.isTrust || p.isTrustWallet) return 'Trust Wallet'
  if (p.isMetaMask) return 'MetaMask'
  return undefined
}

/** Reads the current page's injected wallet. Safe where there is no window. */
export function detectInjected(win: unknown = typeof window !== 'undefined' ? window : undefined): Detected {
  const eth = (win as { ethereum?: unknown } | undefined)?.ethereum
  return { hasInjected: !!eth, injectedName: describeInjected(eth) }
}

const isMetaMaskRdns = (c: ConnectorLike) => {
  const r = c.rdns
  return typeof r === 'string' ? r === 'io.metamask' : Array.isArray(r) && (r as readonly string[]).includes('io.metamask')
}

export function buildWalletChoices<C extends ConnectorLike>(connectors: readonly C[], detected: Detected): WalletChoice<C>[] {
  // Not a choice for anyone seeing the picker: it only opens once the Mini App
  // check has come back "not in a host", and that connector fails silently
  // outside one anyway.
  const usable = connectors.filter((c) => c.id !== 'farcasterMiniApp')

  // Announced by the wallet itself (EIP-6963): an injected connector with its
  // own id, as opposed to wagmi's generic one whose id is just "injected".
  const announced = usable.filter((c) => c.type === 'injected' && c.id !== 'injected')
  const metamaskAnnounced = announced.some(isMetaMaskRdns)

  const out: WalletChoice<C>[] = []

  for (const c of announced) {
    out.push({ connector: c, label: c.name, hint: 'Detected in this browser', icon: c.icon })
  }

  for (const c of usable) {
    if (announced.includes(c)) continue

    if (c.id === 'injected') {
      // A wallet that announced itself is already listed by name above; the
      // generic entry would only be the same wallet again as "Injected".
      if (announced.length > 0) continue
      if (detected.hasInjected) {
        out.push({ connector: c, label: detected.injectedName ?? 'Browser wallet', hint: 'Detected in this browser' })
      } else {
        out.push({ connector: c, label: 'Browser wallet', hint: 'None detected - install one, such as MetaMask', disabled: true })
      }
      continue
    }

    if (c.type === 'metaMask') {
      // The extension is already listed under its own name; this connector
      // would be the same wallet again, by way of the mobile app.
      if (metamaskAnnounced) continue
      out.push({ connector: c, label: c.name, hint: 'Opens the MetaMask app or a QR code' })
      continue
    }

    out.push({ connector: c, label: c.name, icon: c.icon })
  }

  return out
}
