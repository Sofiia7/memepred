import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { checkGeo } from './lib/geocheck'
import { signalAppReady } from './lib/miniapp'
import { captureReferralCode } from './lib/referral'
import { Markets } from './pages/Markets'
import { Market } from './pages/Market'
import { OrderPage } from './pages/Order'
import { Leaderboard } from './pages/Leaderboard'
import { Portfolio } from './pages/Portfolio'
import { GenesisPage } from './pages/Genesis'
import { ReferPage } from './pages/Refer'
import { HowItWorksPage } from './pages/HowItWorks'
import { TermsPage } from './pages/Terms'
import { GeoBlock } from './components/GeoBlock'
import { AppShell } from './components/ui/AppShell'

export function App() {
  const [blocked, setBlocked] = useState(false)
  const [geoChecked, setGeoChecked] = useState(false)

  useEffect(() => {
    captureReferralCode()
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
          <Route path="/order/:address/:orderId" element={<OrderPage />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/genesis" element={<GenesisPage />} />
          <Route path="/refer" element={<ReferPage />} />
          <Route path="/how-it-works" element={<HowItWorksPage />} />
          <Route path="/terms" element={<TermsPage />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  )
}
