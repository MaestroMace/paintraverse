import { useState, useRef } from 'react'
import { useAppStore } from '../../app/store'
import { renderPixelArt } from '../../renderer3d/RenderPipeline'
import { PALETTES } from '../../renderer3d/PaletteQuantizer'

const CAMERA_PRESETS = [
  { label: 'Street Level', elevation: 1.2, fov: 65, desc: 'Low angle, intimate' },
  { label: 'Eye Level', elevation: 3, fov: 55, desc: 'Standing perspective' },
  { label: 'Rooftop', elevation: 8, fov: 50, desc: 'Above the buildings' },
  { label: 'Overview', elevation: 18, fov: 45, desc: 'Cinematic wide shot' },
  { label: "Bird's Eye", elevation: 35, fov: 40, desc: 'Top-down map view' },
]

export function RenderPanel() {
  const [collapsed, setCollapsed] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [previewURL, setPreviewURL] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)

  const map = useAppStore((s) => s.map)
  const objectDefs = useAppStore((s) => s.objectDefinitions)
  const camera = useAppStore((s) => s.renderCamera)
  const updateCamera = useAppStore((s) => s.updateRenderCamera)
  const setActiveTool = useAppStore((s) => s.setActiveTool)
  const buildingPalettes = useAppStore((s) => s.buildingPalettes)

  const [renderOpts, setRenderOpts] = useState({
    dithering: 'ordered' as 'none' | 'ordered' | 'floyd-steinberg',
    outlines: true
  })

  const handleRender = () => {
    setRendering(true)
    setError(null)
    setPreviewURL(null)
    requestAnimationFrame(() => {
      try {
        const result = renderPixelArt(map, camera, objectDefs, {
          paletteId: camera.paletteId,
          dithering: renderOpts.dithering,
          outlines: renderOpts.outlines
        }, buildingPalettes)
        setPreviewURL(result.imageDataURL)
      } catch (e) {
        setError(String(e))
      } finally {
        setRendering(false)
      }
    })
  }

  const handleExport = () => {
    if (!previewURL) return
    const link = document.createElement('a')
    link.download = `${map.name.replace(/\s+/g, '_')}_render.png`
    link.href = previewURL
    link.click()
  }

  const handleCenterCamera = () => {
    const cx = map.gridWidth / 2
    const cy = map.gridHeight / 2
    const mapSize = Math.max(map.gridWidth, map.gridHeight)
    updateCamera({
      worldX: cx - mapSize * 0.35,
      worldY: cy + mapSize * 0.45,
      lookAtX: cx,
      lookAtY: cy,
      elevation: mapSize * 0.4,
      fov: 50
    })
  }

  const applyPreset = (preset: typeof CAMERA_PRESETS[0]) => {
    updateCamera({ elevation: preset.elevation, fov: preset.fov })
  }

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Camera & Render</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          {/* Quick action row - always visible */}
          <div style={{ display: 'flex', gap: 3, marginBottom: 8 }}>
            <button
              onClick={() => setActiveTool('camera')}
              style={{ flex: 1, padding: '5px 6px', fontSize: 11 }}
              title="Click on map to place camera, drag to aim (C)"
            >
              Place Camera
            </button>
            <button onClick={handleCenterCamera} style={{ flex: 1, padding: '5px 6px', fontSize: 11 }}>
              Auto Center
            </button>
            <button
              onClick={handleRender}
              className="active"
              style={{ flex: 1.2, padding: '5px 6px', fontSize: 11, fontWeight: 600 }}
              disabled={rendering}
            >
              {rendering ? '...' : 'Render'}
            </button>
          </div>

          {/* Camera angle presets */}
          <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 3 }}>
            Camera Angle
          </div>
          <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', marginBottom: 8 }}>
            {CAMERA_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => applyPreset(p)}
                title={p.desc}
                style={{
                  padding: '3px 7px', fontSize: 10,
                  background: Math.abs(camera.elevation - p.elevation) < 1 ? 'var(--accent)' : undefined,
                  color: Math.abs(camera.elevation - p.elevation) < 1 ? 'white' : undefined,
                  borderColor: Math.abs(camera.elevation - p.elevation) < 1 ? 'var(--accent)' : undefined
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Height slider - CRITICAL: min 0.3 for street-level */}
          <div style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 1 }}>
              <span style={{ color: 'var(--text-dim)' }}>Height</span>
              <span>{camera.elevation.toFixed(1)} tiles</span>
            </div>
            <input
              type="range" min={0.3} max={50} step={0.1} value={camera.elevation}
              onChange={(e) => updateCamera({ elevation: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
          </div>

          {/* FOV slider */}
          <div style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 1 }}>
              <span style={{ color: 'var(--text-dim)' }}>Field of View</span>
              <span>{camera.fov}&deg;</span>
            </div>
            <input
              type="range" min={20} max={100} value={camera.fov}
              onChange={(e) => updateCamera({ fov: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
          </div>

          {/* Palette selector - important enough to stay visible */}
          <div style={{ marginBottom: 6 }}>
            <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>Palette</label>
            <select
              value={camera.paletteId}
              onChange={(e) => updateCamera({ paletteId: e.target.value })}
            >
              {Object.entries(PALETTES).map(([id, p]) => (
                <option key={id} value={id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Advanced settings (collapsed) */}
          <div
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{
              fontSize: 10, color: 'var(--text-dim)', cursor: 'pointer',
              userSelect: 'none', display: 'flex', justifyContent: 'space-between',
              borderTop: '1px solid var(--border)', paddingTop: 4, marginBottom: 4
            }}
          >
            <span>Position & Output</span>
            <span>{showAdvanced ? '-' : '+'}</span>
          </div>

          {showAdvanced && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '50px 1fr', gap: '3px 6px', fontSize: 12, marginBottom: 6 }}>
                <span style={{ color: 'var(--text-dim)' }}>From X</span>
                <input type="number" value={camera.worldX} step={0.5}
                  onChange={(e) => updateCamera({ worldX: Number(e.target.value) })} />
                <span style={{ color: 'var(--text-dim)' }}>From Y</span>
                <input type="number" value={camera.worldY} step={0.5}
                  onChange={(e) => updateCamera({ worldY: Number(e.target.value) })} />
                <span style={{ color: 'var(--text-dim)' }}>Look X</span>
                <input type="number" value={camera.lookAtX} step={0.5}
                  onChange={(e) => updateCamera({ lookAtX: Number(e.target.value) })} />
                <span style={{ color: 'var(--text-dim)' }}>Look Y</span>
                <input type="number" value={camera.lookAtY} step={0.5}
                  onChange={(e) => updateCamera({ lookAtY: Number(e.target.value) })} />
                <span style={{ color: 'var(--text-dim)' }}>Width</span>
                <input type="number" value={camera.outputWidth}
                  onChange={(e) => updateCamera({ outputWidth: Number(e.target.value) })} />
                <span style={{ color: 'var(--text-dim)' }}>Height</span>
                <input type="number" value={camera.outputHeight}
                  onChange={(e) => updateCamera({ outputHeight: Number(e.target.value) })} />
              </div>

              <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>Dithering</label>
              <select
                value={renderOpts.dithering}
                onChange={(e) => setRenderOpts((o) => ({ ...o, dithering: e.target.value as typeof o.dithering }))}
                style={{ marginBottom: 4 }}
              >
                <option value="none">None</option>
                <option value="ordered">Ordered (Bayer)</option>
                <option value="floyd-steinberg">Floyd-Steinberg</option>
              </select>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={renderOpts.outlines}
                  onChange={(e) => setRenderOpts((o) => ({ ...o, outlines: e.target.checked }))}
                />
                Pixel art outlines
              </label>
            </div>
          )}

          {error && (
            <div style={{ color: '#d95763', fontSize: 11, marginBottom: 4, wordBreak: 'break-word' }}>{error}</div>
          )}

          {/* Preview */}
          {previewURL && (
            <div ref={previewRef} style={{ marginTop: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                  {camera.outputWidth}x{camera.outputHeight}
                </span>
                <button onClick={handleExport} style={{ fontSize: 10, padding: '2px 8px' }}>
                  Export PNG
                </button>
              </div>
              <img
                src={previewURL}
                alt="Pixel art render"
                style={{
                  width: '100%',
                  imageRendering: 'pixelated',
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  background: '#000'
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
