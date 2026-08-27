import { describe, it, expect } from 'vitest'
import { makeClientKey } from './clientKey.js'

const SECRET = 'worker-secret-value'
const key = makeClientKey(SECRET)

const req = (headers: Record<string, string | string[] | undefined>, ip = '172.18.0.5') =>
  ({ ip, headers })

describe('makeClientKey', () => {
  it('uses the real client address when the request came through the Worker', () => {
    expect(key(req({ 'x-worker-secret': SECRET, 'cf-connecting-ip': '203.0.113.9' })))
      .toBe('203.0.113.9')
  })

  it('gives two visitors behind the same proxy different keys', () => {
    const a = key(req({ 'x-worker-secret': SECRET, 'cf-connecting-ip': '203.0.113.9' }))
    const b = key(req({ 'x-worker-secret': SECRET, 'cf-connecting-ip': '198.51.100.4' }))
    expect(a).not.toBe(b)
  })

  // The bug this whole module exists to fix: without it, both of the above
  // collapse to the Caddy container's address and share one budget.
  it('does not collapse every caller onto the socket peer', () => {
    const socketIp = '172.18.0.5'
    expect(key(req({ 'x-worker-secret': SECRET, 'cf-connecting-ip': '203.0.113.9' }, socketIp)))
      .not.toBe(socketIp)
  })

  it('ignores a forged CF-Connecting-IP when the Worker secret is absent', () => {
    expect(key(req({ 'cf-connecting-ip': '203.0.113.9' })))
      .toBe('172.18.0.5')
  })

  it('ignores a forged CF-Connecting-IP when the Worker secret is wrong', () => {
    expect(key(req({ 'x-worker-secret': 'nope', 'cf-connecting-ip': '203.0.113.9' })))
      .toBe('172.18.0.5')
  })

  it('falls back to the socket peer when the Worker sends no client address', () => {
    expect(key(req({ 'x-worker-secret': SECRET }))).toBe('172.18.0.5')
  })

  it('ignores an array-valued header rather than keying on its stringification', () => {
    expect(key(req({ 'x-worker-secret': SECRET, 'cf-connecting-ip': ['203.0.113.9', 'x'] })))
      .toBe('172.18.0.5')
  })

  it('trusts nothing when the deployment has no worker secret configured', () => {
    const noSecret = makeClientKey(undefined)
    expect(noSecret(req({ 'x-worker-secret': '', 'cf-connecting-ip': '203.0.113.9' })))
      .toBe('172.18.0.5')
    const emptySecret = makeClientKey('')
    expect(emptySecret(req({ 'x-worker-secret': '', 'cf-connecting-ip': '203.0.113.9' })))
      .toBe('172.18.0.5')
  })
})
