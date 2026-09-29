import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * What the shell tells a person about the network they are on:
 *
 *   a pill that says this is a test deployment, always, on a testnet build
 *   a banner, with a Switch button, when the connected wallet is on another chain
 *   a banner when the site and its API describe different deployments
 *   a wallet picker that names what was found instead of "Injected"
 */

const h = vi.hoisted(() => ({
  testnet: true,
  account: { isConnected: true, address: '0x00000000000000000000000000000000000000bb' as string | undefined, chainId: 46630 as number | undefined },
  connect: undefined as any,
  connectors: [] as any[],
  ensureChain: undefined as any,
  deployment: { status: 'verified', rpc: 'match', api: 'match', reasons: [] as string[] } as any,
  detected: { hasInjected: false } as { hasInjected: boolean; injectedName?: string },
}))

vi.mock('wagmi', () => ({
  useAccount: () => h.account,
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useConnect: () => ({ connect: (...a: unknown[]) => h.connect(...a), connectors: h.connectors }),
}))

vi.mock('../../lib/chain', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/chain')>()
  const d = orig.resolveDeployment('rhc-testnet')
  const chain = {
    ...d.chain,
    get testnet() {
      return h.testnet
    },
  }
  return { ...orig, DEPLOYMENT: d, TARGET_CHAIN: chain, TARGET_CHAIN_ID: d.chain.id, CURRENCY: d.currency, IS_POOL_BACKED: true }
})
vi.mock('../../hooks/useEnsureChain', () => ({ useEnsureChain: () => (...a: unknown[]) => h.ensureChain(...a) }))
vi.mock('../../hooks/useDeploymentCheck', () => ({ useDeploymentCheck: () => h.deployment }))
vi.mock('../../lib/walletChoices', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/walletChoices')>()
  return { ...orig, detectInjected: () => h.detected }
})

import { AppShell } from './AppShell'
import { useWalletPickerStore } from '../../hooks/useConnectWallet'

const conn = (over: Record<string, unknown>) => ({ uid: String(Math.random()), id: 'x', name: 'X', type: 'x', ...over })

function renderShell() {
  return render(
    <MemoryRouter>
      <AppShell>
        <div>page</div>
      </AppShell>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  h.testnet = true
  h.account = { isConnected: true, address: '0x00000000000000000000000000000000000000bb', chainId: 46630 }
  h.connect = vi.fn()
  h.connectors = []
  h.ensureChain = vi.fn(async () => ({ ok: true }))
  h.deployment = { status: 'verified', rpc: 'match', api: 'match', reasons: [] }
  h.detected = { hasInjected: false }
  useWalletPickerStore.setState({ open: false })
})
afterEach(cleanup)

describe('AppShell, the network pill', () => {
  it('says ROBINHOOD CHAIN TESTNET on a testnet build', () => {
    renderShell()
    const pill = screen.getByLabelText(/Network: Robinhood Chain Testnet/)
    expect(pill.textContent).toContain('ROBINHOOD CHAIN TESTNET')
    expect(pill.getAttribute('aria-label')).toMatch(/no real money/)
  })

  it('is there whether or not a wallet is connected', () => {
    h.account = { isConnected: false, address: undefined, chainId: undefined }
    renderShell()
    expect(screen.getByLabelText(/Network: Robinhood Chain Testnet/)).toBeTruthy()
  })

  it('is not shown on a build that is not a testnet', () => {
    h.testnet = false
    renderShell()
    expect(screen.queryByLabelText(/Network:/)).toBeNull()
  })
})

