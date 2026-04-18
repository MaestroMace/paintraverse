import { useState, useEffect } from 'react'
import { useAppStore } from '../../app/store'
import type { AppMode } from '../../core/types'
import './ModeSelector.css'

const modes: { id: AppMode; icon: string; title: string; desc: string }[] = [
  {
    id: 'landscape',
    icon: '\u{1F3DE}',
    title: 'Landscape Editor',
    desc: 'Build pixel-art worlds with procedural generation and hand-placement tools'
  },
  {
    id: 'asset-creator',
    icon: '\u{2728}',
    title: 'Asset Creator',
    desc: 'Search references, generate 3D game assets with AI, and manage your asset library'
  }
]

export function ModeSelector() {
  const setAppMode = useAppStore((s) => s.setAppMode)
  const [hoveredMode, setHoveredMode] = useState<AppMode | null>(null)
  const [visible, setVisible] = useState(false)
  const [sparkles, setSparkles] = useState<{ id: number; x: number; y: number; delay: number; size: number }[]>([])

  useEffect(() => {
    // Fade in
    const t = setTimeout(() => setVisible(true), 50)

    // Generate sparkle positions
    const s: typeof sparkles = []
    for (let i = 0; i < 24; i++) {
      s.push({
        id: i,
        x: Math.random() * 100,
        y: Math.random() * 100,
        delay: Math.random() * 4,
        size: 2 + Math.random() * 4
      })
    }
    setSparkles(s)

    return () => clearTimeout(t)
  }, [])

  const handleSelect = (mode: AppMode) => {
    setVisible(false)
    setTimeout(() => setAppMode(mode), 350)
  }

  return (
    <div className={`mode-selector ${visible ? 'visible' : ''}`}>
      {/* Background sparkles */}
      <div className="mode-selector-sparkles">
        {sparkles.map((s) => (
          <div
            key={s.id}
            className="sparkle-particle"
            style={{
              left: `${s.x}%`,
              top: `${s.y}%`,
              animationDelay: `${s.delay}s`,
              width: s.size,
              height: s.size
            }}
          />
        ))}
      </div>

      {/* Title */}
      <div className="mode-selector-header">
        <h1 className="mode-selector-title">PainTraverse</h1>
        <p className="mode-selector-subtitle">Choose your path</p>
      </div>

      {/* Mode cards */}
      <div className="mode-selector-cards">
        {modes.map((m) => (
          <button
            key={m.id}
            className={`mode-card ${hoveredMode === m.id ? 'hovered' : ''}`}
            onClick={() => handleSelect(m.id)}
            onMouseEnter={() => setHoveredMode(m.id)}
            onMouseLeave={() => setHoveredMode(null)}
          >
            <span className="mode-icon">{m.icon}</span>
            <span className="mode-title">{m.title}</span>
            <span className="mode-desc">{m.desc}</span>
            <span className="mode-card-arrow">{'\u25B6'}</span>
          </button>
        ))}
      </div>

      {/* Footer hint */}
      <div className="mode-selector-footer">
        <span>You can switch modes anytime from the toolbar</span>
      </div>
    </div>
  )
}
