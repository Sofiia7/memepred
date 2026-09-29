import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The Robinhood Chain build is not a Farcaster Mini App. Its head has no
 * fc:miniapp tags and its connectors have no Farcaster one, so nothing there
 * can run inside a host; the SDK used to be imported on every page load anyway,
 * only to find out it was not in one. On that build it must not be fetched.
 */

const sdkImports = vi.hoisted(() => ({ count: 0 }))

vi.mock('@farcaster/miniapp-sdk', () => {
  sdkImports.count += 1
  return {
    sdk: {
      isInMiniApp: async () => true,
      actions: { ready: vi.fn(async () => {}), addMiniApp: vi.fn(async () => {}) },
    },
  }
})

async function loadWith(poolBacked: boolean) {
  vi.resetModules()
  vi.doMock('./chain', () => ({ IS_POOL_BACKED: poolBacked }))
  return import('./miniapp')
}

beforeEach(() => {
  sdkImports.count = 0
})

describe('miniapp on Robinhood Chain', () => {
  it('is disabled, and never loads the SDK', async () => {
    const m = await loadWith(true)
    expect(m.MINIAPP_ENABLED).toBe(false)
    expect(await m.getMiniAppSDK()).toBeNull()
    await m.signalAppReady()
    expect(await m.isInMiniApp()).toBe(false)
    await m.promptAddMiniApp()
    expect(sdkImports.count).toBe(0)
  })
})

describe('miniapp on Base', () => {
  it('is enabled and loads the SDK as before', async () => {
    const m = await loadWith(false)
    expect(m.MINIAPP_ENABLED).toBe(true)
    expect(await m.isInMiniApp()).toBe(true)
    expect(sdkImports.count).toBe(1)
  })

  it('tells the host the app is ready', async () => {
    const m = await loadWith(false)
    const sdk = await m.getMiniAppSDK()
    await m.signalAppReady()
    expect(sdk.actions.ready).toHaveBeenCalledTimes(1)
  })
})
