import { Application, Container, FederatedPointerEvent } from 'pixi.js'
import { Grid } from './Grid'
import { TerrainLayer } from './layers/TerrainLayer'
import { StructureLayer } from './layers/StructureLayer'
import { PropLayer } from './layers/PropLayer'
import { OverlayLayer } from './layers/OverlayLayer'
import type { MapDocument, ObjectDefinition } from '../core/types'
import { useAppStore } from '../app/store'

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
  private _lastHoverTileX = -1
  private _lastHoverTileY = -1
  private _objectBoundsCache: ReturnType<EditorViewport['getAllObjects']> | null = null

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
    this.requestRender()
  }

  /** Coalesce render requests — at most one render per animation frame */
  requestRender(): void {
    if (this._renderScheduled) return
    this._renderScheduled = true
    requestAnimationFrame(() => {
      this._renderScheduled = false
      this.app.render()
    })
  }

  centerView(gridWidth: number, gridHeight: number, tileSize: number): void {
    const mapW = gridWidth * tileSize
    const mapH = gridHeight * tileSize
    this._panX = (this.app.screen.width - mapW * this._zoom) / 2
    this._panY = (this.app.screen.height - mapH * this._zoom) / 2
    this.updateTransform()
  }

  private setupInteraction(): void {
    const stage = this.app.stage
    stage.eventMode = 'static'
    stage.hitArea = this.app.screen

    stage.on('pointerdown', (e: FederatedPointerEvent) => {
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
    canvasEl.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault()
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1
      const newZoom = Math.max(0.1, Math.min(10, this._zoom * zoomFactor))

      const mouseX = e.offsetX
      const mouseY = e.offsetY
      this._panX = mouseX - (mouseX - this._panX) * (newZoom / this._zoom)
      this._panY = mouseY - (mouseY - this._panY) * (newZoom / this._zoom)
      this._zoom = newZoom

      this.updateTransform()
    }, { passive: false })

    // Space key for panning + WASD for camera movement
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        this._spaceHeld = true
        canvasEl.style.cursor = 'grab'
      }
      // WASD + QE for camera movement
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(e.code)) {
        this._keysHeld.add(e.code)
        if (this._keysHeld.size === 1) this.startCameraTick()
      }
    })

    window.addEventListener('keyup', (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        this._spaceHeld = false
        canvasEl.style.cursor = 'default'
      }
      this._keysHeld.delete(e.code)
      if (this._keysHeld.size === 0) this.stopCameraTick()
    })
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

  getAllObjects() {
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
    this.app.destroy(true)
  }
}
