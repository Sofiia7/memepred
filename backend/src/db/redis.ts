import { createClient, type RedisClientType } from 'redis'
import { REDIS_URL } from '../config.js'

/**
 * Annotated rather than inferred on purpose.
 *
 * `createClient()` returns a type that names the @redis/* modules (bloom,
 * json, search, time-series) which node-redis splits itself into. Those are
 * transitive dependencies, so under pnpm's strict layout they live in
 * .pnpm/... where TypeScript cannot name them portably - and with
 * `declaration: true` it has to, so `tsc --noEmit` fails with TS2742 once per
 * command in every module. It only ever passed on a stale, flatter
 * node_modules; any clean install, CI's included, hits it.
 */
export const redis: RedisClientType = createClient({ url: REDIS_URL })

redis.on('error', (err) => console.error('Redis error:', err))
