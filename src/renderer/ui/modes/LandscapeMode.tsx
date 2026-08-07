import { useState } from 'react'
import { useAppStore } from '../../app/store'
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
  // Both rails start collapsed on a phone. At 232px each they consume 464px
  // of a 412px screen, so the viewport — the entire point of the app — was
  // squeezed to nothing. On narrow screens they become slide-over drawers
  // (see the media query in App.css) rather than layout columns.
  const narrow = typeof window !== 'undefined' && window.innerWidth < 820
  const [leftCollapsed, setLeftCollapsed] = useState(narrow)
  const [rightCollapsed, setRightCollapsed] = useState(narrow)
  const view3D = useAppStore((s) => s.view3D)

  // An open drawer covers its own handle at 80vw, so without this there is
  // no way to close it again on a phone. Tap-outside-to-close is the standard
  // drawer affordance and costs one element.
  const scrim = (close: () => void) => (
    <div className="drawer-scrim" onClick={close} onTouchStart={close} />
  )

  return (
    <div className="app-body">
      {narrow && !leftCollapsed && scrim(() => setLeftCollapsed(true))}
      {narrow && !rightCollapsed && scrim(() => setRightCollapsed(true))}
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
        <button
          onClick={() => setRightCollapsed(!rightCollapsed)}
          className="panel-toggle right-toggle"
          title={rightCollapsed ? 'Show render panel' : 'Hide render panel'}
        >
          {rightCollapsed ? '\u25C0' : '\u25B6'}
        </button>
        {view3D ? <ThreeViewport /> : <EditorCanvas />}
      </div>
      {!rightCollapsed && (
      <div className="right-panel">
        <RenderPanel />
        <EnvironmentPanel />
        <LayerPanel />
        <PropertyInspector />
        <ManifestPanel />
      </div>
      )}
    </div>
  )
}
