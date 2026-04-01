import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useAppStore } from '../../app/store'
import type { ManifestEntry } from '../../core/types'

export function ManifestPanel() {
  const [collapsed, setCollapsed] = useState(false)
  const manifest = useAppStore((s) => s.manifest)
  const addEntry = useAppStore((s) => s.addManifestEntry)
  const updateEntry = useAppStore((s) => s.updateManifestEntry)
  const removeEntry = useAppStore((s) => s.removeManifestEntry)
  const [newTitle, setNewTitle] = useState('')

  const handleAdd = () => {
    if (!newTitle.trim()) return
    const entry: ManifestEntry = {
      id: uuid(),
      title: newTitle.trim(),
      status: 'todo',
      linkedAssets: [],
      notes: '',
      priority: manifest.length
    }
    addEntry(entry)
    setNewTitle('')
  }

  const statusColors: Record<string, string> = {
    todo: 'var(--text-dim)',
    'in-progress': 'var(--info)',
    done: 'var(--success)'
  }

  const statusLabels: Record<string, string> = {
    todo: 'TODO',
    'in-progress': 'WIP',
    done: 'DONE'
  }

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Manifest</span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
          {manifest.filter((e) => e.status === 'done').length}/{manifest.length}
        </span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            <input
              type="text"
              placeholder="New task..."
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
            <button onClick={handleAdd} style={{ flexShrink: 0 }}>+</button>
          </div>

          <div className="item-list">
            {manifest.map((entry) => (
              <div key={entry.id} className="item-row" style={{ gap: 6 }}>
                <button
                  style={{
                    width: 36,
                    padding: '1px 4px',
                    fontSize: 9,
                    color: statusColors[entry.status],
                    borderColor: statusColors[entry.status]
                  }}
                  onClick={() => {
                    const next =
                      entry.status === 'todo'
                        ? 'in-progress'
                        : entry.status === 'in-progress'
                          ? 'done'
                          : 'todo'
                    updateEntry(entry.id, { status: next })
                  }}
                  title="Cycle status"
                >
                  {statusLabels[entry.status]}
                </button>
                <span
                  className="item-name"
                  style={{
                    textDecoration: entry.status === 'done' ? 'line-through' : 'none',
                    opacity: entry.status === 'done' ? 0.6 : 1
                  }}
                >
                  {entry.title}
                </span>
                <button
                  style={{ width: 20, height: 20, padding: 0, fontSize: 10 }}
                  onClick={() => removeEntry(entry.id)}
                  title="Remove"
                >
                  x
                </button>
              </div>
            ))}
            {manifest.length === 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: 11, padding: 4 }}>
                No tasks yet. Add one above.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
