import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'
import { Writable } from 'node:stream'
import { registerErrorHandler, registerHttpPlugins, DEFAULT_ORIGINS } from './httpPlugins.js'

/**
 * A pg error's message carries SQL fragments, constraint and column names, a
 * position in the statement and sometimes a host. Fastify's default handler
 * sends `err.message` to the client for every error, so any route that threw
 * one handed out a tour of the schema.
 */
const PG_MESSAGE =
  'relation "orders" does not exist at character 15: SELECT trader_address FROM orders WHERE payout_usdc > 0 (host 10.0.4.7:5432)'

/** A Fastify whose server log lands in an array, one parsed line per entry. */
function withLogs(): { app: FastifyInstance; lines: any[] } {
  const lines: any[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split('\n')) if (l.trim()) lines.push(JSON.parse(l))
      cb()
    },
  })
  return { app: Fastify({ logger: { level: 'error', stream } }), lines }
}

function routes(app: FastifyInstance) {
  app.get('/db-error', async () => { throw new Error(PG_MESSAGE) })
  app.get('/service-unavailable', async () => {
    throw Object.assign(new Error('replica 10.0.4.9 refused the connection'), { statusCode: 503 })
  })
  app.get('/thrown-string', async () => { throw 'a bare string, not an Error' })
  app.get('/client-error', async () => {
    throw Object.assign(new Error('amount must be positive'), { statusCode: 400 })
  })
  app.get('/conflict', async () => {
    throw Object.assign(new Error('already registered'), { statusCode: 409 })
  })
  app.get('/explicit-500', async (_req, reply) => reply.code(500).send({ error: 'custom body' }))
  app.post('/echo', async (req) => req.body)
}

describe('registerErrorHandler', () => {
  it('never sends the message of a server error to the client', async () => {
    const { app } = withLogs()
    registerErrorHandler(app)
    routes(app)
    await app.ready()

    const res = await app.inject({ url: '/db-error' })
    expect(res.statusCode).toBe(500)
    const body = res.json()
    expect(body.error).toBe('internal')
    expect(typeof body.requestId).toBe('string')
    expect(Object.keys(body).sort()).toEqual(['error', 'requestId'])
    for (const leak of ['orders', 'trader_address', 'payout_usdc', '10.0.4.7', 'character 15', 'relation']) {
      expect(res.body).not.toContain(leak)
    }
    await app.close()
  })

  it('logs the whole error on the server, under the request id the client was given', async () => {
    const { app, lines } = withLogs()
    registerErrorHandler(app)
    routes(app)
    await app.ready()

    const res = await app.inject({ url: '/db-error' })
    const requestId = res.json().requestId

    const entry = lines.find((l) => l.requestId === requestId)
    expect(entry).toBeDefined()
    expect(entry.err.message).toBe(PG_MESSAGE)
    // The full stack, which is what makes the log entry worth having.
    expect(entry.err.stack).toContain('errorHandler.test')
    await app.close()
  })

  it('gives every failing request its own id', async () => {
    const { app } = withLogs()
    registerErrorHandler(app)
    routes(app)
    await app.ready()

    const a = (await app.inject({ url: '/db-error' })).json().requestId
    const b = (await app.inject({ url: '/db-error' })).json().requestId
    expect(a).not.toBe(b)
    await app.close()
  })

  it('keeps the status of a server error that is not a 500, and still hides its message', async () => {
    const { app } = withLogs()
    registerErrorHandler(app)
    routes(app)
    await app.ready()

    const res = await app.inject({ url: '/service-unavailable' })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('internal')
    expect(res.body).not.toContain('10.0.4.9')
    await app.close()
  })

  it('treats a thrown value that is not an Error as the server error it is', async () => {
    const { app } = withLogs()
    registerErrorHandler(app)
    routes(app)
    await app.ready()

    const res = await app.inject({ url: '/thrown-string' })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toBe('internal')
    expect(res.body).not.toContain('bare string')
    await app.close()
  })

  it('leaves a body a route sent itself alone: that is not an error', async () => {
    const { app } = withLogs()
    registerErrorHandler(app)
    routes(app)
    await app.ready()

    const res = await app.inject({ url: '/explicit-500' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'custom body' })
    await app.close()
  })

  /**
   * The other half of the contract. A client error's message is the client's own
   * business, and clients already parse its shape - it must come out exactly as
   * it does from a Fastify that never had this handler.
   */
  describe('client errors keep their shape', () => {
    async function both(request: InjectOptions) {
      const control = Fastify()
      routes(control)
      await control.ready()
      const handled = Fastify()
      registerErrorHandler(handled)
      routes(handled)
      await handled.ready()
      const a = await control.inject(request)
      const b = await handled.inject(request)
      await control.close()
      await handled.close()
      return { a, b }
    }

    it('a 400 thrown by a route', async () => {
      const { a, b } = await both({ url: '/client-error' })
      expect(b.statusCode).toBe(400)
      expect(b.json()).toEqual(a.json())
      expect(b.json().message).toBe('amount must be positive')
    })

    it('a 409 thrown by a route', async () => {
      const { a, b } = await both({ url: '/conflict' })
      expect(b.statusCode).toBe(409)
      expect(b.json()).toEqual(a.json())
    })

    it("Fastify's own rejection of a malformed JSON body", async () => {
      const { a, b } = await both({
        method: 'POST', url: '/echo', payload: '{"broken":', headers: { 'content-type': 'application/json' },
      })
      expect(b.statusCode).toBe(400)
      expect(b.json()).toEqual(a.json())
    })

    it('an unknown route is still a plain 404', async () => {
      const { a, b } = await both({ url: '/nowhere' })
      expect(b.statusCode).toBe(404)
      expect(b.json()).toEqual(a.json())
    })
  })
})

describe('the handler as part of the API plugin stack', () => {
  it('is installed by registerHttpPlugins, so routes registered after it are covered', async () => {
    const app = Fastify()
    await registerHttpPlugins(app, {
      corsOrigins: DEFAULT_ORIGINS,
      workerSecret: undefined,
      markActivity: async () => {},
    })
    // A child plugin, the way index.ts registers every route module.
    await app.register(async (child) => {
      child.get('/api/boom', async () => { throw new Error(PG_MESSAGE) })
    })
    await app.ready()

    const res = await app.inject({ url: '/api/boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toBe('internal')
    expect(res.body).not.toContain('orders')
    await app.close()
  })

  it('does not disturb the rate limiter: a 429 still says so, in the shape it always had', async () => {
    const app = Fastify()
    await registerHttpPlugins(app, {
      corsOrigins: DEFAULT_ORIGINS,
      workerSecret: undefined,
      rateLimitMax: 1,
      markActivity: async () => {},
    })
    app.get('/api/ok', async () => ({ ok: true }))
    await app.ready()

    expect((await app.inject({ url: '/api/ok' })).statusCode).toBe(200)
    const limited = await app.inject({ url: '/api/ok' })
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ statusCode: 429, error: 'Too Many Requests' })
    expect(limited.json().message).toMatch(/Rate limit exceeded/)
    await app.close()
  })
})
