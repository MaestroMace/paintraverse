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
  const map = useAppStore((s) => s.map)
  const objectDefs = useAppStore((s) => s.objectDefinitions)
  const buildingPalettes = useAppStore((s) => s.buildingPalettes)
  // Track the structural shape we last uploaded to the renderer so we can
  // skip rebuilds when only an unrelated field (e.g. environment.timeOfDay)
  // mutated. updateEnvironment creates a new `map` reference via spread,
  // but layers/grid dims stay referentially stable.
  const loadedStructRef = useRef<{
    layers: unknown
    gridWidth: number
    gridHeight: number
    tileSize: number
    objectDefs: unknown
    palettes: unknown
  } | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const renderer = new ThreeRenderer()
    renderer.init(container)
    renderer.loadMap(map, objectDefs, buildingPalettes)
    loadedStructRef.current = {
      layers: map.layers,
      gridWidth: map.gridWidth,
      gridHeight: map.gridHeight,
      tileSize: map.tileSize,
      objectDefs,
      palettes: buildingPalettes,
    }
    rendererRef.current = renderer
    _activeRenderer = renderer
    return () => {
      renderer.dispose()
      rendererRef.current = null
      _activeRenderer = null
      loadedStructRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const r = rendererRef.current
    const prev = loadedStructRef.current
    if (!r || !prev) return
    // Only rebuild when the scene's actual structural inputs changed. Env
    // tweaks (time of day, weather) spread a new map object but leave these
    // references intact — rebuilding would toss the whole Three scene on
    // every slider tick.
    if (
      prev.layers === map.layers &&
      prev.gridWidth === map.gridWidth &&
      prev.gridHeight === map.gridHeight &&
      prev.tileSize === map.tileSize &&
      prev.objectDefs === objectDefs &&
      prev.palettes === buildingPalettes
    ) return
    r.loadMap(map, objectDefs, buildingPalettes)
    loadedStructRef.current = {
      layers: map.layers,
      gridWidth: map.gridWidth,
      gridHeight: map.gridHeight,
      tileSize: map.tileSize,
      objectDefs,
      palettes: buildingPalettes,
    }
  }, [map, objectDefs, buildingPalettes])

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.updateLighting(map.environment.timeOfDay)
  }, [map.environment.timeOfDay])

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
    link.download = `${map.name.replace(/\s+/g, '_')}_3d_screenshot.png`
    link.href = dataURL
    link.click()
  }, [map.name])

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
