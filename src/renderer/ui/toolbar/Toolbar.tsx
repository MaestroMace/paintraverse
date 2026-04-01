import { useAppStore } from '../../app/store'
import type { ToolType } from '../../core/types'
import './Toolbar.css'

const toolButtons: { id: ToolType; label: string; shortcut: string }[] = [
  { id: 'select', label: 'Select', shortcut: 'V' },
  { id: 'place', label: 'Place', shortcut: 'P' },
  { id: 'erase', label: 'Erase', shortcut: 'E' },
  { id: 'brush', label: 'Brush', shortcut: 'B' },
  { id: 'camera', label: 'Camera', shortcut: 'C' }
]

export function Toolbar() {
  const activeTool = useAppStore((s) => s.activeTool)
  const setActiveTool = useAppStore((s) => s.setActiveTool)
  const undo = useAppStore((s) => s.undo)
  const redo = useAppStore((s) => s.redo)
  const undoStack = useAppStore((s) => s.undoStack)
  const redoStack = useAppStore((s) => s.redoStack)

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <span className="toolbar-logo">PainTraverse</span>
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        {toolButtons.map((t) => (
          <button
            key={t.id}
            className={activeTool === t.id ? 'active' : ''}
            onClick={() => setActiveTool(t.id)}
            title={`${t.label} (${t.shortcut})`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <button
          onClick={undo}
          disabled={undoStack.length === 0}
          title="Undo (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          onClick={redo}
          disabled={redoStack.length === 0}
          title="Redo (Ctrl+Shift+Z)"
        >
          Redo
        </button>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-group">
        <span className="toolbar-hint">
          Space+Drag: Pan | Scroll: Zoom | 1-5: Tools
        </span>
      </div>
    </div>
  )
}
