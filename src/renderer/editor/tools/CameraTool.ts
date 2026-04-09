import type { FederatedPointerEvent } from 'pixi.js'
import type { ITool } from './BaseTool'
import type { EditorViewport } from '../EditorViewport'
import { useAppStore } from '../../app/store'

export class CameraTool implements ITool {
  name = 'camera'
  cursor = 'crosshair'
  private viewport: EditorViewport | null = null
  private isDragging = false

  onActivate(viewport: EditorViewport): void {
    this.viewport = viewport
    this.updateCameraOverlay()
  }

  onDeactivate(): void {
    // Don't clear - leave camera visible
  }

  onTileClick(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    // Click sets look-at target (aim direction) — WASD handles position
    this.isDragging = true
    const store = useAppStore.getState()
    store.updateRenderCamera({
      lookAtX: tileX,
      lookAtY: tileY
    })
    this.updateCameraOverlay()
  }

  onTileDrag(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    if (!this.isDragging) return
    // Drag updates the look-at target in real-time
    const store = useAppStore.getState()
    store.updateRenderCamera({
      lookAtX: tileX,
      lookAtY: tileY
    })
    this.updateCameraOverlay()
  }

  onTileUp(_tileX: number, _tileY: number, _event: FederatedPointerEvent): void {
    this.isDragging = false
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
