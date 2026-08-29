/**
 * FlipTheMeme uptime watchdog.
 *
 * A Cloudflare cron Worker that checks production every two minutes and pushes
 * an alert when it stops answering. It exists because in August the keeper sat
 * dead for 15 days and nobody found out: the only monitor in place pinged
 * `/health`, which returns `{status:'ok'}` for as long as the Fastify process
 * has a pulse. The site was up. The product was not.
 *
 * Three properties are the whole point, and each one is a lesson from that
 * outage:
 *
 *  1. It runs OFF the VPS. A watchdog hosted next to the thing it watches dies
 *     with it, and its silence looks exactly like good news.
 *  2. It watches `/health/deep`, which returns 503 when the keeper is out of
 *     gas, when the watchdog snapshot is stale, or when USDC drifts - not a
 *     probe that cannot fail.
 *  3. It sends a daily "still green" heartbeat. Without one, a dead watchdog
 *     is indistinguishable from a healthy system, which is precisely the
 *     failure mode that started all of this.
 *
 * Alert channels are whichever secrets are set - Telegram, a Discord/Slack
 * webhook, or e-mail through the send_email binding. With none set the Worker
 * still records state and serves it at its own URL, so an external uptime
 * service can be pointed here and cover every check at once (this URL answers
 * 503 whenever production is down).
 *
 * Deploy:  wrangler deploy -c wrangler.watchdog.toml
 */

export interface Env {
  WATCHDOG:            KVNamespace
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_CHAT_ID?:   string
  ALERT_WEBHOOK_URL?:  string
  ALERT_EMAIL_TO?:     string
  ALERT_EMAIL_FROM?:   string
  /** Shared secret for GET /test-alert. Without it that route is disabled. */
  TEST_KEY?:           string
  EMAIL?:              { send(msg: unknown): Promise<unknown> }
}

const STATE_KEY = 'state:v1'

/** Two consecutive misses before paging: one 502 during a deploy is not an outage. */
const FAILS_BEFORE_ALERT = 2
/** While it stays down, repeat hourly rather than every two minutes. */
const REALERT_MS = 60 * 60_000
/** Per-request ceiling. A hung origin must not stall the whole run. */
const TIMEOUT_MS = 10_000

interface Check {
  name: string
  url:  string
  /** Hard checks page; soft checks only colour the report. */
  hard: boolean
}

const CHECKS: Check[] = [
  // The deep probe: keeper alive, watchdog snapshot fresh, no USDC drift.
  { name: 'keeper',   url: 'https://api.flipthememe.com/health/deep', hard: true },
  // The API process itself. Separates "backend is down" from "keeper is down"
  // in the alert body, which is the difference between restarting a container
  // and topping up a wallet.
  { name: 'api',      url: 'https://api.flipthememe.com/health',      hard: true },
  { name: 'frontend', url: 'https://flipthememe.com/',                hard: true },
]

interface Result {
  name:   string
  ok:     boolean
  status: number
  detail: string
  warn:   string[]
}

/**
 * One UTC day of tallies. This is what turns the watchdog into a soak report:
 * "it looked fine when I checked" is not an uptime number, and a 48-hour soak
 * that nobody was counting during proves nothing afterwards.
 */
interface DayStat {
  day:      string
  checks:   number
  failures: number
}

interface State {
  status:           'ok' | 'down'
  since:            number
  fails:            number
  lastAlertAt:      number
  lastHeartbeatDay: string
  lastWarnDay:      string
  lastCheckAt:      number
  detail:           string
  results:          Result[]
  /** Most recent 7 UTC days, newest last. */
  days:             DayStat[]
  /** Longest unbroken outage ever observed, in ms. */
  longestDownMs:    number
}

const EMPTY: State = {
  status: 'ok', since: 0, fails: 0, lastAlertAt: 0,
  lastHeartbeatDay: '', lastWarnDay: '', lastCheckAt: 0,
  detail: 'never run', results: [], days: [], longestDownMs: 0,
}

