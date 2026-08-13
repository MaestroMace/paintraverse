import { Application, Container, FederatedPointerEvent } from 'pixi.js'
import { Grid } from './Grid'
import { TerrainLayer } from './layers/TerrainLayer'
import { StructureLayer } from './layers/StructureLayer'
import type { ObjectBounds } from './layers/StructureLayer'
import { PropLayer } from './layers/PropLayer'
import { OverlayLayer } from './layers/OverlayLayer'
import type { MapDocument, ObjectDefinition } from '../core/types'
import { useAppStore } from '../app/store'

/**
 * The live 2D viewport, for tools. Mirrors getActiveThreeRenderer: `private`
 * is compile-time only, so the alternative is every harness reaching through
 * React internals to find the instance — and without it a gesture test can
 * only diff PIXELS, which cannot tell a pan from a selection highlight.
 */
let activeViewport: EditorViewport | null = null
export const getActiveEditorViewport = (): EditorViewport | null => activeViewport

export class EditorViewport {
  app: Application
  worldContainer: Container
  grid: Grid
  terrainLayer: TerrainLayer
  structureLayer: StructureLayer
  propLayer: PropLayer
  overlayLayer: OverlayLayer

  private _zoom = 1
  private _panX = 0
  private _panY = 0
  private _isPanning = false
  private _lastPanX = 0
  private _lastPanY = 0
  private _spaceHeld = false
  private _keysHeld = new Set<string>()
  private _cameraTickId = 0
  private _renderScheduled = false
  /** True only between init() completing and destroy(). Guards rAF renders
   *  scheduled in the gap before Pixi's renderer exists or after teardown. */
  private _ready = false
  private _lastHoverTileX = -1
  private _lastHoverTileY = -1
  private _objectBoundsCache: ObjectBounds[] | null = null
  // Stored listener refs for cleanup
  private _wheelHandler: ((e: WheelEvent) => void) | null = null
  private _keyDownHandler: ((e: KeyboardEvent) => void) | null = null
  private _keyUpHandler: ((e: KeyboardEvent) => void) | null = null
  // Touch gestures — see setupTouchGestures.
  private _touchPts = new Map<number, { x: number; y: number }>()
  private _touchStart: { x: number; y: number } | null = null
  private _pinchDist = 1
  /** A gesture is in flight, so the Pixi stage handlers must stand down. */
  private _touchActive = false
  private _touchDown: ((e: PointerEvent) => void) | null = null
  private _touchMove: ((e: PointerEvent) => void) | null = null
  private _touchUp: ((e: PointerEvent) => void) | null = null

  // Callbacks
  onTileClick?: (tileX: number, tileY: number, event: FederatedPointerEvent) => void
  onTileDrag?: (tileX: number, tileY: number, event: FederatedPointerEvent) => void
  onTileUp?: (tileX: number, tileY: number, event: FederatedPointerEvent) => void
  onTileHover?: (tileX: number, tileY: number, event: FederatedPointerEvent) => void

