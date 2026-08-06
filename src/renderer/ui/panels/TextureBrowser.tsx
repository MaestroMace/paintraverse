import { useState } from 'react'
import { useAppStore } from '../../app/store'
import { TERRAIN_NAMES, TERRAIN_COLORS } from '../../editor/layers/TerrainLayer'

export function TextureBrowser() {
  const [collapsed, setCollapsed] = useState(false)
  const activeTool = useAppStore((s) => s.activeTool)
  const brushTileId = useAppStore((s) => s.brushTileId)
  const setBrushTileId = useAppStore((s) => s.setBrushTileId)
  const setActiveTool = useAppStore((s) => s.setActiveTool)

  // Swatch colours come from the editor's terrain palette so the picker
  // can't drift out of step with what the canvas draws (this used to be a
  // second, partial copy that stopped at tile 7).
  const swatch = (id: number) => '#' + (TERRAIN_COLORS[id] ?? 0x808080).toString(16).padStart(6, '0')

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Terrain / Textures</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-dim)',
              textTransform: 'uppercase',
              padding: '0 8px 4px',
              letterSpacing: '0.5px'
            }}
          >
            Terrain Tiles
          </div>
          <div className="item-list">
            {Object.entries(TERRAIN_NAMES).map(([idStr, name]) => {
              const id = Number(idStr)
              return (
                <div
                  key={id}
                  className={`item-row ${activeTool === 'brush' && brushTileId === id ? 'selected' : ''}`}
                  onClick={() => {
                    setBrushTileId(id)
                    setActiveTool('brush')
                  }}
                >
                  <div
                    className="item-color"
                    style={{ backgroundColor: swatch(id) }}
                  />
                  <span className="item-name">{name}</span>
                </div>
              )
            })}
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-dim)',
              padding: '8px 8px 4px',
              borderTop: '1px solid var(--border)',
              marginTop: 8
            }}
          >
            Custom textures will be added in Phase 2. Drag PNG files here to import.
          </div>
        </div>
      )}
    </div>
  )
}
