import type { FederatedPointerEvent } from 'pixi.js'
import type { ITool } from './BaseTool'
import type { EditorViewport } from '../EditorViewport'
import { useAppStore } from '../../app/store'

export class CameraTool implements ITool {
  name = 'camera'
  cursor = 'crosshair'
  private viewport: EditorViewport | null = null
  private isDragging = false
  private startTileX = 0
  private startTileY = 0

  onActivate(viewport: EditorViewport): void {
    this.viewport = viewport
    // Show current camera on activation
    this.updateCameraOverlay()
  }

  onDeactivate(): void {
    // Don't clear - leave camera visible
  }

  onTileClick(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    // Place camera position
    this.startTileX = tileX
    this.startTileY = tileY
    this.isDragging = true

    const store = useAppStore.getState()
    store.updateRenderCamera({
      worldX: tileX,
      worldY: tileY
    })
    this.updateCameraOverlay()
  }

  onTileDrag(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    if (!this.isDragging) return

    // Drag sets the look-at target
    const store = useAppStore.getState()
    store.updateRenderCamera({
      lookAtX: tileX,
      lookAtY: tileY
    })
    this.updateCameraOverlay()
  }

  onTileUp(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    if (!this.isDragging) return
    this.isDragging = false

    // Final look-at position
    const store = useAppStore.getState()

    // If didn't drag (clicked same tile), set a reasonable default look direction
    if (tileX === this.startTileX && tileY === this.startTileY) {
      const map = store.map
      store.updateRenderCamera({
        worldX: tileX,
        worldY: tileY,
        lookAtX: map.gridWidth / 2,
        lookAtY: map.gridHeight / 2
      })
    } else {
      store.updateRenderCamera({
        lookAtX: tileX,
        lookAtY: tileY
      })
    }
    this.updateCameraOverlay()
  }

  updateCameraOverlay(): void {
    if (!this.viewport) return
    const cam = useAppStore.getState().renderCamera
    const ts = useAppStore.getState().map.tileSize
    this.viewport.overlayLayer.showCameraFrustum(cam, ts)
    this.viewport.requestRender()
  }
}
