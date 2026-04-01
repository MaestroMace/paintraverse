import { Container, Graphics } from 'pixi.js'
import type { ObjectBounds } from './StructureLayer'

export class OverlayLayer {
  container: Container
  private graphics: Graphics

  constructor() {
    this.container = new Container()
    this.graphics = new Graphics()
    this.container.addChild(this.graphics)
  }

  updateSelection(
    selectedIds: string[],
    hoveredId: string | null,
    _tileSize: number,
    allObjects: ObjectBounds[]
  ): void {
    this.graphics.clear()

    // Draw hover highlight
    if (hoveredId) {
      const obj = allObjects.find((o) => o.id === hoveredId)
      if (obj) {
        this.graphics.setStrokeStyle({ width: 2, color: 0x66aaff })
        this.graphics.rect(obj.x - 1, obj.y - 1, obj.width + 2, obj.height + 2)
        this.graphics.stroke()
      }
    }

    // Draw selection highlights
    for (const id of selectedIds) {
      const obj = allObjects.find((o) => o.id === id)
      if (!obj) continue

      // Selection border
      this.graphics.setStrokeStyle({ width: 2, color: 0xffaa00 })
      this.graphics.rect(obj.x - 2, obj.y - 2, obj.width + 4, obj.height + 4)
      this.graphics.stroke()

      // Corner handles
      const handleSize = 6
      const corners = [
        [obj.x - 2, obj.y - 2],
        [obj.x + obj.width - handleSize + 2, obj.y - 2],
        [obj.x - 2, obj.y + obj.height - handleSize + 2],
        [obj.x + obj.width - handleSize + 2, obj.y + obj.height - handleSize + 2]
      ]
      for (const [cx, cy] of corners) {
        this.graphics.rect(cx, cy, handleSize, handleSize)
        this.graphics.fill(0xffaa00)
      }
    }
  }

  showPlacementPreview(tileX: number, tileY: number, width: number, height: number, tileSize: number): void {
    this.graphics.clear()
    this.graphics.rect(tileX * tileSize, tileY * tileSize, width * tileSize, height * tileSize)
    this.graphics.fill({ color: 0x66aaff, alpha: 0.3 })
    this.graphics.setStrokeStyle({ width: 2, color: 0x66aaff })
    this.graphics.rect(tileX * tileSize, tileY * tileSize, width * tileSize, height * tileSize)
    this.graphics.stroke()
  }
}
