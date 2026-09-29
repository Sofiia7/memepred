// Farcaster Mini App SDK initialization.
// Loaded lazily so the app still works when opened outside Farcaster.
import { IS_POOL_BACKED } from './chain'

/**
 * Farcaster and Base App hosts exist for the Base build. The Robinhood Chain
 * build is not a Mini App: its head carries no fc:miniapp tags and its
 * connectors do not include the Farcaster one, so nothing there can be opened
 * inside a host - and yet the SDK used to be dynamically imported on every
 * page load, only to find out it was not in one. It is not fetched at all now.
 */
export const MINIAPP_ENABLED = !IS_POOL_BACKED

let cached: any = null

export async function getMiniAppSDK(): Promise<any | null> {
  if (!MINIAPP_ENABLED) return null
  if (cached) return cached
  try {
    const mod = await import('@farcaster/miniapp-sdk')
    cached = mod.sdk
    return cached
  } catch {
    return null
  }
}

/**
 * Signal the host (Farcaster client / Base App) that the app finished initial
 * render. MUST be called once after first paint or the splash screen hangs.
 */
export async function signalAppReady() {
  const sdk = await getMiniAppSDK()
  if (!sdk) return
  try { await sdk.actions.ready() } catch (e) { console.warn('miniapp ready failed', e) }
}

/** Returns true when running inside a Farcaster / Base App host. */
export async function isInMiniApp(): Promise<boolean> {
  const sdk = await getMiniAppSDK()
  if (!sdk) return false
  try { return await sdk.isInMiniApp() } catch { return false }
}

/** Prompt the user to add this Mini App to their client (notifications etc.). */
export async function promptAddMiniApp() {
  const sdk = await getMiniAppSDK()
  if (!sdk) return
  try { await sdk.actions.addMiniApp() } catch (e) { console.warn('addMiniApp failed', e) }
}
