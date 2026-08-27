import { z } from 'zod'
import type { FastifyReply } from 'fastify'

/** EVM address (0x + 40 hex). */
export const zAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'invalid address')
                                  .transform(s => s.toLowerCase())

/** Pyth feed id (0x + 64 hex). */
export const zFeedId  = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'invalid feed id')

/** Timeframe enum. */
export const zTF = z.enum(['5m', '15m', '1h', '4h', '1d'])

/**
 * Market status enum. Must stay in sync with what the backend actually writes:
 * marketCreator.closeExpiredMarkets() writes 'CLOSED' and indexer's
 * markResolvedMarkets() writes 'RESOLVED'. 'CLOSED' was missing here, so
 * `GET /api/markets?status=CLOSED` 400'd on a value the backend had put in the
 * column itself — every closed market was unreachable through the filter.
 */
export const zStatus = z.enum(['OPEN', 'CLOSED', 'RESOLVED', 'REFUNDED'])

/** Positive integer in a sane range. */
export const zLimit = z.coerce.number().int().min(1).max(500).default(100)

/**
 * Parse input or return a 400 response. Returns `null` on failure (caller should
 * then `return` immediately because reply is already sent).
 */
export function parse<T>(schema: z.ZodType<T>, input: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(input)
  if (!result.success) {
    reply.status(400).send({ error: 'validation_failed', issues: result.error.issues })
    return null
  }
  return result.data
}
