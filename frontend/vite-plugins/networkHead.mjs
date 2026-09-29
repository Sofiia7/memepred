// @ts-check
/**
 * The <head> of the built index.html, per network.
 *
 * frontend/index.html is written for the Base site: "on Base. Bet USDC", the
 * Farcaster Mini App embed tags, a PNG declared as an SVG icon. A Robinhood
 * Chain build served that head unchanged, so a link to it previewed as a Base
 * product, the page told the browser it was a Mini App, and the tab title had
 * nothing to do with the chain it trades on.
 *
 * This rewrites that head for `rhc` and `rhc-testnet` builds and does nothing
 * at all for anything else: for a Base build (or a missing VITE_NETWORK) the
 * function returns the very string it was given, so the output is byte for byte
 * what it was before this file existed.
 *
 * It is plain JavaScript with a .d.mts beside it, not TypeScript, on purpose:
 * vite.config.ts is compiled by its own project (tsconfig.node.json, which is
 * composite and emits next to its sources), and a .ts module imported from it
 * would have to be listed there and would be emitted into the source tree. The
 * test lives in src/lib/networkHead.test.ts and reads the real index.html, so
 * an edit to the head that this no longer matches fails a test instead of
 * silently producing an unrewritten head.
 */

const RHC_NETWORKS = ['rhc', 'rhc-testnet']

/** @param {unknown} v */
const norm = (v) => String(v ?? '').trim().toLowerCase()

/**
 * Whether a VITE_NETWORK value selects Robinhood Chain. Same normalisation as
 * src/lib/chain.ts's parseNetwork: case and surrounding whitespace are ignored.
 * @param {unknown} network
 */
export function isRhcNetwork(network) {
  return RHC_NETWORKS.includes(norm(network))
}

/**
 * The public origin of the site, from VITE_SITE_URL, or undefined when it is
 * missing or is not an http(s) URL. Trailing slashes are dropped so it can be
 * joined with a path.
 * @param {unknown} raw
 * @returns {string | undefined}
 */
