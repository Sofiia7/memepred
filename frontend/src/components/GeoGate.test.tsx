import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { GeoResult } from '../lib/geocheck'

vi.mock('../lib/geocheck', () => ({ checkGeo: vi.fn() }))
import { checkGeo } from '../lib/geocheck'
import { GeoGate } from './GeoGate'

/**
 * Three screens for three different facts:
 *
 *   still asking        "Checking your region..."      (was a blank page, with no deadline)
 *   country excluded    REGION BLOCKED                 (unchanged)
 *   could not ask       "Could not verify your region" (was REGION BLOCKED, a false claim
 *                                                       about the visitor's country)
 *
 * and only one of them opens the app.
 */

const mocked = vi.mocked(checkGeo)

/** A check the test resolves by hand, so the in-between state is observable. */
function pendingCheck() {
  let resolve!: (r: GeoResult) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<GeoResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let mounted = 0
function Probe() {
  mounted += 1
  return <div data-testid="app">the app</div>
}

const settle = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  mocked.mockReset()
  mounted = 0
})
afterEach(cleanup)

describe('GeoGate', () => {
  it('shows a checking state, not a blank page, while the check is in flight', () => {
    mocked.mockReturnValue(pendingCheck().promise)
    render(<GeoGate><Probe /></GeoGate>)

    expect(screen.getByRole('status').textContent).toBe('Checking your region...')
    expect(screen.queryByTestId('app')).toBeNull()
  })

  it('opens the app only for an allowed result', async () => {
    const check = pendingCheck()
    mocked.mockReturnValue(check.promise)
    render(<GeoGate><Probe /></GeoGate>)
    expect(mounted).toBe(0)

    check.resolve({ status: 'allowed', country: 'ES' })
    await settle()

    expect(screen.getByTestId('app')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('mounts nothing behind it in any other state', async () => {
    const check = pendingCheck()
    mocked.mockReturnValue(check.promise)
    render(<GeoGate><Probe /></GeoGate>)
    check.resolve({ status: 'unverified', country: 'XX' })
    await settle()
    expect(mounted).toBe(0)
  })

  it('shows REGION BLOCKED for a blocked country, with nothing to retry', async () => {
    mocked.mockResolvedValue({ status: 'blocked', country: 'DE' })
    render(<GeoGate><Probe /></GeoGate>)
    await settle()

    expect(screen.getByText('REGION BLOCKED')).toBeTruthy()
    expect(screen.queryByTestId('app')).toBeNull()
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
    expect(screen.queryByText('Could not verify your region')).toBeNull()
  })

  it('says it could not verify, and offers Retry, when the check failed - and does not say the region is blocked', async () => {
    mocked.mockResolvedValue({ status: 'unverified', country: 'XX' })
    render(<GeoGate><Probe /></GeoGate>)
    await settle()

    expect(screen.getByText('Could not verify your region')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByText('REGION BLOCKED')).toBeNull()
    expect(screen.queryByTestId('app')).toBeNull()
    // It also must not imply anything about the visitor's country.
    expect(document.body.textContent).toContain('not a decision about your country')
  })

  it('treats a check that throws as unverified rather than leaving the page on "Checking"', async () => {
    mocked.mockRejectedValue(new Error('boom'))
    render(<GeoGate><Probe /></GeoGate>)
    await settle()

    expect(screen.getByText('Could not verify your region')).toBeTruthy()
  })

  it('Retry runs the check again, shows the checking state, and opens the app if it now passes', async () => {
    mocked.mockResolvedValueOnce({ status: 'unverified', country: 'XX' })
    render(<GeoGate><Probe /></GeoGate>)
    await settle()
    expect(mocked).toHaveBeenCalledTimes(1)

    const second = pendingCheck()
    mocked.mockReturnValueOnce(second.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()

    expect(mocked).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status').textContent).toBe('Checking your region...')
    expect(screen.queryByText('Could not verify your region')).toBeNull()

    second.resolve({ status: 'allowed', country: 'ES' })
    await settle()
    expect(screen.getByTestId('app')).toBeTruthy()
  })

  it('a retry that is blocked shows REGION BLOCKED', async () => {
    mocked.mockResolvedValueOnce({ status: 'unverified', country: 'XX' })
    render(<GeoGate><Probe /></GeoGate>)
    await settle()

    mocked.mockResolvedValueOnce({ status: 'blocked', country: 'US' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()

    expect(screen.getByText('REGION BLOCKED')).toBeTruthy()
  })

  it('calls onSettled once per finished check, with its result', async () => {
    const onSettled = vi.fn()
    mocked.mockResolvedValueOnce({ status: 'unverified', country: 'XX' })
    render(<GeoGate onSettled={onSettled}><Probe /></GeoGate>)
    expect(onSettled).not.toHaveBeenCalled()
    await settle()
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenLastCalledWith({ status: 'unverified', country: 'XX' })

    mocked.mockResolvedValueOnce({ status: 'allowed', country: 'ES' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(onSettled).toHaveBeenCalledTimes(2)
  })

  it('does not restart the check when only onSettled changes identity', async () => {
    mocked.mockResolvedValue({ status: 'allowed', country: 'ES' })
    const { rerender } = render(<GeoGate onSettled={() => {}}><Probe /></GeoGate>)
    await settle()
    rerender(<GeoGate onSettled={() => {}}><Probe /></GeoGate>)
    await settle()
    expect(mocked).toHaveBeenCalledTimes(1)
  })
})
