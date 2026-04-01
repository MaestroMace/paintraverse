import { useState } from 'react'
import { useAppStore } from '../../app/store'

export function PropertyInspector() {
  const [collapsed, setCollapsed] = useState(false)
  const selectedIds = useAppStore((s) => s.selectedObjectIds)
  const map = useAppStore((s) => s.map)
  const objectDefinitions = useAppStore((s) => s.objectDefinitions)

  // Find the selected object(s)
  const selectedObjects = selectedIds.map((id) => {
    for (const layer of map.layers) {
      const obj = layer.objects.find((o) => o.id === id)
      if (obj) return { obj, layer }
    }
    return null
  }).filter(Boolean) as { obj: (typeof map.layers)[0]['objects'][0]; layer: (typeof map.layers)[0] }[]

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Properties</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          {selectedObjects.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 11, padding: 4 }}>
              No object selected
            </div>
          ) : selectedObjects.length === 1 ? (
            <SingleObjectProps
              obj={selectedObjects[0].obj}
              layer={selectedObjects[0].layer}
              objectDefs={objectDefinitions}
            />
          ) : (
            <div style={{ color: 'var(--text-dim)', fontSize: 11, padding: 4 }}>
              {selectedObjects.length} objects selected
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SingleObjectProps({
  obj,
  layer,
  objectDefs
}: {
  obj: { id: string; definitionId: string; x: number; y: number; rotation: number; elevation: number }
  layer: { name: string }
  objectDefs: { id: string; name: string; category: string; footprint: { w: number; h: number } }[]
}) {
  const def = objectDefs.find((d) => d.id === obj.definitionId)

  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr', gap: '4px 8px' }}>
        <span style={{ color: 'var(--text-dim)' }}>Type</span>
        <span>{def?.name || obj.definitionId}</span>

        <span style={{ color: 'var(--text-dim)' }}>Category</span>
        <span>{def?.category || '—'}</span>

        <span style={{ color: 'var(--text-dim)' }}>Layer</span>
        <span>{layer.name}</span>

        <span style={{ color: 'var(--text-dim)' }}>Position</span>
        <span>{obj.x}, {obj.y}</span>

        <span style={{ color: 'var(--text-dim)' }}>Size</span>
        <span>{def?.footprint.w || 1}x{def?.footprint.h || 1}</span>

        <span style={{ color: 'var(--text-dim)' }}>Rotation</span>
        <span>{obj.rotation}&deg;</span>

        <span style={{ color: 'var(--text-dim)' }}>Elevation</span>
        <span>{obj.elevation}</span>

        <span style={{ color: 'var(--text-dim)' }}>ID</span>
        <span style={{ fontSize: 9, color: 'var(--text-dim)', wordBreak: 'break-all' }}>
          {obj.id}
        </span>
      </div>
    </div>
  )
}
