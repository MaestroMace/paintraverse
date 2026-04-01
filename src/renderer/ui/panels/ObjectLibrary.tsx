import { useState } from 'react'
import { useAppStore } from '../../app/store'

export function ObjectLibrary() {
  const [collapsed, setCollapsed] = useState(false)
  const objectDefinitions = useAppStore((s) => s.objectDefinitions)
  const selectedDefinitionId = useAppStore((s) => s.selectedDefinitionId)
  const setSelectedDefinitionId = useAppStore((s) => s.setSelectedDefinitionId)
  const setActiveTool = useAppStore((s) => s.setActiveTool)
  const [filter, setFilter] = useState('')

  const filtered = objectDefinitions.filter(
    (d) =>
      d.name.toLowerCase().includes(filter.toLowerCase()) ||
      d.category.toLowerCase().includes(filter.toLowerCase())
  )

  // Group by category
  const grouped = filtered.reduce(
    (acc, d) => {
      if (!acc[d.category]) acc[d.category] = []
      acc[d.category].push(d)
      return acc
    },
    {} as Record<string, typeof filtered>
  )

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Objects</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          <input
            type="text"
            placeholder="Filter objects..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ marginBottom: 6 }}
          />
          <div className="item-list">
            {Object.entries(grouped).map(([category, defs]) => (
              <div key={category}>
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--text-dim)',
                    textTransform: 'uppercase',
                    padding: '4px 8px 2px',
                    letterSpacing: '0.5px'
                  }}
                >
                  {category}
                </div>
                {defs.map((d) => (
                  <div
                    key={d.id}
                    className={`item-row ${selectedDefinitionId === d.id ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedDefinitionId(d.id)
                      setActiveTool('place')
                    }}
                  >
                    <div className="item-color" style={{ backgroundColor: d.color }} />
                    <span className="item-name">{d.name}</span>
                    <span className="item-meta">
                      {d.footprint.w}x{d.footprint.h}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
