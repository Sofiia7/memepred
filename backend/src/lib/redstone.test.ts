import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  feedIdToBytes32,
  selectAuthorisedPackages,
  withPayload,
  fetchPayload,
  AUTHORISED_SIGNERS,
  SIGNERS_REQUIRED,
} from './redstone.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('feedIdToBytes32', () => {
  /**
   * RedStone identifies feeds by their symbol, right-padded into a bytes32 -
   * not by a hash the way Pyth did. Getting this wrong does not fail loudly:
   * the contract simply finds no matching data point in the payload and the
   * call reverts with nothing useful in it.
   */
  it('right-pads the symbol, as the contracts expect', () => {
    expect(feedIdToBytes32('PEPE')).toBe(
      '0x5045504500000000000000000000000000000000000000000000000000000000',
    )
  })

  it('is 32 bytes for every feed we run', () => {
    for (const symbol of ['PEPE', 'DOGE', 'BRETT']) {
      expect(feedIdToBytes32(symbol)).toMatch(/^0x[0-9a-f]{64}$/)
    }
  })

  it('keeps distinct feeds distinct', () => {
    expect(feedIdToBytes32('PEPE')).not.toBe(feedIdToBytes32('DOGE'))
  })
})

describe('selectAuthorisedPackages', () => {
  const pkg = (signer: string) => ({ signerAddress: signer, dataPoints: [], timestampMilliseconds: 1 })

  it('keeps only packages signed by an authorised signer', () => {
    const kept = selectAuthorisedPackages(
      [pkg(AUTHORISED_SIGNERS[0]), pkg('0x' + 'ff'.repeat(20)), pkg(AUTHORISED_SIGNERS[1])],
      (p) => p.signerAddress,
      2,
    )

    expect(kept).toHaveLength(2)
  })

  it('matches signers regardless of address casing', () => {
    const kept = selectAuthorisedPackages(
      [pkg(AUTHORISED_SIGNERS[0].toLowerCase()), pkg(AUTHORISED_SIGNERS[1].toUpperCase())],
      (p) => p.signerAddress,
      2,
    )

    expect(kept).toHaveLength(2)
  })

  /**
   * The contract needs three of five. Sending fewer wastes a transaction to
   * discover a revert, and sending unauthorised ones wastes it in a way that
   * looks like the gateway is fine.
   */
  it('refuses to build from fewer signers than the contract requires', () => {
    expect(() =>
      selectAuthorisedPackages([pkg(AUTHORISED_SIGNERS[0])], (p) => p.signerAddress, 3),
    ).toThrow(/signer/i)
  })

  it('takes exactly as many as asked for, not all of them', () => {
    const all = AUTHORISED_SIGNERS.map(pkg)

    expect(selectAuthorisedPackages(all, (p) => p.signerAddress, 3)).toHaveLength(3)
  })
})

describe('withPayload', () => {
  it('appends the payload to the encoded call', () => {
    expect(withPayload('0xdeadbeef', '0xcafe')).toBe('0xdeadbeefcafe')
  })

  it('accepts a payload that is not 0x-prefixed', () => {
    expect(withPayload('0xdeadbeef', 'cafe' as `0x${string}`)).toBe('0xdeadbeefcafe')
  })

  it('leaves the selector at the front, where the node expects it', () => {
    expect(withPayload('0xdeadbeef', '0xcafe').slice(0, 10)).toBe('0xdeadbeef')
  })
})

describe('fetchPayload', () => {
  const gatewayResponse = (feed: string) => ({
    [feed]: AUTHORISED_SIGNERS.map((s) => ({
      signerAddress: s,
      dataPackageId: feed,
      timestampMilliseconds: 1_787_853_570_000,
      dataPoints: [{ dataFeedId: feed, value: 0.00000392 }],
      signature: 'AA==',
    })),
  })

  /**
   * No credential of any kind. This is the entire reason the protocol is on
   * RedStone rather than paying Pyth $500 a month, so if a key ever creeps in
   * here the migration's premise has quietly changed.
   */
  it('asks the gateway without any authorization header', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(gatewayResponse('PEPE'))))
    vi.stubGlobal('fetch', spy)

    await fetchPayload('PEPE').catch(() => {})

    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit | undefined]
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization')
  })

  it('reports a gateway failure with its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))

    await expect(fetchPayload('PEPE')).rejects.toThrow(/503/)
  })

  it('says which feed was missing rather than failing anonymously', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ DOGE: [] }))))

    await expect(fetchPayload('PEPE')).rejects.toThrow(/PEPE/)
  })

  /**
   * Any package we cannot attribute to an authorised signer must not become a
   * payload. Two things can go wrong here and both are the same answer: the
   * signature recovers to a stranger, or it does not recover at all. The
   * threshold logic itself is pinned directly in the selectAuthorisedPackages
   * tests above, where a signer can be stated rather than signed for.
   */
  it('refuses to build a payload from packages it cannot attribute', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ PEPE: [{ signerAddress: '0x' + 'ff'.repeat(20) }] })),
    ))

    await expect(fetchPayload('PEPE')).rejects.toThrow()
  })
})

describe('constants', () => {
  /// Mirrors PrimaryProdDataServiceConsumerBase. A drift here means every
  /// transaction we send is rejected on-chain.
  it('carries the five signers the contracts authorise', () => {
    expect(AUTHORISED_SIGNERS).toHaveLength(5)
    for (const s of AUTHORISED_SIGNERS) expect(s).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('requires the same three-of-five the contracts do', () => {
    expect(SIGNERS_REQUIRED).toBe(3)
  })
})
