import { useEffect, useRef, useCallback } from 'react'
import { EditorViewport } from './EditorViewport'
import { SelectTool } from './tools/SelectTool'
import { PlaceTool } from './tools/PlaceTool'
import { EraseTool } from './tools/EraseTool'
import { BrushTool } from './tools/BrushTool'
import { CameraTool } from './tools/CameraTool'
import type { ITool } from './tools/BaseTool'
import { useAppStore } from '../app/store'

const tools: Record<string, ITool> = {
  select: new SelectTool(),
  place: new PlaceTool(),
  erase: new EraseTool(),
  brush: new BrushTool(),
  camera: new CameraTool()
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

      // Hover callback for live previews
      viewport.onTileHover = (tx, ty, _e) => {
        const store = useAppStore.getState()
        const tool = activeToolRef.current
        const ts = store.map.tileSize
        const gw = store.map.gridWidth
        const gh = store.map.gridHeight

        if (tool.name === 'place') {
          // Show placement ghost
          const defId = store.selectedDefinitionId
          const def = defId ? store.objectDefinitions.find((d) => d.id === defId) : null
          if (def) {
            const inBounds = tx >= 0 && ty >= 0 &&
              tx + def.footprint.w <= gw && ty + def.footprint.h <= gh

            // Check overlap
            const layerType = def.category === 'building' ? 'structure' : 'prop'
            const layer = store.map.layers.find((l) => l.type === layerType)
            let valid = inBounds
            if (valid && layer) {
              valid = !layer.objects.some((o) => {
                const oDef = store.objectDefinitions.find((d) => d.id === o.definitionId)
                if (!oDef) return false
                return !(
                  tx + def.footprint.w <= o.x ||
                  tx >= o.x + oDef.footprint.w ||
                  ty + def.footprint.h <= o.y ||
                  ty >= o.y + oDef.footprint.h
                )
              })
            }
            viewport.overlayLayer.showPlacementPreview(
              tx, ty, def.footprint.w, def.footprint.h, ts, valid
            )
          }
        } else if (tool.name === 'brush') {
          // Show tile highlight for brush
          if (tx >= 0 && ty >= 0 && tx < gw && ty < gh) {
            viewport.overlayLayer.showTileHighlight(tx, ty, ts)
          } else {
            viewport.overlayLayer.clearPreview()
          }
        } else if (tool.name === 'select' || tool.name === 'erase') {
          // Show hover highlight on objects
          const allObjects = viewport.getAllObjects()
          const worldX = tx * ts + ts / 2
          const worldY = ty * ts + ts / 2
          const hit = allObjects.find(
            (o) => worldX >= o.x && worldX <= o.x + o.width &&
                   worldY >= o.y && worldY <= o.y + o.height
          )
          store.setHoveredObjectId(hit?.id ?? null)
          if (!hit) viewport.overlayLayer.clearPreview()
        } else if (tool.name === 'camera') {
          // Camera tool: show current frustum + tile highlight for placement
          if (tx >= 0 && ty >= 0 && tx < gw && ty < gh) {
            viewport.overlayLayer.showTileHighlight(tx, ty, ts)
          }
          // Keep camera frustum visible (drawn by CameraTool)
        } else {
          viewport.overlayLayer.clearPreview()
        }
      }

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
    vp.overlayLayer.clearPreview()
  }, [activeTool])

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Don't capture if typing in an input
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return

    const store = useAppStore.getState()

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

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (store.activeTool === 'select' && store.selectedObjectIds.length > 0) {
        ;(tools.select as SelectTool).deleteSelected()
      }
    }

    if (e.key === 'v' || e.key === '1') store.setActiveTool('select')
    if (e.key === 'p' || e.key === '2') store.setActiveTool('place')
    if (e.key === 'e' || e.key === '3') store.setActiveTool('erase')
    if (e.key === 'b' || e.key === '4') store.setActiveTool('brush')
    if (e.key === 'c' || e.key === '5') store.setActiveTool('camera')
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
