/**
 * ThreeViewport: Full-screen Three.js 3D view component.
 * Takes over the main editor canvas area for real-time town exploration.
 */

import { useRef, useEffect, useCallback, useState } from 'react'
import { useAppStore } from '../../app/store'
import { ThreeRenderer } from '../../renderer3d/ThreeRenderer'

let _activeRenderer: ThreeRenderer | null = null
export function getActiveThreeRenderer(): ThreeRenderer | null { return _activeRenderer }

export function ThreeViewport() {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<ThreeRenderer | null>(null)

  // Subscribe to the NARROW slices we actually react to, not the whole `map`.
  // updateEnvironment() spreads a new map object on every slider tick, so a
  // whole-map subscription re-rendered this viewport ~24x/sec while dragging
  // the weather/moon/star/ambient/sun sliders — even though only timeOfDay
  // drives the 3D lighting. layers/grid drive structural rebuilds; name only
  // feeds the screenshot filename.
  const layers = useAppStore((s) => s.map.layers)
  const gridWidth = useAppStore((s) => s.map.gridWidth)
  const gridHeight = useAppStore((s) => s.map.gridHeight)
  const tileSize = useAppStore((s) => s.map.tileSize)
  const timeOfDay = useAppStore((s) => s.map.environment.timeOfDay)
  const mapName = useAppStore((s) => s.map.name)
  const objectDefs = useAppStore((s) => s.objectDefinitions)
  const buildingPalettes = useAppStore((s) => s.buildingPalettes)

  // Mount: build the renderer once from the current map snapshot.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const renderer = new ThreeRenderer()
    renderer.init(container)
    renderer.loadMap(useAppStore.getState().map, objectDefs, buildingPalettes)
    rendererRef.current = renderer
    _activeRenderer = renderer
    return () => {
      renderer.dispose()
      rendererRef.current = null
      _activeRenderer = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Rebuild the scene only when its structural inputs change. Environment
  // tweaks no longer reach here (we don't subscribe to the whole map), so the
  // old manual ref-diff guarding against per-tick rebuilds is unnecessary.
  const skipFirstStruct = useRef(true)
  useEffect(() => {
    if (skipFirstStruct.current) { skipFirstStruct.current = false; return } // mount already loaded
    rendererRef.current?.loadMap(useAppStore.getState().map, objectDefs, buildingPalettes)
  }, [layers, gridWidth, gridHeight, tileSize, objectDefs, buildingPalettes])

  // Lighting tracks time of day.
  useEffect(() => {
    rendererRef.current?.updateLighting(timeOfDay)
  }, [timeOfDay])

  // FPS/draws telemetry: updates once per second. Writing to a ref'd DOM
  // node avoids a React state update → full component re-render every tick,
  // which would reconcile the entire viewport subtree just to redraw one
  // short string.
  const fpsTextRef = useRef<HTMLDivElement>(null)
  const [locked, setLocked] = useState(false)
  useEffect(() => {
    const iv = setInterval(() => {
      const el = fpsTextRef.current
      const r = rendererRef.current
      if (el && r) el.textContent = `${r.fps} FPS | ${r.drawCalls} draws`
    }, 1000)
    const onLockChange = () => setLocked(!!rendererRef.current?.isPointerLocked)
    document.addEventListener('pointerlockchange', onLockChange)
    return () => {
      clearInterval(iv)
      document.removeEventListener('pointerlockchange', onLockChange)
    }
  }, [])

  const handleScreenshot = useCallback(() => {
    if (!rendererRef.current) return
    const dataURL = rendererRef.current.captureScreenshot()
    if (!dataURL) return
    const link = document.createElement('a')
    link.download = `${mapName.replace(/\s+/g, '_')}_3d_screenshot.png`
    link.href = dataURL
    link.click()
  }, [mapName])

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        background: '#000',
        cursor: 'pointer',
      }}
    >
      {/* "Click to enter" overlay — shown only when pointer is NOT locked.
          Clear signal that the viewport needs to be clicked to start
          walking around. pointerEvents:none so the click passes to canvas. */}
      {!locked && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none', zIndex: 2,
        }}>
          <div style={{
            background: 'rgba(0,0,0,0.55)', color: '#e8e8e8',
            padding: '14px 22px', borderRadius: 8,
            fontFamily: 'monospace', fontSize: 13, textAlign: 'center',
            border: '1px solid rgba(255,255,255,0.15)',
          }}>
            <div style={{ fontSize: 16, marginBottom: 6, color: '#4ade80' }}>Click to walk</div>
            <div style={{ opacity: 0.8 }}>
              <b>WASD</b> move &nbsp;·&nbsp; <b>mouse</b> look &nbsp;·&nbsp; <b>space</b> jump<br />
              <b>2×space</b> fly &nbsp;·&nbsp; <b>shift</b> descend &nbsp;·&nbsp; <b>esc</b> release
            </div>
          </div>
        </div>
      )}
      {/* FPS — top left. Content written imperatively via fpsTextRef to
          avoid re-rendering the viewport each tick. */}
      <div
        ref={fpsTextRef}
        style={{
          position: 'absolute', top: 4, left: 4,
          background: 'rgba(0,0,0,0.5)', padding: '2px 6px',
          borderRadius: 3, fontSize: 10, fontFamily: 'monospace',
          color: '#4ade80', pointerEvents: 'none',
        }}
      >...</div>
      {/* Screenshot — bottom right */}
      <button
        onClick={handleScreenshot}
        style={{
          position: 'absolute', bottom: 8, right: 8,
          padding: '4px 10px', fontSize: 10,
          background: 'rgba(0,0,0,0.6)', color: '#aaa',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 4, cursor: 'pointer',
        }}
      >
        Screenshot
      </button>
    </div>
  )
}
