export function GeoBlock() {
  return (
    <div className="geo-block">
      <h1 style={{ color: 'var(--down)' }}>⛔</h1>
      <h2 style={{ color: 'var(--down)', marginBottom: 12, letterSpacing: '.06em', fontFamily: 'var(--mono)', fontSize: 14 }}>
        REGION BLOCKED
      </h2>
      <p>
        flipthememe is not available in your region due to regulatory restrictions.
        If you believe this is an error, please contact support.
      </p>
    </div>
  )
}
