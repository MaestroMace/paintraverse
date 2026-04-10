import { useState } from 'react'
import { EditorCanvas } from '../../editor/EditorCanvas'
import { ThreeViewport } from '../components/ThreeViewport'
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
  const [view3D, setView3D] = useState(false)

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
        {/* Toggle between 2D editor and 3D walkthrough */}
        <button
          onClick={() => setView3D(!view3D)}
          style={{
            position: 'absolute', top: 8, right: 8, zIndex: 20,
            padding: '6px 14px', fontSize: 12, fontWeight: 700,
            background: view3D
              ? 'linear-gradient(135deg, #2a6a3a, #1a4a2a)'
              : 'linear-gradient(135deg, rgba(20,28,56,0.9), rgba(14,20,44,0.9))',
            color: view3D ? '#4ade80' : 'var(--text)',
            border: `1px solid ${view3D ? '#4ade80' : 'rgba(100,140,255,0.2)'}`,
            borderRadius: 6, cursor: 'pointer',
          }}
        >
          {view3D ? 'Exit 3D' : 'Enter 3D World'}
        </button>
        {view3D ? <ThreeViewport /> : <EditorCanvas />}
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
