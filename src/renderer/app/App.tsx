import { useEffect } from 'react'
import { EditorCanvas } from '../editor/EditorCanvas'
import { Toolbar } from '../ui/toolbar/Toolbar'
import { ManifestPanel } from '../ui/panels/ManifestPanel'
import { ObjectLibrary } from '../ui/panels/ObjectLibrary'
import { PropertyInspector } from '../ui/panels/PropertyInspector'
import { LayerPanel } from '../ui/panels/LayerPanel'
import { TextureBrowser } from '../ui/panels/TextureBrowser'
import { StyleSetEditor } from '../ui/panels/StyleSetEditor'
import { GenerationPanel } from '../ui/panels/GenerationPanel'
import { EnvironmentPanel } from '../ui/panels/EnvironmentPanel'
import { RenderPanel } from '../ui/panels/RenderPanel'
// Ensure generators are registered
import '../generation/GeneratorRegistry'
import { useAppStore } from './store'
import './App.css'

// Declare the Electron API type on window
declare global {
  interface Window {
    electronAPI?: {
      saveDialog: (defaultPath?: string) => Promise<string | null>
      openDialog: () => Promise<string | null>
      writeFile: (path: string, data: string) => Promise<boolean>
      readFile: (path: string) => Promise<string>
      onMenuAction: (callback: (action: string) => void) => void
    }
  }
}

export function App() {
  const projectName = useAppStore((s) => s.projectName)
  const dirty = useAppStore((s) => s.dirty)

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

  return (
    <div className="app">
      <Toolbar />
      <div className="app-body">
        <div className="left-panel">
          <GenerationPanel />
          <ObjectLibrary />
          <TextureBrowser />
          <StyleSetEditor />
        </div>
        <EditorCanvas />
        <div className="right-panel">
          <LayerPanel />
          <PropertyInspector />
          <EnvironmentPanel />
          <RenderPanel />
          <ManifestPanel />
        </div>
      </div>
      <div className="status-bar">
        <span>{projectName}{dirty ? ' *' : ''}</span>
        <span>Grid: {useAppStore.getState().map.gridWidth}x{useAppStore.getState().map.gridHeight}</span>
      </div>
    </div>
  )
}
