import { useState } from 'react'
import { useAppStore } from '../../app/store'
import type { WeatherType } from '../../core/types'

const weatherOptions: WeatherType[] = ['clear', 'rain', 'fog', 'snow', 'storm']

/** Labeled slider row: name + live value above an amber range track. */
function Slider(props: {
  label: string
  display: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <div className="slider-row">
      <div className="slider-head">
        <span className="k">{props.label}</span>
        <span>{props.display}</span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  )
}

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
          <Slider
            label="Time of Day"
            display={`${timeLabel(environment.timeOfDay)} (${timeCategory(environment.timeOfDay)})`}
            value={environment.timeOfDay}
            min={0}
            max={24}
            step={0.25}
            onChange={(v) => updateEnvironment({ timeOfDay: v })}
          />

          {/* Weather */}
          <div className="slider-row">
            <div className="slider-head"><span className="k">Weather</span></div>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              {weatherOptions.map((w) => (
                <button
                  key={w}
                  className={environment.weather === w ? 'active' : ''}
                  onClick={() => updateEnvironment({ weather: w })}
                  style={{ fontSize: 'var(--fs-sm)', padding: '3px 8px', textTransform: 'capitalize' }}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>

          {environment.weather !== 'clear' && (
            <Slider
              label="Intensity"
              display={`${(environment.weatherIntensity * 100).toFixed(0)}%`}
              value={environment.weatherIntensity}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => updateEnvironment({ weatherIntensity: v })}
            />
          )}

          {/* Celestial */}
          <div className="panel-section">
            <div className="section-label">Celestial</div>
            <Slider
              label="Moon Phase"
              display={`${(environment.celestial.moonPhase * 100).toFixed(0)}%`}
              value={environment.celestial.moonPhase}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => updateEnvironment({ celestial: { ...environment.celestial, moonPhase: v } })}
            />
            <Slider
              label="Star Density"
              display={`${(environment.celestial.starDensity * 100).toFixed(0)}%`}
              value={environment.celestial.starDensity}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => updateEnvironment({ celestial: { ...environment.celestial, starDensity: v } })}
            />
          </div>

          {/* Lighting */}
          <div className="panel-section">
            <div className="section-label">Lighting</div>
            <Slider
              label="Ambient"
              display={`${(environment.lighting.ambientIntensity * 100).toFixed(0)}%`}
              value={environment.lighting.ambientIntensity}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => updateEnvironment({ lighting: { ...environment.lighting, ambientIntensity: v } })}
            />
            <Slider
              label="Sun Angle"
              display={`${environment.celestial.sunAngle}°`}
              value={environment.celestial.sunAngle}
              min={0}
              max={360}
              step={5}
              onChange={(v) => updateEnvironment({ celestial: { ...environment.celestial, sunAngle: v } })}
            />
            <div className="slider-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="k" style={{ fontSize: 'var(--fs-sm)' }}>Ambient Color</span>
              <input
                type="color"
                value={environment.lighting.ambientColor}
                onChange={(e) => updateEnvironment({ lighting: { ...environment.lighting, ambientColor: e.target.value } })}
                style={{ width: 32, height: 24, padding: 0 }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
