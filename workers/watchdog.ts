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
  /**
   * Host of the API to watch, without a scheme - e.g. `api.flipthememe.com`.
   *
   * Configurable because there is now more than one deployment, and a monitor
   * hardcoded to one of them reports the other as healthy by never looking at
   * it. Unset keeps the Base production host, so an existing worker keeps
   * watching exactly what it watched before.
   */
  API_HOST?:           string
  /** Host of the frontend to watch. Same reasoning as API_HOST. */
  SITE_HOST?:          string
  /**
   * Name of the deployment, for the alert body. "keeper down" is not actionable
   * when two keepers exist and the message does not say which.
   */
  DEPLOYMENT?:         string
  EMAIL?:              { send(msg: unknown): Promise<unknown> }
}

const STATE_KEY = 'state:v1'

/** Two consecutive misses before paging: one 502 during a deploy is not an outage. */
const FAILS_BEFORE_ALERT = 2
/** While it stays down, repeat hourly rather than every two minutes. */
const REALERT_MS = 60 * 60_000
/** Per-request ceiling. A hung origin must not stall the whole run. */
const TIMEOUT_MS = 10_000

/** How often the cron fires. Used to infer how many quiet checks a gap covers. */
const CRON_MS = 2 * 60_000

/**
 * How long a quiet, all-green run may go without persisting state.
 *
 * Workers KV's free tier is not one budget but four, and the binding one is
 * writes: 100,000 reads a day against only 1,000 writes. A put on every tick
 * of a 2-minute cron is 720 writes a day - 72% of the daily cap burned by one
 * key holding one small object, which is how this account got a "50% of your
 * KV limit" e-mail on 2026-08-29 with reads sitting at 0.6%.
 *
 * The fix is to write less, not to check less. Detection stays at two minutes;
 * only the bookkeeping is rate-limited, and anything that actually matters -
 * a failure, a recovery, an alert, a day rolling over - writes immediately.
 * Quiet green runs cost ~144 writes a day instead of 720.
 */
const QUIET_WRITE_MS = 10 * 60_000

interface Check {
  name: string
  url:  string
  /** Hard checks page; soft checks only colour the report. */
  hard: boolean
}

const DEFAULT_API_HOST = 'api.flipthememe.com'
const DEFAULT_SITE_HOST = 'flipthememe.com'

/**
 * " (robinhood-chain)" when DEPLOYMENT is set, else "" - every alert subject
 * runs through this so two watchdogs never read as one in an inbox.
 */
function deployTag(env: Env): string {
  return env.DEPLOYMENT ? ` (${env.DEPLOYMENT})` : ''
}

/** The human-facing health page, on whichever host this worker is actually watching. */
function keeperHealthUrl(env: Env): string {
  return `https://${env.API_HOST ?? DEFAULT_API_HOST}/api/keeper/health`
}

/**
 * What this worker watches, built from its own configuration.
 *
 * These were four hardcoded URLs, which was right while there was one
 * deployment and became a hazard the moment there were two: a second chain's
 * backend would have had no monitor at all, and the worker watching the first
 * would have gone on reporting green for it. One worker per deployment, each
 * with its own API_HOST, is the shape that scales without duplicating this file.
 *
 * DEPLOYMENT set without API_HOST/SITE_HOST is refused rather than defaulted:
 * a KV namespace id filled in on its own - the only other thing standing
 * between wrangler.watchdog.rhc.toml and a real deploy - would otherwise
 * start this worker watching Base under the "robinhood-chain" label and
 * reporting it all green: the exact failure mode this file exists to catch,
 * just aimed at itself.
 */
