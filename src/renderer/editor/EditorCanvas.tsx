import { useEffect, useRef, useCallback, useState } from 'react'
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
  const [initError, setInitError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const map = useAppStore((s) => s.map)
  const objectDefinitions = useAppStore((s) => s.objectDefinitions)
  const activeTool = useAppStore((s) => s.activeTool)
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds)
  const hoveredObjectId = useAppStore((s) => s.hoveredObjectId)

  // Initialize PixiJS with timeout and error handling
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let destroyed = false
    const viewport = new EditorViewport()
    viewportRef.current = viewport

    // Timeout: if init takes more than 8 seconds, it's stuck on GPU
    const initTimeout = setTimeout(() => {
      if (!destroyed) {
        setInitError('Canvas initialization timed out. GPU/WebGL may not be available. Try reloading the app.')
        setIsLoading(false)
      }
    }, 8000)

    viewport.init(canvas).then(() => {
      if (destroyed) return
      clearTimeout(initTimeout)
      setIsLoading(false)

      viewport.updateFromMap(map, objectDefinitions)
      viewport.centerView(map.gridWidth, map.gridHeight, map.tileSize)

      // Wire up tool callbacks
      viewport.onTileClick = (tx, ty, e) => activeToolRef.current.onTileClick?.(tx, ty, e)
      viewport.onTileDrag = (tx, ty, e) => activeToolRef.current.onTileDrag?.(tx, ty, e)
      viewport.onTileUp = (tx, ty, e) => activeToolRef.current.onTileUp?.(tx, ty, e)

      // Hover callback for live previews
      viewport.onTileHover = (tileX, tileY, _e) => {
        const store = useAppStore.getState()
        const tool = activeToolRef.current
        const ts = store.map.tileSize
        const gw = store.map.gridWidth
        const gh = store.map.gridHeight

        if (tool.name === 'place') {
          const defId = store.selectedDefinitionId
          const def = defId ? store.objectDefinitions.find((d) => d.id === defId) : null
          if (def) {
            const inBounds = tileX >= 0 && tileY >= 0 &&
              tileX + def.footprint.w <= gw && tileY + def.footprint.h <= gh

            const layerType = def.category === 'building' ? 'structure' : 'prop'
            const layer = store.map.layers.find((l) => l.type === layerType)
            let valid = inBounds
            if (valid && layer) {
              valid = !layer.objects.some((o) => {
                const oDef = store.objectDefinitions.find((d) => d.id === o.definitionId)
                if (!oDef) return false
                return !(
                  tileX + def.footprint.w <= o.x ||
                  tileX >= o.x + oDef.footprint.w ||
                  tileY + def.footprint.h <= o.y ||
                  tileY >= o.y + oDef.footprint.h
                )
              })
            }
            viewport.overlayLayer.showPlacementPreview(
              tileX, tileY, def.footprint.w, def.footprint.h, ts, valid
            )
          }
        } else if (tool.name === 'brush') {
          if (tileX >= 0 && tileY >= 0 && tileX < gw && tileY < gh) {
            viewport.overlayLayer.showTileHighlight(tileX, tileY, ts)
          } else {
            viewport.overlayLayer.clearPreview()
          }
        } else if (tool.name === 'select' || tool.name === 'erase') {
          const allObjects = viewport.getAllObjects()
          const worldX = tileX * ts + ts / 2
          const worldY = tileY * ts + ts / 2
          const hit = allObjects.find(
            (o) => worldX >= o.x && worldX <= o.x + o.width &&
                   worldY >= o.y && worldY <= o.y + o.height
          )
          store.setHoveredObjectId(hit?.id ?? null)
          if (!hit) viewport.overlayLayer.clearPreview()
        } else if (tool.name === 'camera') {
          if (tileX >= 0 && tileY >= 0 && tileX < gw && tileY < gh) {
            viewport.overlayLayer.showTileHighlight(tileX, tileY, ts)
          }
        } else {
          viewport.overlayLayer.clearPreview()
        }
      }

      activeToolRef.current.onActivate?.(viewport)
    }).catch((err) => {
      if (destroyed) return
      clearTimeout(initTimeout)
      console.error('EditorCanvas init failed:', err)
      setInitError(`Canvas failed to initialize: ${err?.message || err}. Try reloading or check GPU drivers.`)
      setIsLoading(false)
    })

    const handleResize = () => {
      if (!destroyed) viewport.resize()
    }
    window.addEventListener('resize', handleResize)

    return () => {
      destroyed = true
      clearTimeout(initTimeout)
      window.removeEventListener('resize', handleResize)
      viewport.destroy()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Update map rendering when data changes
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp || initError) return
    vp.updateFromMap(map, objectDefinitions)
    vp.updateLayerVisibility(map.layers)
    vp.updateSelection(selectedObjectIds, hoveredObjectId, map.tileSize)
  }, [map, objectDefinitions, selectedObjectIds, hoveredObjectId, initError])

  // Switch tools
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp || initError) return
    activeToolRef.current.onDeactivate?.()
    activeToolRef.current = tools[activeTool] || tools.select
    activeToolRef.current.onActivate?.(vp)
    if (canvasRef.current) {
      canvasRef.current.style.cursor = activeToolRef.current.cursor
    }
    vp.overlayLayer.clearPreview()
  }, [activeTool, initError])

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
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

  // Error state
  if (initError) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 16, padding: 32, textAlign: 'center',
        background: 'var(--bg-dark)'
      }}>
        <div style={{ fontSize: 36, opacity: 0.4 }}>{'\u26A0'}</div>
        <div style={{ color: 'var(--accent)', fontSize: 14, fontWeight: 600 }}>
          Canvas Initialization Error
        </div>
        <div style={{ color: 'var(--text-dim)', fontSize: 12, maxWidth: 400, lineHeight: 1.6 }}>
          {initError}
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{ marginTop: 8 }}
        >
          Reload
        </button>
      </div>
    )
  }

  // Loading state
  if (isLoading) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 12, background: 'var(--bg-dark)'
      }}>
        <div style={{
          width: 32, height: 32, border: '2px solid rgba(240, 192, 64, 0.2)',
          borderTopColor: 'var(--accent)', borderRadius: '50%',
          animation: 'spin 1s linear infinite'
        }} />
        <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
          Initializing canvas...
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  )
}
