import { describe, expect, it, vi } from 'vitest'
import { zAddress, zFeedId, zTF, zStatus, zLimit, parse } from './validate.js'

describe('zAddress', () => {
  it('accepts a valid checksum-agnostic address and lowercases it', () => {
    const r = zAddress.safeParse('0xABCDEF0123456789ABCDEF0123456789ABCDEF01')
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toBe('0xabcdef0123456789abcdef0123456789abcdef01')
  })

  it.each([
    'not-an-address',
    '0x123', // too short
    '0xABCDEF0123456789ABCDEF0123456789ABCDEF0123', // too long
    '1234567890123456789012345678901234567890', // missing 0x prefix
  ])('rejects %s', (input) => {
    expect(zAddress.safeParse(input).success).toBe(false)
  })
})

describe('zFeedId', () => {
  it('accepts a 32-byte hex id (0x + 64 hex chars)', () => {
    const valid = '0x' + 'a'.repeat(64)
    expect(zFeedId.safeParse(valid).success).toBe(true)
  })

  it('rejects an address-length (20-byte) value', () => {
    const tooShort = '0x' + 'a'.repeat(40)
    expect(zFeedId.safeParse(tooShort).success).toBe(false)
  })
})

describe('zTF', () => {
  it.each(['5m', '15m', '1h', '4h', '1d'])('accepts %s', (tf) => {
    expect(zTF.safeParse(tf).success).toBe(true)
  })

  it('rejects an arbitrary string', () => {
    expect(zTF.safeParse('30m').success).toBe(false)
  })
})

describe('zStatus', () => {
  it.each(['OPEN', 'CLOSED', 'RESOLVED', 'REFUNDED'])('accepts %s', (status) => {
    expect(zStatus.safeParse(status).success).toBe(true)
  })

  // This assertion used to read `.toBe(false)`, locking in a real bug: the
  // keeper writes 'CLOSED' into markets.status itself (marketCreator.ts
  // closeExpiredMarkets), so the API was rejecting a value it had stored, and
  // `?status=CLOSED` returned a 400 rather than the closed markets.
  it('accepts every status the backend is capable of writing', () => {
    expect(zStatus.safeParse('CLOSED').success).toBe(true)
  })

  it('rejects a lowercase or unknown status', () => {
    expect(zStatus.safeParse('open').success).toBe(false)
    expect(zStatus.safeParse('SETTLED').success).toBe(false)
  })
})

describe('zLimit', () => {
  it('defaults to 100 when absent', () => {
    const r = zLimit.safeParse(undefined)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toBe(100)
  })

  it('coerces numeric strings from query params', () => {
    const r = zLimit.safeParse('42')
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toBe(42)
  })

  it('rejects 0 and values above the 500 cap', () => {
    expect(zLimit.safeParse(0).success).toBe(false)
    expect(zLimit.safeParse(501).success).toBe(false)
  })
})

describe('parse()', () => {
  function mockReply() {
    const reply: any = {}
    reply.status = vi.fn().mockReturnValue(reply)
    reply.send = vi.fn().mockReturnValue(reply)
    return reply
  }

  it('returns the parsed data on success without touching reply', () => {
    const reply = mockReply()
    const result = parse(zLimit, '10', reply)
    expect(result).toBe(10)
    expect(reply.status).not.toHaveBeenCalled()
  })

  it('sends a 400 with validation_failed and returns null on failure', () => {
    const reply = mockReply()
    const result = parse(zAddress, 'garbage', reply)
    expect(result).toBeNull()
    expect(reply.status).toHaveBeenCalledWith(400)
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'validation_failed' }),
    )
  })
})
