import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

/**
 * Opening the wallet picker from a Robinhood Chain build must not go through
 * the Farcaster SDK: that build is not a Mini App, and asking the SDK whether
 * it is one means downloading it first.
 */

const h = vi.hoisted(() => ({
  miniappEnabled: true,
  inMiniApp: false,
  isInMiniApp: undefined as any,
  connect: undefined as any,
  connectors: [] as any[],
}))

vi.mock('wagmi', () => ({
  useConnect: () => ({ connect: (...a: unknown[]) => h.connect(...a), connectors: h.connectors }),
}))
vi.mock('../lib/miniapp', () => ({
  get MINIAPP_ENABLED() {
    return h.miniappEnabled
  },
  isInMiniApp: (...a: unknown[]) => h.isInMiniApp(...a),
}))

import { useConnectWallet, useWalletPickerStore } from './useConnectWallet'

beforeEach(() => {
  h.miniappEnabled = true
  h.inMiniApp = false
  h.isInMiniApp = vi.fn(async () => h.inMiniApp)
  h.connect = vi.fn()
  h.connectors = [{ id: 'farcasterMiniApp', uid: 'fc' }, { id: 'injected', uid: 'inj' }]
  useWalletPickerStore.setState({ open: false })
})
afterEach(cleanup)

describe('useConnectWallet', () => {
  it('on Robinhood Chain opens the picker without loading the Mini App SDK', async () => {
    h.miniappEnabled = false
    const { result } = renderHook(() => useConnectWallet())
    await act(async () => {
      await result.current.connectWallet()
    })

    expect(h.isInMiniApp).not.toHaveBeenCalled()
    expect(useWalletPickerStore.getState().open).toBe(true)
    expect(h.connect).not.toHaveBeenCalled()
  })

  it('on Base outside a Mini App host opens the picker, after asking', async () => {
    const { result } = renderHook(() => useConnectWallet())
    await act(async () => {
      await result.current.connectWallet()
    })

    expect(h.isInMiniApp).toHaveBeenCalledTimes(1)
    expect(useWalletPickerStore.getState().open).toBe(true)
  })

  it('on Base inside a Mini App host connects the host wallet directly, as before', async () => {
    h.inMiniApp = true
    const { result } = renderHook(() => useConnectWallet())
    await act(async () => {
      await result.current.connectWallet()
    })

    expect(h.connect).toHaveBeenCalledWith({ connector: h.connectors[0] })
    expect(useWalletPickerStore.getState().open).toBe(false)
  })
})