function checksFor(env: Env): Check[] {
  if (env.DEPLOYMENT && (!env.API_HOST || !env.SITE_HOST)) {
    throw new Error(
      `[watchdog] DEPLOYMENT="${env.DEPLOYMENT}" is set but API_HOST/SITE_HOST ` +
      `are not - refusing to fall back to the Base defaults (${DEFAULT_API_HOST} / ` +
      `${DEFAULT_SITE_HOST}) under a different deployment's label. Set both ` +
      `API_HOST and SITE_HOST in this deployment's wrangler .toml [vars] before deploying.`
    )
  }
  const api = env.API_HOST ?? DEFAULT_API_HOST
  const site = env.SITE_HOST ?? DEFAULT_SITE_HOST
  return [
    // The deep probe: keeper alive, watchdog snapshot fresh, no balance drift.
    { name: 'keeper',   url: `https://${api}/health/deep`, hard: true },
    // The API process itself. Separates "backend is down" from "keeper is down"
    // in the alert body, which is the difference between restarting a container
    // and topping up a wallet.
    { name: 'api',      url: `https://${api}/health`,      hard: true },
    // The edge-to-origin secret pairing. Both probes above are edge-exempt, so
    // a secret that drifted would leave them green while every product route
    // answered 403 - the API would be down for every real user and no monitor
    // would say so.
    { name: 'edge',     url: `https://${api}/health/edge`, hard: true },
    { name: 'frontend', url: `https://${site}/`,           hard: true },
  ]
}

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
  /**
   * KV writes actually performed today, counted rather than inferred.
   *
   * The free tier allows 1,000 a day and this Worker is the only thing
   * spending them. Nobody was counting when a put-per-tick quietly reached 72%
   * of that cap, and the first anyone knew was an e-mail from Cloudflare - so
   * the number that matters now gets measured instead of reasoned about.
   */
  writes:   number
  /**
   * Wall-clock time this day that nobody actually checked, in ms.
   *
   * Counting quiet checks from elapsed time has one failure mode and it is a
   * bad one: if the cron stops, the next write credits the whole silent gap as
   * successful checks and the soak number becomes fiction. Anything longer than
   * one quiet interval plus a tick is therefore not counted as checks at all -
   * it is recorded here, where it reads as a hole in the coverage rather than
   * as uptime.
   */
  unobservedMs: number
  /** How many times coverage was lost, so one long gap reads differently from many. */
  gaps:     number
}

interface State {
  status:           'ok' | 'down'
  since:            number
  fails:            number
  lastAlertAt:      number
  lastHeartbeatDay: string
  lastWarnDay:      string
  lastCheckAt:      number
  /** When state was last persisted, which is not every check - see QUIET_WRITE_MS. */
  lastWriteAt:      number
  detail:           string
  results:          Result[]
  /** Most recent 7 UTC days, newest last. */
  days:             DayStat[]
  /** Longest unbroken outage ever observed, in ms. */
  longestDownMs:    number
}

