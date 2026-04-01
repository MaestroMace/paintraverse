import { useState } from 'react'
import { useAppStore } from '../../app/store'

export function LayerPanel() {
  const [collapsed, setCollapsed] = useState(false)
  const layers = useAppStore((s) => s.map.layers)
  const activeLayerId = useAppStore((s) => s.activeLayerId)
  const setActiveLayer = useAppStore((s) => s.setActiveLayer)
  const toggleVisibility = useAppStore((s) => s.toggleLayerVisibility)
  const toggleLock = useAppStore((s) => s.toggleLayerLock)

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Layers</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          <div className="item-list">
            {[...layers].reverse().map((layer) => (
              <div
                key={layer.id}
                className={`item-row ${activeLayerId === layer.id ? 'selected' : ''}`}
                onClick={() => setActiveLayer(layer.id)}
              >
                <button
                  style={{
                    width: 24,
                    height: 24,
                    padding: 0,
                    fontSize: 14,
                    opacity: layer.visible ? 1 : 0.3
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleVisibility(layer.id)
                  }}
                  title={layer.visible ? 'Hide' : 'Show'}
                >
                  {layer.visible ? '\u25C9' : '\u25CB'}
                </button>
                <span className="item-name">{layer.name}</span>
                <button
                  style={{
                    width: 24,
                    height: 24,
                    padding: 0,
                    fontSize: 11,
                    opacity: layer.locked ? 1 : 0.3
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleLock(layer.id)
                  }}
                  title={layer.locked ? 'Unlock' : 'Lock'}
                >
                  {layer.locked ? '\u{1F512}' : '\u{1F513}'}
                </button>
                <span className="item-meta">{layer.objects.length}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