  constructor() {
    this.app = new Application()
    this.worldContainer = new Container()
    this.grid = new Grid()
    this.terrainLayer = new TerrainLayer()
    this.structureLayer = new StructureLayer()
    this.propLayer = new PropLayer()
    this.overlayLayer = new OverlayLayer()
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    // Pre-check: can we actually get a WebGL context?
    const testCanvas = document.createElement('canvas')
    const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl')
    if (!gl) {
      throw new Error('WebGL is not available. Software rendering may not be supported.')
    }
    // Clean up the test context
    const ext = (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')
    if (ext) ext.loseContext()

    // Race PixiJS init against a 6-second timeout
    const initPromise = this.app.init({
      canvas,
      resizeTo: canvas.parentElement!,
      backgroundColor: 0x080c1a,
      antialias: false,
      resolution: 1,
      autoDensity: true,
      preferWebGLVersion: 1,
      preference: 'webgl',
      hello: false
    })

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('PixiJS init timed out after 6s. WebGL context may be stuck.')), 6000)
    })

    await Promise.race([initPromise, timeoutPromise])

    // Throttle idle rendering to 1 FPS (keeps event system alive, near-zero cost)
    // Explicit requestRender() calls handle on-demand frames during interaction
    this.app.ticker.maxFPS = 1

    // Pass app to terrain layer for RenderTexture support
    this.terrainLayer.setApp(this.app)

    this.app.stage.addChild(this.worldContainer)
    this.worldContainer.addChild(this.terrainLayer.container)
    this.worldContainer.addChild(this.grid.container)
    this.worldContainer.addChild(this.structureLayer.container)
    this.worldContainer.addChild(this.propLayer.container)
    this.worldContainer.addChild(this.overlayLayer.container)

    this.setupInteraction()
    this.centerView(32, 32, 32)
    this._ready = true
    activeViewport = this
    this.requestRender()
  }

  /** Where the plan is and how big — pan in screen pixels, zoom as a factor. */
  viewState(): { panX: number; panY: number; zoom: number } {
    return { panX: this._panX, panY: this._panY, zoom: this._zoom }
  }

  /** Coalesce render requests — at most one render per animation frame */
  requestRender(): void {
    if (this._renderScheduled) return
    this._renderScheduled = true
    requestAnimationFrame(() => {
      this._renderScheduled = false
      // app.renderer doesn't exist until init() completes and is gone after
      // destroy(); a frame can be queued in either gap. Skip it safely.
      if (this._ready) this.app.render()
    })
  }

  /**
   * Put the whole map on screen.
   *
   * This used to centre the pan and leave the zoom alone, which on a phone
   * meant opening a 48x48 town at 1:1 — 1536 pixels of plan in a 412-pixel
   * viewport, so you saw about a twelfth of it and had no way to reach the
   * rest. Centring a thing you cannot see the edges of is not centring it.
   *
   * Never magnifies past 1:1: a small map should sit at its authored tile
   * size rather than being blown up to fill a desktop window.
   */
  centerView(gridWidth: number, gridHeight: number, tileSize: number): void {
    const mapW = gridWidth * tileSize
    const mapH = gridHeight * tileSize
    const sw = this.app.screen.width, sh = this.app.screen.height
    if (mapW > 0 && mapH > 0 && sw > 0 && sh > 0) {
      const margin = 0.94
      this._zoom = Math.max(0.05, Math.min(1, Math.min(sw / mapW, sh / mapH) * margin))
    }
    this._panX = (sw - mapW * this._zoom) / 2
    this._panY = (sh - mapH * this._zoom) / 2
    this.updateTransform()
  }

  /** Zoom about a point in screen space, clamped. Shared by wheel and pinch. */
  private zoomAbout(sx: number, sy: number, factor: number): void {
    const next = Math.max(0.1, Math.min(10, this._zoom * factor))
    if (next === this._zoom) return
    this._panX = sx - (sx - this._panX) * (next / this._zoom)
    this._panY = sy - (sy - this._panY) * (next / this._zoom)
    this._zoom = next
    this.updateTransform()
  }

  private setupInteraction(): void {
    const stage = this.app.stage
    stage.eventMode = 'static'
    stage.hitArea = this.app.screen

    stage.on('pointerdown', (e: FederatedPointerEvent) => {
      // A touch that turns out to be a drag is handled by the native gesture
      // listeners below; the tool must not also fire. See setupTouchGestures.
      if (this._touchActive) return
      if (e.button === 1 || (this._spaceHeld && e.button === 0)) {
        this._isPanning = true
        this._lastPanX = e.globalX
        this._lastPanY = e.globalY
        return
      }
      if (e.button === 0) {
        const tile = this.screenToTile(e.globalX, e.globalY)
        this.onTileClick?.(tile.x, tile.y, e)
      }
    })

    stage.on('pointermove', (e: FederatedPointerEvent) => {
      if (this._touchActive) return
      if (this._isPanning) {
        this._panX += e.globalX - this._lastPanX
        this._panY += e.globalY - this._lastPanY
        this._lastPanX = e.globalX
        this._lastPanY = e.globalY
        this.updateTransform()
        return
      }

      const tile = this.screenToTile(e.globalX, e.globalY)

      // Only fire hover when tile coordinate changes (not every pixel)
      if (tile.x !== this._lastHoverTileX || tile.y !== this._lastHoverTileY) {
        this._lastHoverTileX = tile.x
        this._lastHoverTileY = tile.y
        this.onTileHover?.(tile.x, tile.y, e)
      }

      // Drag support for tools
      if (e.buttons === 1 && !this._spaceHeld) {
        this.onTileDrag?.(tile.x, tile.y, e)
      }
    })

    stage.on('pointerup', (e: FederatedPointerEvent) => {
      if (this._touchActive) return
      if (this._isPanning) {
        this._isPanning = false
        return
      }
      if (e.button === 0) {
        const tile = this.screenToTile(e.globalX, e.globalY)
        this.onTileUp?.(tile.x, tile.y, e)
      }
    })

    stage.on('pointerleave', () => {
      this.overlayLayer.clearPreview()
      this.requestRender()
    })

    // Zoom with scroll wheel - smooth
    const canvasEl = this.app.canvas
    this._wheelHandler = (e: WheelEvent) => {
      e.preventDefault()
      this.zoomAbout(e.offsetX, e.offsetY, e.deltaY > 0 ? 0.9 : 1.1)
    }
    canvasEl.addEventListener('wheel', this._wheelHandler, { passive: false })
    this.setupTouchGestures(canvasEl)

    // Space key for panning + WASD for camera movement
    this._keyDownHandler = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        this._spaceHeld = true
        canvasEl.style.cursor = 'grab'
      }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(e.code)) {
        this._keysHeld.add(e.code)
        if (this._keysHeld.size === 1) this.startCameraTick()
      }
    }
    window.addEventListener('keydown', this._keyDownHandler)

    this._keyUpHandler = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        this._spaceHeld = false
        canvasEl.style.cursor = 'default'
      }
      this._keysHeld.delete(e.code)
      if (this._keysHeld.size === 0) this.stopCameraTick()
    }
    window.addEventListener('keyup', this._keyUpHandler)
  }

  /**
   * PAN AND ZOOM ON A TOUCHSCREEN.
   *
   * The 2D plan could not be moved at all on a phone, and the reason is worth
   * writing down because nothing flagged it: panning was bound to the MIDDLE
   * MOUSE BUTTON or space-and-drag, and zoom to the SCROLL WHEEL. A phone has
   * none of the three. Every input this editor had was a desktop input, so the
   * map opened wherever it opened and stayed there.
   *
   * The rule, which is the one every map application uses:
   *
   *   - TWO fingers always pan and pinch, in every tool. A gesture you have to
   *     switch modes to perform is a gesture people do not find.
   *   - ONE finger belongs to the tool — tap to place, drag to paint — EXCEPT
   *     where the tool has no drag behaviour, and then it pans too. Select is
   *     the default tool and does nothing on drag, so the app you first open
   *     scrolls under your thumb, which is what a map is expected to do.
   *
   * `_touchActive` gates the Pixi stage handlers off while a gesture is in
   * flight. Both listen to the same canvas, so without it a two-finger pan
   * also paints a line of cobbles under the first finger.
   */
  private setupTouchGestures(canvasEl: HTMLCanvasElement): void {
    // Without this the browser owns the gesture: a drag scrolls the page and
    // a pinch zooms the whole document instead of the map.
    canvasEl.style.touchAction = 'none'

    const rectPos = (e: PointerEvent) => {
      const r = canvasEl.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    /** Does one finger belong to the tool, or to the map? */
    const toolOwnsDrag = () => {
      const t = useAppStore.getState().activeTool
      return t === 'brush' || t === 'place' || t === 'erase'
    }

    this._touchDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return
      this._touchPts.set(e.pointerId, rectPos(e))
      if (this._touchPts.size === 2) {
        const [a, b] = [...this._touchPts.values()]
        this._pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 1
        this._touchActive = true
      } else if (this._touchPts.size === 1 && !toolOwnsDrag()) {
        // Not active yet — a tap must still reach the tool. It only becomes a
        // pan once the finger has actually travelled (see _touchMove).
        this._touchStart = { ...rectPos(e) }
      }
    }
    this._touchMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || !this._touchPts.has(e.pointerId)) return
      const prev = this._touchPts.get(e.pointerId)!
      const now = rectPos(e)
      this._touchPts.set(e.pointerId, now)

      if (this._touchPts.size >= 2) {
        const [a, b] = [...this._touchPts.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
        const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2
        // Pan by the midpoint's movement, then zoom about the new midpoint —
        // so the two fingers stay on the same two pieces of ground.
        this._panX += (now.x - prev.x) / 2
        this._panY += (now.y - prev.y) / 2
        this.updateTransform()
        this.zoomAbout(midX, midY, dist / this._pinchDist)
        this._pinchDist = dist
        return
      }

      if (this._touchStart && !this._touchActive) {
        const travelled = Math.hypot(now.x - this._touchStart.x, now.y - this._touchStart.y)
        // 8px, so a tap with a shaky thumb still places a building.
        if (travelled > 8) this._touchActive = true
      }
      if (this._touchActive) {
        this._panX += now.x - prev.x
        this._panY += now.y - prev.y
        this.updateTransform()
      }
    }
    this._touchUp = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return
      this._touchPts.delete(e.pointerId)
      if (this._touchPts.size === 0) {
        // Deferred a frame: the stage's own pointerup fires after this one,
        // and clearing the flag synchronously lets the end of a pan land as a
        // tool click on whatever tile the finger stopped over.
        const wasActive = this._touchActive
        this._touchStart = null
        if (wasActive) requestAnimationFrame(() => { this._touchActive = false })
        else this._touchActive = false
      }
    }
    canvasEl.addEventListener('pointerdown', this._touchDown)
    canvasEl.addEventListener('pointermove', this._touchMove)
    canvasEl.addEventListener('pointerup', this._touchUp)
    canvasEl.addEventListener('pointercancel', this._touchUp)
  }

  private updateTransform(): void {
    this.worldContainer.x = this._panX
    this.worldContainer.y = this._panY
    this.worldContainer.scale.set(this._zoom)
    this.requestRender()
  }

  // === WASD Camera Movement ===

  private startCameraTick(): void {
    if (this._cameraTickId) return
    const tick = () => {
      if (this._keysHeld.size === 0) {
        this._cameraTickId = 0
        return // Stop loop when no keys held
      }
      this.tickCamera()
      this._cameraTickId = requestAnimationFrame(tick)
    }
    this._cameraTickId = requestAnimationFrame(tick)
  }

  private stopCameraTick(): void {
    if (this._cameraTickId) {
      cancelAnimationFrame(this._cameraTickId)
      this._cameraTickId = 0
    }
  }

  private tickCamera(): void {
    if (this._keysHeld.size === 0) return
    const store = useAppStore.getState()
    const cam = store.renderCamera
    const speed = 0.25 // tiles per frame

    // Forward/right vectors from camera→lookAt direction
    const dx = cam.lookAtX - cam.worldX
    const dy = cam.lookAtY - cam.worldY
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const fwdX = dx / len, fwdY = dy / len
    const rightX = -fwdY, rightY = fwdX

    let moveX = 0, moveY = 0, moveElev = 0
    if (this._keysHeld.has('KeyW')) { moveX += fwdX * speed; moveY += fwdY * speed }
    if (this._keysHeld.has('KeyS')) { moveX -= fwdX * speed; moveY -= fwdY * speed }
    if (this._keysHeld.has('KeyA')) { moveX -= rightX * speed; moveY -= rightY * speed }
    if (this._keysHeld.has('KeyD')) { moveX += rightX * speed; moveY += rightY * speed }
    if (this._keysHeld.has('KeyQ')) { moveElev += speed * 0.5 }
    if (this._keysHeld.has('KeyE')) { moveElev -= speed * 0.5 }

    if (moveX || moveY || moveElev) {
      store.updateRenderCamera({
        worldX: cam.worldX + moveX,
        worldY: cam.worldY + moveY,
        lookAtX: cam.lookAtX + moveX,
        lookAtY: cam.lookAtY + moveY,
        elevation: Math.max(0.5, cam.elevation + moveElev),
      })
      // Update camera overlay if visible
      this.overlayLayer.showCameraFrustum(
        useAppStore.getState().renderCamera,
        store.map.tileSize
      )
      this.requestRender()
    }
  }

  screenToTile(screenX: number, screenY: number): { x: number; y: number } {
    const worldX = (screenX - this._panX) / this._zoom
    const worldY = (screenY - this._panY) / this._zoom
    const tileSize = this.grid.tileSize
    return {
      x: Math.floor(worldX / tileSize),
      y: Math.floor(worldY / tileSize)
    }
  }

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this._panX) / this._zoom,
      y: (screenY - this._panY) / this._zoom
    }
  }

  updateFromMap(map: MapDocument, objectDefs: ObjectDefinition[]): void {
    this.grid.update(map.gridWidth, map.gridHeight, map.tileSize)

    const terrainLayer = map.layers.find((l) => l.type === 'terrain')
    if (terrainLayer) {
      this.terrainLayer.update(terrainLayer, map.tileSize)
    }

    const structureLayer = map.layers.find((l) => l.type === 'structure')
    if (structureLayer) {
      this.structureLayer.update(structureLayer, map.tileSize, objectDefs)
    }

    const propLayer = map.layers.find((l) => l.type === 'prop')
    if (propLayer) {
      this.propLayer.update(propLayer, map.tileSize, objectDefs)
    }

    this._objectBoundsCache = null
    this.requestRender()
  }

  updateSelection(selectedIds: string[], hoveredId: string | null, tileSize: number): void {
    this.overlayLayer.updateSelection(selectedIds, hoveredId, tileSize, this.getAllObjects())
    this.requestRender()
  }

  getAllObjects(): ObjectBounds[] {
    if (!this._objectBoundsCache) {
      this._objectBoundsCache = [
        ...this.structureLayer.getObjectBounds(),
        ...this.propLayer.getObjectBounds()
      ]
    }
    return this._objectBoundsCache
  }

  updateLayerVisibility(layers: MapDocument['layers']): void {
    for (const layer of layers) {
      switch (layer.type) {
        case 'terrain':
          this.terrainLayer.container.visible = layer.visible
          break
        case 'structure':
          this.structureLayer.container.visible = layer.visible
          break
        case 'prop':
          this.propLayer.container.visible = layer.visible
          break
      }
    }
    this.requestRender()
  }

  resize(): void {
    this.app.resize()
    this.requestRender()
  }

  destroy(): void {
    // Mark not-ready first so any queued rAF render bails instead of touching
    // the torn-down Pixi renderer.
    this._ready = false
    if (activeViewport === this) activeViewport = null
    // Clean up event listeners to prevent memory leaks
    this.stopCameraTick()
    if (this._wheelHandler) {
      this.app.canvas.removeEventListener('wheel', this._wheelHandler)
    }
    if (this._keyDownHandler) {
      window.removeEventListener('keydown', this._keyDownHandler)
    }
    if (this._keyUpHandler) {
      window.removeEventListener('keyup', this._keyUpHandler)
    }
    const cv = this.app.canvas
    if (this._touchDown) cv.removeEventListener('pointerdown', this._touchDown)
    if (this._touchMove) cv.removeEventListener('pointermove', this._touchMove)
    if (this._touchUp) {
      cv.removeEventListener('pointerup', this._touchUp)
      cv.removeEventListener('pointercancel', this._touchUp)
    }
    this.app.destroy(true)
  }
}
