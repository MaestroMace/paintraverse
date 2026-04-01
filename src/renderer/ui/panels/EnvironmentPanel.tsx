import { useState } from 'react'
import { useAppStore } from '../../app/store'
import type { WeatherType } from '../../core/types'

const weatherOptions: WeatherType[] = ['clear', 'rain', 'fog', 'snow', 'storm']

export function EnvironmentPanel() {
  const [collapsed, setCollapsed] = useState(false)
  const environment = useAppStore((s) => s.map.environment)
  const updateEnvironment = useAppStore((s) => s.updateEnvironment)

  const timeLabel = (t: number) => {
    const h = Math.floor(t)
    const m = Math.floor((t % 1) * 60)
    const period = h >= 12 ? 'PM' : 'AM'
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
    return `${h12}:${m.toString().padStart(2, '0')} ${period}`
  }

  const timeCategory = (t: number) => {
    if (t >= 5 && t < 7) return 'Dawn'
    if (t >= 7 && t < 17) return 'Day'
    if (t >= 17 && t < 19) return 'Dusk'
    return 'Night'
  }

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Environment</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          {/* Time of Day */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
              <span style={{ color: 'var(--text-dim)' }}>Time of Day</span>
              <span>{timeLabel(environment.timeOfDay)} ({timeCategory(environment.timeOfDay)})</span>
            </div>
            <input
              type="range"
              min={0}
              max={24}
              step={0.25}
              value={environment.timeOfDay}
              onChange={(e) => updateEnvironment({ timeOfDay: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
          </div>

          {/* Weather */}
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>
              Weather
            </label>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              {weatherOptions.map((w) => (
                <button
                  key={w}
                  className={environment.weather === w ? 'active' : ''}
                  onClick={() => updateEnvironment({ weather: w })}
                  style={{ fontSize: 11, padding: '3px 8px', textTransform: 'capitalize' }}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>

          {/* Weather Intensity */}
          {environment.weather !== 'clear' && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
                <span style={{ color: 'var(--text-dim)' }}>Intensity</span>
                <span>{(environment.weatherIntensity * 100).toFixed(0)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={environment.weatherIntensity}
                onChange={(e) => updateEnvironment({ weatherIntensity: Number(e.target.value) })}
                style={{ width: '100%' }}
              />
            </div>
          )}

          {/* Celestial */}
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-dim)',
              textTransform: 'uppercase',
              padding: '4px 0',
              letterSpacing: '0.5px',
              borderTop: '1px solid var(--border)',
              marginTop: 4
            }}
          >
            Celestial
          </div>

          <div style={{ marginBottom: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
              <span style={{ color: 'var(--text-dim)' }}>Moon Phase</span>
              <span>{(environment.celestial.moonPhase * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={environment.celestial.moonPhase}
              onChange={(e) =>
                updateEnvironment({
                  celestial: { ...environment.celestial, moonPhase: Number(e.target.value) }
                })
              }
              style={{ width: '100%' }}
            />
          </div>

          <div style={{ marginBottom: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
              <span style={{ color: 'var(--text-dim)' }}>Star Density</span>
              <span>{(environment.celestial.starDensity * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={environment.celestial.starDensity}
              onChange={(e) =>
                updateEnvironment({
                  celestial: { ...environment.celestial, starDensity: Number(e.target.value) }
                })
              }
              style={{ width: '100%' }}
            />
          </div>

          {/* Lighting */}
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-dim)',
              textTransform: 'uppercase',
              padding: '4px 0',
              letterSpacing: '0.5px',
              borderTop: '1px solid var(--border)',
              marginTop: 4
            }}
          >
            Lighting
          </div>

          <div style={{ marginBottom: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
              <span style={{ color: 'var(--text-dim)' }}>Ambient</span>
              <span>{(environment.lighting.ambientIntensity * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={environment.lighting.ambientIntensity}
              onChange={(e) =>
                updateEnvironment({
                  lighting: { ...environment.lighting, ambientIntensity: Number(e.target.value) }
                })
              }
              style={{ width: '100%' }}
            />
          </div>

          <div style={{ marginBottom: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
              <span style={{ color: 'var(--text-dim)' }}>Sun Angle</span>
              <span>{environment.celestial.sunAngle}&deg;</span>
            </div>
            <input
              type="range"
              min={0}
              max={360}
              step={5}
              value={environment.celestial.sunAngle}
              onChange={(e) =>
                updateEnvironment({
                  celestial: { ...environment.celestial, sunAngle: Number(e.target.value) }
                })
              }
              style={{ width: '100%' }}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            <label style={{ fontSize: 11, color: 'var(--text-dim)' }}>Ambient Color</label>
            <input
              type="color"
              value={environment.lighting.ambientColor}
              onChange={(e) =>
                updateEnvironment({
                  lighting: { ...environment.lighting, ambientColor: e.target.value }
                })
              }
              style={{ width: 32, height: 24, padding: 0 }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
