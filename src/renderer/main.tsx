import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { installDebugBridge } from './debug/DebugBridge'

// window.__pt — inspect/drive the running app from devtools or headless tooling.
installDebugBridge()

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
