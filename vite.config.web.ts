/**
 * Standalone WEB build of the renderer — no Electron.
 *
 * The renderer is already a plain Vite + React app that happens to be hosted
 * by Electron: every dependency (three, pixi, react, zustand, immer, uuid) is
 * pure web, and the only Electron surface is seven file-I/O functions behind
 * `window.electronAPI`, which core/platform.ts now shims for the browser.
 *
 * This target exists so the app can run anywhere a WebGL2 browser does —
 * which is what makes an Android APK possible, since Electron itself has no
 * Android port. Capacitor wraps this output in a native WebView.
 *
 *   npm run build:web     -> dist-web/
 *
 * `base: './'` matters: Capacitor serves assets over a custom scheme from the
 * APK, and absolute /assets/... paths do not resolve there.
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist-web',
    emptyOutDir: true,
    // Phones have less memory headroom than a desktop Electron process, and
    // the single 2.8MB chunk is mostly three.js + pixi.js. Splitting them out
    // lets the WebView cache and parse them separately.
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          pixi: ['pixi.js'],
          react: ['react', 'react-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 1500,
  },
  plugins: [react()],
})
