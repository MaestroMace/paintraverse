import { useState, useRef } from 'react'
import { useAppStore } from '../../app/store'
import { renderPixelArt } from '../../renderer3d/RenderPipeline'
import { PALETTES } from '../../renderer3d/PaletteQuantizer'

export function RenderPanel() {
  const [collapsed, setCollapsed] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [previewURL, setPreviewURL] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)

  const map = useAppStore((s) => s.map)
  const objectDefs = useAppStore((s) => s.objectDefinitions)
  const camera = useAppStore((s) => s.renderCamera)
  const updateCamera = useAppStore((s) => s.updateRenderCamera)
  const setActiveTool = useAppStore((s) => s.setActiveTool)

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

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Pixel Art Render</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          {/* Camera placement hint */}
          <div style={{
            background: 'var(--bg-dark)', borderRadius: 3, padding: '6px 8px',
            marginBottom: 8, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4
          }}>
            Use the <button
              onClick={() => setActiveTool('camera')}
              style={{ display: 'inline', padding: '1px 6px', fontSize: 11, verticalAlign: 'baseline' }}
            >Camera</button> tool (C) to click where you want the camera, then drag toward where it should look.
            The blue cone shows what's in frame.
          </div>

          {/* Camera Position - editable but also set by tool */}
          <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
            Camera Position
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '50px 1fr', gap: '3px 6px', fontSize: 12, marginBottom: 6 }}>
            <span style={{ color: 'var(--text-dim)' }}>From X</span>
            <input type="number" value={camera.worldX} step={0.5}
              onChange={(e) => updateCamera({ worldX: Number(e.target.value) })} />
            <span style={{ color: 'var(--text-dim)' }}>From Y</span>
            <input type="number" value={camera.worldY} step={0.5}
              onChange={(e) => updateCamera({ worldY: Number(e.target.value) })} />
            <span style={{ color: 'var(--text-dim)' }}>Height</span>
            <input type="range" min={2} max={60} step={0.5} value={camera.elevation}
              onChange={(e) => updateCamera({ elevation: Number(e.target.value) })} />
            <span /><span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{camera.elevation.toFixed(1)} tiles up</span>
            <span style={{ color: 'var(--text-dim)' }}>Look X</span>
            <input type="number" value={camera.lookAtX} step={0.5}
              onChange={(e) => updateCamera({ lookAtX: Number(e.target.value) })} />
            <span style={{ color: 'var(--text-dim)' }}>Look Y</span>
            <input type="number" value={camera.lookAtY} step={0.5}
              onChange={(e) => updateCamera({ lookAtY: Number(e.target.value) })} />
            <span style={{ color: 'var(--text-dim)' }}>FOV</span>
            <input type="range" min={25} max={90} value={camera.fov}
              onChange={(e) => updateCamera({ fov: Number(e.target.value) })} />
            <span /><span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{camera.fov}&deg; (wider = more in frame)</span>
          </div>

          <button onClick={handleCenterCamera} style={{ width: '100%', marginBottom: 6, fontSize: 11 }}>
            Auto-position: Cinematic Overview
          </button>

          {/* Output Settings */}
          <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
            Output Settings
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '50px 1fr', gap: '3px 6px', fontSize: 12, marginBottom: 6 }}>
            <span style={{ color: 'var(--text-dim)' }}>Width</span>
            <input type="number" value={camera.outputWidth}
              onChange={(e) => updateCamera({ outputWidth: Number(e.target.value) })} />
            <span style={{ color: 'var(--text-dim)' }}>Height</span>
            <input type="number" value={camera.outputHeight}
              onChange={(e) => updateCamera({ outputHeight: Number(e.target.value) })} />
          </div>

          {/* Palette */}
          <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>Palette</label>
          <select
            value={camera.paletteId}
            onChange={(e) => updateCamera({ paletteId: e.target.value })}
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

          {previewURL && (
            <div ref={previewRef} style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                  Preview ({camera.outputWidth}x{camera.outputHeight})
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
