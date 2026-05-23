import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { checkGeo } from './lib/geocheck'
import { signalAppReady } from './lib/miniapp'
import { Markets } from './pages/Markets'
import { Market } from './pages/Market'
import { Leaderboard } from './pages/Leaderboard'
import { Portfolio } from './pages/Portfolio'
import { GenesisPage } from './pages/Genesis'
import { GeoBlock } from './components/GeoBlock'

export function App() {
  const { address, isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const [blocked, setBlocked] = useState(false)
  const [geoChecked, setGeoChecked] = useState(false)

  useEffect(() => {
    checkGeo().then(({ blocked }) => {
      setBlocked(blocked)
      setGeoChecked(true)
      // Signal the Farcaster / Base App host that the splash can dismiss.
      signalAppReady()
    })
  }, [])

  if (!geoChecked) return null
  if (blocked) return <GeoBlock />

  return (
    <BrowserRouter>
      {/* NAV */}
      <nav className="nav">
        <div className="nav-logo">⚡ MemePred</div>
        <div className="nav-links">
          <NavLink to="/" className={({isActive}) => isActive ? 'active' : ''}>
            Markets
          </NavLink>
          <NavLink to="/leaderboard" className={({isActive}) => isActive ? 'active' : ''}>
            Leaderboard
          </NavLink>
          <NavLink to="/genesis" className={({isActive}) => isActive ? 'active' : ''}>
            Genesis LP
          </NavLink>
          {isConnected && (
            <NavLink to="/portfolio" className={({isActive}) => isActive ? 'active' : ''}>
              Portfolio
            </NavLink>
          )}
        </div>
        <div>
          {isConnected ? (
            <button className="connect-btn" onClick={() => disconnect()}>
              {address?.slice(0,6)}...{address?.slice(-4)}
            </button>
          ) : (
            <button className="connect-btn" onClick={() => connect({ connector: connectors[0] })}>
              Connect
            </button>
          )}
        </div>
      </nav>

      {/* ROUTES */}
      <Routes>
        <Route path="/" element={<Markets />} />
        <Route path="/market/:address" element={<Market />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="/genesis" element={<GenesisPage />} />
      </Routes>
    </BrowserRouter>
  )
}
