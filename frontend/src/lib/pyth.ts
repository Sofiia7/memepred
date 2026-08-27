/**
 * Price updates, fetched through our backend rather than from Pyth directly.
 *
 * Pyth closed Hermes to unauthenticated callers on 2026-08-26 at 16:00 UTC.
 * The browser cannot hold the bearer token: Vite inlines every VITE_* value
 * into the public bundle, so putting the key here would publish it. The backend
 * proxies instead (routes/pyth.ts), which also lets it cache and keep the
 * endpoint scoped to the feeds we actually run markets on.
 */

/**
 * URL for a price update on `feedId`.
 *
 * @param parsed true for a human-readable price to display, false for the
 *               signed binary payload that goes on-chain with a bet.
 */
export function pythUpdatesUrl(feedId: string, parsed: boolean): string {
  // The backend whitelist matches on the 0x form. usePythPrice used to strip
  // the prefix before calling Hermes, which would now be rejected as an
  // unsupported feed.
  const id = feedId.startsWith('0x') ? feedId : `0x${feedId}`
  return `${import.meta.env.VITE_API_URL}/api/pyth/updates?ids=${id}&parsed=${parsed}`
}