describe('AppShell, the wrong-network banner', () => {
  it('appears when the wallet is on another chain, and names the one to switch to', () => {
    h.account = { isConnected: true, address: '0x00000000000000000000000000000000000000bb', chainId: 1 }
    renderShell()
    const banner = screen.getByRole('alert')
    expect(banner.textContent).toContain('Your wallet is on another network (chain 1)')
    expect(banner.textContent).toContain('Switch to Robinhood Chain Testnet')
    expect(screen.getByRole('button', { name: 'SWITCH' })).toBeTruthy()
  })

  it('asks the wallet to switch when Switch is pressed', async () => {
    h.account = { isConnected: true, address: '0x00000000000000000000000000000000000000bb', chainId: 8453 }
    renderShell()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'SWITCH' }))
    })
    expect(h.ensureChain).toHaveBeenCalledTimes(1)
  })

  it('shows the wallet\'s answer when the switch is refused', async () => {
    h.account = { isConnected: true, address: '0x00000000000000000000000000000000000000bb', chainId: 1 }
    h.ensureChain = vi.fn(async () => ({ ok: false, error: 'User rejected the request.' }))
    renderShell()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'SWITCH' }))
    })
    expect(screen.getByRole('alert').textContent).toContain('User rejected the request.')
    // Still offered, so it can be tried again.
    expect((screen.getByRole('button', { name: 'SWITCH' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('is absent when the wallet is on the right chain', () => {
    renderShell()
    expect(screen.queryByRole('button', { name: 'SWITCH' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('is absent when no wallet is connected, and when its chain is not yet known', () => {
    h.account = { isConnected: false, address: undefined, chainId: undefined }
    renderShell()
    expect(screen.queryByRole('button', { name: 'SWITCH' })).toBeNull()
    cleanup()

    h.account = { isConnected: true, address: '0x00000000000000000000000000000000000000bb', chainId: undefined }
    renderShell()
    expect(screen.queryByRole('button', { name: 'SWITCH' })).toBeNull()
  })
})

describe('AppShell, the deployment banner', () => {
  it('says so, with the reasons, when the site and its API describe different deployments', () => {
    h.deployment = { status: 'mismatch', rpc: 'match', api: 'mismatch', reasons: ['The API indexes a different market factory than the one this site is built for.'] }
    renderShell()
    const banner = screen.getByRole('alert')
    expect(banner.textContent).toContain('This site is configured for a different deployment than its API')
    expect(banner.textContent).toContain('different market factory')
    // Nothing the user can press: the fix is a rebuild, not a click.
    expect(screen.queryByRole('button', { name: 'SWITCH' })).toBeNull()
  })

  it('says nothing when the check passed, could not be made, or is still running', () => {
    for (const status of ['verified', 'unverified', 'checking']) {
      h.deployment = { status, rpc: 'unknown', api: 'unknown', reasons: [] }
      renderShell()
      expect(screen.queryByRole('alert')).toBeNull()
      cleanup()
    }
  })
})

describe('AppShell, the sign-in button', () => {
  it('carries the neutral mark, not the Base square, on Robinhood Chain', () => {
    h.account = { isConnected: false, address: undefined, chainId: undefined }
    const { container } = renderShell()
    expect(container.querySelector('.connect .chainmark')).toBeTruthy()
    expect(container.querySelector('.connect .basesq')).toBeNull()
  })
})

describe('AppShell, the wallet picker says what it found', () => {
  const open = () =>
    act(async () => {
      useWalletPickerStore.setState({ open: true })
    })

  it('lists a wallet the browser announced by its own name, not "Injected"', async () => {
    h.connectors = [
      conn({ id: 'metaMaskSDK', name: 'MetaMask', type: 'metaMask' }),
      conn({ id: 'injected', name: 'Injected', type: 'injected' }),
      conn({ id: 'io.rabby', name: 'Rabby Wallet', type: 'injected', rdns: 'io.rabby' }),
    ]
    h.detected = { hasInjected: true, injectedName: 'Rabby' }
    renderShell()
    await open()

    const dialog = screen.getByRole('dialog', { name: 'Connect a wallet' })
    expect(dialog.textContent).toContain('Rabby Wallet')
    expect(dialog.textContent).toContain('Detected in this browser')
    expect(dialog.textContent).not.toContain('Injected')
  })

  it('says plainly that no browser wallet was found, and cannot be pressed', async () => {
    h.connectors = [conn({ id: 'injected', name: 'Injected', type: 'injected' })]
    h.detected = { hasInjected: false }
    renderShell()
    await open()

    const row = screen.getByRole('button', { name: /Browser wallet/ }) as HTMLButtonElement
    expect(row.textContent).toContain('None detected')
    expect(row.disabled).toBe(true)
  })

  it('connects with the target chain, so the wallet is asked to switch as it connects', async () => {
    const rabby = conn({ id: 'io.rabby', name: 'Rabby Wallet', type: 'injected', rdns: 'io.rabby' })
    h.connectors = [rabby]
    renderShell()
    await open()

    fireEvent.click(screen.getByRole('button', { name: /Rabby Wallet/ }))

    expect(h.connect).toHaveBeenCalledWith({ connector: rabby, chainId: 46630 })
    expect(useWalletPickerStore.getState().open).toBe(false)
  })
})
