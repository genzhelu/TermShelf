import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('TermShelf renderer crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="fatal-error" data-testid="fatal-error">
          <h1>Something went wrong</h1>
          <p>The TermShelf interface hit an unexpected error.</p>
          <pre className="fatal-error__message">{this.state.error.message}</pre>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => window.location.reload()}
          >
            Reload TermShelf
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
