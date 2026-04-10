/**
 * ThreeViewport: Full-screen Three.js 3D view component.
 * Takes over the main editor canvas area for real-time town exploration.
 */

import { useRef, useEffect } from 'react'
import { useAppStore } from '../../app/store'
import { ThreeRenderer } from '../../renderer3d/ThreeRenderer'

export function ThreeViewport() {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<ThreeRenderer | null>(null)
  const map = useAppStore((s) => s.map)
  const objectDefs = useAppStore((s) => s.objectDefinitions)
  const buildingPalettes = useAppStore((s) => s.buildingPalettes)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new ThreeRenderer()
    renderer.init(container)
    renderer.loadMap(map, objectDefs, buildingPalettes)
    rendererRef.current = renderer

    return () => {
      renderer.dispose()
      rendererRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Reload map when it changes
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.loadMap(map, objectDefs, buildingPalettes)
    }
  }, [map, objectDefs, buildingPalettes])

  // Update lighting when time-of-day changes
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.updateLighting(map.environment.timeOfDay)
    }
  }, [map.environment.timeOfDay])

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
      <div style={{
        position: 'absolute', bottom: 12, left: 12,
        background: 'rgba(0,0,0,0.6)', padding: '6px 12px',
        borderRadius: 6, fontSize: 11, color: '#ccc',
        pointerEvents: 'none', fontFamily: 'monospace',
        lineHeight: 1.8,
      }}>
        <span style={{ color: '#4ade80' }}>WASD</span> move &nbsp;
        <span style={{ color: '#4ade80' }}>Q/E</span> up/down &nbsp;
        <span style={{ color: '#4ade80' }}>Drag</span> look
      </div>
    </div>
  )
}
