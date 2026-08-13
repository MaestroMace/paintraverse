import { useState } from 'react'
import { useAppStore } from '../../app/store'
import { EditorCanvas } from '../../editor/EditorCanvas'
import { getActiveEditorViewport } from '../../editor/EditorViewport'
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

/**
 * Phone layout.
 *
 * The first attempt kept the desktop shape — two 232px rails — and just slid
 * them in from the side when narrow. That is not a mobile layout, it is a
 * desktop layout hidden behind a handle, and it showed: opening the right
 * rail to reach Render covered three quarters of the screen with a scrolling
 * column, and the only 3D visible was the render panel's thumbnail. The thing
 * the app exists to show ended up as a small picture inside a menu.
 *
 * So the structure is inverted here. The viewport is not a column between two
 * panels — it IS the screen, always, full bleed. Controls are grouped into
 * four tabs along the bottom, where a thumb actually reaches, and a tab opens
 * a sheet that covers the LOWER part of the screen only, so the town stays
 * visible above it while you drag a slider. Tapping the open tab again, or
 * anywhere above the sheet, dismisses it.
 *
 * The panel components are reused verbatim — this is a different arrangement
 * of the same controls, not a second implementation of them, so nothing here
 * can drift from the desktop behaviour.
 */

type TabId = 'build' | 'objects' | 'world' | 'render'

const TABS: { id: TabId; glyph: string; label: string }[] = [
  { id: 'build',   glyph: '◈', label: 'Build' },
  { id: 'objects', glyph: '▣', label: 'Objects' },
  { id: 'world',   glyph: '☀', label: 'World' },
  { id: 'render',  glyph: '◐', label: 'Render' },
]

export function MobileShell() {
  const view3D = useAppStore((s) => s.view3D)
  const setView3D = useAppStore((s) => s.setView3D)
  const map = useAppStore((s) => s.map)
  // null = sheet closed, viewport owns the whole screen.
  const [tab, setTab] = useState<TabId | null>(null)

  // Panning and pinching are only half of navigating a map — the other half
  // is getting back. Without this the way to see the whole town again is to
  // pinch out by eye until it happens to fit, which is a thing nobody does.
  const fitPlan = () =>
    getActiveEditorViewport()?.centerView(map.gridWidth, map.gridHeight, map.tileSize)

  return (
    <div className="app-body mobile-shell">
      <div className="mobile-viewport">
        {view3D ? <ThreeViewport /> : <EditorCanvas />}

        {/* Floating 2D/3D switch. The single control worth reaching without
            opening anything — it is the difference between reading the plan
            and standing in the town. */}
        <div className="mobile-viewswitch">
          <button
            className={!view3D ? 'active' : ''}
            onClick={() => setView3D(false)}
          >2D</button>
          <button
            className={view3D ? 'active' : ''}
            onClick={() => setView3D(true)}
          >3D</button>
        </div>

        {/* Fit the whole plan back on screen. 2D only — the 3D view is a
            walkaround and has no such thing as "the whole map". */}
        {!view3D && (
          <button className="mobile-fit" onClick={fitPlan} aria-label="Fit map to screen">
            {'\u29C9'}
          </button>
        )}
      </div>

      {/* Tapping the town above the sheet closes it — the sheet is a transient
          thing you pull up, not a place you navigate into. Deliberately only
          covers the area ABOVE the sheet so it never blocks the controls. */}
      {tab && <div className="mobile-sheet-scrim" onClick={() => setTab(null)} />}

      {tab && (
        <div className="mobile-sheet">
          <div className="mobile-sheet-grip" onClick={() => setTab(null)} />
          <div className="mobile-sheet-body">
            {tab === 'build' && (<><GenerationPanel /><InspirationPanel /></>)}
            {tab === 'objects' && (
              <><ObjectLibrary /><ObjectCreator /><TextureBrowser /><StyleSetEditor /></>
            )}
            {tab === 'world' && (
              <><EnvironmentPanel /><LayerPanel /><PropertyInspector /></>
            )}
            {tab === 'render' && (<><RenderPanel /><ManifestPanel /></>)}
          </div>
        </div>
      )}

      <nav className="mobile-tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            // Tapping the open tab closes the sheet, so the same thumb motion
            // that opened it puts it away.
            onClick={() => setTab(tab === t.id ? null : t.id)}
          >
            <span className="mobile-tab-glyph">{t.glyph}</span>
            <span className="mobile-tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
