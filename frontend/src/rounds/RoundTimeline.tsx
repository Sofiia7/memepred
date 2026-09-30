import { clockTime, durationWords, phaseAt, type RoundPhase, type RoundTimes } from './roundMath'

/**
 * The life of one round on a single bar, with clock times: when bets close,
 * the pause, the strike window, the stretch to the exit, and the result.
 *
 * It exists to make one thing impossible to miss: the price that decides the
 * bet is measured later, in two windows that have not started when the bet is
 * placed. The "now" marker shows where the player is on that bar.
 */
const STAGES: { phase: Exclude<RoundPhase, 'upcoming' | 'result'>; label: string; from: keyof RoundTimes; to: keyof RoundTimes }[] = [
  { phase: 'betting', label: 'Bets open', from: 'openAt', to: 'closeAt' },
  { phase: 'pause', label: 'Pause', from: 'closeAt', to: 'strikeStart' },
  { phase: 'strike', label: 'Strike averaged', from: 'strikeStart', to: 'strikeEnd' },
  { phase: 'exit', label: 'To the exit', from: 'strikeEnd', to: 'settleAt' },
]

export function RoundTimeline({ times, now }: { times: RoundTimes; now: number }) {
  const span = Math.max(1, times.settleAt - times.openAt)
  const current = phaseAt(times, now)
  const marker = Math.min(100, Math.max(0, ((now - times.openAt) / span) * 100))
  const minutes = Math.round(span / 60)
  const afterClose = Math.round((times.settleAt - times.closeAt) / 60)

  return (
    <div className="rnd-timeline" aria-label="Round timeline">
      <div className="rnd-tl-bar" aria-hidden="true">
        {STAGES.map((s) => (
          <div
            key={s.phase}
            className={`rnd-tl-seg rnd-tl-${s.phase}` + (current === s.phase ? ' on' : '')}
            style={{ flexGrow: Math.max(1, times[s.to] - times[s.from]) }}
          />
        ))}
        {now >= times.openAt && now <= times.settleAt && <div className="rnd-tl-now" style={{ left: `${marker}%` }} />}
      </div>
      <ol className="rnd-tl-list">
        {STAGES.map((s) => (
          <li key={s.phase} className={current === s.phase ? 'on' : ''}>
            <span className="rnd-tl-name">{s.label}</span>
            <span className="rnd-tl-time">
              {clockTime(times[s.from])}-{clockTime(times[s.to])} · {durationWords(times[s.to] - times[s.from])}
            </span>
          </li>
        ))}
        <li className={current === 'result' ? 'on' : ''}>
          <span className="rnd-tl-name">Result</span>
          <span className="rnd-tl-time">from {clockTime(times.settleAt)}</span>
        </li>
      </ol>
      <p className="rnd-tl-note">
        Your bet is decided by the move from the <b>strike</b> average to the <b>exit</b>. The price during bets and the
        pause does not count. Result about {afterClose} minutes after bets close, {minutes} after this round opened.
      </p>
    </div>
  )
}
