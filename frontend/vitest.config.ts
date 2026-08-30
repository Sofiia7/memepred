import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose - the app itself needs no test
// runtime concerns (jsdom, globals), and mixing them risks the test config
// leaking into the real Vite dev/build pipeline.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
