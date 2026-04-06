import { useState } from 'react'
import { useAppStore } from '../../app/store'
import { getAllGenerators, getGenerator } from '../../generation/GeneratorRegistry'
import type { GenerationConfig } from '../../core/types'

export function GenerationPanel() {
  const [collapsed, setCollapsed] = useState(false)
  const setMap = useAppStore((s) => s.setMap)
  const generators = getAllGenerators()

  const [config, setConfig] = useState<GenerationConfig>({
    mapType: 'town',
    seed: Math.floor(Math.random() * 99999),
    width: 48,
    height: 48,
    complexity: 0.5,
    density: 0.5,
    assetFrequencies: {
      lamppost: 0.5,
      bench: 0.3,
      sign: 0.3,
      fountain: 0.3,
      well: 0.2
    },
    levelCount: 1,
    customParams: {}
  })

  const [lastSeed, setLastSeed] = useState<number | null>(null)

  const handleGenerate = () => {
    try {
      console.log('[generate] starting generation...')
      const gen = getGenerator(config.mapType)
      if (!gen) return
      console.log('[generate] calling gen.generate()...')
      const map = gen.generate(config)
      console.log('[generate] map created:', map.gridWidth, 'x', map.gridHeight,
        'structures:', map.layers.find(l => l.type === 'structure')?.objects.length,
        'props:', map.layers.find(l => l.type === 'prop')?.objects.length)
      console.log('[generate] calling setMap()...')
      setMap(map)
      console.log('[generate] setMap() complete')
      setLastSeed(config.seed)
    } catch (e) {
      console.error('[generate] CRASH:', e)
    }
  }

  const handleRandomSeed = () => {
    setConfig((c) => ({ ...c, seed: Math.floor(Math.random() * 99999) }))
  }

  const handleRegenerate = () => {
    handleRandomSeed()
    // We'll generate on next render after seed updates
    setTimeout(() => {
      const gen = getGenerator(config.mapType)
      if (!gen) return
      const newSeed = Math.floor(Math.random() * 99999)
      const newConfig = { ...config, seed: newSeed }
      setConfig(newConfig)
      const map = gen.generate(newConfig)
      setMap(map)
      setLastSeed(newSeed)
    }, 0)
  }

  const updateFreq = (key: string, value: number) => {
    setConfig((c) => ({
      ...c,
      assetFrequencies: { ...c.assetFrequencies, [key]: value }
    }))
  }

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Generation</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          {generators.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 11, padding: 4 }}>
              No generators registered.
            </div>
          ) : (
            <>
              {/* Map Type */}
              <label style={{ fontSize: 11, color: 'var(--text-dim)' }}>Map Type</label>
              <select
                value={config.mapType}
                onChange={(e) => setConfig((c) => ({ ...c, mapType: e.target.value }))}
                style={{ marginBottom: 8 }}
              >
                {generators.map((g) => (
                  <option key={g.type} value={g.type}>
                    {g.displayName}
                  </option>
                ))}
              </select>

              {/* Size */}
              <label style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                Size: {config.width}x{config.height}
              </label>
              <input
                type="range"
                min={16}
                max={128}
                step={8}
                value={config.width}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setConfig((c) => ({ ...c, width: v, height: v }))
                }}
                style={{ marginBottom: 8 }}
              />

              {/* Seed */}
              <label style={{ fontSize: 11, color: 'var(--text-dim)' }}>Seed</label>
              <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                <input
                  type="number"
                  value={config.seed}
                  onChange={(e) => setConfig((c) => ({ ...c, seed: Number(e.target.value) }))}
                />
                <button onClick={handleRandomSeed} style={{ flexShrink: 0 }} title="Random seed">
                  Dice
                </button>
              </div>

              {/* Complexity */}
              <SliderRow
                label="Complexity"
                value={config.complexity}
                onChange={(v) => setConfig((c) => ({ ...c, complexity: v }))}
              />

              {/* Density */}
              <SliderRow
                label="Density"
                value={config.density}
                onChange={(v) => setConfig((c) => ({ ...c, density: v }))}
              />

              {/* Asset Frequencies */}
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--text-dim)',
                  textTransform: 'uppercase',
                  padding: '8px 0 4px',
                  letterSpacing: '0.5px',
                  borderTop: '1px solid var(--border)',
                  marginTop: 4
                }}
              >
                Asset Frequencies
              </div>
              {Object.entries(config.assetFrequencies).map(([key, value]) => (
                <SliderRow
                  key={key}
                  label={key}
                  value={value}
                  onChange={(v) => updateFreq(key, v)}
                />
              ))}

              {/* Generate buttons */}
              <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
                <button
                  onClick={handleGenerate}
                  className="active"
                  style={{ flex: 1, padding: '6px 10px' }}
                >
                  Generate
                </button>
                <button
                  onClick={handleRegenerate}
                  style={{ flex: 1, padding: '6px 10px' }}
                  title="Generate with new random seed"
                >
                  Re-roll
                </button>
              </div>

              {lastSeed !== null && (
                <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, textAlign: 'center' }}>
                  Last seed: {lastSeed}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function SliderRow({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.05
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
        <span style={{ color: 'var(--text-dim)' }}>{label}</span>
        <span>{(value * 100).toFixed(0)}%</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
    </div>
  )
}
