import { useState } from 'react'
import { useAppStore } from '../../app/store'
import { TERRAIN_NAMES } from '../../editor/layers/TerrainLayer'

export function TextureBrowser() {
  const [collapsed, setCollapsed] = useState(false)
  const activeTool = useAppStore((s) => s.activeTool)
  const brushTileId = useAppStore((s) => s.brushTileId)
  const setBrushTileId = useAppStore((s) => s.setBrushTileId)
  const setActiveTool = useAppStore((s) => s.setActiveTool)

  // Terrain tile colors for preview
  const terrainColors: Record<number, string> = {
    0: '#2d5a27',
    1: '#8b7355',
    2: '#708090',
    3: '#4682b4',
    4: '#f4e9c8',
    5: '#556b2f',
    6: '#3a3a3a',
    7: '#dcdcdc'
  }

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
                    style={{ backgroundColor: terrainColors[id] }}
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
