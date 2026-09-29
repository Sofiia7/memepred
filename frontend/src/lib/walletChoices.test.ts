import { describe, it, expect } from 'vitest'
import { buildWalletChoices, describeInjected, detectInjected, type ConnectorLike } from './walletChoices'

/**
 * The connect dialog should say what was found. On Robinhood Chain the raw
 * connector list is "MetaMask" (an SDK connector that opens a QR flow for
 * anyone without the extension) and "Injected", and wagmi additionally adds
 * one connector per wallet the browser announces (EIP-6963), so the same
 * wallet could be listed two or three times under different names.
 */

let n = 0
const conn = (over: Partial<ConnectorLike>): ConnectorLike => ({
  uid: `uid-${++n}`,
  id: 'x',
  name: 'X',
  type: 'x',
  ...over,
})

const injectedGeneric = () => conn({ id: 'injected', name: 'Injected', type: 'injected' })
const metaMaskSdk = () => conn({ id: 'metaMaskSDK', name: 'MetaMask', type: 'metaMask' })
const announced = (name: string, rdns: string, icon?: string) => conn({ id: rdns, name, type: 'injected', rdns, icon })
const farcaster = () => conn({ id: 'farcasterMiniApp', name: 'Farcaster', type: 'farcasterMiniApp' })

const none = { hasInjected: false }

describe('buildWalletChoices', () => {
  it('lists a wallet the browser announced by its own name, with its icon, and drops the generic entry', () => {
    const rabby = announced('Rabby Wallet', 'io.rabby', 'data:image/svg+xml;base64,AAA')
    const choices = buildWalletChoices([metaMaskSdk(), injectedGeneric(), rabby], { hasInjected: true, injectedName: 'Rabby' })
    expect(choices.map((c) => c.label)).toEqual(['Rabby Wallet', 'MetaMask'])
    expect(choices[0].icon).toBe('data:image/svg+xml;base64,AAA')
    expect(choices[0].hint).toBe('Detected in this browser')
    expect(choices.some((c) => c.label === 'Injected')).toBe(false)
  })

  it('does not list MetaMask twice when the extension announced itself', () => {
    const mm = announced('MetaMask', 'io.metamask')
    const choices = buildWalletChoices([metaMaskSdk(), injectedGeneric(), mm], { hasInjected: true, injectedName: 'MetaMask' })
    expect(choices.map((c) => c.label)).toEqual(['MetaMask'])
    expect(choices[0].connector).toBe(mm)
  })

  it('keeps the MetaMask app entry, and says what it does, when the extension is not there', () => {
    const choices = buildWalletChoices([metaMaskSdk(), injectedGeneric()], none)
    const mm = choices.find((c) => c.label === 'MetaMask')!
    expect(mm.hint).toMatch(/app or a QR code/)
    expect(mm.disabled).toBeUndefined()
  })

  it('names the generic injected connector for the wallet window.ethereum turned out to be', () => {
    const choices = buildWalletChoices([injectedGeneric()], { hasInjected: true, injectedName: 'Brave Wallet' })
    expect(choices).toHaveLength(1)
    expect(choices[0].label).toBe('Brave Wallet')
    expect(choices[0].hint).toBe('Detected in this browser')
  })

  it('calls it a browser wallet when something is injected but cannot be named', () => {
    const choices = buildWalletChoices([injectedGeneric()], { hasInjected: true })
    expect(choices[0].label).toBe('Browser wallet')
    expect(choices[0].disabled).toBeUndefined()
  })

  it('says plainly that nothing was found, and does not offer it as a choice', () => {
    const choices = buildWalletChoices([injectedGeneric()], none)
    expect(choices).toHaveLength(1)
    expect(choices[0].label).toBe('Browser wallet')
    expect(choices[0].hint).toMatch(/None detected/)
    expect(choices[0].disabled).toBe(true)
  })

  it('never shows the opaque word "Injected"', () => {
    for (const detected of [none, { hasInjected: true }, { hasInjected: true, injectedName: 'Rabby' }]) {
      const labels = buildWalletChoices([injectedGeneric(), metaMaskSdk()], detected).map((c) => c.label)
      expect(labels).not.toContain('Injected')
    }
  })

  it('leaves the Farcaster connector out', () => {
    const choices = buildWalletChoices([farcaster(), injectedGeneric(), metaMaskSdk()], { hasInjected: true, injectedName: 'MetaMask' })
    expect(choices.map((c) => c.connector.id)).not.toContain('farcasterMiniApp')
  })

  it('passes other connectors through under their own name (Base builds: Coinbase)', () => {
    const cb = conn({ id: 'coinbaseWalletSDK', name: 'Coinbase Wallet', type: 'coinbaseWallet' })
    const choices = buildWalletChoices([cb, injectedGeneric()], { hasInjected: true, injectedName: 'MetaMask' })
    expect(choices.map((c) => c.label)).toEqual(['Coinbase Wallet', 'MetaMask'])
  })

  it('puts announced wallets first, in the order they were announced', () => {
    const a = announced('Alpha', 'io.alpha')
    const b = announced('Beta', 'io.beta')
    const choices = buildWalletChoices([metaMaskSdk(), b, injectedGeneric(), a], none)
    expect(choices.map((c) => c.label).slice(0, 2)).toEqual(['Beta', 'Alpha'])
  })

  it('recognises MetaMask when rdns is a list', () => {
    const mm = conn({ id: 'io.metamask', name: 'MetaMask', type: 'injected', rdns: ['io.metamask', 'io.metamask.flask'] })
    const choices = buildWalletChoices([metaMaskSdk(), mm], none)
    expect(choices).toHaveLength(1)
  })
})

describe('describeInjected', () => {
  it('names a wallet from the flags it sets, specific ones before isMetaMask', () => {
    expect(describeInjected({ isMetaMask: true, isRabby: true })).toBe('Rabby')
    expect(describeInjected({ isMetaMask: true, isBraveWallet: true })).toBe('Brave Wallet')
    expect(describeInjected({ isMetaMask: true, isCoinbaseWallet: true })).toBe('Coinbase Wallet')
    expect(describeInjected({ isMetaMask: true })).toBe('MetaMask')
    expect(describeInjected({ isPhantom: true })).toBe('Phantom')
  })

  it('is undefined for a provider it cannot name, and for no provider', () => {
    expect(describeInjected({})).toBeUndefined()
    expect(describeInjected(undefined)).toBeUndefined()
    expect(describeInjected(null)).toBeUndefined()
    expect(describeInjected('nope')).toBeUndefined()
  })
})

describe('detectInjected', () => {
  it('reads window.ethereum', () => {
    expect(detectInjected({ ethereum: { isMetaMask: true } })).toEqual({ hasInjected: true, injectedName: 'MetaMask' })
    expect(detectInjected({ ethereum: {} })).toEqual({ hasInjected: true, injectedName: undefined })
  })

  it('finds nothing where there is nothing', () => {
    expect(detectInjected({})).toEqual({ hasInjected: false, injectedName: undefined })
    expect(detectInjected(undefined)).toEqual({ hasInjected: false, injectedName: undefined })
  })
})
