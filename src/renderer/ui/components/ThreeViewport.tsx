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
  useEffect(() => {
    const iv = setInterval(() => {
      if (rendererRef.current) {
        setFpsText(`${rendererRef.current.fps} FPS | ${rendererRef.current.drawCalls} draws`)
      }
    }, 1000)
    return () => clearInterval(iv)
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
        cursor: 'grab',
      }}
    >
      {/* Controls hint — bottom left */}
      <div style={{
        position: 'absolute', bottom: 8, left: 8,
        background: 'rgba(0,0,0,0.6)', padding: '4px 10px',
        borderRadius: 4, fontSize: 10, color: '#aaa',
        pointerEvents: 'none', fontFamily: 'monospace',
      }}>
        <span style={{ color: '#4ade80' }}>WASD</span> move &nbsp;
        <span style={{ color: '#4ade80' }}>Q/E</span> up/down &nbsp;
        <span style={{ color: '#4ade80' }}>Drag</span> look
      </div>
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
