import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@capra/theme/base.css'
import '@capra/core/styles.css'
import '@capra/icons/styles.css'
import App from './App'
// App styles come last so the chart palette and layout wrappers sit on top of Capra's.
// `theme.css` first among them: it re-points Capra's dark scales, which the other two read.
import './styles/theme.css'
import './styles/viz.css'
import './styles/app.css'

/**
 * The dashboard is dark-only.
 *
 * `index.html` carries the class so the first paint is already near-black, and this
 * line covers the case where the app is mounted into a host document we did not
 * write — Capra's dark scope has to be on the root element, because Drawers and
 * Popovers render through a portal at body level rather than inside the app tree.
 */
document.documentElement.classList.add('dark')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
