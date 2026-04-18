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
import './App.css'
import './kh1-theme.css'

// Declare the Electron API type on window
declare global {
  interface Window {
    electronAPI?: {
      saveDialog: (defaultPath?: string) => Promise<string | null>
      openDialog: () => Promise<string | null>
      openImageDialog: () => Promise<string | null>
      writeFile: (path: string, data: string) => Promise<boolean>
      readFile: (path: string) => Promise<string>
      readImageAsDataURL: (path: string) => Promise<string>
      onMenuAction: (callback: (action: string) => void) => void
    }
  }
}

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
    if (!window.electronAPI) return

    window.electronAPI.onMenuAction(async (action) => {
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
          const path = await window.electronAPI!.openDialog()
          if (path) {
            const data = await window.electronAPI!.readFile(path)
            store.loadFromJSON(data)
            store.setProjectPath(path)
          }
          break
        }

        case 'save': {
          let path = store.projectPath
          if (!path) {
            path = await window.electronAPI!.saveDialog()
          }
          if (path) {
            await window.electronAPI!.writeFile(path, store.toJSON())
            store.setProjectPath(path)
            store.setDirty(false)
          }
          break
        }

        case 'save-as': {
          const path = await window.electronAPI!.saveDialog(store.projectPath || undefined)
          if (path) {
            await window.electronAPI!.writeFile(path, store.toJSON())
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
