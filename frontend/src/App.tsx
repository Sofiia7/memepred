import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { checkGeo } from './lib/geocheck'
import { signalAppReady } from './lib/miniapp'
import { Markets } from './pages/Markets'
import { Market } from './pages/Market'
import { Leaderboard } from './pages/Leaderboard'
import { Portfolio } from './pages/Portfolio'
import { GenesisPage } from './pages/Genesis'
import { GeoBlock } from './components/GeoBlock'
import { AppShell } from './components/ui/AppShell'

export function App() {
  const [blocked, setBlocked] = useState(false)
  const [geoChecked, setGeoChecked] = useState(false)

  useEffect(() => {
    checkGeo().then(({ blocked }) => {
      setBlocked(blocked)
      setGeoChecked(true)
      signalAppReady()
    })
  }, [])

  if (!geoChecked) return null
  if (blocked) return <GeoBlock />

  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<Markets />} />
          <Route path="/market/:address" element={<Market />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/genesis" element={<GenesisPage />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  )
}
