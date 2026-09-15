/**
 * A basic error state with a retry button, for the backend-fetch failures
 * that used to show permanent loading/empty text with nothing to click.
 * Deliberately small and shared rather than a per-page redesign - see
 * Markets/Pools/Leaderboard/Market.tsx for where react-query's isError and
 * refetch were already sitting there unused.
 */
export function ApiError({ onRetry, message = "Couldn't reach the server" }: { onRetry: () => void; message?: string }) {
  return (
    <div className="empty-state">
      <div>{message}</div>
      <button className="cta" style={{ marginTop: 10 }} onClick={() => onRetry()}>
        RETRY
      </button>
    </div>
  )
}