const EMPTY: State = {
  status: 'ok', since: 0, fails: 0, lastAlertAt: 0,
  lastHeartbeatDay: '', lastWarnDay: '', lastCheckAt: 0, lastWriteAt: 0,
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
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
        signal:  AbortSignal.timeout(TIMEOUT_MS),
      })
      // Telegram answers 200 only when it accepted the message. A wrong token (401) or a chat the
      // bot cannot reach (400, 403) is an ordinary response, not a thrown error, so it used to be
      // counted as sent: /test-alert then claimed a delivery that never happened, which is exactly
      // the false comfort that route exists to remove. Its description carries no secret.
      if (res.ok) sent.push('telegram')
      else console.error('telegram rejected the alert', res.status, (await res.text().catch(() => '')).slice(0, 160))
    } catch (err) { console.error('telegram failed', err) }
  }

  if (env.ALERT_WEBHOOK_URL) {
    try {
      // `content` is Discord's field, `text` is Slack's; a generic receiver
      // gets both, plus the structured pair. One shape fits all three.
      const res = await fetch(env.ALERT_WEBHOOK_URL, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ content: text, text, subject, body }),
        signal:  AbortSignal.timeout(TIMEOUT_MS),
      })
      // Same rule as Telegram: only a 2xx counts as delivered.
      if (res.ok) sent.push('webhook')
      else console.error('webhook rejected the alert', res.status)
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
  const checks = checksFor(env)
  const results = await Promise.all(checks.map(runCheck))

  const broken = results.filter(r => !r.ok && checks.find(c => c.name === r.name)?.hard)
  const down   = broken.length > 0
  const detail = down ? broken.map(r => `${r.name}: ${r.detail}`).join('; ') : 'all green'
  const warns  = [...new Set(results.flatMap(r => r.warn))]

  // Tally before anything else can return early.
  //
  // Quiet checks are counted from elapsed time rather than one-per-tick,
  // because a quiet tick may not persist at all. Failing ticks always persist,
  // so failures are still counted exactly - which is the half of the ratio a
  // soak number depends on being right.
  const today = utcDay(now)
  const days  = [...(prev.days ?? [])]
  if (!days.length || days[days.length - 1].day !== today) {
    days.push({ day: today, checks: 0, failures: 0, writes: 0, unobservedMs: 0, gaps: 0 })
  }
  const cur     = days[days.length - 1]
  const gap     = prev.lastWriteAt ? now - prev.lastWriteAt : CRON_MS
  const wasDown = prev.status === 'down'

  // The most ticks a healthy gap can contain.
  //
  // A write lands on the first tick at or after QUIET_WRITE_MS, so the real
  // interval between writes is 10-12 minutes, not 10 - measured at 11m37s on
  // 2026-08-30. Two ticks of headroom on top of that absorbs schedule jitter;
  // sizing it to exactly one tick would report a healthy watchdog as having
  // lost coverage, which is the same species of lie in the other direction.
  const MAX_GAP_TICKS = Math.round((QUIET_WRITE_MS + 2 * CRON_MS) / CRON_MS)
  const raw = Math.max(1, Math.round(gap / CRON_MS))
  const ran = Math.min(raw, MAX_GAP_TICKS)
  if (raw > MAX_GAP_TICKS) {
    cur.unobservedMs = (cur.unobservedMs ?? 0) + (gap - MAX_GAP_TICKS * CRON_MS)
    cur.gaps         = (cur.gaps ?? 0) + 1
    console.warn(`[watchdog] ${Math.round(gap / 60_000)} min gap since last write - cron missed runs, not counting them as checks`)
  }
  cur.checks += ran
  // A gap between writes is homogeneous, because every status change writes
  // immediately: if it was down at both ends, every tick in between was a
  // failure. Counting 1 per write instead would report a total outage as an
  // 80% uptime, which is worse than not measuring at all.
  cur.failures += down
    ? (wasDown ? ran : 1)
    : (wasDown ? Math.max(0, ran - 1) : 0)
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
        `FlipTheMeme is DOWN${deployTag(env)} - ${detail}`,
        [
          detail,
          '',
          firstTime ? 'First seen just now.' : `Still down after ~${minutes} min.`,
          '',
          ...results.map(r => `  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(9)} ${r.detail}`),
          '',
          keeperHealthUrl(env),
        ].join('\n'),
      )
      next.status      = 'down'
      next.lastAlertAt = now
    }
  }

  // ── recovery ────────────────────────────────────────────────────────
  if (!down && prev.status === 'down') {
    const minutes = Math.round((now - prev.since) / 60_000)
    await notify(env, `FlipTheMeme recovered${deployTag(env)}`, `Back up after ~${minutes} min down.\n\nWas: ${prev.detail}`)
    next.status = 'ok'
    next.since  = now
  }

  // ── daily nudge for green-but-degraded ──────────────────────────────
  // 'warn' on the keeper wallet means roughly days of gas left. Days is enough
  // time to act on, but only if somebody is told.
  if (!down && warns.length && utcDay(now) !== prev.lastWarnDay) {
    await notify(
      env,
      `FlipTheMeme degraded${deployTag(env)} - ${warns.join(', ')}`,
      `Up and serving, but: ${warns.join(', ')}.\n\n` +
      'keeper-eth-low   -> top up the keeper wallet\n' +
      'resolver-eth-low -> send ETH to OracleResolver\n' +
      'feed-degraded    -> an oracle feed is failing to publish\n' +
      'invariant-unmeasured -> the money monitor cannot read every balance; red after 15 min\n\n' +
      keeperHealthUrl(env),
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
        `FlipTheMeme daily check${deployTag(env)} - all green`,
        `${checks.length} checks passing against ${env.API_HOST ?? DEFAULT_API_HOST}.\n\n` +
          'If this stops arriving, the watchdog is dead - not the silence.',
      )
    }
    next.lastHeartbeatDay = utcDay(now)
  }

  // Persist when something happened, or when the last write has aged out.
  // Everything listed here is a state a later run has to be able to read back:
  // skipping any of them would lose an outage, an alert, or a day boundary.
  const mustWrite =
    // The pre-alert failure counter has to survive to reach the threshold - a
    // dropped increment here means fails never reaches 2 and nobody is ever
    // paged. Past that, a sustained outage rides the quiet interval like
    // anything else, so a bad day costs ~144 writes rather than 720.
    (down && next.fails < FAILS_BEFORE_ALERT)     ||
    prev.status !== next.status                   ||   // up/down transition
    prev.lastAlertAt !== next.lastAlertAt         ||   // an alert went out
    prev.lastWarnDay !== next.lastWarnDay         ||
    prev.lastHeartbeatDay !== next.lastHeartbeatDay ||
    utcDay(prev.lastWriteAt || now) !== today     ||   // day rolled over
    now - (prev.lastWriteAt || 0) >= QUIET_WRITE_MS

  if (mustWrite) {
    next.lastWriteAt = now
    // Counted before the put so the stored value includes itself; a record
    // written before this field existed resumes from 0 rather than NaN.
    cur.writes = (cur.writes ?? 0) + 1
    await env.WATCHDOG.put(STATE_KEY, JSON.stringify(next))
  }
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
        `FlipTheMeme watchdog${deployTag(env)} - test alert`,
        'This is a test, production is not down.\n\n' +
        'It was sent to prove the alert path works end to end. A real alert ' +
        'looks like this one and names which check failed.',
      )
      return Response.json({ sent, channels: sent.length })
    }

    /**
     * Manual run, for verifying the wiring without waiting for the cron.
     *
     * Behind the same key as /test-alert. A tick writes to KV, the free tier
     * allows 1,000 writes a day, and this Worker is the only thing spending
     * them - Cloudflare already e-mailed once about hitting half the budget on
     * cron alone. Anyone who learned this URL could loop it, exhaust the day's
     * writes, and leave the watchdog unable to record state: the alarm system
     * silenced from outside, which is a worse outcome than the inconvenience
     * of needing a key to run it by hand. GET / still reports state to anyone,
     * and costs nothing.
     */
    if (url.pathname === '/check') {
      if (!env.TEST_KEY || url.searchParams.get('key') !== env.TEST_KEY) {
        return new Response('not found', { status: 404 })
      }
      const state = await tick(env, Date.now())
      return Response.json(state, { status: state.status === 'down' ? 503 : 200 })
    }

    const state: State = JSON.parse((await env.WATCHDOG.get(STATE_KEY)) ?? 'null') ?? EMPTY
    // A state nobody has refreshed in a while means the cron stopped. Report
    // that as down: a stale green is the lie this Worker exists to prevent.
    // The window has to clear QUIET_WRITE_MS with room, or a healthy watchdog
    // that simply had nothing to say would report itself dead.
    const stale = Date.now() - (state.lastWriteAt || state.lastCheckAt) > QUIET_WRITE_MS + 10 * 60_000

    const days    = state.days ?? []
    const checks  = days.reduce((n, d) => n + d.checks, 0)
    const failed  = days.reduce((n, d) => n + d.failures, 0)
    const soak = {
      windowDays:    days.length,
      checks,
      failures:      failed,
      uptimePct:     checks ? Number((100 * (checks - failed) / checks).toFixed(4)) : null,
      longestDownMs: state.longestDownMs ?? 0,
      // Time nobody watched. Uptime above is measured over observed minutes
      // only, so this is the number that says how much the percentage is
      // actually about.
      unobservedMs:  days.reduce((n, d) => n + (d.unobservedMs ?? 0), 0),
      coverageGaps:  days.reduce((n, d) => n + (d.gaps ?? 0), 0),
      perDay:        days,
    }

    // lastCheckAt is only as fresh as the last write, because quiet checks do
    // not persist. Said out loud here so "the timestamp stopped moving" is not
    // mistaken for "the cron died" - `stale` is the field that answers that.
    const todayStat = days[days.length - 1]
    const kv = {
      writesToday: todayStat?.writes ?? 0,
      dailyLimit:  1000,
      percentUsed: Math.round(((todayStat?.writes ?? 0) / 1000) * 100),
      note: 'checks run every 2 min; state persists at most every 10 (QUIET_WRITE_MS)',
    }

    return Response.json(
      { ...state, stale, soak, kv },
      {
        status:  state.status === 'down' || stale ? 503 : 200,
        headers: { 'cache-control': 'no-store' },
      },
    )
  },
}
