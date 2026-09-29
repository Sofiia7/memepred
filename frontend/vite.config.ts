import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { applyNetworkHead, isRhcNetwork, resolveSiteUrl } from './vite-plugins/networkHead.mjs'

/**
 * Rewrites index.html's <head> for Robinhood Chain builds (VITE_NETWORK=rhc or
 * rhc-testnet): title, description, Open Graph, the icon type, and no Farcaster
 * Mini App tags. For every other network it returns the HTML untouched, so a
 * Base build's index.html is byte for byte what it was. The rewriting itself is
 * in vite-plugins/networkHead.mjs, where it has tests.
 *
 * VITE_NETWORK and VITE_SITE_URL are read from the same env Vite uses for
 * import.meta.env (.env files for the mode, and the process environment), so
 * the head and the bundle cannot describe two different networks.
 */
function networkHead(): Plugin {
  let env: Record<string, string | undefined> = {}
  return {
    name: 'flipthememe-network-head',
    configResolved(config) {
      env = config.env as Record<string, string | undefined>
      if (isRhcNetwork(env.VITE_NETWORK) && !resolveSiteUrl(env.VITE_SITE_URL)) {
        config.logger.warn(
          '[network-head] VITE_SITE_URL is not set to an http(s) URL: og:url, og:image and twitter:image are left out of this Robinhood Chain build.',
        )
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => applyNetworkHead(html, env),
    },
  }
}

export default defineConfig({
  plugins: [react(), networkHead()],
  server: {
    port: 5173,
    host: true
  }
})
