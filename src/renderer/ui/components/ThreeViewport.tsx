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

  useEffect(() => {
    if (!rendererRef.current || map === loadedMapRef.current) return
    rendererRef.current.loadMap(map, objectDefs, buildingPalettes)
    loadedMapRef.current = map
  }, [map, objectDefs, buildingPalettes])

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.updateLighting(map.environment.timeOfDay)
  }, [map.environment.timeOfDay])

  const [fpsText, setFpsText] = useState('')
  const [locked, setLocked] = useState(false)
  useEffect(() => {
    const iv = setInterval(() => {
      if (rendererRef.current) {
        setFpsText(`${rendererRef.current.fps} FPS | ${rendererRef.current.drawCalls} draws`)
      }
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
      {/* FPS — top left */}
      <div style={{
        position: 'absolute', top: 4, left: 4,
        background: 'rgba(0,0,0,0.5)', padding: '2px 6px',
        borderRadius: 3, fontSize: 10, fontFamily: 'monospace',
        color: '#4ade80', pointerEvents: 'none',
      }}>
        {fpsText || '...'}
      </div>
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
