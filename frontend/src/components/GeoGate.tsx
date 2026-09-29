import { useEffect, useState, type ReactNode } from 'react'
import { checkGeo, type GeoResult } from '../lib/geocheck'
import { GeoBlock, GeoChecking, GeoUnverified } from './GeoBlock'

/**
 * Renders its children only once the region check has come back "allowed".
 *
 *   checking    -> a short "Checking your region..." state (was a blank page)
 *   blocked     -> the REGION BLOCKED screen, unchanged
 *   unverified  -> "Could not verify your region" with Retry, and no app
 *
 * The children are not mounted in any state but the last, so nothing behind
 * the gate fetches, connects a wallet or renders a market while the answer is
 * outstanding or negative.
 */
export function GeoGate({
  children,
  onSettled,
}: {
  children: ReactNode
  /** Called each time a check finishes, whatever it decided. */
  onSettled?: (result: GeoResult) => void
}) {
  const [result, setResult] = useState<GeoResult | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setResult(null)
    checkGeo()
      .catch((): GeoResult => ({ status: 'unverified', country: 'XX' }))
      .then((r) => {
        if (cancelled) return
        setResult(r)
        onSettled?.(r)
      })
    return () => {
      cancelled = true
    }
    // onSettled is a callback for the caller's bookkeeping, not an input to
    // the check: a new function identity must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  if (result === null) return <GeoChecking />
  if (result.status === 'blocked') return <GeoBlock />
  if (result.status === 'unverified') return <GeoUnverified onRetry={() => setAttempt((n) => n + 1)} />
  return <>{children}</>
}
