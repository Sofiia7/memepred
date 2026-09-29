/**
 * The first line of an error, however it was thrown, for a log line or a small
 * record that must stay one line.
 *
 * viem's errors carry the whole request in `message` (the call, the ABI, the RPC
 * url, a stack of context - dozens of lines) and a short reason in
 * `shortMessage`; a plain Error has only `message`; anything else is stringified.
 * Truncated so a message that is itself enormous cannot flood a log, and any URL
 * in it is replaced: an RPC endpoint often carries its API key in the path, and
 * this text ends up in log files, Redis and a health response.
 */
export function oneLine(err: unknown, max = 200): string {
  const e = err as { shortMessage?: unknown; message?: unknown } | null | undefined
  const raw =
    typeof e?.shortMessage === 'string' ? e.shortMessage
    : typeof e?.message === 'string' ? e.message
    : String(err)
  const first = raw.split('\n')[0].replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').trim()
  return first.length > max ? `${first.slice(0, max - 1)}~` : first
}