async function runCheck(c: Check): Promise<Result> {
  try {
    const res = await fetch(c.url, {
      signal:  AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'flipthememe-watchdog' },
      cf:      { cacheTtl: 0, cacheEverything: false },
    } as RequestInit)

    let reason = ''
    let warn: string[] = []
    // Only the deep probe has a body worth reading, and it is a few dozen
    // bytes. A parse failure is ignored on purpose: the status code is the
    // signal, the body is colour.
    try {
      const body = (await res.json()) as { reason?: string; warn?: string[] }
      reason = body?.reason ?? ''
      warn   = Array.isArray(body?.warn) ? body.warn : []
    } catch { /* not JSON - fine */ }

    return {
      name:   c.name,
      ok:     res.status === 200,
      status: res.status,
      detail: res.status === 200 ? 'ok' : `HTTP ${res.status}${reason ? ` - ${reason}` : ''}`,
      warn,
    }
  } catch (err) {
    // A timeout or a DNS/TLS failure is the loudest possible signal: the host
    // did not answer at all.
    return {
      name: c.name, ok: false, status: 0,
      detail: `unreachable: ${(err as Error).message}`, warn: [],
    }
  }
}

async function notify(env: Env, subject: string, body: string): Promise<string[]> {
  const sent: string[] = []
  const text = `${subject}\n\n${body}`

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
        signal:  AbortSignal.timeout(TIMEOUT_MS),
      })
      sent.push('telegram')
    } catch (err) { console.error('telegram failed', err) }
  }

  if (env.ALERT_WEBHOOK_URL) {
    try {
      // `content` is Discord's field, `text` is Slack's; a generic receiver
      // gets both, plus the structured pair. One shape fits all three.
      await fetch(env.ALERT_WEBHOOK_URL, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ content: text, text, subject, body }),
        signal:  AbortSignal.timeout(TIMEOUT_MS),
      })
      sent.push('webhook')
    } catch (err) { console.error('webhook failed', err) }
  }

  if (env.EMAIL && env.ALERT_EMAIL_TO && env.ALERT_EMAIL_FROM) {
    try {
      await env.EMAIL.send({
        to:      env.ALERT_EMAIL_TO,
        from:    { email: env.ALERT_EMAIL_FROM, name: 'FlipTheMeme watchdog' },
        subject,
        text:    body,
      })
      sent.push('email')
    } catch (err) { console.error('email failed', err) }
  }

  return sent
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

