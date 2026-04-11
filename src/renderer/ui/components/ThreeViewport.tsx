/**
 * ThreeViewport: Full-screen Three.js 3D view component.
 * Takes over the main editor canvas area for real-time town exploration.
 */

import { useRef, useEffect, useCallback, useState } from 'react'
import { useAppStore } from '../../app/store'
import { ThreeRenderer } from '../../renderer3d/ThreeRenderer'

// Expose renderer globally so RenderPanel can access it for screenshots
let _activeRenderer: ThreeRenderer | null = null
export function getActiveThreeRenderer(): ThreeRenderer | null { return _activeRenderer }

export function ThreeViewport() {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<ThreeRenderer | null>(null)
  const [locked, setLocked] = useState(false)
  const map = useAppStore((s) => s.map)
  const objectDefs = useAppStore((s) => s.objectDefinitions)
  const buildingPalettes = useAppStore((s) => s.buildingPalettes)

  // Track the map identity that was last loaded to prevent double-load
  const loadedMapRef = useRef<unknown>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new ThreeRenderer()
    renderer.init(container)
    renderer.loadMap(map, objectDefs, buildingPalettes)
    loadedMapRef.current = map
    rendererRef.current = renderer
    _activeRenderer = renderer

    return () => {
      renderer.dispose()
      rendererRef.current = null
      _activeRenderer = null
      loadedMapRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Reload map when it changes (skip if same map object already loaded)
  useEffect(() => {
    if (!rendererRef.current || map === loadedMapRef.current) return
    rendererRef.current.loadMap(map, objectDefs, buildingPalettes)
    loadedMapRef.current = map
  }, [map, objectDefs, buildingPalettes])

  // Track pointer lock state for UI overlay
  useEffect(() => {
    const handler = () => setLocked(!!document.pointerLockElement)
    document.addEventListener('pointerlockchange', handler)
    return () => document.removeEventListener('pointerlockchange', handler)
  }, [])

  // Update lighting when time-of-day changes
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.updateLighting(map.environment.timeOfDay)
    }
  }, [map.environment.timeOfDay])

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
        cursor: 'crosshair',
      }}
    >
      {/* Controls overlay */}
      {locked ? (
        <div style={{
          position: 'absolute', bottom: 12, left: 12,
          background: 'rgba(0,0,0,0.6)', padding: '6px 12px',
          borderRadius: 6, fontSize: 11, color: '#ccc',
          pointerEvents: 'none', fontFamily: 'monospace',
          lineHeight: 1.8,
        }}>
          <span style={{ color: '#4ade80' }}>WASD</span> move &nbsp;
          <span style={{ color: '#4ade80' }}>Q/E</span> up/down &nbsp;
          <span style={{ color: '#4ade80' }}>Mouse</span> look &nbsp;
          <span style={{ color: '#f87171' }}>Esc</span> release
        </div>
      ) : (
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(0,0,0,0.7)', padding: '16px 28px',
          borderRadius: 8, fontSize: 14, color: '#fff',
          pointerEvents: 'none', fontFamily: 'monospace',
          textAlign: 'center',
        }}>
          Click to enter walkthrough<br/>
          <span style={{ fontSize: 11, color: '#aaa' }}>WASD move / Mouse look / Esc to exit</span>
        </div>
      )}
      {/* Screenshot button */}
      <button
        onClick={handleScreenshot}
        style={{
          position: 'absolute', bottom: 12, right: 12,
          padding: '5px 12px', fontSize: 11,
          background: 'rgba(0,0,0,0.6)', color: '#ccc',
          border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: 6, cursor: 'pointer',
        }}
      >
        Screenshot
      </button>
    </div>
  )
}
