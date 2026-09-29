export function GeoBlock() {
  return (
    <div className="geo-block">
      <h1 style={{ color: 'var(--down)' }}>⛔</h1>
      <h2 style={{ color: 'var(--down)', marginBottom: 12, letterSpacing: '.06em', fontFamily: 'var(--mono)', fontSize: 14 }}>
        REGION BLOCKED
      </h2>
      <p>
        flipthememe is not available where you are.
      </p>
      <p style={{ marginTop: 12 }}>
        Short-horizon price contracts are a licensed derivatives or gambling
        product in a number of countries. This one holds no such licence
        anywhere, so it doesn't operate in those places - that includes the
        US, UK, Canada, Australia, Japan, Singapore, France, Germany and the
        Netherlands, alongside comprehensively sanctioned countries.
      </p>
      <p style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
        This isn't a check to get around. Using a VPN to reach the product
        doesn't make it legal for you - it just moves the problem onto you.
      </p>
    </div>
  )
}

/**
 * Shown while the region check is in flight (at most GEO_TIMEOUT_MS). Before
 * this the page was simply blank until /api/geo answered - with no deadline,
 * so a hung request looked exactly like a broken site.
 */
export function GeoChecking() {
  return (
    <div className="geo-block" role="status" aria-live="polite">
      <p>Checking your region...</p>
    </div>
  )
}

/**
 * The region check itself failed: the API was unreachable, timed out, or
 * answered with an error. That is a different fact from "your country is
 * excluded" (GeoBlock), and used to be shown as the same screen - a visitor
 * from a permitted country was told theirs was banned because a server was
 * down.
 *
 * Nothing of the app renders behind this. Trading stays closed until the check
 * has actually answered, exactly as it did when this case was folded into
 * GeoBlock; only what the visitor is told, and whether they can retry, changed.
 */
export function GeoUnverified({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="geo-block" role="alert">
      <h2 style={{ color: 'var(--warn)', marginBottom: 12, letterSpacing: '.06em', fontFamily: 'var(--mono)', fontSize: 14 }}>
        Could not verify your region
      </h2>
      <p>
        flipthememe checks which country you are in before it shows any market,
        and that check did not complete.
      </p>
      <p style={{ marginTop: 12 }}>
        This is not a decision about your country. The service that answers the
        question did not respond in time or returned an error. Check your
        connection and try again.
      </p>
      <button className="cta geo-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}
