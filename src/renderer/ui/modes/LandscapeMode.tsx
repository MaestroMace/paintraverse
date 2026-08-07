import { useState, useEffect } from 'react'
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
import { isMobileLayout, MOBILE_LAYOUT_QUERY } from '../../core/platform'
import { MobileShell } from './MobileShell'

export function LandscapeMode() {
  // Both rails start collapsed on a phone. At 232px each they consume 464px
  // of a 412px screen, so the viewport — the entire point of the app — is
  // squeezed to nothing. On phones they become slide-over drawers (see the
  // matching media query in App.css) rather than layout columns.
  //
  // This MUST be live, not read once at mount. It was `window.innerWidth <
  // 820` evaluated on first render, so rotating the phone kept whatever
  // layout it booted with — and since a Pixel is 915px wide in landscape, it
  // did not consider itself a phone at all.
  const [narrow, setNarrow] = useState(isMobileLayout)
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_LAYOUT_QUERY)
    const onChange = (e: MediaQueryListEvent) => {
      setNarrow(e.matches)
      // Entering the phone layout closes both rails so the viewport is not
      // left covered by two drawers the user never opened.
      if (!e.matches) { setLeftCollapsed(false); setRightCollapsed(false) }
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const [leftCollapsed, setLeftCollapsed] = useState(narrow)
  const [rightCollapsed, setRightCollapsed] = useState(narrow)
  const view3D = useAppStore((s) => s.view3D)

  // Phones get a different shell entirely, not this one with the rails
  // hidden — see MobileShell for why that distinction matters.
  if (narrow) return <MobileShell />

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
