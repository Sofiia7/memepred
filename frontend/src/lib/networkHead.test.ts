import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyNetworkHead, isRhcNetwork, resolveSiteUrl } from '../../vite-plugins/networkHead.mjs'

/**
 * The <head> of a Robinhood Chain build (audit section 5: "on Base. Bet USDC",
 * a PNG declared as an SVG, Farcaster Mini App tags on every build).
 *
 * The input is the real frontend/index.html, so an edit to that file that the
 * rewrite no longer matches fails here (and fails the RHC build) instead of
 * shipping an unrewritten head.
 */

// Tests run from frontend/ (that is where vitest.config.ts lives), which is where index.html is.
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
const SITE = 'https://rhc.example.test'

const testnet = (over: Record<string, string | undefined> = {}) =>
  applyNetworkHead(html, { VITE_NETWORK: 'rhc-testnet', VITE_SITE_URL: SITE, ...over })

/** The <head> only, so the checks are about what a link preview or a browser tab reads. */
const head = (s: string) => s.slice(s.indexOf('<head>'), s.indexOf('</head>'))

describe('Base builds are untouched, byte for byte', () => {
  it('returns the very same string for every network that is not Robinhood Chain', () => {
    for (const network of ['mainnet', 'sepolia', 'MAINNET', undefined, '', 'staging']) {
      expect(applyNetworkHead(html, { VITE_NETWORK: network, VITE_SITE_URL: SITE })).toBe(html)
    }
    expect(applyNetworkHead(html)).toBe(html)
    expect(applyNetworkHead(html, {})).toBe(html)
  })

  it('is guarding the real Base head: it still says what the audit found', () => {
    expect(html).toContain('on Base. Bet USDC')
    expect(html).toContain('type="image/svg+xml" href="/icon.png"')
    expect(html).toContain('fc:miniapp')
  })
})

describe('the Robinhood Chain testnet head', () => {
  const out = testnet()
  const h = head(out)

  it('names the chain in the title, description and Open Graph text', () => {
    expect(h).toContain('<title>FlipTheMeme - Meme Coin Predictions (Robinhood Chain Testnet)</title>')
    expect(h).toMatch(/<meta name="description" content="[^"]*Robinhood Chain testnet, test tokens only/)
    expect(h).toMatch(/<meta property="og:title"\s+content="FlipTheMeme - Meme Coin Predictions \(Robinhood Chain Testnet\)"/)
    expect(h).toMatch(/<meta property="og:description"\s+content="Predict meme coin prices on Robinhood Chain testnet\. Test WETH only, no real money\."/)
  })

  it('no longer says Base or USDC anywhere a preview or a tab would read it', () => {
    expect(h).not.toMatch(/\bBase\b/)
    expect(h).not.toMatch(/USDC/)
  })

  it('has no Farcaster Mini App tags, comments included', () => {
    expect(h).not.toMatch(/fc:miniapp/)
    expect(h).not.toMatch(/fc:frame/)
    expect(h).not.toMatch(/Farcaster/)
    expect(h).not.toMatch(/miniapps\.farcaster/)
  })

  it('declares the PNG icon as a PNG', () => {
    expect(h).toContain('<link rel="icon" type="image/png" href="/icon.png" />')
    expect(h).not.toContain('image/svg+xml')
  })

  it('points og:url, og:image and twitter:image at this site, not at the Base one', () => {
    expect(h).toMatch(new RegExp(`<meta property="og:url"\\s+content="${SITE}"`))
    expect(h).toMatch(new RegExp(`<meta property="og:image"\\s+content="${SITE}/embed\\.png"`))
    expect(h).toMatch(new RegExp(`<meta name="twitter:image"\\s+content="${SITE}/embed\\.png"`))
    expect(h).not.toContain('https://flipthememe.com')
  })

  it('keeps everything that is not about the network', () => {
    expect(h).toContain('<meta charset="UTF-8" />')
    expect(h).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0" />')
    expect(h).toMatch(/<meta property="og:type"\s+content="website"/)
    expect(h).toMatch(/<meta name="twitter:card"\s+content="summary_large_image"/)
    expect(h).toContain('fonts.googleapis.com')
    expect(out).toContain('<div id="root"></div>')
    expect(out).toContain('<script type="module" src="/src/main.tsx"></script>')
  })

  it('leaves no run of blank lines where the Farcaster block was', () => {
    expect(out).not.toMatch(/\n[ \t]*\n[ \t]*\n/)
  })

  it('is well formed: one head, and every meta tag still closed', () => {
    expect(out.match(/<head>/g)).toHaveLength(1)
    expect(out.match(/<\/head>/g)).toHaveLength(1)
    const metas = h.match(/<meta[^>]*>/g) ?? []
    expect(metas.length).toBeGreaterThan(8)
    for (const tag of metas) expect(tag).toMatch(/\/>$/)
  })
})

