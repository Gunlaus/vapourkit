import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

declare const __APP_VERSION__: string
document.title = `Vapourkit v${__APP_VERSION__}`

const isTauri = '__TAURI_INTERNALS__' in window

// Keep the existing Electron app untouched until its IPC surface has a
// functional Tauri implementation. Never mount it with missing electronAPI.
const Root = React.lazy(() =>
  isTauri
    ? import('./TauriMigrationStatus')
    : import('./App')
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <React.Suspense fallback={<div>Loading Vapourkit...</div>}>
      <Root />
    </React.Suspense>
  </React.StrictMode>,
)
