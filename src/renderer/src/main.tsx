import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/app.css'

// Intentionally no <StrictMode>: the app mounts real PTY sessions and xterm
// instances in effects, and React 19's development double-mount would spawn
// duplicate shells.
const container = document.getElementById('root')
if (!container) {
  throw new Error('TermShelf root element is missing')
}

createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
