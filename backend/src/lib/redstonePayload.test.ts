import { describe, it, expect } from 'vitest'
import { buildPayload, packageBytes, recoverPackageSigner, type GatewayPackage } from './redstonePayload.js'

/**
 * A real package captured from the public gateway. Real because the only
 * meaningful test of a byte layout is whether the signature over it recovers to
 * the signer who actually made it: re-encode one field a unit differently and
 * recovery silently yields a stranger, which on-chain is an unauthorised-signer
 * revert with nothing to point at.
 */
const REAL: GatewayPackage & { signerAddress: string } = {
  dataPackageId: 'PEPE',
  timestampMilliseconds: 1787867130000,
  signature: '+IhI3i3bXY9xioMMekklEhGVNJTcP+v2ePdvnH0hGZ0CwoE/FG1+SYF4M3m0P51APR6l9SgSHOdj8Qvp6gaNgRw=',
  dataPoints: [{ dataFeedId: 'PEPE', value: 0.00000388 }],
  signerAddress: '0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202',
}

describe('packageBytes', () => {
  /**
   * 142 bytes for one data point: feedId(32) value(32) timestamp(6)
   * valueByteSize(4) pointsCount(3) signature(65). Checked against the length
   * the gateway actually produces, not against the arithmetic that produced it.
   */
  it('is 142 bytes for a single data point', () => {
    expect((packageBytes(REAL).length - 2) / 2).toBe(142)
  })

  it('starts with the feed symbol padded into a bytes32', () => {
    expect(packageBytes(REAL).slice(0, 66)).toBe(
      '0x5045504500000000000000000000000000000000000000000000000000000000',
    )
  })

  it('encodes the price at 8 decimals, in the second word', () => {
    // 0.00000388 * 1e8 = 388 = 0x184
    expect(packageBytes(REAL).slice(66, 130)).toBe(
      '0000000000000000000000000000000000000000000000000000000000000184',
    )
  })
})

describe('recoverPackageSigner', () => {
  /**
   * The whole reason this file can exist without RedStone's SDK. If our byte
   * reconstruction differs from theirs anywhere - field order, padding, the
   * decimal scaling, the hash - recovery lands on a different address and this
   * fails. It is a full check of the encoding, not just of ecrecover.
   */
  it('recovers the signer the gateway named', async () => {
    expect((await recoverPackageSigner(REAL)).toLowerCase()).toBe(REAL.signerAddress.toLowerCase())
  })

  it('recovers a different address if the price is altered by one unit', async () => {
    const tampered = { ...REAL, dataPoints: [{ dataFeedId: 'PEPE', value: 0.00000389 }] }

    expect((await recoverPackageSigner(tampered)).toLowerCase())
      .not.toBe(REAL.signerAddress.toLowerCase())
  })

  it('recovers a different address if the timestamp is altered', async () => {
    const tampered = { ...REAL, timestampMilliseconds: REAL.timestampMilliseconds + 1000 }

    expect((await recoverPackageSigner(tampered)).toLowerCase())
      .not.toBe(REAL.signerAddress.toLowerCase())
  })
})

describe('buildPayload', () => {
  it('is 440 bytes for three packages, as the gateway produces', () => {
    expect((buildPayload([REAL, REAL, REAL]).length - 2) / 2).toBe(440)
  })

  it('grows by exactly one package per signer', () => {
    const three = buildPayload([REAL, REAL, REAL]).length
    const four = buildPayload([REAL, REAL, REAL, REAL]).length

    expect((four - three) / 2).toBe(142)
  })

  /**
   * The tail is packagesCount(2), metadataSize(3), marker(9) - in that order,
   * which is not the order the field names suggest. Getting it backwards keeps
   * the payload exactly the right length and makes every offset in the
   * contract's parser wrong, surfacing as an arithmetic panic that names
   * nothing.
   */
  it('ends with count, metadata size, then the marker', () => {
    const tail = buildPayload([REAL, REAL, REAL]).slice(-28)

    expect(tail).toBe('0003' + '000000' + '000002ed57011e0000')
  })

  it('refuses to build from nothing', () => {
    expect(() => buildPayload([])).toThrow()
  })
})
