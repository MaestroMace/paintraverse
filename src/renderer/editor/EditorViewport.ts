import { Application, Container, FederatedPointerEvent } from 'pixi.js'
import { Grid } from './Grid'
import { TerrainLayer } from './layers/TerrainLayer'
import { StructureLayer } from './layers/StructureLayer'
import { PropLayer } from './layers/PropLayer'
import { OverlayLayer } from './layers/OverlayLayer'
import type { MapDocument, ObjectDefinition } from '../core/types'

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
    // Try WebGL with fallback options for environments without full GPU support
    await this.app.init({
      canvas,
      resizeTo: canvas.parentElement!,
      backgroundColor: 0x080c1a,
      antialias: false,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      preferWebGLVersion: 2,
      preference: 'webgl'
    })

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

      // Always fire hover for preview feedback
      this.onTileHover?.(tile.x, tile.y, e)

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

    // Space key for panning
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        this._spaceHeld = true
        canvasEl.style.cursor = 'grab'
      }
    })

    window.addEventListener('keyup', (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        this._spaceHeld = false
        canvasEl.style.cursor = 'default'
      }
    })
  }

  private updateTransform(): void {
    this.worldContainer.x = this._panX
    this.worldContainer.y = this._panY
    this.worldContainer.scale.set(this._zoom)
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
  }

  updateSelection(selectedIds: string[], hoveredId: string | null, tileSize: number): void {
    this.overlayLayer.updateSelection(selectedIds, hoveredId, tileSize, this.getAllObjects())
  }

  getAllObjects() {
    return [
      ...this.structureLayer.getObjectBounds(),
      ...this.propLayer.getObjectBounds()
    ]
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
  }

  resize(): void {
    this.app.resize()
  }

  destroy(): void {
    this.app.destroy(true)
  }
}
