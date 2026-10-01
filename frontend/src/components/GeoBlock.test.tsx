import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

/**
 * The REGION BLOCKED screen names the countries this build does not serve. A
 * build that has switched the whole restricted list off must stop naming
 * them: the sentence would otherwise be a written claim the edge no longer
 * enforces. The list is read from the environment when the module loads, so
 * each case loads the component fresh.
 */
async function loadGeoBlock() {
  vi.resetModules()
  return (await import('./GeoBlock')).GeoBlock
}

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('GeoBlock, the countries it names', () => {
  it('with nothing opened, names the restricted jurisdictions and the sanctioned countries', async () => {
    vi.stubEnv('VITE_GEO_OPEN_ALL_RESTRICTED', '0')
    vi.stubEnv('VITE_GEO_OPEN_COUNTRIES', '')
    const GeoBlock = await loadGeoBlock()
    render(<GeoBlock />)
    expect(document.body.textContent).toContain(
      'that includes the US, UK, Canada, Australia, Japan, Singapore, France, Germany and the Netherlands, alongside comprehensively sanctioned countries.',
    )
  })

  it('with the whole restricted list switched off, names only the sanctioned countries', async () => {
    vi.stubEnv('VITE_GEO_OPEN_ALL_RESTRICTED', '1')
    const GeoBlock = await loadGeoBlock()
    render(<GeoBlock />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('On this testnet preview only comprehensively sanctioned countries are excluded.')
    for (const name of ['Canada', 'Japan', 'Singapore', 'Germany', 'the Netherlands']) expect(text).not.toContain(name)
  })
})
