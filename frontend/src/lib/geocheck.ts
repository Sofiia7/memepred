const BLOCKED_COUNTRIES = ['US', 'GB', 'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG']

export async function checkGeo(): Promise<{ blocked: boolean; country: string }> {
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL}/api/geo`)
    const { country } = await res.json()
    return {
      blocked: BLOCKED_COUNTRIES.includes(country),
      country
    }
  } catch {
    // Fail closed — block by default if geo check fails
    return { blocked: true, country: 'XX' }
  }
}
