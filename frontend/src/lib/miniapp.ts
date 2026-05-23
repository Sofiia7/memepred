// Farcaster Mini App SDK initialization.
// Loaded lazily so the app still works when opened outside Farcaster.

let cached: any = null

export async function getMiniAppSDK(): Promise<any | null> {
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
