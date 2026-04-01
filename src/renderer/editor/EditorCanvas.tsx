import { useEffect, useRef, useCallback } from 'react'
import { EditorViewport } from './EditorViewport'
import { SelectTool } from './tools/SelectTool'
import { PlaceTool } from './tools/PlaceTool'
import { EraseTool } from './tools/EraseTool'
import { BrushTool } from './tools/BrushTool'
import type { ITool } from './tools/BaseTool'
import { useAppStore } from '../app/store'

const tools: Record<string, ITool> = {
  select: new SelectTool(),
  place: new PlaceTool(),
  erase: new EraseTool(),
  brush: new BrushTool()
}

export function EditorCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<EditorViewport | null>(null)
  const activeToolRef = useRef<ITool>(tools.select)

  const map = useAppStore((s) => s.map)
  const objectDefinitions = useAppStore((s) => s.objectDefinitions)
  const activeTool = useAppStore((s) => s.activeTool)
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds)
  const hoveredObjectId = useAppStore((s) => s.hoveredObjectId)

  // Initialize PixiJS
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const viewport = new EditorViewport()
    viewportRef.current = viewport

    viewport.init(canvas).then(() => {
      viewport.updateFromMap(map, objectDefinitions)
      viewport.centerView(map.gridWidth, map.gridHeight, map.tileSize)

      // Wire up tool callbacks
      viewport.onTileClick = (tx, ty, e) => activeToolRef.current.onTileClick?.(tx, ty, e)
      viewport.onTileDrag = (tx, ty, e) => activeToolRef.current.onTileDrag?.(tx, ty, e)
      viewport.onTileUp = (tx, ty, e) => activeToolRef.current.onTileUp?.(tx, ty, e)

      // Activate initial tool
      activeToolRef.current.onActivate?.(viewport)
    })

    const handleResize = () => viewport.resize()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      viewport.destroy()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Update map rendering when data changes
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    vp.updateFromMap(map, objectDefinitions)
    vp.updateLayerVisibility(map.layers)
    vp.updateSelection(selectedObjectIds, hoveredObjectId, map.tileSize)
  }, [map, objectDefinitions, selectedObjectIds, hoveredObjectId])

  // Switch tools
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    activeToolRef.current.onDeactivate?.()
    activeToolRef.current = tools[activeTool] || tools.select
    activeToolRef.current.onActivate?.(vp)
    canvasRef.current!.style.cursor = activeToolRef.current.cursor
  }, [activeTool])

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const store = useAppStore.getState()

    // Undo/Redo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      store.undo()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) {
      e.preventDefault()
      store.redo()
      return
    }

    // Delete
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (store.activeTool === 'select' && store.selectedObjectIds.length > 0) {
        ;(tools.select as SelectTool).deleteSelected()
      }
    }

    // Tool shortcuts
    if (e.key === 'v' || e.key === '1') store.setActiveTool('select')
    if (e.key === 'p' || e.key === '2') store.setActiveTool('place')
    if (e.key === 'e' || e.key === '3') store.setActiveTool('erase')
    if (e.key === 'b' || e.key === '4') store.setActiveTool('brush')
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  )
}
