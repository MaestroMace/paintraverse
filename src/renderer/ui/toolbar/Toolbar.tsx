import { useAppStore } from '../../app/store'
import type { ToolType, AppMode } from '../../core/types'
import './Toolbar.css'

const toolButtons: { id: ToolType; label: string; shortcut: string }[] = [
  { id: 'select', label: 'Select', shortcut: 'V' },
  { id: 'place', label: 'Place', shortcut: 'P' },
  { id: 'erase', label: 'Erase', shortcut: 'E' },
  { id: 'brush', label: 'Brush', shortcut: 'B' },
  { id: 'camera', label: 'Camera', shortcut: 'C' }
]

const modeLabels: Record<AppMode, string> = {
  menu: 'Menu',
  landscape: 'Landscape',
  'asset-creator': 'Assets'
}

export function Toolbar() {
  const activeTool = useAppStore((s) => s.activeTool)
  const setActiveTool = useAppStore((s) => s.setActiveTool)
  const appMode = useAppStore((s) => s.appMode)
  const setAppMode = useAppStore((s) => s.setAppMode)
  const undo = useAppStore((s) => s.undo)
  const redo = useAppStore((s) => s.redo)
  const undoStack = useAppStore((s) => s.undoStack)
  const redoStack = useAppStore((s) => s.redoStack)
  const view3D = useAppStore((s) => s.view3D)
  const setView3D = useAppStore((s) => s.setView3D)

  return (
    <div className="toolbar">
      {/* Logo + mode switcher */}
      <div className="toolbar-group">
        <span className="toolbar-logo">PainTraverse</span>
        <div className="toolbar-mode-switcher">
          <button
            className={`toolbar-mode-btn ${appMode === 'landscape' ? 'active' : ''}`}
            onClick={() => setAppMode('landscape')}
            title="Landscape Editor"
          >
            {'\u{1F3DE}'} Landscape
          </button>
          <button
            className={`toolbar-mode-btn ${appMode === 'asset-creator' ? 'active' : ''}`}
            onClick={() => setAppMode('asset-creator')}
            title="Asset Creator"
          >
            {'\u2728'} Assets
          </button>
        </div>
      </div>

      <div className="toolbar-divider" />

      {/* Tool buttons - only show in landscape mode */}
      {appMode === 'landscape' && (
        <>
          <div className="toolbar-group">
            {toolButtons.map((t) => (
              <button
                key={t.id}
                className={`toolbar-tool-btn ${activeTool === t.id ? 'active' : ''}`}
                onClick={() => setActiveTool(t.id)}
                title={`${t.label} (${t.shortcut})`}
              >
                {t.label}
                <span className="toolbar-kbd">{t.shortcut}</span>
              </button>
            ))}
          </div>

          <div className="toolbar-divider" />

          <div className="toolbar-group">
            <button
              className="toolbar-action-btn"
              onClick={undo}
              disabled={undoStack.length === 0}
              title="Undo (Ctrl+Z)"
            >
              Undo
            </button>
            <button
              className="toolbar-action-btn"
              onClick={redo}
              disabled={redoStack.length === 0}
              title="Redo (Ctrl+Shift+Z)"
            >
              Redo
            </button>
          </div>
        </>
      )}

      <div className="toolbar-spacer" />

      {/* Right side */}
      <div className="toolbar-group">
        {appMode === 'landscape' && (
          <div className="toolbar-view-toggle" title="Switch between the 2D editor and the 3D walkthrough">
            <button
              className={`toolbar-view-btn ${!view3D ? 'active' : ''}`}
              onClick={() => setView3D(false)}
              title="2D top-down editor"
            >
              2D
            </button>
            <button
              className={`toolbar-view-btn ${view3D ? 'active' : ''}`}
              onClick={() => setView3D(true)}
              title="3D walkthrough"
            >
              3D
            </button>
          </div>
        )}
        <button
          className="toolbar-home-btn"
          onClick={() => setAppMode('menu')}
          title="Back to menu"
        >
          {'\u{2302}'}
        </button>
        <span className="toolbar-hint">
          {appMode === 'landscape'
            ? 'Space+Drag: Pan | Scroll: Zoom'
            : 'Search & create game assets'}
        </span>
      </div>
    </div>
  )
}
