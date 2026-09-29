import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { blockedFor, isGeoExempt } from '../../../workers/geo-block'
import {
  OFAC_CODES,
  OPENABLE_CODES,
  RESTRICTED_CODES,
  blockedCodes,
  joinList,
  parseOpenCountries,
  restrictedNames,
} from './restrictedRegions'

/**
 * The Worker decides what is enforced; the page mirrors it for the fallback and
 * for the words it shows. These tests import the Worker itself, so the mirror
 * cannot drift from it without a red build. Which countries are on either list
 * is a legal decision, and a change to one has to be a change to this file too.
 */

const sorted = (xs: Iterable<string>) => [...xs].sort()

describe('the Worker and the page agree on what is blocked', () => {
  it('with nothing opened, both block exactly the full list', () => {
    expect(sorted(blockedFor({}))).toEqual(sorted(blockedCodes(new Set())))
    expect(sorted(blockedFor({}))).toEqual(sorted([...OFAC_CODES, ...RESTRICTED_CODES]))
  })

  it.each([
    'SG',
    'sg',
    ' SG , jp ',
    'GB,FR,DE,NL,CA,AU,JP,SG',
    'IR',
    'US',
    'T1',
    'PR,GU,VI,AS,MP,UM',
    'xx,,SG',
    '',
  ])('opening %j gives the same set on both sides', (raw) => {
    expect(sorted(blockedFor({ GEO_OPEN_COUNTRIES: raw }))).toEqual(
      sorted(blockedCodes(parseOpenCountries(raw))),
    )
  })

  it('opens Singapore and nothing else when told to open Singapore', () => {
    const rhc = blockedFor({ GEO_OPEN_COUNTRIES: 'SG' })
    expect(rhc.has('SG')).toBe(false)
    expect(sorted(rhc)).toEqual(sorted([...OFAC_CODES, ...RESTRICTED_CODES].filter((c) => c !== 'SG')))
  })

  it('never opens an OFAC country, whatever the setting says', () => {
    const all = OFAC_CODES.join(',')
    for (const c of OFAC_CODES) {
      expect(blockedFor({ GEO_OPEN_COUNTRIES: all }).has(c)).toBe(true)
      expect(blockedCodes(parseOpenCountries(all))).toContain(c)
    }
  })

  it('never opens the U.S., its territories or Tor, whatever the setting says', () => {
    const notOpenable = ['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'T1']
    const raw = notOpenable.join(',')
    for (const c of notOpenable) {
      expect(blockedFor({ GEO_OPEN_COUNTRIES: raw }).has(c)).toBe(true)
      expect(blockedCodes(parseOpenCountries(raw))).toContain(c)
    }
  })

  it('a code is openable on the Worker exactly when it is in OPENABLE_CODES', () => {
    for (const c of RESTRICTED_CODES) {
      const openedOnWorker = !blockedFor({ GEO_OPEN_COUNTRIES: c }).has(c)
      expect(openedOnWorker).toBe((OPENABLE_CODES as readonly string[]).includes(c))
    }
  })
})

describe('the lists in the page are the lists in the Worker source', () => {
  /** The quoted two-character codes of one array literal, comments stripped. */
  function codesOf(source: string, name: string): string[] {
    const start = source.indexOf(`const ${name} = [`)
    expect(start, `${name} not found in workers/geo-block.ts`).toBeGreaterThan(-1)
    const end = source.indexOf('\n]', start)
    const body = source
      .slice(start, end)
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    return [...body.matchAll(/'([A-Z][A-Z0-9])'/g)].map((m) => m[1])
  }

  const source = readFileSync(
    // vitest runs from frontend/, the same way networkHead.test.ts finds index.html
    resolve(process.cwd(), '../workers/geo-block.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n')

  it('OFAC list', () => {
    expect(codesOf(source, 'OFAC_SANCTIONED')).toEqual([...OFAC_CODES])
  })

  it('restricted jurisdictions, in the same order', () => {
    expect(codesOf(source, 'RESTRICTED_JURISDICTIONS')).toEqual([...RESTRICTED_CODES])
  })
})

describe('the words the page shows', () => {
  it('with nothing opened, the banners and the Terms read exactly as they always did', () => {
    expect(joinList(restrictedNames('short', new Set()), 'and')).toBe(
      'the US, UK, Canada, Australia, Japan, Singapore, France, Germany and the Netherlands',
    )
    expect(restrictedNames('short', new Set()).join(', ')).toBe(
      'the US, UK, Canada, Australia, Japan, Singapore, France, Germany, the Netherlands',
    )
    expect(joinList(restrictedNames('long', new Set()), 'and', true)).toBe(
      'the United States (including Puerto Rico, Guam, the U.S. Virgin Islands, American Samoa, the Northern Mariana Islands), the United Kingdom, France, Germany, the Netherlands, Canada, Australia, Japan, and Singapore',
    )
  })

  it('a country the deployment opened is no longer named as restricted', () => {
    const open = new Set(['SG'])
    expect(restrictedNames('short', open)).not.toContain('Singapore')
    expect(restrictedNames('long', open)).not.toContain('Singapore')
    expect(joinList(restrictedNames('long', open), 'and', true)).toContain('Canada, Australia, and Japan')
    // ...and nothing else went missing with it.
    expect(restrictedNames('short', open)).toHaveLength(restrictedNames('short', new Set()).length - 1)
    expect(restrictedNames('long', open)).toHaveLength(restrictedNames('long', new Set()).length - 1)
  })

  it('every country the copy names is on the restricted list', () => {
    // A name in the copy with no code behind it would be a claim nobody enforces.
    const named = ['US', 'GB', 'CA', 'AU', 'JP', 'SG', 'FR', 'DE', 'NL']
    for (const c of named) expect(RESTRICTED_CODES as readonly string[]).toContain(c)
  })

  it('joinList handles every length', () => {
    expect(joinList([], 'and')).toBe('')
    expect(joinList(['a'], 'and')).toBe('a')
    expect(joinList(['a', 'b'], 'and')).toBe('a and b')
    expect(joinList(['a', 'b', 'c'], 'and')).toBe('a, b and c')
    expect(joinList(['a', 'b', 'c'], 'or', true)).toBe('a, b, or c')
  })
})

describe('what a blocked country can still reach at the edge', () => {
  it('the liveness probes and the certificate challenge path', () => {
    for (const p of ['/health', '/health/deep', '/health/edge']) expect(isGeoExempt(p)).toBe(true)
    // The CA's validators are in blocked countries; a 451 here means no certificate.
    expect(isGeoExempt('/.well-known/acme-challenge/kZap8YVPgSYwYjhzj8pyuvSos9aH-IZIMEOuragY9Jw')).toBe(true)
  })

  it('nothing else, not even its neighbours', () => {
    for (const p of [
      '/',
      '/api/markets',
      '/api/geo',
      '/api/geo/config',
      '/.well-known/security.txt',
      '/.well-known/acme-challenge', // no token: not a challenge
      '/x/.well-known/acme-challenge/token', // not at the root
      '/health/deeper',
    ]) {
      expect(isGeoExempt(p), p).toBe(false)
    }
  })
})
