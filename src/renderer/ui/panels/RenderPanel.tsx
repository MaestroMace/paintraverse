import { useState, useRef, useEffect, useCallback } from 'react'
import { useAppStore } from '../../app/store'
import { renderPixelArt } from '../../renderer3d/RenderPipeline'
import { PALETTES } from '../../renderer3d/PaletteQuantizer'

const CAMERA_PRESETS = [
  { label: 'Street', elevation: 1.5, fov: 60, desc: 'Low angle among buildings' },
  { label: 'Eye Level', elevation: 3, fov: 55, desc: 'Standing perspective' },
  { label: 'Rooftop', elevation: 8, fov: 48, desc: 'Above the rooftops' },
  { label: 'Overview', elevation: 16, fov: 42, desc: 'Wide town view' },
  { label: "Bird's Eye", elevation: 30, fov: 35, desc: 'Near top-down' },
]

export function RenderPanel() {
  const [collapsed, setCollapsed] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [previewURL, setPreviewURL] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(0)
  const previewRef = useRef<HTMLDivElement>(null)
  const animFrameRef = useRef<number>(0)
  const timeRef = useRef(0)
  const fpsCountRef = useRef(0)
  const fpsTimerRef = useRef(0)

  const map = useAppStore((s) => s.map)
  const objectDefs = useAppStore((s) => s.objectDefinitions)
  const camera = useAppStore((s) => s.renderCamera)
  const updateCamera = useAppStore((s) => s.updateRenderCamera)
  const setActiveTool = useAppStore((s) => s.setActiveTool)
  const buildingPalettes = useAppStore((s) => s.buildingPalettes)

  const [renderOpts, setRenderOpts] = useState({
    dithering: 'none' as 'none' | 'ordered' | 'floyd-steinberg',
    outlines: false
  })

  const handleRender = () => {
    setRendering(true)
    setError(null)
    setPreviewURL(null)
    setPlaying(false)
    requestAnimationFrame(() => {
      try {
        const result = renderPixelArt(map, camera, objectDefs, {
          paletteId: camera.paletteId,
          dithering: renderOpts.dithering,
          outlines: renderOpts.outlines,
          quality: 'final'
        }, buildingPalettes, timeRef.current)
        setPreviewURL(result.imageDataURL)
      } catch (e) {
        setError(String(e))
      } finally {
        setRendering(false)
      }
    })
  }

  // Animation loop — renders continuously in preview quality
  const renderFrame = useCallback((ts: number) => {
    const dt = fpsTimerRef.current ? (ts - fpsTimerRef.current) / 1000 : 0
    fpsTimerRef.current = ts
    timeRef.current += dt
    fpsCountRef.current++

    // Update FPS display every second
    if (fpsCountRef.current % 15 === 0) {
      setFps(dt > 0 ? Math.round(1 / dt) : 0)
    }

    try {
      const result = renderPixelArt(
        useAppStore.getState().map,
        useAppStore.getState().renderCamera,
        useAppStore.getState().objectDefinitions,
        { paletteId: useAppStore.getState().renderCamera.paletteId, quality: 'preview' },
        useAppStore.getState().buildingPalettes,
        timeRef.current
      )
      setPreviewURL(result.imageDataURL)
    } catch (_) { /* skip frame on error */ }

    animFrameRef.current = requestAnimationFrame(renderFrame)
  }, [])

  useEffect(() => {
    if (!playing) {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      return
    }
    fpsTimerRef.current = 0
    fpsCountRef.current = 0
    animFrameRef.current = requestAnimationFrame(renderFrame)
    return () => { cancelAnimationFrame(animFrameRef.current) }
  }, [playing, renderFrame])

  const handleExport = () => {
    if (!previewURL) return
    const link = document.createElement('a')
    link.download = `${map.name.replace(/\s+/g, '_')}_render.png`
    link.href = previewURL
    link.click()
  }

  const handleDebugPackage = () => {
    // Gather all current settings and state into a debug bundle
    const debugData: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      camera: { ...camera },
      renderOptions: { ...renderOpts, paletteId: camera.paletteId },
      environment: { ...map.environment },
      mapInfo: {
        name: map.name,
        gridWidth: map.gridWidth,
        gridHeight: map.gridHeight,
        tileSize: map.tileSize,
        layerCount: map.layers.length,
        layers: map.layers.map((l) => ({
          name: l.name,
          type: l.type,
          objectCount: l.objects.length,
          visible: l.visible
        }))
      },
      totalObjects: map.layers.reduce((sum, l) => sum + l.objects.length, 0),
      buildingPalettes: buildingPalettes ? buildingPalettes.length : 'default'
    }

    // Capture overhead view from the editor canvas
    const editorCanvas = document.querySelector('canvas') as HTMLCanvasElement | null
    const overheadURL = editorCanvas ? editorCanvas.toDataURL('image/png') : null

    // Build a single HTML file with everything embedded
    const html = `<!DOCTYPE html>
<html><head><title>Debug Package - ${map.name}</title>
<style>
body { font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 20px; max-width: 1200px; margin: 0 auto; }
h1 { color: #fff; border-bottom: 1px solid #333; padding-bottom: 8px; }
h2 { color: #aaa; margin-top: 24px; }
.images { display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0; }
.images div { flex: 1; min-width: 300px; }
.images img { width: 100%; image-rendering: pixelated; border: 2px solid #333; border-radius: 4px; }
pre { background: #0d0d1a; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; line-height: 1.5; }
.label { font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 4px; }
</style></head><body>
<h1>Debug Package</h1>
<p>${new Date().toLocaleString()}</p>

<div class="images">
${previewURL ? `<div><div class="label">Rendered Output (${camera.outputWidth}x${camera.outputHeight})</div><img src="${previewURL}" /></div>` : '<div><div class="label">No render available</div></div>'}
${overheadURL ? `<div><div class="label">Overhead / Editor View</div><img src="${overheadURL}" /></div>` : ''}
</div>

<h2>Settings</h2>
<pre>${JSON.stringify(debugData, null, 2)}</pre>
</body></html>`

    const blob = new Blob([html], { type: 'text/html' })
    const link = document.createElement('a')
    link.download = `${map.name.replace(/\s+/g, '_')}_debug_${Date.now()}.html`
    link.href = URL.createObjectURL(blob)
    link.click()
    URL.revokeObjectURL(link.href)
  }

  // Place camera at a given elevation looking at map center.
  // Uses the FOV and elevation to compute proper distance so the
  // town fills the frame. Camera is placed "in front" (lower Y)
  // at an angle that feels like a 3/4 view.
  const placeCamera = (elevation: number, fov: number) => {
    const cx = map.gridWidth / 2
    const cy = map.gridHeight / 2
    const mapSize = Math.max(map.gridWidth, map.gridHeight)

    // Distance from look-at center: enough to see the town.
    // At higher elevations we pull back; at low we stay close.
    const halfFovRad = (fov * Math.PI / 180) / 2
    // Desired visible width ≈ mapSize tiles → distance = mapSize / (2 * tan(halfFov))
    const framingDist = (mapSize * 0.6) / Math.tan(halfFovRad)
    // Clamp to keep a reasonable range
    const dist = Math.max(mapSize * 0.3, Math.min(mapSize * 1.5, framingDist))

    // Camera offset: 45-degree angle "southwest" of center, so we see
    // both the front and right sides of buildings.
    const angle = -Math.PI * 0.75 // 225° — looking northeast
    const hDist = Math.sqrt(Math.max(0, dist * dist - elevation * elevation)) || dist * 0.5

    updateCamera({
      worldX: Math.round((cx + Math.cos(angle) * hDist) * 2) / 2,
      worldY: Math.round((cy + Math.sin(angle) * hDist) * 2) / 2,
      lookAtX: cx,
      lookAtY: cy,
      elevation,
      fov,
    })
  }

  const handleCenterCamera = () => {
    placeCamera(camera.elevation, camera.fov)
  }

  const applyPreset = (preset: typeof CAMERA_PRESETS[0]) => {
    placeCamera(preset.elevation, preset.fov)
  }

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Camera & Render</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          {/* Render + Play buttons */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            <button
              onClick={handleRender}
              className="active"
              style={{ flex: 2, padding: '7px 6px', fontSize: 12, fontWeight: 700 }}
              disabled={rendering || playing}
            >
              {rendering ? 'Rendering...' : 'Render'}
            </button>
            <button
              onClick={() => setPlaying(!playing)}
              style={{
                flex: 1, padding: '7px 6px', fontSize: 12, fontWeight: 700,
                background: playing ? '#d95763' : undefined,
                color: playing ? 'white' : undefined,
                borderColor: playing ? '#d95763' : undefined
              }}
              disabled={rendering}
            >
              {playing ? 'Stop' : 'Play'}
            </button>
            {playing && fps > 0 && (
              <span style={{ fontSize: 10, color: 'var(--text-dim)', alignSelf: 'center', minWidth: 30 }}>
                {fps}fps
              </span>
            )}
          </div>

          {error && (
            <div style={{ color: '#d95763', fontSize: 11, marginBottom: 4, wordBreak: 'break-word' }}>{error}</div>
          )}

          {/* Preview - immediately below render button */}
          {previewURL && (
            <div ref={previewRef} style={{ marginBottom: 6 }}>
              <img
                src={previewURL}
                alt="Pixel art render"
                style={{
                  width: '100%',
                  maxHeight: 400,
                  objectFit: 'contain',
                  imageRendering: 'pixelated',
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  background: '#000',
                  marginBottom: 3
                }}
              />
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={handleExport} style={{ flex: 1, fontSize: 10, padding: '2px 8px' }}>
                  Export PNG
                </button>
                <button onClick={handleDebugPackage} style={{ flex: 1, fontSize: 10, padding: '2px 8px' }} title="Download render + overhead + all settings as a single HTML file">
                  Debug Pkg
                </button>
              </div>
            </div>
          )}

          {/* Camera presets + palette - compact, always visible */}
          <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', marginBottom: 4 }}>
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

          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <select
              value={camera.paletteId}
              onChange={(e) => updateCamera({ paletteId: e.target.value })}
              style={{ flex: 1 }}
            >
              {Object.entries(PALETTES).map(([id, p]) => (
                <option key={id} value={id}>{p.name}</option>
              ))}
            </select>
            <button onClick={handleCenterCamera} style={{ padding: '3px 8px', fontSize: 10 }}>
              Center
            </button>
          </div>

          {/* All adjustable controls - collapsed by default */}
          <div
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{
              fontSize: 10, color: 'var(--text-dim)', cursor: 'pointer',
              userSelect: 'none', display: 'flex', justifyContent: 'space-between',
              borderTop: '1px solid var(--border)', paddingTop: 4, marginBottom: 4
            }}
          >
            <span>Adjust</span>
            <span>{showAdvanced ? '-' : '+'}</span>
          </div>

          {showAdvanced && (
            <div style={{ marginBottom: 6 }}>
              {/* Height slider */}
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

              <button
                onClick={() => setActiveTool('camera')}
                style={{ width: '100%', padding: '4px 6px', fontSize: 11, marginBottom: 4 }}
                title="WASD to move, click/drag map to aim, Q/E height"
              >
                Camera Mode
              </button>

              <div style={{
                fontSize: 9, color: 'var(--text-dim)', marginBottom: 6,
                padding: '4px 6px', background: 'rgba(255,255,255,0.03)',
                borderRadius: 3, lineHeight: 1.6, fontFamily: 'monospace'
              }}>
                <span style={{ color: 'var(--accent)' }}>WASD</span> move &nbsp;
                <span style={{ color: 'var(--accent)' }}>Q/E</span> height &nbsp;
                <span style={{ color: 'var(--accent)' }}>Click</span> aim
              </div>

              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 2 }}>
                Camera at ({camera.worldX.toFixed(1)}, {camera.worldY.toFixed(1)}) → ({camera.lookAtX.toFixed(1)}, {camera.lookAtY.toFixed(1)})
                &nbsp;|&nbsp;Map: {map.gridWidth}×{map.gridHeight}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '50px 1fr', gap: '3px 6px', fontSize: 12, marginBottom: 6 }}>
                <span style={{ color: 'var(--text-dim)' }} title="Camera tile column (left-right)">Cam Col</span>
                <input type="number" value={camera.worldX} step={0.5}
                  onChange={(e) => updateCamera({ worldX: Number(e.target.value) })} />
                <span style={{ color: 'var(--text-dim)' }} title="Camera tile row (top-bottom)">Cam Row</span>
                <input type="number" value={camera.worldY} step={0.5}
                  onChange={(e) => updateCamera({ worldY: Number(e.target.value) })} />
                <span style={{ color: 'var(--text-dim)' }} title="Look-at tile column">Aim Col</span>
                <input type="number" value={camera.lookAtX} step={0.5}
                  onChange={(e) => updateCamera({ lookAtX: Number(e.target.value) })} />
                <span style={{ color: 'var(--text-dim)' }} title="Look-at tile row">Aim Row</span>
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
        </div>
      )}
    </div>
  )
}
