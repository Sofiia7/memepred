/**
 * Whether this build shows the rounds screen at all. Off unless the build sets
 * VITE_ROUNDS_ENABLED=1, exactly (a stray space or BOM keeps it off).
 *
 * Its own module, and a bare comparison, so that Vite replaces it with a
 * literal at build time: with the flag off, App.tsx's lazy import of the
 * rounds code is dead and the public bundle carries none of it. The same rule
 * is applied by readRoundsConfig (roundsAbi.ts) for everything else.
 */
export const ROUNDS_ENABLED: boolean = import.meta.env.VITE_ROUNDS_ENABLED === '1'
