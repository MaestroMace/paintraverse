import { Container, Graphics } from 'pixi.js'
import type { ObjectBounds } from './StructureLayer'

export class OverlayLayer {
  container: Container
  private selectionGraphics: Graphics
  private previewGraphics: Graphics
  private hoverGraphics: Graphics

  constructor() {
    this.container = new Container()
    this.hoverGraphics = new Graphics()
    this.selectionGraphics = new Graphics()
    this.previewGraphics = new Graphics()
    this.container.addChild(this.hoverGraphics)
    this.container.addChild(this.selectionGraphics)
    this.container.addChild(this.previewGraphics)
  }

  updateSelection(
    selectedIds: string[],
    hoveredId: string | null,
    _tileSize: number,
    allObjects: ObjectBounds[]
  ): void {
    this.selectionGraphics.clear()
    this.hoverGraphics.clear()

    // Hover highlight (blue glow)
    if (hoveredId && !selectedIds.includes(hoveredId)) {
      const obj = allObjects.find((o) => o.id === hoveredId)
      if (obj) {
        // Outer glow
        this.hoverGraphics.setStrokeStyle({ width: 3, color: 0x66aaff, alpha: 0.4 })
        this.hoverGraphics.rect(obj.x - 3, obj.y - 3, obj.width + 6, obj.height + 6)
        this.hoverGraphics.stroke()
        // Inner border
        this.hoverGraphics.setStrokeStyle({ width: 1.5, color: 0x66aaff })
        this.hoverGraphics.rect(obj.x - 1, obj.y - 1, obj.width + 2, obj.height + 2)
        this.hoverGraphics.stroke()
      }
    }

    // Selection highlights (orange with handles)
    for (const id of selectedIds) {
      const obj = allObjects.find((o) => o.id === id)
      if (!obj) continue

      // Animated-looking selection (bright dashed feel via double stroke)
      this.selectionGraphics.setStrokeStyle({ width: 3, color: 0xffaa00, alpha: 0.3 })
      this.selectionGraphics.rect(obj.x - 3, obj.y - 3, obj.width + 6, obj.height + 6)
      this.selectionGraphics.stroke()

      this.selectionGraphics.setStrokeStyle({ width: 1.5, color: 0xffcc33 })
      this.selectionGraphics.rect(obj.x - 1, obj.y - 1, obj.width + 2, obj.height + 2)
      this.selectionGraphics.stroke()

      // Corner handles
      const hs = 5
      const corners = [
        [obj.x - hs / 2, obj.y - hs / 2],
        [obj.x + obj.width - hs / 2, obj.y - hs / 2],
        [obj.x - hs / 2, obj.y + obj.height - hs / 2],
        [obj.x + obj.width - hs / 2, obj.y + obj.height - hs / 2]
      ]
      for (const [cx, cy] of corners) {
        this.selectionGraphics.rect(cx, cy, hs, hs)
        this.selectionGraphics.fill(0xffcc33)
        this.selectionGraphics.setStrokeStyle({ width: 1, color: 0x000000 })
        this.selectionGraphics.rect(cx, cy, hs, hs)
        this.selectionGraphics.stroke()
      }
    }
  }

  showPlacementPreview(
    tileX: number, tileY: number,
    width: number, height: number,
    tileSize: number,
    valid: boolean
  ): void {
    this.previewGraphics.clear()
    const px = tileX * tileSize
    const py = tileY * tileSize
    const pw = width * tileSize
    const ph = height * tileSize

    const color = valid ? 0x66aaff : 0xff4444

    // Semi-transparent fill
    this.previewGraphics.rect(px, py, pw, ph)
    this.previewGraphics.fill({ color, alpha: 0.2 })

    // Border
    this.previewGraphics.setStrokeStyle({ width: 2, color, alpha: 0.8 })
    this.previewGraphics.rect(px, py, pw, ph)
    this.previewGraphics.stroke()

    // Crosshair at center
    const cx = px + pw / 2
    const cy = py + ph / 2
    this.previewGraphics.setStrokeStyle({ width: 1, color, alpha: 0.5 })
    this.previewGraphics.moveTo(cx - 6, cy)
    this.previewGraphics.lineTo(cx + 6, cy)
    this.previewGraphics.moveTo(cx, cy - 6)
    this.previewGraphics.lineTo(cx, cy + 6)
    this.previewGraphics.stroke()
  }

  showTileHighlight(tileX: number, tileY: number, tileSize: number): void {
    this.previewGraphics.clear()
    this.previewGraphics.rect(tileX * tileSize, tileY * tileSize, tileSize, tileSize)
    this.previewGraphics.fill({ color: 0xffffff, alpha: 0.1 })
    this.previewGraphics.setStrokeStyle({ width: 1, color: 0xffffff, alpha: 0.3 })
    this.previewGraphics.rect(tileX * tileSize, tileY * tileSize, tileSize, tileSize)
    this.previewGraphics.stroke()
  }

  clearPreview(): void {
    this.previewGraphics.clear()
  }
}
