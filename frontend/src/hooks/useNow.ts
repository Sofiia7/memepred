import { useEffect, useState } from 'react'

/** Re-renders every `intervalMs` (default 1000ms). Returns unix-seconds. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function countdownFrom(closeTime: number, now: number): string {
  const secs = Math.max(0, closeTime - now)
  const m = Math.floor(secs / 60)
  const s = secs % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const mm = m % 60
    return `${h}:${mm.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
