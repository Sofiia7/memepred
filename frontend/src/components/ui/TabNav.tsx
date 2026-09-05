import { NavLink } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { MarketsIcon, TrophyIcon, StarIcon, WalletIcon, PoolsIcon } from './icons'
import { IS_POOL_BACKED } from '../../lib/contracts'

export function TabNav() {
  const { isConnected } = useAccount()
  const tabs: { to: string; label: string; ico: JSX.Element; end?: boolean }[] = [
    { to: '/', label: 'MARKETS', ico: <MarketsIcon />, end: true },
    { to: '/leaderboard', label: 'LEADERS', ico: <TrophyIcon /> },
    { to: '/genesis', label: 'GENESIS', ico: <StarIcon /> },
  ]
  // Only where a market is backed by a pool. On a feed-priced deployment the
  // list is three whitelisted symbols and there is nothing to browse.
  if (IS_POOL_BACKED) tabs.splice(1, 0, { to: '/pools', label: 'POOLS', ico: <PoolsIcon /> })
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
