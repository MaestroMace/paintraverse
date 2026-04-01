import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useAppStore } from '../../app/store'
import type { StyleSet } from '../../core/types'

export function StyleSetEditor() {
  const [collapsed, setCollapsed] = useState(false)
  const styleSets = useAppStore((s) => s.styleSets)
  const addStyleSet = useAppStore((s) => s.addStyleSet)
  const updateStyleSet = useAppStore((s) => s.updateStyleSet)
  const removeStyleSet = useAppStore((s) => s.removeStyleSet)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newSlotName, setNewSlotName] = useState('')

  const handleAddSet = () => {
    const ss: StyleSet = {
      id: uuid(),
      name: `Style Set ${styleSets.length + 1}`,
      slots: {}
    }
    addStyleSet(ss)
    setEditingId(ss.id)
  }

  const handleAddSlot = (setId: string) => {
    if (!newSlotName.trim()) return
    const ss = styleSets.find((s) => s.id === setId)
    if (!ss) return
    updateStyleSet(setId, {
      slots: {
        ...ss.slots,
        [newSlotName.trim()]: {
          variants: [{ textureId: '', weight: 1, tags: [] }],
          defaultWeight: 1
        }
      }
    })
    setNewSlotName('')
  }

  const handleAddVariant = (setId: string, slotName: string) => {
    const ss = styleSets.find((s) => s.id === setId)
    if (!ss || !ss.slots[slotName]) return
    const slot = ss.slots[slotName]
    updateStyleSet(setId, {
      slots: {
        ...ss.slots,
        [slotName]: {
          ...slot,
          variants: [...slot.variants, { textureId: '', weight: 1, tags: [] }]
        }
      }
    })
  }

  const handleRemoveSlot = (setId: string, slotName: string) => {
    const ss = styleSets.find((s) => s.id === setId)
    if (!ss) return
    const { [slotName]: _, ...rest } = ss.slots
    updateStyleSet(setId, { slots: rest })
  }

  const editing = editingId ? styleSets.find((s) => s.id === editingId) : null

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Style Sets</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          <div className="item-list" style={{ marginBottom: 6 }}>
            {styleSets.map((ss) => (
              <div
                key={ss.id}
                className={`item-row ${editingId === ss.id ? 'selected' : ''}`}
                onClick={() => setEditingId(editingId === ss.id ? null : ss.id)}
              >
                <span className="item-name">{ss.name}</span>
                <span className="item-meta">{Object.keys(ss.slots).length} slots</span>
                <button
                  style={{ width: 20, height: 20, padding: 0, fontSize: 10 }}
                  onClick={(e) => {
                    e.stopPropagation()
                    removeStyleSet(ss.id)
                    if (editingId === ss.id) setEditingId(null)
                  }}
                >
                  x
                </button>
              </div>
            ))}
          </div>
          <button onClick={handleAddSet} style={{ width: '100%', marginBottom: 6 }}>
            + New Style Set
          </button>

          {editing && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
              <div style={{ marginBottom: 4 }}>
                <input
                  value={editing.name}
                  onChange={(e) => updateStyleSet(editing.id, { name: e.target.value })}
                  style={{ fontWeight: 600 }}
                />
              </div>

              {Object.entries(editing.slots).map(([slotName, slot]) => (
                <div
                  key={slotName}
                  style={{
                    background: 'var(--bg-dark)',
                    borderRadius: 3,
                    padding: 6,
                    marginBottom: 4
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 600 }}>{slotName}</span>
                    <button
                      style={{ width: 16, height: 16, padding: 0, fontSize: 9 }}
                      onClick={() => handleRemoveSlot(editing.id, slotName)}
                    >
                      x
                    </button>
                  </div>
                  {slot.variants.map((v, i) => (
                    <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 2, fontSize: 11 }}>
                      <input
                        placeholder="texture id"
                        value={v.textureId}
                        onChange={(e) => {
                          const newVariants = [...slot.variants]
                          newVariants[i] = { ...v, textureId: e.target.value }
                          updateStyleSet(editing.id, {
                            slots: {
                              ...editing.slots,
                              [slotName]: { ...slot, variants: newVariants }
                            }
                          })
                        }}
                        style={{ flex: 1 }}
                      />
                      <input
                        type="number"
                        value={v.weight}
                        onChange={(e) => {
                          const newVariants = [...slot.variants]
                          newVariants[i] = { ...v, weight: Number(e.target.value) }
                          updateStyleSet(editing.id, {
                            slots: {
                              ...editing.slots,
                              [slotName]: { ...slot, variants: newVariants }
                            }
                          })
                        }}
                        style={{ width: 40 }}
                        min={0}
                        step={0.1}
                      />
                    </div>
                  ))}
                  <button
                    onClick={() => handleAddVariant(editing.id, slotName)}
                    style={{ fontSize: 10, padding: '1px 6px', marginTop: 2 }}
                  >
                    + variant
                  </button>
                </div>
              ))}

              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                <input
                  placeholder="New slot name (e.g. door, window)"
                  value={newSlotName}
                  onChange={(e) => setNewSlotName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddSlot(editing.id)}
                />
                <button onClick={() => handleAddSlot(editing.id)} style={{ flexShrink: 0 }}>+</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
