import { useState } from 'react'
import { EditorCanvas } from '../../editor/EditorCanvas'
import { GenerationPanel } from '../panels/GenerationPanel'
import { InspirationPanel } from '../panels/InspirationPanel'
import { ObjectLibrary } from '../panels/ObjectLibrary'
import { ObjectCreator } from '../panels/ObjectCreator'
import { TextureBrowser } from '../panels/TextureBrowser'
import { StyleSetEditor } from '../panels/StyleSetEditor'
import { RenderPanel } from '../panels/RenderPanel'
import { EnvironmentPanel } from '../panels/EnvironmentPanel'
import { LayerPanel } from '../panels/LayerPanel'
import { PropertyInspector } from '../panels/PropertyInspector'
import { ManifestPanel } from '../panels/ManifestPanel'

export function LandscapeMode() {
  const [leftCollapsed, setLeftCollapsed] = useState(true)

  return (
    <div className="app-body">
      {!leftCollapsed && (
        <div className="left-panel">
          <GenerationPanel />
          <InspirationPanel />
          <ObjectLibrary />
          <ObjectCreator />
          <TextureBrowser />
          <StyleSetEditor />
        </div>
      )}
      <div style={{ position: 'relative', flex: 1, display: 'flex', overflow: 'hidden' }}>
        <button
          onClick={() => setLeftCollapsed(!leftCollapsed)}
          className="panel-toggle left-toggle"
          title={leftCollapsed ? 'Show tools panel' : 'Hide tools panel'}
        >
          {leftCollapsed ? '\u25B6' : '\u25C0'}
        </button>
        <EditorCanvas />
      </div>
      <div className="right-panel">
        <RenderPanel />
        <EnvironmentPanel />
        <LayerPanel />
        <PropertyInspector />
        <ManifestPanel />
      </div>
    </div>
  )
}
