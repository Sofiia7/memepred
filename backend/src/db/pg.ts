import pg from 'pg'
import { DATABASE_URL } from '../config.js'

const pool = new pg.Pool({ connectionString: DATABASE_URL })

/**
 * Without this, a dropped idle connection - Docker Desktop restarting
 * Postgres, the box sleeping, a network blip - throws an unhandled 'error'
 * event on the pool and crashes the whole process (Node's default for an
 * EventEmitter's 'error' with no listener). redis.ts has always had this;
 * pg.ts never did, so a database hiccup took the API or the keeper down
 * with it instead of the pool just reconnecting on the next checkout, which
 * is what an idle-client error from a normally-configured pg.Pool means.
 */
pool.on('error', (err) => {
  console.error('[pg] idle client error (pool continues):', err)
})

export { pool as pg }
