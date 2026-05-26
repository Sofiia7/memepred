type Rarity = 'common' | 'rare' | 'epic' | 'legendary'

interface BadgeInfo {
  id:     number
  name:   string
  rarity: Rarity
}

const BADGES: BadgeInfo[] = [
  { id: 1,  name: 'Beginner',      rarity: 'common' },
  { id: 2,  name: 'On Fire',       rarity: 'common' },
  { id: 3,  name: 'Diamond',       rarity: 'rare' },
  { id: 4,  name: 'Sniper',        rarity: 'rare' },
  { id: 5,  name: 'Speed',         rarity: 'common' },
  { id: 6,  name: 'Whale',         rarity: 'rare' },
  { id: 7,  name: 'To The Moon',   rarity: 'epic' },
  { id: 8,  name: 'Oracle',        rarity: 'epic' },
  { id: 9,  name: 'Legend',        rarity: 'legendary' },
  { id: 10, name: 'Champion',      rarity: 'legendary' },
  { id: 11, name: 'Pepe Master',   rarity: 'common' },
  { id: 12, name: 'Brett Fan',     rarity: 'common' },
  { id: 13, name: 'Pro',           rarity: 'rare' },
  { id: 14, name: 'Institutional', rarity: 'epic' },
  { id: 15, name: 'Connector',     rarity: 'rare' },
  { id: 16, name: 'Network',       rarity: 'epic' },
]

const RARITY_COLOR: Record<Rarity, string> = {
  common:    'var(--text-dim)',
  rare:      '#4d8dff',
  epic:      '#a866ff',
  legendary: '#ffb547',
}

interface Props {
  ownedIds:  Set<number>
  baseUri?:  string
}

export function BadgeGrid({ ownedIds, baseUri }: Props) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 8,
      fontFamily: 'var(--mono)',
    }}>
      {BADGES.map(b => {
        const owned = ownedIds.has(b.id)
        const color = RARITY_COLOR[b.rarity]
        return (
          <div
            key={b.id}
            title={`${b.name} · ${b.rarity}${owned ? '' : ' (locked)'}`}
            style={{
              aspectRatio: '1',
              borderRadius: 10,
              border: `1px solid ${owned ? color : 'var(--line)'}`,
              background: owned ? `radial-gradient(circle, ${color}28, var(--surface) 70%)` : 'var(--surface)',
              backdropFilter: 'var(--glass-blur)',
              opacity: owned ? 1 : 0.4,
              filter: owned ? 'none' : 'grayscale(1)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              padding: 6,
            }}
          >
            {baseUri ? (
              <img
                src={`${baseUri}${b.id}.png`}
                alt={b.name}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                style={{ width: '60%', height: '60%', objectFit: 'contain' }}
              />
            ) : (
              <div style={{ fontSize: 24, fontWeight: 800, color }}>{b.name[0]}</div>
            )}
            <div style={{ fontSize: 9, color: 'var(--text-dim)', textAlign: 'center', letterSpacing: '.02em' }}>
              {b.name}
            </div>
          </div>
        )
      })}
    </div>
  )
}
