import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useAppStore } from '../../app/store'
import type { ObjectCategory, ObjectDefinition } from '../../core/types'

const CATEGORIES: { id: ObjectCategory; label: string }[] = [
  { id: 'building', label: 'Building' },
  { id: 'prop', label: 'Prop' },
  { id: 'vegetation', label: 'Vegetation' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'custom', label: 'Custom' }
]

const PRESET_COLORS = [
  '#8B7355', '#A0896C', '#6B5B4A', '#7A5A3A', '#9A7A5A',
  '#606070', '#B09878', '#707060', '#2D5A27', '#3A7A33',
  '#4A4A4A', '#8B6914', '#CD853F', '#4682B4', '#696969',
  '#6B4226', '#B06030', '#aa3333', '#3333aa', '#B8860B'
]

export function ObjectCreator() {
  const [collapsed, setCollapsed] = useState(true)
  const addDef = useAppStore((s) => s.addObjectDefinition)
  const removeDef = useAppStore((s) => s.removeObjectDefinition)
  const objectDefs = useAppStore((s) => s.objectDefinitions)

  const [name, setName] = useState('')
  const [category, setCategory] = useState<ObjectCategory>('prop')
  const [color, setColor] = useState('#8B7355')
  const [footW, setFootW] = useState(1)
  const [footH, setFootH] = useState(1)
  const [tags, setTags] = useState('')

  const handleCreate = () => {
    if (!name.trim()) return

    const def: ObjectDefinition = {
      id: `custom_${uuid().slice(0, 8)}`,
      name: name.trim(),
      category,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      color,
      footprint: { w: footW, h: footH },
      styleSetSlots: category === 'building' ? ['wall', 'roof', 'door', 'window'] : []
    }

    addDef(def)
    setName('')
    setTags('')
  }

  // Count custom assets
  const customCount = objectDefs.filter((d) => d.id.startsWith('custom_')).length

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Create Asset</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          {/* Name */}
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Market Stall"
            style={{ marginBottom: 6 }}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />

          {/* Category */}
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ObjectCategory)}
            style={{ marginBottom: 6 }}
          >
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>

          {/* Footprint */}
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>
            Footprint: {footW}x{footH} tiles
          </label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Width</div>
              <input
                type="range" min={1} max={6} value={footW}
                onChange={(e) => setFootW(Number(e.target.value))}
              />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Height</div>
              <input
                type="range" min={1} max={6} value={footH}
                onChange={(e) => setFootH(Number(e.target.value))}
              />
            </div>
          </div>

          {/* Color */}
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>Color</label>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
            {PRESET_COLORS.map((c) => (
              <div
                key={c}
                onClick={() => setColor(c)}
                style={{
                  width: 18, height: 18,
                  backgroundColor: c,
                  borderRadius: 3,
                  cursor: 'pointer',
                  border: color === c ? '2px solid var(--highlight)' : '1px solid rgba(255,255,255,0.15)'
                }}
              />
            ))}
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              style={{ width: 18, height: 18, padding: 0, border: 'none', cursor: 'pointer' }}
            />
          </div>

          {/* Tags */}
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>
            Tags (comma-separated)
          </label>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="e.g. decoration, market"
            style={{ marginBottom: 8 }}
          />

          {/* Preview */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: 'var(--bg-dark)', borderRadius: 3, padding: 8, marginBottom: 8
          }}>
            <div style={{
              width: footW * 16, height: footH * 16,
              backgroundColor: color,
              borderRadius: category === 'building' ? 2 : footW === 1 && footH === 1 ? 8 : 4,
              border: '1px solid rgba(255,255,255,0.2)',
              minWidth: 16, minHeight: 16
            }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{name || 'Untitled'}</div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                {category} &middot; {footW}x{footH}
              </div>
            </div>
          </div>

          <button
            onClick={handleCreate}
            className="active"
            style={{ width: '100%', padding: '6px 10px' }}
            disabled={!name.trim()}
          >
            Create Asset
          </button>

          {/* Custom assets list with delete */}
          {customCount > 0 && (
            <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 4 }}>
                Custom Assets ({customCount})
              </div>
              <div className="item-list">
                {objectDefs.filter((d) => d.id.startsWith('custom_')).map((d) => (
                  <div key={d.id} className="item-row">
                    <div className="item-color" style={{ backgroundColor: d.color }} />
                    <span className="item-name">{d.name}</span>
                    <span className="item-meta">{d.footprint.w}x{d.footprint.h}</span>
                    <button
                      style={{ width: 20, height: 20, padding: 0, fontSize: 10 }}
                      onClick={() => removeDef(d.id)}
                    >x</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
