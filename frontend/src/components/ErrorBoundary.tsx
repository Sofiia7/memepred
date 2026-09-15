import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * The only error boundary in the app (confirmed by grep before adding this -
 * there was none). A render throw anywhere below this point used to white-
 * screen the whole app with nothing on screen and nothing to click; this at
 * least leaves a page that says something went wrong and offers a reload,
 * which is the difference between a bug report and a support ticket that
 * starts with "the site is just blank".
 *
 * Deliberately minimal: this does not attempt to recover in place (React
 * error boundaries cannot re-render the failed subtree safely without more
 * state than is worth adding here) or report the error anywhere - it exists
 * to catch what the stake-input validation fix (usePlaceBet's amountWei, and
 * Composer's stakeInput) was written to prevent from throwing in the first
 * place, as a second line of defence for whatever the next one turns out to
 * be.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    // No error-reporting service wired up yet; console is the only sink.
    console.error('Unhandled render error:', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'JetBrains Mono, monospace',
          background: '#000', color: '#fff', padding: 24, textAlign: 'center',
        }}>
          <div style={{ maxWidth: 420 }}>
            <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 8 }}>FLIPTHEMEME</div>
            <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>Something went wrong</h1>
            <p style={{ color: '#ccc', fontSize: 13, lineHeight: 1.5, marginBottom: 20 }}>
              This screen hit an unexpected error. Reloading usually fixes it;
              nothing you were doing has been lost on-chain.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '10px 20px', borderRadius: 8, background: '#4d8dff',
                color: '#fff', fontWeight: 700, fontSize: 13,
              }}
            >
              RELOAD
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
