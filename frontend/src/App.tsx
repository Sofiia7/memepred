import { useEffect } from 'react'
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom'
import { signalAppReady } from './lib/miniapp'
import { captureReferralCode } from './lib/referral'
import { Markets } from './pages/Markets'
import { Pools } from './pages/Pools'
import { Market } from './pages/Market'
import { OrderPage } from './pages/Order'
import { Leaderboard } from './pages/Leaderboard'
import { Portfolio } from './pages/Portfolio'
import { GenesisPage } from './pages/Genesis'
import { ReferPage } from './pages/Refer'
import { HowItWorksPage } from './pages/HowItWorks'
import { TermsPage } from './pages/Terms'
import { GeoGate } from './components/GeoGate'
import { RiskGate } from './components/RiskDisclosure'
import { AppShell } from './components/ui/AppShell'
import { IS_POOL_BACKED } from './lib/contracts'

export function App() {
  useEffect(() => {
    captureReferralCode()
  }, [])

  return (
    // GeoGate shows "Checking your region..." while the check is in flight,
    // REGION BLOCKED for a country on the list, and "Could not verify your
    // region" (with Retry) when the check itself failed. Only "allowed" mounts
    // anything below it. The Mini App host is told we are ready as soon as the
    // check has produced any screen, so its splash never outlives the 8 s
    // deadline.
    <GeoGate onSettled={() => void signalAppReady()}>
    <BrowserRouter>
      {/* RiskGate sits inside the router (it links to /terms and reads the
          path) but outside AppShell, so the unaudited-contracts notice is the
          entire screen on first visit rather than a banner competing with live
          markets. /terms and /how-it-works are the two routes it lets through
          before acknowledgement, and there they render inside AppShell. */}
      <RiskGate>
      <AppShell>
        <Routes>
          <Route path="/" element={<Markets />} />
          <Route path="/pools" element={<Pools />} />
          <Route path="/market/:address" element={<Market />} />
          <Route path="/order/:address/:orderId" element={<OrderPage />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/genesis" element={IS_POOL_BACKED ? <Navigate to="/pools" replace /> : <GenesisPage />} />
          <Route path="/refer" element={<ReferPage />} />
          <Route path="/how-it-works" element={<HowItWorksPage />} />
          <Route path="/terms" element={<TermsPage />} />
        </Routes>
      </AppShell>
      </RiskGate>
    </BrowserRouter>
    </GeoGate>
  )
}
