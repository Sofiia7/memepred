import { NavLink } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { MarketsIcon, TrophyIcon, StarIcon, WalletIcon, PoolsIcon } from './icons'
import { IS_POOL_BACKED } from '../../lib/contracts'
import { ROUNDS_ENABLED } from '../../rounds/flag'
import { RoundsIcon } from '../../rounds/RoundsIcon'

export function TabNav() {
  const { isConnected } = useAccount()
  const roundsFirst = IS_POOL_BACKED && ROUNDS_ENABLED
  const tabs: { to: string; label: string; ico: JSX.Element; end?: boolean }[] = roundsFirst
    ? [
        { to: '/rounds', label: 'ROUNDS', ico: <RoundsIcon /> },
        { to: '/markets', label: 'LEGACY', ico: <MarketsIcon /> },
        { to: '/leaderboard', label: 'LEADERS', ico: <TrophyIcon /> },
      ]
    : [
        { to: '/', label: 'MARKETS', ico: <MarketsIcon />, end: true },
        { to: '/leaderboard', label: 'LEADERS', ico: <TrophyIcon /> },
      ]
  // Only where a market is backed by a pool. On a feed-priced deployment the
  // list is three whitelisted symbols and there is nothing to browse.
  if (IS_POOL_BACKED) tabs.splice(1, 0, { to: '/pools', label: 'POOLS', ico: <PoolsIcon /> })
  else tabs.push({ to: '/genesis', label: 'GENESIS', ico: <StarIcon /> })
  // Only in builds that turn the rounds screen on (VITE_ROUNDS_ENABLED=1); otherwise the tabs are unchanged.
  if (ROUNDS_ENABLED && !roundsFirst) tabs.splice(1, 0, { to: '/rounds', label: 'ROUNDS', ico: <RoundsIcon /> })
  if (isConnected) tabs.push({ to: '/portfolio', label: 'PORTFOLIO', ico: <WalletIcon /> })

  return (
    <nav className="tabnav" style={{ ['--tabs' as any]: tabs.length }}>
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'on' : '')}>
          <span className="tab-ico">{t.ico}</span>
          <span>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