async function tick(env: Env, now: number): Promise<State> {
  const prev: State = JSON.parse((await env.WATCHDOG.get(STATE_KEY)) ?? 'null') ?? EMPTY
  const results = await Promise.all(CHECKS.map(runCheck))

  const broken = results.filter(r => !r.ok && CHECKS.find(c => c.name === r.name)?.hard)
  const down   = broken.length > 0
  const detail = down ? broken.map(r => `${r.name}: ${r.detail}`).join('; ') : 'all green'
  const warns  = [...new Set(results.flatMap(r => r.warn))]

  // Tally before anything else can return early.
  const today = utcDay(now)
  const days  = [...(prev.days ?? [])]
  if (!days.length || days[days.length - 1].day !== today) {
    days.push({ day: today, checks: 0, failures: 0 })
  }
  const cur = days[days.length - 1]
  cur.checks   += 1
  cur.failures += down ? 1 : 0
  while (days.length > 7) days.shift()

  const next: State = {
    ...prev,
    lastCheckAt: now,
    detail,
    results,
    days,
    longestDownMs: Math.max(
      prev.longestDownMs ?? 0,
      down && prev.status === 'down' ? now - prev.since : 0,
    ),
    fails:  down ? prev.fails + 1 : 0,
    status: down ? prev.status : 'ok',
    since:  prev.status === 'ok' && down ? now : prev.since,
  }

  // ── down: page after the debounce, then hourly ──────────────────────
  if (down && next.fails >= FAILS_BEFORE_ALERT) {
    const firstTime = prev.status === 'ok'
    if (firstTime || now - prev.lastAlertAt >= REALERT_MS) {
      const minutes = Math.round((now - (next.since || now)) / 60_000)
      await notify(
        env,
        `FlipTheMeme is DOWN - ${detail}`,
        [
          detail,
          '',
          firstTime ? 'First seen just now.' : `Still down after ~${minutes} min.`,
          '',
          ...results.map(r => `  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(9)} ${r.detail}`),
          '',
          'https://api.flipthememe.com/api/keeper/health',
        ].join('\n'),
      )
      next.status      = 'down'
      next.lastAlertAt = now
    }
  }

  // ── recovery ────────────────────────────────────────────────────────
  if (!down && prev.status === 'down') {
    const minutes = Math.round((now - prev.since) / 60_000)
    await notify(env, 'FlipTheMeme recovered', `Back up after ~${minutes} min down.\n\nWas: ${prev.detail}`)
    next.status = 'ok'
    next.since  = now
  }

  // ── daily nudge for green-but-degraded ──────────────────────────────
  // 'warn' on the keeper wallet means roughly days of gas left. Days is enough
  // time to act on, but only if somebody is told.
  if (!down && warns.length && utcDay(now) !== prev.lastWarnDay) {
    await notify(
      env,
      `FlipTheMeme degraded - ${warns.join(', ')}`,
      `Up and serving, but: ${warns.join(', ')}.\n\n` +
      'keeper-eth-low   -> top up the keeper wallet\n' +
      'resolver-eth-low -> send ETH to OracleResolver\n' +
      'feed-degraded    -> an oracle feed is failing to publish\n\n' +
      'https://api.flipthememe.com/api/keeper/health',
    )
    next.lastWarnDay = utcDay(now)
  }

  // ── dead man's switch ───────────────────────────────────────────────
  // One green ping a day. Its absence is the only way to notice that the
  // watchdog itself has stopped, and a watchdog that fails silently is the
  // exact thing this is here to prevent. Skipped on the very first run so
  // deploying it does not immediately page.
  if (!down && !warns.length && utcDay(now) !== prev.lastHeartbeatDay) {
    if (prev.lastHeartbeatDay !== '') {
      await notify(
        env,
        'FlipTheMeme daily check - all green',
        `${CHECKS.length} checks passing.\n\nIf this stops arriving, the watchdog is dead - not the silence.`,
      )
    }
    next.lastHeartbeatDay = utcDay(now)
  }

  await env.WATCHDOG.put(STATE_KEY, JSON.stringify(next))
  return next
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(tick(env, event.scheduledTime || Date.now()))
  },

  /**
   * The same verdict over HTTP, answering 503 when production is down - so an
   * external uptime service pointed at this single URL covers every check.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    /**
     * Fire one alert on demand, to prove the channel works.
     *
     * An alert path that has never actually delivered is not a monitor, it is
     * a belief about a monitor - and this project has already paid for the
     * difference once. Guarded by a shared secret so the URL cannot be used to
     * spam somebody's phone, and disabled entirely when TEST_KEY is unset.
     */
    if (url.pathname === '/test-alert') {
      if (!env.TEST_KEY || url.searchParams.get('key') !== env.TEST_KEY) {
        return new Response('not found', { status: 404 })
      }
      const sent = await notify(
        env,
        'FlipTheMeme watchdog - test alert',
        'This is a test, production is not down.\n\n' +
        'It was sent to prove the alert path works end to end. A real alert ' +
        'looks like this one and names which check failed.',
      )
      return Response.json({ sent, channels: sent.length })
    }

    // Manual run, for verifying the wiring without waiting for the cron.
    if (url.pathname === '/check') {
      const state = await tick(env, Date.now())
      return Response.json(state, { status: state.status === 'down' ? 503 : 200 })
    }

    const state: State = JSON.parse((await env.WATCHDOG.get(STATE_KEY)) ?? 'null') ?? EMPTY
    // A state nobody has refreshed in 10 minutes means the cron stopped. Report
    // that as down: a stale green is the lie this Worker exists to prevent.
    const stale = Date.now() - state.lastCheckAt > 10 * 60_000

    const days    = state.days ?? []
    const checks  = days.reduce((n, d) => n + d.checks, 0)
    const failed  = days.reduce((n, d) => n + d.failures, 0)
    const soak = {
      windowDays:    days.length,
      checks,
      failures:      failed,
      uptimePct:     checks ? Number((100 * (checks - failed) / checks).toFixed(4)) : null,
      longestDownMs: state.longestDownMs ?? 0,
      perDay:        days,
    }

    return Response.json(
      { ...state, stale, soak },
      {
        status:  state.status === 'down' || stale ? 503 : 200,
        headers: { 'cache-control': 'no-store' },
      },
    )
  },
}
