/**
 * /api/keeper/health
 *
 * Surfaces the watchdog snapshot the keeper publishes to Redis every ~90s.
 * Used by uptime monitoring (e.g. Tenderly alert webhook, Grafana) and the
 * /status page in the dashboard.
 *
 * Status codes:
 *   200  resolver balance ok AND watchdog ticked < 5 min ago
 *   503  resolver balance critical, OR watchdog hasn't ticked in 5+ min
 */
import { FastifyInstance } from 'fastify'
import { redis } from '../db/redis.js'

const REDIS_KEY      = 'watchdog:state'
const STALE_THRESHOLD = 5 * 60_000 // 5 min

interface Snapshot {
  resolverEthWei:    string
  resolverEthAlert:  'ok' | 'warn' | 'critical' | 'unknown'
  feedStatus:        Record<string, { failStreak: number; lastPausedAt?: number }>
  lastTick:          number
}

export async function keeperHealthRoutes(app: FastifyInstance) {
  app.get('/api/keeper/health', async (_req, reply) => {
    const raw = await redis.get(REDIS_KEY)
    if (!raw) {
      return reply.code(503).send({
        status: 'down',
        reason: 'no watchdog snapshot — keeper not running?',
      })
    }

    let snap: Snapshot
    try {
      snap = JSON.parse(raw)
    } catch {
      return reply.code(503).send({ status: 'down', reason: 'corrupt snapshot' })
    }

    const age = Date.now() - snap.lastTick
    const stale = age > STALE_THRESHOLD
    const crit  = snap.resolverEthAlert === 'critical'

    // Sprint 5.6: also surface invariant-monitor critical flag.
    const invariantCritRaw = await redis.get('invariant:critical')
    const invariantCrit = invariantCritRaw ? JSON.parse(invariantCritRaw) : null

    if (stale || crit || invariantCrit) {
      return reply.code(503).send({
        status: 'down',
        reason:
          invariantCrit ? `usdc invariant drift $${invariantCrit.drift?.toFixed?.(2) ?? '?'}`
          : stale       ? `watchdog stale ${Math.round(age / 1000)}s`
          :               'resolver eth critical',
        snapshot: snap,
        invariant: invariantCrit ?? undefined,
        ageMs: age,
      })
    }

    return reply.send({
      status: 'ok',
      snapshot: snap,
      ageMs: age,
    })
  })
}
