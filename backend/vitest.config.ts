import { defineConfig } from 'vitest/config'

/**
 * The backend had no vitest config, so every test ran under the default 5s
 * timeout - and several of these build a real Fastify instance, register the
 * plugin stack and inject a request. On a cold run the first test in such a
 * file pays the whole file's transform and import cost, which is charged to it
 * rather than to setup: pools.test.ts took 7.0s on its first execution and
 * 0.45s on the next, and httpPlugins.test.ts had been failing about twice in
 * eight full runs while passing every time in isolation.
 *
 * That reads as a flaky assertion and is not one. It is a timeout wearing the
 * name of whichever test happened to be first.
 *
 * 20s is chosen to be far above cold-import cost and far below anything a
 * genuine hang would finish in - a test that actually deadlocks still fails,
 * just later. If a test legitimately needs longer than this, it wants its own
 * timeout argument and a comment saying why, not a higher global.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
