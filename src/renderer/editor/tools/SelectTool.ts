import type { FederatedPointerEvent } from 'pixi.js'
import type { ITool } from './BaseTool'
import type { EditorViewport } from '../EditorViewport'
import type { ObjectBounds } from '../layers/StructureLayer'
import { useAppStore } from '../../app/store'
import { createMoveObjectCommand, createDeleteObjectCommand } from '../../core/commands'

export class SelectTool implements ITool {
  name = 'select'
  cursor = 'default'
  private viewport: EditorViewport | null = null
  private dragStartTileX = 0
  private dragStartTileY = 0
  private dragObjectId: string | null = null
  private dragLayerId: string | null = null
  private isDragging = false

  onActivate(viewport: EditorViewport): void {
    this.viewport = viewport
  }

  onTileClick(tileX: number, tileY: number, event: FederatedPointerEvent): void {
    if (!this.viewport) return

    const store = useAppStore.getState()
    const allObjects = this.getAllObjectBounds()
    const tileSize = store.map.tileSize

    // Find object at click position
    const worldX = tileX * tileSize + tileSize / 2
    const worldY = tileY * tileSize + tileSize / 2

    const hit = allObjects.find(
      (o) =>
        worldX >= o.x &&
        worldX <= o.x + o.width &&
        worldY >= o.y &&
        worldY <= o.y + o.height
    )

    if (hit) {
      const isMulti = event.shiftKey
      if (isMulti) {
        const ids = store.selectedObjectIds.includes(hit.id)
          ? store.selectedObjectIds.filter((id) => id !== hit.id)
          : [...store.selectedObjectIds, hit.id]
        store.setSelectedObjectIds(ids)
      } else {
        store.setSelectedObjectIds([hit.id])
      }
      this.dragObjectId = hit.id
      this.dragLayerId = hit.layerId
      this.dragStartTileX = tileX
      this.dragStartTileY = tileY
      this.isDragging = false
    } else {
      store.setSelectedObjectIds([])
      this.dragObjectId = null
    }
  }

  onTileDrag(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    if (!this.dragObjectId || !this.dragLayerId) return

    if (tileX !== this.dragStartTileX || tileY !== this.dragStartTileY) {
      this.isDragging = true
    }

    if (this.isDragging) {
      const store = useAppStore.getState()
      // Live preview: directly move the object
      store.updateObjectInLayer(this.dragLayerId, this.dragObjectId, {
        x: tileX,
        y: tileY
      })
    }
  }

  onTileUp(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    if (!this.dragObjectId || !this.dragLayerId || !this.isDragging) {
      this.dragObjectId = null
      this.isDragging = false
      return
    }

    // Create undo command for the move
    if (tileX !== this.dragStartTileX || tileY !== this.dragStartTileY) {
      const store = useAppStore.getState()
      // Move back to start first (undo the live preview), then execute via command
      store.updateObjectInLayer(this.dragLayerId, this.dragObjectId, {
        x: this.dragStartTileX,
        y: this.dragStartTileY
      })

      const cmd = createMoveObjectCommand(
        this.dragLayerId,
        this.dragObjectId,
        this.dragStartTileX,
        this.dragStartTileY,
        tileX,
        tileY,
        store.updateObjectInLayer
      )
      store.executeCommand(cmd)
    }

    this.dragObjectId = null
    this.isDragging = false
  }

  deleteSelected(): void {
    const store = useAppStore.getState()
    for (const id of store.selectedObjectIds) {
      // Find which layer has this object
      for (const layer of store.map.layers) {
        const obj = layer.objects.find((o) => o.id === id)
        if (obj) {
          const cmd = createDeleteObjectCommand(
            layer.id,
            obj,
            store.addObjectToLayer,
            store.removeObjectFromLayer
          )
          store.executeCommand(cmd)
          break
        }
      }
    }
    store.setSelectedObjectIds([])
  }

  private getAllObjectBounds(): ObjectBounds[] {
    if (!this.viewport) return []
    return [
      ...this.viewport.structureLayer.getObjectBounds(),
      ...this.viewport.propLayer.getObjectBounds()
    ]
  }
}