export function resolveSiteUrl(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return undefined
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    return (u.origin + u.pathname).replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

/** @param {string} s */
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** @param {string} s */
const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const COPY = {
  'rhc-testnet': {
    title: 'FlipTheMeme - Meme Coin Predictions (Robinhood Chain Testnet)',
    description:
      "FlipTheMeme - short UP/DOWN bets on meme coins, priced by each token's own Uniswap v3 pool. " +
      'Robinhood Chain testnet, test tokens only, no real money.',
    ogDescription: 'Predict meme coin prices on Robinhood Chain testnet. Test WETH only, no real money.',
  },
  rhc: {
    title: 'FlipTheMeme - Meme Coin Predictions on Robinhood Chain',
    description:
      "FlipTheMeme - short UP/DOWN bets on meme coins on Robinhood Chain, priced by each token's own Uniswap v3 pool. " +
      'Bet WETH on price direction.',
    ogDescription: 'Predict meme coin prices on Robinhood Chain. Bet WETH on price direction.',
  },
}

/**
 * Replace exactly one match, or fail. A head that no longer matches is the
 * exact bug this exists to prevent, so it stops the build instead of quietly
 * shipping the Base head under a Robinhood name.
 * @param {string} html
 * @param {RegExp} re
 * @param {string | ((...m: string[]) => string)} to
 * @param {string} what
 */
function replaceOnce(html, re, to, what) {
  if (!re.test(html)) {
    throw new Error(`network-head: could not find ${what} in index.html; update vite-plugins/networkHead.mjs to match it`)
  }
  return html.replace(re, /** @type {any} */ (to))
}

/**
 * @param {string} html the index.html source
 * @param {Record<string, string | undefined>} [env] the Vite env (import.meta.env values)
 * @returns {string}
 */
export function applyNetworkHead(html, env = {}) {
  const network = norm(env.VITE_NETWORK)
  // Not a Robinhood build: hand back the same string, untouched.
  if (network !== 'rhc' && network !== 'rhc-testnet') return html

  const copy = COPY[network]
  const site = resolveSiteUrl(env.VITE_SITE_URL)
  let out = html

  // Icon: the file is a PNG, and the tag said image/svg+xml.
  out = replaceOnce(
    out,
    /<link\s+rel="icon"\s+type="[^"]*"\s+href="([^"]*)"\s*\/>/,
    (_m, href) => {
      const type = /\.svg(\?|$)/i.test(href) ? 'image/svg+xml' : /\.ico(\?|$)/i.test(href) ? 'image/x-icon' : 'image/png'
      return `<link rel="icon" type="${type}" href="${href}" />`
    },
    'the <link rel="icon"> tag',
  )

  out = replaceOnce(
    out,
    /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
    `<meta name="description" content="${escapeAttr(copy.description)}" />`,
    'the description meta tag',
  )
  out = replaceOnce(out, /<title>[^<]*<\/title>/, `<title>${escapeText(copy.title)}</title>`, 'the <title>')

  // Farcaster Mini App embed and its legacy alias, with their comments: this
  // build is not a Mini App, so a client that reads these tags would offer to
  // launch one.
  out = replaceOnce(out, /[ \t]*<meta\s+name="fc:miniapp"[^>]*>[ \t]*\r?\n?/, '', 'the fc:miniapp meta tag')
  out = replaceOnce(out, /[ \t]*<meta\s+name="fc:frame"[^>]*>[ \t]*\r?\n?/, '', 'the fc:frame meta tag')
  out = out.replace(/[ \t]*<!--(?:(?!-->)[\s\S])*(?:Farcaster Mini App embed|Backwards-compat alias)(?:(?!-->)[\s\S])*-->[ \t]*\r?\n?/g, '')
  out = out.replace(/<!--\s*Open Graph \(Base App \+ Farcaster \+ Twitter\)\s*-->/, '<!-- Open Graph + Twitter -->')
  // Removing the block leaves two blank lines where there was one.
  out = out.replace(/(\r?\n)[ \t]*(\r?\n)[ \t]*(\r?\n)+/g, '$1$2')

  out = replaceOnce(
    out,
    /(<meta\s+property="og:title"\s+content=")[^"]*(")/,
    (_m, a, b) => `${a}${escapeAttr(copy.title)}${b}`,
    'the og:title meta tag',
  )
  out = replaceOnce(
    out,
    /(<meta\s+property="og:description"\s+content=")[^"]*(")/,
    (_m, a, b) => `${a}${escapeAttr(copy.ogDescription)}${b}`,
    'the og:description meta tag',
  )

  // What needs an absolute URL of this site. Without VITE_SITE_URL there is no
  // honest value to give (the Base site's is exactly what must not stay), so
  // the tags are left out rather than pointing at the wrong site.
  const dropTag = /** @param {string} attrName @param {string} attrValue */ (attrName, attrValue) =>
    new RegExp(`[ \\t]*<meta\\s+${attrName}="${attrValue}"\\s+content="[^"]*"\\s*/>[ \\t]*\\r?\\n?`)

  if (site) {
    out = replaceOnce(out, /(<meta\s+property="og:url"\s+content=")[^"]*(")/, (_m, a, b) => `${a}${escapeAttr(site)}${b}`, 'the og:url meta tag')
    // Keep the image's own path (/embed.png); only the origin is the site's.
    for (const [attr, value] of /** @type {const} */ ([
      ['property', 'og:image'],
      ['name', 'twitter:image'],
    ])) {
      out = replaceOnce(
        out,
        new RegExp(`(<meta\\s+${attr}="${value}"\\s+content=")([^"]*)(")`),
        (_m, a, current, b) => {
          let path = '/embed.png'
          try {
            path = new URL(current).pathname
          } catch {
            /* keep the default */
          }
          return `${a}${escapeAttr(site + path)}${b}`
        },
        `the ${value} meta tag`,
      )
    }
  } else {
    out = replaceOnce(out, dropTag('property', 'og:url'), '', 'the og:url meta tag')
    out = replaceOnce(out, dropTag('property', 'og:image'), '', 'the og:image meta tag')
    out = replaceOnce(out, dropTag('name', 'twitter:image'), '', 'the twitter:image meta tag')
  }

  return out
}
