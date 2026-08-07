import { useEffect, useState } from 'react'
import { Toolbar } from '../ui/toolbar/Toolbar'
import { ModeSelector } from '../ui/menu/ModeSelector'
import { LandscapeMode } from '../ui/modes/LandscapeMode'
import { AssetCreatorMode } from '../ui/modes/AssetCreatorMode'
import { TransitionOverlay } from '../ui/effects/TransitionOverlay'
import { SparkleField } from '../ui/effects/SparkleField'
// Ensure generators are registered
import '../generation/GeneratorRegistry'
import { useAppStore } from './store'
import { platform } from '../core/platform'
import './App.css'
import './kh1-theme.css'

export function App() {
  const projectName = useAppStore((s) => s.projectName)
  const dirty = useAppStore((s) => s.dirty)
  const appMode = useAppStore((s) => s.appMode)
  const [transitioning, setTransitioning] = useState(false)
  const [prevMode, setPrevMode] = useState(appMode)

  // Detect mode changes for transition
  useEffect(() => {
    if (appMode !== prevMode) {
      setTransitioning(true)
      const t = setTimeout(() => {
        setTransitioning(false)
        setPrevMode(appMode)
      }, 500)
      return () => clearTimeout(t)
    }
  }, [appMode, prevMode])

  // Wire up menu actions from Electron
  useEffect(() => {
    // Menus only exist under Electron; platform.onMenuAction is a no-op
    // elsewhere, and the handlers below go through the shim so Save/Open
    // work in the browser and the Android WebView too.
    platform.onMenuAction(async (action) => {
      const store = useAppStore.getState()

      switch (action) {
        case 'new': {
          if (store.dirty) {
            // TODO: confirm discard
          }
          store.loadFromJSON(JSON.stringify({
            projectName: 'Untitled Project',
            map: null
          }))
          break
        }

        case 'open': {
          const path = await platform.openDialog()
          if (path) {
            const data = await platform.readFile(path)
            store.loadFromJSON(data)
            store.setProjectPath(path)
          }
          break
        }

        case 'save': {
          let path = store.projectPath
          if (!path) {
            path = await platform.saveDialog()
          }
          if (path) {
            await platform.writeFile(path, store.toJSON())
            store.setProjectPath(path)
            store.setDirty(false)
          }
          break
        }

        case 'save-as': {
          const path = await platform.saveDialog(store.projectPath || undefined)
          if (path) {
            await platform.writeFile(path, store.toJSON())
            store.setProjectPath(path)
            store.setDirty(false)
          }
          break
        }

        case 'undo':
          store.undo()
          break

        case 'redo':
          store.redo()
          break

        case 'delete':
          // Handled by keyboard shortcut in EditorCanvas
          break
      }
    })
  }, [])

  // Menu mode - full screen selector
  if (appMode === 'menu') {
    return (
      <div className="app">
        <ModeSelector />
        <TransitionOverlay active={transitioning} />
      </div>
    )
  }

  return (
    <div className="app">
      <Toolbar />

      {appMode === 'landscape' && <LandscapeMode />}
      {appMode === 'asset-creator' && (
        <div className="app-body">
          <AssetCreatorMode />
        </div>
      )}

      <div className="status-bar">
        <span>{projectName}{dirty ? ' *' : ''}</span>
        <span className="status-mode">{appMode === 'landscape' ? 'Landscape Editor' : 'Asset Creator'}</span>
        {appMode === 'landscape' && (
          <span>Grid: {useAppStore.getState().map.gridWidth}x{useAppStore.getState().map.gridHeight}</span>
        )}
      </div>

      {/* Subtle sparkle overlay on the whole app */}
      <SparkleField count={8} color="rgba(100, 160, 255, 0.3)" />

      <TransitionOverlay active={transitioning} />
    </div>
  )
}