describe('the Robinhood Chain (mainnet) head', () => {
  it('says Robinhood Chain without calling itself a testnet', () => {
    const h = head(applyNetworkHead(html, { VITE_NETWORK: 'rhc', VITE_SITE_URL: SITE }))
    expect(h).toContain('<title>FlipTheMeme - Meme Coin Predictions on Robinhood Chain</title>')
    expect(h).not.toMatch(/testnet/i)
    expect(h).not.toMatch(/fc:miniapp/)
    expect(h).not.toMatch(/\bBase\b/)
  })
})

describe('without a usable VITE_SITE_URL', () => {
  it('leaves out the tags that need an absolute URL instead of keeping the Base site\'s', () => {
    for (const bad of [undefined, '', 'not a url', 'javascript:alert(1)', 'ftp://x.test']) {
      const h = head(testnet({ VITE_SITE_URL: bad }))
      expect(h, String(bad)).not.toMatch(/og:url/)
      expect(h, String(bad)).not.toMatch(/og:image/)
      expect(h, String(bad)).not.toMatch(/twitter:image/)
      expect(h, String(bad)).not.toContain('flipthememe.com')
      // ...and the rest of the rewrite still happens.
      expect(h, String(bad)).toContain('Robinhood Chain Testnet')
      expect(h, String(bad)).not.toMatch(/fc:miniapp/)
    }
  })
})

describe('the rewrite is strict about what it is given', () => {
  it('reads the network the way chain.ts does: any case, stray whitespace, a BOM', () => {
    expect(head(testnet({ VITE_NETWORK: '  RHC-Testnet\n' }))).toContain('Robinhood Chain Testnet')
    // Built from a code point so this file does not itself contain an invisible character.
    expect(head(testnet({ VITE_NETWORK: String.fromCharCode(0xfeff) + 'rhc-testnet' }))).toContain('Robinhood Chain Testnet')
  })

  it('fails the build, rather than ship the Base head, if index.html no longer matches', () => {
    expect(() => applyNetworkHead('<html><head></head></html>', { VITE_NETWORK: 'rhc', VITE_SITE_URL: SITE })).toThrow(
      /could not find/,
    )
    // A missing tag is caught too, not only a missing head.
    const noTitle = html.replace(/<title>[^<]*<\/title>/, '')
    expect(() => applyNetworkHead(noTitle, { VITE_NETWORK: 'rhc-testnet', VITE_SITE_URL: SITE })).toThrow(/<title>/)
  })

  it('cannot be made to inject markup through VITE_SITE_URL', () => {
    const out = testnet({ VITE_SITE_URL: 'https://rhc.example.test/a?x="><script>alert(1)</script>' })
    expect(head(out)).not.toContain('<script')
    expect(head(out)).not.toContain('alert(1)')
  })
})

describe('isRhcNetwork and resolveSiteUrl', () => {
  it('isRhcNetwork is true only for the two Robinhood networks', () => {
    expect(isRhcNetwork('rhc')).toBe(true)
    expect(isRhcNetwork(' RHC-TESTNET ')).toBe(true)
    for (const v of ['mainnet', 'sepolia', '', undefined, null, 'rhc-mainnet']) expect(isRhcNetwork(v)).toBe(false)
  })

  it('resolveSiteUrl gives an origin without a trailing slash, or nothing', () => {
    expect(resolveSiteUrl('https://rhc.flipthememe.com')).toBe('https://rhc.flipthememe.com')
    expect(resolveSiteUrl('  https://rhc.flipthememe.com/  ')).toBe('https://rhc.flipthememe.com')
    expect(resolveSiteUrl('https://rhc.flipthememe.com/app/?x=1#y')).toBe('https://rhc.flipthememe.com/app')
    for (const v of [undefined, null, '', 'nope', 'javascript:alert(1)', 'file:///etc/passwd']) {
      expect(resolveSiteUrl(v)).toBeUndefined()
    }
  })
})
