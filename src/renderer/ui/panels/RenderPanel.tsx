import { useState, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import { useAppStore } from '../../app/store'
import { renderPixelArt } from '../../renderer3d/RenderPipeline'
import { PALETTES } from '../../renderer3d/PaletteQuantizer'
import type { RenderCamera } from '../../core/types'

export function RenderPanel() {
  const [collapsed, setCollapsed] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [previewURL, setPreviewURL] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)

  const map = useAppStore((s) => s.map)
  const objectDefs = useAppStore((s) => s.objectDefinitions)

  const [cameraConfig, setCameraConfig] = useState<RenderCamera>({
    id: uuid(),
    name: 'Camera 1',
    worldX: 16,
    worldY: 16,
    lookAtX: 16,
    lookAtY: 16,
    elevation: 20,
    fov: 60,
    outputWidth: 320,
    outputHeight: 240,
    paletteId: 'db32'
  })

  const [renderOpts, setRenderOpts] = useState({
    dithering: 'ordered' as 'none' | 'ordered' | 'floyd-steinberg',
    outlines: true
  })

  const handleRender = () => {
    setRendering(true)
    setError(null)
    setPreviewURL(null)

    // Use requestAnimationFrame to let UI update before heavy computation
    requestAnimationFrame(() => {
      try {
        const result = renderPixelArt(map, cameraConfig, objectDefs, {
          paletteId: cameraConfig.paletteId,
          dithering: renderOpts.dithering,
          outlines: renderOpts.outlines
        })
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

  // Auto-center camera on map with good cinematic angle
  const handleCenterCamera = () => {
    const cx = map.gridWidth / 2
    const cy = map.gridHeight / 2
    const mapSize = Math.max(map.gridWidth, map.gridHeight)
    setCameraConfig((c) => ({
      ...c,
      worldX: cx - mapSize * 0.35,
      worldY: cy + mapSize * 0.45,
      lookAtX: cx,
      lookAtY: cy,
      elevation: mapSize * 0.4,
      fov: 50
    }))
  }

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Pixel Art Render</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          {/* Camera Position */}
          <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
            Camera Position
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '50px 1fr', gap: '3px 6px', fontSize: 12, marginBottom: 6 }}>
            <span style={{ color: 'var(--text-dim)' }}>X</span>
            <input type="number" value={cameraConfig.worldX} onChange={(e) => setCameraConfig((c) => ({ ...c, worldX: Number(e.target.value) }))} />
            <span style={{ color: 'var(--text-dim)' }}>Y</span>
            <input type="number" value={cameraConfig.worldY} onChange={(e) => setCameraConfig((c) => ({ ...c, worldY: Number(e.target.value) }))} />
            <span style={{ color: 'var(--text-dim)' }}>Height</span>
            <input type="number" value={cameraConfig.elevation} onChange={(e) => setCameraConfig((c) => ({ ...c, elevation: Number(e.target.value) }))} />
            <span style={{ color: 'var(--text-dim)' }}>Look X</span>
            <input type="number" value={cameraConfig.lookAtX} onChange={(e) => setCameraConfig((c) => ({ ...c, lookAtX: Number(e.target.value) }))} />
            <span style={{ color: 'var(--text-dim)' }}>Look Y</span>
            <input type="number" value={cameraConfig.lookAtY} onChange={(e) => setCameraConfig((c) => ({ ...c, lookAtY: Number(e.target.value) }))} />
            <span style={{ color: 'var(--text-dim)' }}>FOV</span>
            <input type="range" min={30} max={120} value={cameraConfig.fov} onChange={(e) => setCameraConfig((c) => ({ ...c, fov: Number(e.target.value) }))} />
          </div>

          <button onClick={handleCenterCamera} style={{ width: '100%', marginBottom: 6, fontSize: 11 }}>
            Center Camera on Map
          </button>

          {/* Output Settings */}
          <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
            Output Settings
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '50px 1fr', gap: '3px 6px', fontSize: 12, marginBottom: 6 }}>
            <span style={{ color: 'var(--text-dim)' }}>Width</span>
            <input type="number" value={cameraConfig.outputWidth} onChange={(e) => setCameraConfig((c) => ({ ...c, outputWidth: Number(e.target.value) }))} />
            <span style={{ color: 'var(--text-dim)' }}>Height</span>
            <input type="number" value={cameraConfig.outputHeight} onChange={(e) => setCameraConfig((c) => ({ ...c, outputHeight: Number(e.target.value) }))} />
          </div>

          {/* Palette */}
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>Palette</label>
          <select
            value={cameraConfig.paletteId}
            onChange={(e) => setCameraConfig((c) => ({ ...c, paletteId: e.target.value }))}
            style={{ marginBottom: 6 }}
          >
            {Object.entries(PALETTES).map(([id, p]) => (
              <option key={id} value={id}>{p.name}</option>
            ))}
          </select>

          {/* Dithering */}
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>Dithering</label>
          <select
            value={renderOpts.dithering}
            onChange={(e) => setRenderOpts((o) => ({ ...o, dithering: e.target.value as typeof o.dithering }))}
            style={{ marginBottom: 6 }}
          >
            <option value="none">None</option>
            <option value="ordered">Ordered (Bayer)</option>
            <option value="floyd-steinberg">Floyd-Steinberg</option>
          </select>

          {/* Outlines */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={renderOpts.outlines}
              onChange={(e) => setRenderOpts((o) => ({ ...o, outlines: e.target.checked }))}
            />
            Pixel art outlines
          </label>

          {/* Render button */}
          <button
            onClick={handleRender}
            className="active"
            style={{ width: '100%', padding: '8px 10px', fontWeight: 600 }}
            disabled={rendering}
          >
            {rendering ? 'Rendering...' : 'Render Pixel Art'}
          </button>

          {error && (
            <div style={{ color: '#d95763', fontSize: 11, marginTop: 4 }}>{error}</div>
          )}

          {/* Preview */}
          {previewURL && (
            <div ref={previewRef} style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                  Preview ({cameraConfig.outputWidth}x{cameraConfig.outputHeight})
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
