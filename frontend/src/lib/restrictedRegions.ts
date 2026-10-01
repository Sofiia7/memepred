/**
 * The countries this build treats as restricted, and how it names them to a
 * visitor.
 *
 * Until now the list was typed out in four places (the fallback in geocheck,
 * GeoBlock, RiskDisclosure and Terms). That is how opening one country for one
 * deployment would have left it named as blocked in the page copy, a written
 * statement contradicted by what the edge does. Everything that names a country
 * now reads it from here.
 *
 * `workers/geo-block.ts` stays the authority: its blockedFor() decides what is
 * enforced, and /api/geo/config serves that set to the page. This module mirrors
 * it for the two things the Worker cannot supply (the fallback when the Worker
 * is unreachable, and the display names), and restrictedRegions.test.ts imports
 * the Worker and fails if the two ever disagree.
 *
 * VITE_GEO_OPEN_COUNTRIES is the frontend half of the Worker's
 * GEO_OPEN_COUNTRIES for the same deployment: the same codes, on both sides, or
 * the page and the edge tell different stories. Unset means the full list.
 *
 * VITE_GEO_OPEN_ALL_RESTRICTED=1 is the frontend half of the Worker's
 * GEO_OPEN_ALL_RESTRICTED: the whole restricted list is off on that deployment
 * (a testnet demo), and the copy names no country as restricted. The OFAC
 * countries stay blocked on both sides whatever is open.
 */

/** Comprehensively sanctioned (OFAC). Never openable by configuration. */
export const OFAC_CODES = ['CU', 'IR', 'KP', 'SY'] as const

/** Restricted jurisdictions, in the same order as the Worker's list. */
export const RESTRICTED_CODES = [
  'US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM',
  'GB', 'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG',
  'T1',
] as const

/**
 * The only restricted jurisdictions a deployment may open. The U.S. and its
 * territories and Tor ('T1') are not here, exactly as in the Worker.
 */
export const OPENABLE_CODES = ['GB', 'FR', 'DE', 'NL', 'CA', 'AU', 'JP', 'SG'] as const

/** Parse the comma-separated setting, keeping only countries that may be opened. */
export function parseOpenCountries(raw: string | null | undefined): Set<string> {
  const openable = new Set<string>(OPENABLE_CODES)
  return new Set(
    (raw ?? '')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => openable.has(c)),
  )
}

/**
 * Every restricted jurisdiction, the U.S. and Tor included: the set a build
 * has opened when its whole restricted list is switched off. OFAC_CODES are
 * never in it, so blockedCodes() keeps them.
 */
export function allRestrictedOpen(): Set<string> {
  return new Set<string>(RESTRICTED_CODES)
}

/** Exactly "1" switches the whole restricted list off for this build; anything else does not. */
export const OPEN_ALL_RESTRICTED: boolean = import.meta.env.VITE_GEO_OPEN_ALL_RESTRICTED === '1'

/** The countries this build has opened. Read once, at build time. */
export const OPEN_COUNTRIES: ReadonlySet<string> = OPEN_ALL_RESTRICTED
  ? allRestrictedOpen()
  : parseOpenCountries(import.meta.env.VITE_GEO_OPEN_COUNTRIES)

/** Every code this build blocks: the whole OFAC list plus the restricted ones not opened. */
export function blockedCodes(open: ReadonlySet<string> = OPEN_COUNTRIES): string[] {
  return [...OFAC_CODES, ...RESTRICTED_CODES.filter((c) => !open.has(c))]
}

// [code, name] in the order each piece of copy has always used.
const SHORT_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['US', 'the US'],
  ['GB', 'UK'],
  ['CA', 'Canada'],
  ['AU', 'Australia'],
  ['JP', 'Japan'],
  ['SG', 'Singapore'],
  ['FR', 'France'],
  ['DE', 'Germany'],
  ['NL', 'the Netherlands'],
]

const LONG_NAMES: ReadonlyArray<readonly [string, string]> = [
  [
    'US',
    'the United States (including Puerto Rico, Guam, the U.S. Virgin Islands, American Samoa, the Northern Mariana Islands)',
  ],
  ['GB', 'the United Kingdom'],
  ['FR', 'France'],
  ['DE', 'Germany'],
  ['NL', 'the Netherlands'],
  ['CA', 'Canada'],
  ['AU', 'Australia'],
  ['JP', 'Japan'],
  ['SG', 'Singapore'],
]

/**
 * The restricted jurisdictions to name in copy, minus any this build opened.
 * `short` is for banners, `long` is for the Terms.
 */
export function restrictedNames(
  style: 'short' | 'long',
  open: ReadonlySet<string> = OPEN_COUNTRIES,
): string[] {
  return (style === 'short' ? SHORT_NAMES : LONG_NAMES)
    .filter(([code]) => !open.has(code))
    .map(([, name]) => name)
}

/** "a", "a and b", "a, b and c", or with the serial comma "a, b, and c". */
export function joinList(items: readonly string[], conjunction: 'and' | 'or', serialComma = false): string {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`
  const head = items.slice(0, -1).join(', ')
  return `${head}${serialComma ? ',' : ''} ${conjunction} ${items[items.length - 1]}`
}
