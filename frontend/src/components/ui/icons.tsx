export function Chev({ dir = 'up' }: { dir?: 'up' | 'down' }) {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" style={{ display: 'inline-block' }}>
      {dir === 'up' ? (
        <path d="M2 6.5L5 3.5L8 6.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  )
}

export function MarketsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M3 17L9 11L13 15L21 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 7H21V13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function TrophyIcon({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M6 4H18V8C18 11 16 13 12 13C8 13 6 11 6 8V4Z" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      <path d="M9 19H15M12 13V19M4 6H6M18 6H20" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function StarIcon({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M12 3L14 9H20L15 13L17 19L12 15L7 19L9 13L4 9H10L12 3Z" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  )
}

export function WalletIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M3 10H17C18.1 10 19 10.9 19 12V13C19 14.1 18.1 15 17 15H3" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  )
}

export function LiveDot({ color = 'var(--down)' }: { color?: string }) {
  return <span className="dot" style={{ background: color }} />
}

export function PoolsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M3 11c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".55" />
    </svg>
  )
}
